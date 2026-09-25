import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import type { DayHealth, ModelHealth, PersistedFile, HealthSample } from "../types.js";
import { dshHome } from "./dsh-home.ts";

function persistPath(): string {
  return join(dshHome(), "storages", "dsh-model-health", "health.json");
}

function emptyHealth(model: string): ModelHealth {
  return { model, ttftSumMs: 0, ttftCount: 0, decodeMsSum: 0, decodeTokensSum: 0, steps: 0 };
}

/** Per model per field: MAX merge. Persisted is cumulative truth that never
 *  shrinks, so deleting sessions keeps history while new steps still grow. */
export function mergeDayHealth(persisted: DayHealth, live: DayHealth): DayHealth {
  const result: DayHealth = new Map();
  for (const [k, v] of persisted) result.set(k, { ...v });
  for (const [k, l] of live) {
    const p = result.get(k);
    if (!p) {
      result.set(k, { ...l });
      continue;
    }
    result.set(k, {
      model: l.model || p.model,
      ttftSumMs: Math.max(p.ttftSumMs, l.ttftSumMs),
      ttftCount: Math.max(p.ttftCount, l.ttftCount),
      decodeMsSum: Math.max(p.decodeMsSum, l.decodeMsSum),
      decodeTokensSum: Math.max(p.decodeTokensSum, l.decodeTokensSum),
      steps: Math.max(p.steps, l.steps),
    });
  }
  return result;
}

/** Merge whole day maps with per-day max semantics. */
export function mergeDays(persisted: Map<string, DayHealth>, live: Map<string, DayHealth>): Map<string, DayHealth> {
  const result = new Map<string, DayHealth>();
  for (const [day, dh] of persisted) result.set(day, new Map([...dh].map(([k, v]) => [k, { ...v }])));
  for (const [day, liveDh] of live) {
    result.set(day, mergeDayHealth(result.get(day) ?? new Map(), liveDh));
  }
  return result;
}

/** Aggregate raw samples into day -> model counters. */
export function aggregateSamples(samples: HealthSample[]): Map<string, DayHealth> {
  const days = new Map<string, DayHealth>();
  for (const s of samples) {
    if (!s.model) continue;
    let dh = days.get(s.dayKey);
    if (!dh) {
      dh = new Map();
      days.set(s.dayKey, dh);
    }
    const cur = dh.get(s.model) ?? emptyHealth(s.model);
    cur.steps += 1;
    if (s.ttftMs != null) {
      cur.ttftSumMs += s.ttftMs;
      cur.ttftCount += 1;
    }
    if (s.decodeMs != null && s.decodeMs > 0) {
      cur.decodeMsSum += s.decodeMs;
      cur.decodeTokensSum += s.outputTokens;
    }
    dh.set(s.model, cur);
  }
  return days;
}

export function loadPersisted(): Map<string, DayHealth> {
  try {
    const p = persistPath();
    if (!existsSync(p)) return new Map();
    const parsed: PersistedFile = JSON.parse(readFileSync(p, "utf-8"));
    if (!parsed || typeof parsed.days !== "object") return new Map();
    const out = new Map<string, DayHealth>();
    for (const [day, models] of Object.entries(parsed.days)) {
      const dh: DayHealth = new Map();
      for (const [model, h] of Object.entries(models ?? {})) {
        dh.set(model, { ...emptyHealth(model), ...h, model });
      }
      out.set(day, dh);
    }
    return out;
  } catch {
    return new Map();
  }
}

export function savePersisted(days: Map<string, DayHealth>): void {
  try {
    const out: PersistedFile = {
      version: 1,
      days: Object.fromEntries([...days.entries()].map(([day, dh]) => [day, Object.fromEntries(dh)])),
    };
    const json = JSON.stringify(out, null, 2);
    const p = persistPath();
    mkdirSync(dirname(p), { recursive: true });
    const tmp = p + ".tmp";
    writeFileSync(tmp, json, "utf-8");
    renameSync(tmp, p);
  } catch {
    // best-effort
  }
}

export function getPersistPath(): string {
  return persistPath();
}
