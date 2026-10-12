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
    // GenerateOptions is FLAT: provider/model are top-level fields
    expect(captured.provider).toBe("xiaomi");
    expect(captured.model).toBe("mimo-v2.6-pro");
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

describe("5s measure window (early stop)", () => {
  it("stops after the measure window and estimates speed from delta count", async () => {
    // a long stream: 30 deltas x 100ms, no usage/finish until the very end
    const script = Array.from({ length: 30 }, (_, i) => ({
      delay: 100,
      chunk: i === 29 ? { type: "finish", reason: { kind: "stop" } } : { type: "text-delta", index: 0, text: "x" },
    }));
    const runner = new SpeedTestRunner(fakeCtx(script), { measureMs: 200 });
    const t0 = Date.now();
    runner.start("p", "m");
    const s = await settle(runner);
    const wall = Date.now() - t0;
    expect(s.status).toBe("done");
    expect(wall).toBeLessThan(1500);          // stopped early, not at stream end (~3s)
    expect(s.decodeMs).toBeGreaterThanOrEqual(200);
    expect(s.outputTokens).toBeGreaterThan(0); // delta-count estimate
    expect(s.tokPerSec!).toBeGreaterThan(0);
  });
});

describe("stall guard (absolute wall-clock timeout)", () => {
  it("times out even when the stream stalls without yielding chunks", async () => {
    // a stream that never yields: the per-chunk deadline check can never run
    const ctx = { llm: { async *stream() { await sleep(60_000); yield { type: "text-delta", index: 0, text: "x" }; } } };
    const runner = new SpeedTestRunner(ctx, { timeoutMs: 300 });
    runner.start("p", "m");
    const s = await Promise.race([
      settle(runner),
      sleep(1500).then(() => runner.state()),
    ]);
    expect(s.status).toBe("error");
    expect(s.error).toContain("timed out");
    // the slot is freed despite the hanging stream
    expect(runner.start("p", "m")).toBe(true);
  });
});

describe("routes cache (instant picker, background refresh)", () => {
  it("serves cached routes instantly and dedupes concurrent refreshes", async () => {
    let calls = 0;
    const ctx = {
      llm: {
        listProviders: () => [{ id: "p" }],
        listModels: async () => {
          calls++;
          await sleep(20);
          return [{ provider: "p", id: "m" }];
        },
      },
    };
    const runner = new SpeedTestRunner(ctx);
    // before any refresh: empty + stale
    expect(runner.getRoutes().models).toEqual([]);
    expect(runner.getRoutes().stale).toBe(true);
    // two concurrent refreshes collapse into one adapter round-trip
    await Promise.all([runner.refreshRoutes(), runner.refreshRoutes()]);
    expect(calls).toBe(1);
    const cached = runner.getRoutes();
    expect(cached.models).toEqual([{ provider: "p", model: "m" }]);
    expect(cached.stale).toBe(false);
    expect(cached.loading).toBe(false);
  });
});
