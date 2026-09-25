import { describe, it, expect } from "vitest";
import { SpeedTestRunner, computeMetrics } from "./speed-test.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeCtx(script: Array<{ delay: number; chunk: any }>) {
  return {
    llm: {
      async *stream() {
        for (const { delay, chunk } of script) {
          await sleep(delay);
          yield chunk;
        }
      },
    },
  };
}

async function settle(runner: SpeedTestRunner) {
  while (runner.state().status === "running") await sleep(10);
  return runner.state();
}

describe("computeMetrics", () => {
  it("derives ttft / decode window / tok-per-sec from timestamps", () => {
    expect(computeMetrics(1000, 1400, 2400, 60)).toEqual({ ttftMs: 400, decodeMs: 1000, tokPerSec: 60 });
  });
  it("returns nulls when no first token arrived", () => {
    expect(computeMetrics(1000, null, 2400, 0)).toEqual({ ttftMs: null, decodeMs: null, tokPerSec: null });
  });
});

describe("SpeedTestRunner", () => {
  it("streams a tiny prompt and records ttft + output speed", async () => {
    const ctx = fakeCtx([
      { delay: 30, chunk: { type: "text-delta", index: 0, text: "1, 2," } },
      { delay: 170, chunk: { type: "usage", usage: { inputTokens: 12, outputTokens: 60 } } },
      { delay: 10, chunk: { type: "finish", reason: { kind: "stop" } } },
    ]);
    const runner = new SpeedTestRunner(ctx);
    expect(runner.start("prov", "model")).toBe(true);
    expect(runner.start("prov", "model")).toBe(false); // one at a time
    const s = await settle(runner);
    expect(s.status).toBe("done");
    expect(s.ttftMs).toBeGreaterThanOrEqual(20);
    expect(s.outputTokens).toBe(60);
    // ~60 tokens over ~170ms → hundreds of tok/s; loose bounds keep the test timing-tolerant
    expect(s.tokPerSec!).toBeGreaterThan(100);
    expect(s.tokPerSec!).toBeLessThan(2000);
    // a finished test frees the slot
    expect(runner.start("prov", "model")).toBe(true);
  });

  it("records the error and frees the slot when the stream throws", async () => {
    const ctx = { llm: { async *stream() { await sleep(10); throw new Error("boom"); } } };
    const runner = new SpeedTestRunner(ctx);
    runner.start("p", "m");
    const s = await settle(runner);
    expect(s.status).toBe("error");
    expect(s.error).toContain("boom");
    expect(runner.start("p", "m")).toBe(true);
  });

  it("reports a friendly error when the llm service is missing", async () => {
    const runner = new SpeedTestRunner({});
    runner.start("p", "m");
    const s = await settle(runner);
    expect(s.status).toBe("error");
    expect(s.error).toContain("llm");
  });
});

describe("route + failure surfacing", () => {
  it("strips the provider prefix from the model for the route", async () => {
    let captured: any = null;
    const ctx = {
      llm: {
        async *stream(options: any) {
          captured = options;
          await sleep(20);
          yield { type: "text-delta", index: 0, text: "ok" };
          await sleep(20);
          yield { type: "usage", usage: { outputTokens: 5 } };
          yield { type: "finish", reason: { kind: "stop" } };
        },
      },
    };
    const runner = new SpeedTestRunner(ctx);
    runner.start("xiaomi", "xiaomi/mimo-v2.6-pro");
    await settle(runner);
    expect(captured.route).toEqual({ provider: "xiaomi", model: "mimo-v2.6-pro" });
  });

  it("surfaces a provider finish error instead of a generic no-output", async () => {
    const ctx = fakeCtx([
      { delay: 10, chunk: { type: "finish", reason: { kind: "error", failure: { message: "upstream 502" } } } },
    ]);
    const runner = new SpeedTestRunner(ctx);
    runner.start("p", "m");
    const s = await settle(runner);
    expect(s.status).toBe("error");
    expect(s.error).toContain("upstream 502");
  });

  it("no-output error lists the chunk types seen (diagnosable)", async () => {
    const ctx = fakeCtx([
      { delay: 10, chunk: { type: "usage", usage: { outputTokens: 0 } } },
      { delay: 10, chunk: { type: "finish", reason: { kind: "stop" } } },
    ]);
    const runner = new SpeedTestRunner(ctx);
    runner.start("p", "m");
    const s = await settle(runner);
    expect(s.status).toBe("error");
    expect(s.error).toContain("usage×1");
  });
});

describe("listRoutes (currently available models from the llm service)", () => {
  it("enumerates registered providers x advertised models", async () => {
    const ctx = {
      llm: {
        listProviders: () => [{ id: "xiaomi", name: "Xiaomi" }, { id: "p2", name: "P2" }],
        listModels: async (provider: string) =>
          provider === "xiaomi"
            ? [{ provider: "xiaomi", id: "mimo-v2.6-pro", name: "MiMo v2.6 Pro" }, { provider: "xiaomi", name: "no id" }]
            : [],
      },
    };
    const runner = new SpeedTestRunner(ctx);
    const routes = await runner.listRoutes();
    // entries without an id are skipped — "undefined" must never reach a route
    expect(routes).toEqual([{ provider: "xiaomi", model: "mimo-v2.6-pro" }]);
  });

  it("returns [] when the llm service is missing", async () => {
    const runner = new SpeedTestRunner({});
    expect(await runner.listRoutes()).toEqual([]);
  });
});
