import { describe, it, expect } from "vitest";
import { dayMetric, pickTopModels, pickTrendModels, buildSeries, summarize, splitSeries, shortModel, seriesPathFixed } from "./trend.js";
import { addDays, toDayKey } from "../date-bucket.js";

const weekA = addDays(toDayKey(Date.now()), -21);
const today = toDayKey(Date.now());
import type { DayHealth, ModelHealth } from "../types.js";

function mh(model: string, over: Partial<ModelHealth> = {}): ModelHealth {
  return {
    model,
    ttftSumMs: 0,
    ttftCount: 0,
    decodeMsSum: 0,
    decodeTokensSum: 0,
    steps: 0,
    ...over,
  };
}

describe("dayMetric", () => {
  it("avg ttft = ttftSumMs / ttftCount; null without samples", () => {
    expect(dayMetric(mh("mA", { ttftSumMs: 900, ttftCount: 3 }), "ttft")).toBe(300);
    expect(dayMetric(mh("mA", { ttftCount: 0 }), "ttft")).toBeNull();
  });

  it("speed = decodeTokensSum / decodeMsSum * 1000 (tok/s); null without decode window", () => {
    // 5000 tokens over 100_000 ms = 50 tok/s
    expect(dayMetric(mh("mA", { decodeTokensSum: 5000, decodeMsSum: 100_000 }), "speed")).toBe(50);
    expect(dayMetric(mh("mA", { decodeMsSum: 0 }), "speed")).toBeNull();
  });
});

describe("pickTopModels", () => {
  it("ranks models by sample steps in the window", () => {
    const days = new Map<string, DayHealth>([
      ["2026-08-29", new Map([["mA", mh("mA", { steps: 1 })], ["mB", mh("mB", { steps: 5 })]])],
      ["2026-08-30", new Map([["mA", mh("mA", { steps: 2 })], ["mC", mh("mC", { steps: 1 })]])],
    ]);
    // totals: mB=5 > mA=3 > mC=1
    const top = pickTopModels(days, ["2026-08-29", "2026-08-30"], 2);
    expect(top).toEqual(["mB", "mA"]);
  });
});

describe("buildSeries", () => {
  it("aligns each model's daily metric to the day keys with null gaps", () => {
    const days = new Map<string, DayHealth>([
      ["2026-08-29", new Map([["mA", mh("mA", { ttftSumMs: 600, ttftCount: 2 })]])],
      ["2026-08-30", new Map([["mA", mh("mA", { ttftSumMs: 400, ttftCount: 2 })]])],
    ]);
    const series = buildSeries(days, ["2026-08-28", "2026-08-29", "2026-08-30"], ["mA"], "ttft");
    expect(series.length).toBe(1);
    expect(series[0].points).toEqual([null, 300, 200]);
  });
});

describe("summarize", () => {
  it("sums per model across the window and derives the card averages", () => {
    const days = new Map<string, DayHealth>([
      ["2026-08-29", new Map([["mA", mh("mA", { ttftSumMs: 300, ttftCount: 1, decodeMsSum: 2000, decodeTokensSum: 100, steps: 1 })]])],
      ["2026-08-30", new Map([["mA", mh("mA", { ttftSumMs: 500, ttftCount: 1, decodeMsSum: 3000, decodeTokensSum: 200, steps: 1 })]])],
    ]);
    const sum = summarize(days, ["2026-08-29", "2026-08-30"]);
    const a = sum.get("mA")!;
    expect(a.steps).toBe(2);
    expect(a.ttftSumMs).toBe(800);
    expect(a.decodeMsSum).toBe(5000);
    expect(a.decodeTokensSum).toBe(300);
  });
});

describe("pickTrendModels (week top-3 always visible)", () => {
  it("guarantees the last-week top-3 even when they rank low over the range", () => {
    // range (30d): old models dominate; this week's hot models are small overall
    const days = new Map<string, DayHealth>([
      [weekA, new Map([["oldA", mh("oldA", { steps: 50 })], ["oldB", mh("oldB", { steps: 40 })], ["oldC", mh("oldC", { steps: 30 })], ["oldD", mh("oldD", { steps: 20 })], ["oldE", mh("oldE", { steps: 10 })]])],
      [today, new Map([["newA", mh("newA", { steps: 3 })], ["newB", mh("newB", { steps: 2 })], ["newC", mh("newC", { steps: 1 })], ["oldA", mh("oldA", { steps: 1 })]])],
    ]);
    const rangeKeys = [weekA, today];
    const weekKeys = [today];
    const picked = pickTrendModels(days, rangeKeys, weekKeys, 5, 3);
    // this week's top-3 must be in regardless of range rank
    expect(picked).toEqual(expect.arrayContaining(["newA", "newB", "newC"]));
    expect(picked.length).toBe(5);
  });

  it("caps at k and keeps week top-3 when k slots are filled", () => {
    const days = new Map<string, DayHealth>([
      [weekA, new Map([["r1", mh("r1", { steps: 9 })], ["r2", mh("r2", { steps: 8 })]])],
      [today, new Map([["w1", mh("w1", { steps: 5 })], ["w2", mh("w2", { steps: 4 })], ["w3", mh("w3", { steps: 3 })]])],
    ]);
    const picked = pickTrendModels(days, [weekA, today], [today], 5, 3);
    expect(picked).toEqual(expect.arrayContaining(["w1", "w2", "w3"]));
    expect(picked).toEqual(expect.arrayContaining(["r1"]));
    expect(picked.length).toBeLessThanOrEqual(5);
  });
});

describe("splitSeries (estimated spans for missing days)", () => {
  it("internal gaps become linear interpolations spanning both real anchors", () => {
    const seg = splitSeries([null, 100, null, null, 300, null]);
    expect(seg.runs).toEqual([[{ i: 1, v: 100 }], [{ i: 4, v: 300 }]]);
    // bridge from idx 1 to idx 4 inclusive, linear between 100 and 300
    expect(seg.interpolations.length).toBe(1);
    expect(seg.interpolations[0].idxs).toEqual([1, 2, 3, 4]);
    expect(seg.interpolations[0].values).toEqual([100, 166.67, 233.33, 300].map((x) => Math.round(x * 100) / 100));
  });

  it("leading/trailing gaps get NO estimated spans (lines stop at real data)", () => {
    const seg = splitSeries([null, null, 50, 60, null]);
    expect(seg.runs).toEqual([[{ i: 2, v: 50 }, { i: 3, v: 60 }]]);
    expect(seg.interpolations).toEqual([]);
    expect(seg).not.toHaveProperty("persistLeading");
    expect(seg).not.toHaveProperty("persistTrailing");
  });

  it("a fully populated series has one run and no estimated spans", () => {
    const seg = splitSeries([1, 2, 3]);
    expect(seg.runs.length).toBe(1);
    expect(seg.interpolations.length).toBe(0);
  });
});

describe("shortModel (legend shows the part after the last slash)", () => {
  it("strips provider prefixes and keeps bare names untouched", () => {
    expect(shortModel("xiaomi/mimo-v2.6-pro")).toBe("mimo-v2.6-pro");
    expect(shortModel("glm-5.3")).toBe("glm-5.3");
    expect(shortModel("minimax/minimax-m3-free")).toBe("minimax-m3-free");
    expect(shortModel("a/b/c")).toBe("c");
  });
});

describe("seriesPathFixed (morph-friendly fixed-length path)", () => {
  it("always emits the same command count and passes through the endpoints", () => {
    const d1 = seriesPathFixed([[0, 0], [10, 5], [20, 3]]);
    const d2 = seriesPathFixed([[0, 1], [20, 9]]);
    // M + 89 sampled L commands → identical structure → transition: d can morph
    expect(d1.split(" L ").length).toBe(90);
    expect(d2.split(" L ").length).toBe(90);
    expect(d1.endsWith("L 20 3")).toBe(true);
    expect(d2.endsWith("L 20 9")).toBe(true);
    expect(d1.startsWith("M 0 0")).toBe(true);
  });
});
