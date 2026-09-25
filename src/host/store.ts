import type { HealthSample, DayHealth } from "../types.js";
import { HealthTracker, readAllHealthSamples, readLiveHealthSamples } from "./session-reader.ts";
import { loadPersisted, savePersisted, aggregateSamples, mergeDays } from "./persist.ts";

export class HealthStore {
  private samples: HealthSample[] = [];
  private persisted = new Map<string, DayHealth>();
  private tracker = new HealthTracker();
  private ctx: any;
  /** True after init() finished scanning disk; API reports it as `ready` so
   *  the client keeps retrying instead of caching a partial snapshot. */
  private initialized = false;

  private cachedDays: Map<string, DayHealth> | null = null;
  private cachedAt = 0;
  private static CACHE_TTL_MS = 30_000;

  constructor(ctx: any) {
    this.ctx = ctx;
  }

  async init(): Promise<void> {
    this.persisted = loadPersisted();
    const samples = await readAllHealthSamples(this.ctx);
    this.samples = samples;
    this.rebuild();
    this.initialized = true;
  }

  /** Refresh from LIVE sessions only (the full disk scan happens once at init).
   *  A live session's snapshot is complete, so REPLACE its samples in place —
   *  samples of sessions no longer live are kept as-is from init(). */
  async refresh(): Promise<void> {
    try {
      const live = await readLiveHealthSamples(this.ctx);
      const liveSids = new Set(live.map((s) => s.sid));
      this.samples = [...this.samples.filter((s) => !liveSids.has(s.sid)), ...live];
      this.rebuild();
    } catch (e: unknown) {
      this.ctx?.logger?.warn?.(`dsh-model-health refresh failed: ${String(e)}`);
    }
  }

  private rebuild(): void {
    this.invalidateCache();
    const liveDays = aggregateSamples(this.samples);
    const prev = this.persisted;
    const merged = mergeDays(prev, liveDays);
    this.persisted = merged;
    if (grew(prev, merged)) savePersisted(merged);
  }

  /** Incremental ingest from `session/event`. Emits one sample when an
   *  assistant/message finalizes a tracked step. */
  ingest(event: any): void {
    const sample = this.tracker.feed(event);
    if (!sample) return;
    // replace-or-push by step key: a re-emitted step (resume / rewritten log)
    // overwrites its old sample instead of double counting (silent-growth guard)
    const i = this.samples.findIndex((s) => s.key === sample.key);
    if (i >= 0) this.samples[i] = sample;
    else this.samples.push(sample);
    this.persisted = mergeDays(this.persisted, aggregateSamples([sample]));
    savePersisted(this.persisted);
    this.invalidateCache();
  }

  isReady(): boolean {
    return this.initialized;
  }

  getDays(): Map<string, DayHealth> {
    if (!this.initialized) return new Map();
    const now = Date.now();
    if (this.cachedDays && now - this.cachedAt < HealthStore.CACHE_TTL_MS) return this.cachedDays;
    this.cachedDays = mergeDays(this.persisted, aggregateSamples(this.samples));
    this.cachedAt = now;
    return this.cachedDays;
  }

  private invalidateCache(): void {
    this.cachedDays = null;
    this.cachedAt = 0;
  }

  dispose(): void {}
}

/** True when any model's counters grew (only then a persist write is needed). */
function grew(prev: Map<string, DayHealth>, next: Map<string, DayHealth>): boolean {
  for (const [day, dh] of next) {
    const pdh = prev.get(day);
    if (!pdh) return true;
    for (const [model, h] of dh) {
      const p = pdh.get(model);
      if (!p) return true;
      if (h.steps > p.steps || h.ttftSumMs > p.ttftSumMs || h.decodeTokensSum > p.decodeTokensSum) return true;
    }
  }
  return false;
}
