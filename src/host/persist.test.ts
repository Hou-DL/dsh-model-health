import { describe, it, expect } from "vitest";
import { mergeDayHealth } from "./persist.js";
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

describe("mergeDayHealth", () => {
  it("keeps persisted when live shrinks (session deletion never loses health history)", () => {
    const persisted: DayHealth = new Map([["mA", mh("mA", { ttftSumMs: 1000, ttftCount: 10, decodeMsSum: 1000, decodeTokensSum: 5000, steps: 10 })]]);
    const live: DayHealth = new Map([["mA", mh("mA", { ttftSumMs: 500, ttftCount: 5, decodeMsSum: 500, decodeTokensSum: 2500, steps: 5 })]]);
    const merged = mergeDayHealth(persisted, live);
    const a = merged.get("mA")!;
    expect(a.ttftSumMs).toBe(1000);
    expect(a.ttftCount).toBe(10);
    expect(a.decodeMsSum).toBe(1000);
    expect(a.decodeTokensSum).toBe(5000);
    expect(a.steps).toBe(10);
  });

  it("takes the max per field when live grows (new steps recorded)", () => {
    const persisted: DayHealth = new Map([["mA", mh("mA", { ttftSumMs: 1000, ttftCount: 10, decodeMsSum: 1000, decodeTokensSum: 5000, steps: 10 })]]);
    const live: DayHealth = new Map([["mA", mh("mA", { ttftSumMs: 1600, ttftCount: 16, decodeMsSum: 1600, decodeTokensSum: 8000, steps: 16 })]]);
    const merged = mergeDayHealth(persisted, live);
    const a = merged.get("mA")!;
    expect(a.steps).toBe(16);
    expect(a.ttftCount).toBe(16);
    expect(a.decodeTokensSum).toBe(8000);
  });

  it("propagates models that only exist in live", () => {
    const persisted: DayHealth = new Map([["mA", mh("mA", { steps: 3, ttftSumMs: 300, ttftCount: 3 })]]);
    const live: DayHealth = new Map([["mB", mh("mB", { steps: 1, ttftSumMs: 90, ttftCount: 1 })]]);
    const merged = mergeDayHealth(persisted, live);
    expect(merged.get("mA")!.steps).toBe(3);
    expect(merged.get("mB")!.ttftSumMs).toBe(90);
    expect(merged.size).toBe(2);
  });
});

describe("persist round-trip (silent-drop guard)", () => {
  it("keeps every counter through save -> load", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const home = mkdtempSync(join(tmpdir(), "mh-rt-"));
    const prev = process.env.DSH_HOME;
    process.env.DSH_HOME = home;
    try {
      const { savePersisted, loadPersisted } = await import("./persist.js");
      const days = new Map<string, DayHealth>([
        ["2026-09-24", new Map([["mA", mh("mA", { ttftSumMs: 123, ttftCount: 7, decodeMsSum: 4567, decodeTokensSum: 890, steps: 11 })]])],
      ]);
      savePersisted(days);
      const back = loadPersisted().get("2026-09-24")!.get("mA")!;
      expect(back).toEqual({ model: "mA", ttftSumMs: 123, ttftCount: 7, decodeMsSum: 4567, decodeTokensSum: 890, steps: 11 });
    } finally {
      if (prev === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = prev;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
