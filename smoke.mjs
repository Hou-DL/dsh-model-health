// Smoke: parse REAL session logs read-only and print per-model health.
import { readAllHealthSamples } from "./src/host/session-reader.ts";
import { aggregateSamples } from "./src/host/persist.ts";

const samples = await readAllHealthSamples({});
console.log("total samples:", samples.length);
const days = aggregateSamples(samples);
console.log("days:", days.size);

const totals = new Map();
for (const dh of days.values()) {
  for (const [model, h] of dh) {
    const t = totals.get(model) ?? { steps: 0, ttftSum: 0, ttftN: 0, decMs: 0, decTok: 0 };
    t.steps += h.steps; t.ttftSum += h.ttftSumMs; t.ttftN += h.ttftCount;
    t.decMs += h.decodeMsSum; t.decTok += h.decodeTokensSum;
    totals.set(model, t);
  }
}
const rows = [...totals.entries()].sort((a, b) => b[1].steps - a[1].steps);
console.log("model | steps | avg TTFT | avg speed");
for (const [m, t] of rows) {
  const ttft = t.ttftN ? (t.ttftSum / t.ttftN / 1000).toFixed(2) + " s" : "-";
  const speed = t.decMs ? (t.decTok / t.decMs * 1000).toFixed(1) + " tok/s" : "-";
  console.log(`${m} | ${t.steps} | ${ttft} | ${speed}`);
}
const allSteps = rows.reduce((a, [, t]) => a + t.steps, 0);
const withTtft = rows.reduce((a, [, t]) => a + t.ttftN, 0);
console.log(`steps with ttft: ${withTtft}/${allSteps}`);
