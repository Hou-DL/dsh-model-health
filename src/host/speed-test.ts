import type { SpeedTestState } from "../types.js";

/**
 * Token-frugal probe: count to 300 with no system prompt. The target is sized
 * so the decode window lasts ~3-6s for most models (stable average speed) and
 * reasoning models keep headroom above their thinking tokens (a 64-token
 * budget died on finish_reason=length with 62 reasoning tokens).
 */
const SPEED_PROMPT = "从 1 数到 300，用逗号分隔，不要输出其他内容";
const MAX_TOKENS = 1536;
const TIMEOUT_MS = 45_000;
/** ~5s decode window: enough for a stable average, no need to run to the
 *  token limit — the stream is stopped early and speed derives from deltas. */
const MEASURE_MS = 5_000;

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
  private opts: { measureMs?: number };
  private st: SpeedTestState = {
    status: "idle", provider: "", model: "", startedAt: null,
    ttftMs: null, decodeMs: null, outputTokens: 0, tokPerSec: null, error: null,
  };
  private running = false;

  constructor(ctx: any, opts: { measureMs?: number } = {}) {
    this.ctx = ctx;
    this.opts = opts;
  }

  state(): SpeedTestState {
    return { ...this.st };
  }

  /**
   * Currently AVAILABLE routes straight from the llm service registry:
   * registered providers x their advertised models. This mirrors the user's
   * live model configuration (NOT historical session usage).
   */
  async listRoutes(): Promise<Array<{ provider: string; model: string }>> {
    const llm = this.ctx?.llm;
    if (!llm?.listProviders || !llm?.listModels) return [];
    const out: Array<{ provider: string; model: string }> = [];
    for (const p of llm.listProviders()) {
      const provider = typeof p === "string" ? p : p?.id;
      if (!provider) continue;
      try {
        const infos = await llm.listModels(provider);
        for (const info of infos ?? []) {
          if (info?.id) out.push({ provider, model: info.id });
        }
      } catch {}
    }
    return out;
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
    let first: number | null = null;
    let usageTime: number | null = null;
    let tokens = 0;
    let deltas = 0;
    const seen: Record<string, number> = {};
    const measureMs = this.opts.measureMs ?? MEASURE_MS;
    const timeoutMs = this.opts.timeoutMs ?? TIMEOUT_MS;
    // wall-clock watchdog: a stream that stalls WITHOUT yielding never reaches
    // the per-chunk deadline check, and would hold the single-run slot forever
    const guard = { live: true };
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    // models are often recorded as "provider/model"; the route wants the bare name
    const bareModel = model.startsWith(`${provider}/`) ? model.slice(provider.length + 1) : model;
    try {
      const llm = this.ctx?.llm;
      if (!llm?.stream) throw new Error("llm service unavailable on this host");
      // GenerateOptions is FLAT: provider/model are TOP-LEVEL fields (no nested
      // route object — that was misread from title-llm's local variable)
      const options = {
        provider,
        model: bareModel,
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
      const consume = async () => {
        for await (const chunk of llm.stream(options)) {
          if (!guard.live) return; // watchdog fired: stop touching state
          const now = Date.now();
          const type = chunk?.type;
          seen[type ?? "unknown"] = (seen[type ?? "unknown"] ?? 0) + 1;
          if (type === "text-delta" || type === "reasoning-delta") {
            if (typeof chunk.text === "string" && chunk.text.trim() !== "") {
              if (first == null) first = now;
              deltas++;
            }
          } else if (type === "tool-call-delta") {
            if (first == null) first = now;
            deltas++;
          } else if (type === "usage") {
            usageTime = now;
            tokens = chunk.usage?.outputTokens ?? tokens;
          } else if (type === "finish") {
            const kind = chunk.reason?.kind;
            if (kind === "error" || kind === "aborted") {
              throw new Error(String(chunk.reason?.failure?.message ?? `provider stream ${kind}`));
            }
            break;
          }
          // live interim metrics (speedtest-style rising number): each delta is
          // ~one token, so tok/s ≈ deltas / (now − first)
          if (first != null && now > first) {
            const liveTokPerSec = Math.round((deltas / (now - first)) * 1000 * 100) / 100;
            this.st = { ...this.st, ttftMs: first - t0, tokPerSec: liveTokPerSec };
          }
          // measure window reached: stop early — deltas so far give a stable
          // average, and running to the token limit adds nothing but waiting
          if (first != null && now - first >= measureMs) break;
        }
      };
      await Promise.race([
        consume(),
        new Promise<never>((_, reject) => {
          watchdog = setTimeout(() => reject(new Error(`speed test timed out after ${timeoutMs / 1000}s`)), timeoutMs);
        }),
      ]);
      if (usageTime == null) usageTime = Date.now();
      if (!tokens) tokens = deltas; // early stop: each delta ≈ one token
      if (first == null) {
        const seenStr = Object.entries(seen).map(([k, v]) => `${k}×${v}`).join(", ") || "none";
        throw new Error(`model produced no output (chunks seen: ${seenStr})`);
      }
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
      guard.live = false;
      if (watchdog) clearTimeout(watchdog);
      this.running = false;
    }
  }
}
