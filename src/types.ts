/** One finished LLM step's health measurements (Phase 1: passive recording).
 *
 *  ttftMs: first non-empty delta (reasoning or text) minus step start, ms.
 *  decodeMs: usage-reporting event minus first non-empty delta, ms.
 *  outputTokens: provider-reported output tokens of the step.
 *  A sample carries null for measurements that could not be observed. */
export type HealthSample = {
  /** step key (`sid::turn:step`) — one sample per step; not persisted */
  key: string;
  /** session id — used to replace a live session's samples on refresh; not persisted */
  sid: string;
  /** Asia/Shanghai day of the step start (fallback: first token / end) */
  dayKey: string;
  provider: string;
  model: string;
  ttftMs: number | null;
  decodeMs: number | null;
  outputTokens: number;
};

/** Per model per day: additive counters. Averages derive as:
 *  avg TTFT = ttftSumMs / ttftCount; avg speed = decodeTokensSum / decodeMsSum * 1000. */
export type ModelHealth = {
  model: string;
  ttftSumMs: number;
  ttftCount: number;
  decodeMsSum: number;
  decodeTokensSum: number;
  steps: number;
};

export type DayHealth = Map<string, ModelHealth>;

export type PersistedFile = {
  version: 1;
  days: Record<string, Record<string, ModelHealth>>;
};
