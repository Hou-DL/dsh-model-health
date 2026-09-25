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
