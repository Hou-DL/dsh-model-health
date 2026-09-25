// Diagnose: what does the DISK parse produce per day/model recently?
import { readAllHealthSamples } from "./src/host/session-reader.ts";
import { aggregateSamples } from "./src/host/persist.ts";

const samples = await readAllHealthSamples({});
const days = aggregateSamples(samples);
console.log("disk-parse days:", days.size, "| samples:", samples.length);
for (const k of [...days.keys()].sort()) {
  if (k < "2026-09-14") continue;
  for (const [m, h] of days.get(k)) {
    console.log(k, "|", m, "| steps", h.steps, "| ttftN", h.ttftCount, "| ttftSum", h.ttftSumMs, "| decMs", h.decodeMsSum, "| decTok", h.decodeTokensSum);
  }
}
