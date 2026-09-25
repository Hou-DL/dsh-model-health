import type { SpeedTestState } from "../types.js";

/**
 * Token-frugal probe: count to 30 with no system prompt. A handful of input
 * tokens and ~maxTokens of output are enough to measure TTFT and decode speed.
 */
const SPEED_PROMPT = "从 1 数到 30，用逗号分隔，不要输出其他内容";
const MAX_TOKENS = 64;
const TIMEOUT_MS = 30_000;

/** Pure metric derivation: TTFT = first output − start; decode window =
 *  usage arrival − first output; speed = outputTokens / decode window. */
export function computeMetrics(t0: number, first: number | null, usage: number | null, tokens: number): {
  ttftMs: number | null;
  decodeMs: number | null;
  tokPerSec: number | null;
} {
  const ttftMs = first != null ? first - t0 : null;
  const decodeMs = first != null && usage != null && usage > first ? usage - first : null;
  const tokPerSec = decodeMs && tokens > 0 ? Math.round(((tokens / decodeMs) * 1000) * 100) / 100 : null;
  return { ttftMs, decodeMs, tokPerSec };
}

/**
 * One-at-a-time active speed test against a provider/model route via the
 * host `llm` service (same access pattern as dsh-session-title-llm:
 * `ctx.llm.stream({route, messages, maxTokens})` over flat StreamChunks).
 */
export class SpeedTestRunner {
  private ctx: any;
  private st: SpeedTestState = {
    status: "idle", provider: "", model: "", startedAt: null,
    ttftMs: null, decodeMs: null, outputTokens: 0, tokPerSec: null, error: null,
  };
  private running = false;

  constructor(ctx: any) {
    this.ctx = ctx;
  }

  state(): SpeedTestState {
    return { ...this.st };
  }

  /** Start a test; false when one is already in flight. */
  start(provider: string, model: string): boolean {
    if (this.running) return false;
    this.running = true;
    this.st = {
      status: "running", provider, model, startedAt: Date.now(),
      ttftMs: null, decodeMs: null, outputTokens: 0, tokPerSec: null, error: null,
    };
    void this.run(provider, model);
    return true;
  }

  private async run(provider: string, model: string): Promise<void> {
    const t0 = Date.now();
    const deadline = t0 + TIMEOUT_MS;
    let first: number | null = null;
    let usageTime: number | null = null;
    let tokens = 0;
    try {
      const llm = this.ctx?.llm;
      if (!llm?.stream) throw new Error("llm service unavailable on this host");
      const options = {
        route: { provider, model },
        messages: [
          {
            id: crypto.randomUUID(),
            role: "user" as const,
            content: [{ type: "text", text: SPEED_PROMPT }],
            source: { kind: "plugin", plugin: "dsh-model-health" },
          },
        ],
        maxTokens: MAX_TOKENS,
      };
      for await (const chunk of llm.stream(options)) {
        const now = Date.now();
        if (now > deadline) throw new Error(`speed test timed out after ${TIMEOUT_MS / 1000}s`);
        const type = chunk?.type;
        if ((type === "text-delta" || type === "reasoning-delta")) {
          if (typeof chunk.text === "string" && chunk.text.trim() !== "") {
            if (first == null) first = now;
          }
        } else if (type === "tool-call-delta") {
          if (first == null) first = now;
        } else if (type === "usage") {
          usageTime = now;
          tokens = chunk.usage?.outputTokens ?? tokens;
        } else if (type === "finish") {
          break;
        }
      }
      if (usageTime == null) usageTime = Date.now();
      if (first == null) throw new Error("model produced no output within the timeout");
      const m = computeMetrics(t0, first, usageTime, tokens);
      this.st = {
        status: "done", provider, model, startedAt: t0,
        ttftMs: m.ttftMs, decodeMs: m.decodeMs, outputTokens: tokens, tokPerSec: m.tokPerSec, error: null,
      };
    } catch (e) {
      this.st = {
        status: "error", provider, model, startedAt: t0,
        ttftMs: null, decodeMs: null, outputTokens: 0, tokPerSec: null,
        error: String((e as any)?.message ?? e),
      };
    } finally {
      this.running = false;
    }
  }
}
