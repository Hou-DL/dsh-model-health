import type { DayHealth, ModelHealth } from "../types.js";
import { addDays } from "../date-bucket.ts";

/**
 * Pure logic for the health card and the trend chart: metric derivation,
 * window sums, top-model selection and monotone cubic smoothing.
 * Free of React/DOM so it is unit-testable.
 */

export type Metric = "ttft" | "speed";

/** Per-day metric value: avg TTFT (ms) or avg output speed (tok/s); null when
 *  the day has no usable samples for the metric. */
export function dayMetric(h: ModelHealth | undefined, metric: Metric): number | null {
  if (!h) return null;
  if (metric === "ttft") {
    return h.ttftCount > 0 ? h.ttftSumMs / h.ttftCount : null;
  }
  return h.decodeMsSum > 0 ? (h.decodeTokensSum / h.decodeMsSum) * 1000 : null;
}

/** Sum each model's counters over `dayKeys` (window summary for the card). */
export function summarize(days: Map<string, DayHealth>, dayKeys: string[]): Map<string, ModelHealth> {
  const out = new Map<string, ModelHealth>();
  for (const k of dayKeys) {
    const dh = days.get(k);
    if (!dh) continue;
    for (const [model, h] of dh) {
      const cur = out.get(model) ?? { model, ttftSumMs: 0, ttftCount: 0, decodeMsSum: 0, decodeTokensSum: 0, steps: 0 };
      cur.ttftSumMs += h.ttftSumMs;
      cur.ttftCount += h.ttftCount;
      cur.decodeMsSum += h.decodeMsSum;
      cur.decodeTokensSum += h.decodeTokensSum;
      cur.steps += h.steps;
      out.set(model, cur);
    }
  }
  return out;
}

/** Up to `k` busiest models of the window (by sample steps) — the legend set. */
export function pickTopModels(days: Map<string, DayHealth>, dayKeys: string[], k = 5): string[] {
  return [...summarize(days, dayKeys).entries()]
    .sort((a, b) => (b[1].steps - a[1].steps) || (a[0] < b[0] ? -1 : 1))
    .slice(0, k)
    .map(([model]) => model);
}

export type TrendSeries = { model: string; points: Array<number | null> };

/** One series per model: its daily metric aligned to `dayKeys`, null on gaps. */
export function buildSeries(days: Map<string, DayHealth>, dayKeys: string[], models: string[], metric: Metric): TrendSeries[] {
  return models.map((model) => ({
    model,
    points: dayKeys.map((k) => dayMetric(days.get(k)?.get(model), metric)),
  }));
}

/** N consecutive day keys ending at `endKey` (inclusive). */
export function recentDayKeys(endKey: string, n: number): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(addDays(endKey, -i));
  return out;
}

export type Segment = {
  p0: [number, number];
  c1: [number, number];
  c2: [number, number];
  p1: [number, number];
};

/**
 * Monotone cubic (Fritsch–Carlson) Hermite interpolation as cubic bezier
 * segments — a smooth trend line must NOT overshoot (no fake troughs/peaks).
 */
export function monotoneSegments(pts: Array<[number, number]>): Segment[] {
  const n = pts.length;
  if (n < 2) return [];
  const h: number[] = [];
  const delta: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = pts[i + 1][0] - pts[i][0];
    h.push(dx);
    delta.push(dx === 0 ? 0 : (pts[i + 1][1] - pts[i][1]) / dx);
  }
  const m: number[] = new Array(n);
  m[0] = delta[0];
  m[n - 1] = delta[n - 2];
  for (let i = 1; i < n - 1; i++) {
    m[i] = delta[i - 1] * delta[i] <= 0 ? 0 : (delta[i - 1] + delta[i]) / 2;
  }
  for (let i = 0; i < n - 1; i++) {
    if (delta[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / delta[i];
    const b = m[i + 1] / delta[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * delta[i];
      m[i + 1] = t * b * delta[i];
    }
  }
  const segs: Segment[] = [];
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];
    const dx = (x1 - x0) / 3;
    segs.push({
      p0: [x0, y0],
      c1: [x0 + dx, y0 + m[i] * (x1 - x0) / 3],
      c2: [x1 - dx, y1 - m[i + 1] * (x1 - x0) / 3],
      p1: [x1, y1],
    });
  }
  return segs;
}

const fmtNum = (v: number) => Math.round(v * 100) / 100;

/** SVG path `d` for a smoothed polyline through `[x,y]` points. */
export function seriesPath(points: Array<[number, number]>): string {
  if (points.length === 0) return "";
  const head = `M ${fmtNum(points[0][0])} ${fmtNum(points[0][1])}`;
  if (points.length === 1) return head;
  const segs = monotoneSegments(points);
  return head + segs
    .map((s) => ` C ${fmtNum(s.c1[0])} ${fmtNum(s.c1[1])}, ${fmtNum(s.c2[0])} ${fmtNum(s.c2[1])}, ${fmtNum(s.p1[0])} ${fmtNum(s.p1[1])}`)
    .join("");
}

/** "320 ms" / "1.24 s" */
export function formatMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  return `${Math.round(ms)} ms`;
}

/** "45.2 tok/s" */
export function formatSpeed(v: number): string {
  return `${v.toFixed(1)} tok/s`;
}

/** Axis/tooltip formatting for a metric value. */
export function formatMetric(v: number, metric: Metric): string {
  return metric === "ttft" ? formatMs(v) : formatSpeed(v);
}

/**
 * Legend set for the trend chart: the range's top-`k` models PLUS the last
 * week's top-`weekTopN` guaranteed (a model that took over this week must stay
 * visible in a 30-day view). If the union would exceed `k`, the weakest
 * range-ranked models give up their slots. Result: at most `k` names, ordered
 * by range steps desc.
 */
export function pickTrendModels(
  days: Map<string, DayHealth>,
  dayKeys: string[],
  weekKeys: string[],
  k = 5,
  weekTopN = 3,
): string[] {
  const totals = summarize(days, dayKeys);
  const ranked = [...totals.entries()]
    .sort((a, b) => (b[1].steps - a[1].steps) || (a[0] < b[0] ? -1 : 1))
    .map(([m]) => m);
  const weekTop = pickTopModels(days, weekKeys, weekTopN);
  const selected = new Set<string>(weekTop);
  for (const m of ranked) {
    if (selected.size >= k) break;
    selected.add(m);
  }
  return [...selected].sort(
    (a, b) => ((totals.get(b)?.steps ?? 0) - (totals.get(a)?.steps ?? 0)) || (a < b ? -1 : 1),
  );
}

export type GapSpan = { idxs: number[]; values: number[] };

export type SplitSeries = {
  /** consecutive observed points (solid line runs) */
  runs: Array<Array<{ i: number; v: number }>>;
  /** internal gaps only: linear interpolation between the two real anchors,
   *  anchors included so the estimated span passes exactly through them.
   *  Leading/trailing gaps get NO estimate — lines stop at real data. */
  interpolations: GapSpan[];
};

const r2 = (v: number) => Math.round(v * 100) / 100;

/** Split one series into observed runs and estimated (dashed) spans. */
export function splitSeries(points: Array<number | null>): SplitSeries {
  const runs: Array<Array<{ i: number; v: number }>> = [];
  let cur: Array<{ i: number; v: number }> = [];
  points.forEach((v, i) => {
    if (v != null) cur.push({ i, v });
    else if (cur.length) {
      runs.push(cur);
      cur = [];
    }
  });
  if (cur.length) runs.push(cur);

  const interpolations: GapSpan[] = [];
  for (let r = 0; r + 1 < runs.length; r++) {
    const a = runs[r][runs[r].length - 1];
    const b = runs[r + 1][0];
    const idxs: number[] = [];
    const values: number[] = [];
    for (let i = a.i; i <= b.i; i++) {
      idxs.push(i);
      const t = (i - a.i) / (b.i - a.i);
      values.push(r2(a.v + (b.v - a.v) * t));
    }
    interpolations.push({ idxs, values });
  }

  return { runs, interpolations };
}

/** Display name for legend chips: only the part after the last "/" (provider
 *  prefixes make real names too long to fit). Bare names stay untouched. */
export function shortModel(name: string): string {
  const i = name.lastIndexOf("/");
  return i >= 0 ? name.slice(i + 1) : name;
}

/**
 * Resample the monotone curve at a FIXED number of x samples (M + N L
 * commands). CSS `transition: d` can then morph lines across range switches
 * too — where raw bezier paths (M + n-1 C) have mismatched structures and
 * would jump. Learned from token-pulse's animated trend chart.
 */
export function seriesPathFixed(points: Array<[number, number]>, samples = 89): string {
  if (points.length === 0) return "";
  const x0 = points[0][0];
  const x1 = points[points.length - 1][0];
  const head = `M ${fmtNum(x0)} ${fmtNum(points[0][1])}`;
  if (points.length === 1) return head;
  const segs = monotoneSegments(points);
  let out = "";
  let seg = 0;
  for (let s = 1; s <= samples; s++) {
    const x = x0 + ((x1 - x0) * s) / samples;
    while (seg < segs.length - 1 && x > segs[seg].p1[0]) seg++;
    const g = segs[seg];
    const t = g.p1[0] === g.p0[0] ? 0 : Math.min(1, Math.max(0, (x - g.p0[0]) / (g.p1[0] - g.p0[0])));
    const mt = 1 - t;
    const y = mt * mt * mt * g.p0[1] + 3 * mt * mt * t * g.c1[1] + 3 * mt * t * t * g.c2[1] + t * t * t * g.p1[1];
    out += ` L ${fmtNum(x)} ${fmtNum(y)}`;
  }
  return head + out;
}

/**
 * Outlier-robust chart ceiling: P75 (nearest rank) x 1.5. One model running
 * 15x faster than the rest must not crush every other line against the axis;
 * outliers clamp to the top edge instead of stretching the scale.
 */
export function chartCeiling(values: number[]): number {
  if (values.length === 0) return 1;
  const sorted = [...values].sort((a, b) => a - b);
  const p75 = sorted[Math.min(sorted.length - 1, Math.ceil(0.75 * sorted.length) - 1)];
  return Math.max(1, p75 * 1.5);
}
