import type { HealthSample } from "../types.js";
import { toDayKey } from "../date-bucket.ts";
import { sessionsDir } from "./dsh-home.ts";

/** zstd frame magic: bytes 28 B5 2F FD, read as UInt32LE. */
const ZSTD_MAGIC = 0xfd2fb528;

/**
 * Locate complete zstd frames inside a concatenated-frame container (DSH's
 * session.jsonl.zstd format: every appended batch is its own compressed
 * frame). Node's one-shot decompress reads only frame 1, so callers decode
 * each frame separately. Mirrors dsh-session-persistence-jsonl's scanZstdFrames.
 */
export function scanZstdFrames(buffer: Buffer): Array<{ start: number; end: number }> {
  const frames: Array<{ start: number; end: number }> = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) break;
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) break; // torn/corrupt tail
    offset += 4;
    if (offset === buffer.length) break;
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) break;
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) break;
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) break;
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) break;
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) break;
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) break;
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return frames;
}

/** Decode a concatenated-frame zstd log to full UTF-8 text; null on failure. */
export async function decodeSessionZstd(buffer: Buffer): Promise<string | null> {
  const zlib = await import("node:zlib");
  if (typeof zlib.zstdDecompressSync !== "function") return null;
  const frames = scanZstdFrames(buffer);
  if (frames.length === 0) return null;
  const parts: string[] = [];
  for (const { start, end } of frames) {
    try {
      parts.push(zlib.zstdDecompressSync(buffer.subarray(start, end)).toString("utf-8"));
    } catch {
      return null;
    }
  }
  return parts.join("");
}

type SessionEvent = {
  type: string;
  time?: number;
  seq?: number;
  /** batched compact events ("*-chunks") carry the first piece's time/seq */
  time0?: number;
  seq0?: number;
  data?: any;
  sid?: string;
};

/**
 * Timestamp of the first non-empty piece in a batched "*-chunks" event:
 * `time0` is piece 0's time and `dt[i]` is the gap between piece i and i+1.
 * Whitespace-only pieces do not count as output (matches dsh-session-stats'
 * "first non-empty delta chunk").
 */
export function firstNonEmptyTime(time0: number, dt: unknown, pieces: unknown): number | null {
  if (!Array.isArray(pieces)) return null;
  const gaps: number[] = Array.isArray(dt) ? dt : [];
  let t = time0;
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i];
    if (typeof piece === "string" && piece.trim() !== "") return t;
    if (typeof gaps[i] === "number") t += gaps[i];
  }
  return null;
}

/**
 * First non-empty output timestamp inside a v3 message's embedded stream
 * (`data.stream`). Items are either raw chunks ({type:"chunk", time, chunk}) or
 * batched runs ({type:"text-chunks", time0, dt, texts/args}) with FLAT fields —
 * the v3 log keeps the whole stream timeline inside the message record.
 */
export function streamFirstToken(stream: unknown): number | null {
  if (!Array.isArray(stream)) return null;
  for (const raw of stream as any[]) {
    if (!raw || typeof raw !== "object") continue;
    const c = raw.chunk;
    if (c && (c.type === "text-delta" || c.type === "reasoning-delta")) {
      if (typeof c.text === "string" && c.text.trim() !== "" && typeof raw.time === "number") return raw.time;
    } else if (c && c.type === "tool-call-delta") {
      if (typeof raw.time === "number") return raw.time;
    } else if (!c && (raw.type === "text-chunks" || raw.type === "reasoning-chunks" || raw.type === "tool-call-chunks")) {
      const src = raw.data ?? raw;
      const pieces = raw.type === "tool-call-chunks" ? src.args : src.texts;
      const time0 = typeof raw.time0 === "number" ? raw.time0 : typeof raw.time === "number" ? raw.time : 0;
      const t = firstNonEmptyTime(time0, src.dt, pieces);
      if (t != null) return t;
    }
  }
  return null;
}

/**
 * Session-log file rank inside one session directory. v3 logs REWRITE the
 * whole history (streams embedded in messages), so when several versions
 * coexist only the newest is read — the legacy file is a frozen duplicate
 * whose seq numbering restarts and would collide with v3's.
 */
export function sessionFileRank(name: string): number {
  const m = /^session(?:\.v(\d+))?\.jsonl(?:\.zstd)?$/.exec(name);
  if (!m) return -1;
  return m[1] ? Number(m[1]) : 0;
}

type OpenStep = {
  startTimeMs: number | null;
  firstTokenMs: number | null;
  endTimeMs: number | null;
  outputTokens: number;
  provider: string;
  model: string;
  finalized: boolean;
};

/**
 * Incremental step-lifecycle tracker. Feed raw session events in stream order;
 * each finalized step surfaces as one HealthSample (emitted on the
 * authoritative `assistant/message` usage).
 *
 * Definitions (matching dsh-session-stats):
 *  - TTFT = first non-empty delta chunk (reasoning or text) minus step/start
 *  - decode window = usage-reporting event minus first non-empty delta
 *  - a whitespace-only delta does NOT start the first-token clock
 *
 * Keys are scoped per session (`sid::turn:step`): turn/step counters restart
 * per session, so without the sid different sessions collide.
 */
export class HealthTracker {
  private fallbackBySid = new Map<string, { provider: string; model: string }>();
  private steps = new Map<string, OpenStep>();
  private results = new Map<string, HealthSample>();
  private static MAX_OPEN_STEPS = 5000;

  /** Finalized samples collapsed by step key (one per step, newest wins). */
  collected(): HealthSample[] {
    return [...this.results.values()];
  }

  feed(ev: SessionEvent): HealthSample | null {
    const sid = ev.sid ?? "";
    const data = ev.data ?? {};

    if (ev.type === "request/header" && data.header?.config) {
      this.setFallback(sid, data.header.config.provider, data.header.config.model);
      return null;
    }
    if (ev.type === "request/context") {
      this.setFallback(sid, data.provider, data.model);
      return null;
    }

    const turn = data.turn;
    const step = data.step;
    const keyed = typeof turn === "number" && typeof step === "number";
    const key = keyed ? `${sid}::${turn}:${step}` : null;

    if (ev.type === "step/start" && key) {
      const cur = this.steps.get(key);
      if (!cur) this.steps.set(key, this.open(sid, ev.time ?? null));
      else if (cur.startTimeMs == null) cur.startTimeMs = ev.time ?? null;
      return null;
    }

    if (ev.type === "assistant/chunk" && (data.chunk?.type === "text-delta" || data.chunk?.type === "reasoning-delta")) {
      const cur = key ? this.steps.get(key) ?? this.steps.set(key, this.open(sid, null)).get(key)! : null;
      if (cur && cur.firstTokenMs == null && typeof data.chunk.text === "string" && data.chunk.text.trim() !== "") {
        cur.firstTokenMs = ev.time ?? null;
      }
      return null;
    }

    // Batched compact events (compacted logs): one event carries a whole run
    // of streamed pieces with per-piece time gaps.
    if (ev.type === "text-chunks" || ev.type === "reasoning-chunks" || ev.type === "tool-call-chunks") {
      const cur = key ? this.steps.get(key) ?? this.steps.set(key, this.open(sid, null)).get(key)! : null;
      if (cur && cur.firstTokenMs == null) {
        const pieces = ev.type === "tool-call-chunks" ? data.args : data.texts;
        const t = firstNonEmptyTime(ev.time0 ?? ev.time ?? 0, data.dt, pieces);
        if (t != null) cur.firstTokenMs = t;
      }
      return null;
    }

    // Raw tool-call delta: the call header itself is output activity — it starts
    // the first-token clock even with an empty argumentsDelta.
    if (ev.type === "assistant/chunk" && data.chunk?.type === "tool-call-delta") {
      const cur = key ? this.steps.get(key) ?? this.steps.set(key, this.open(sid, null)).get(key)! : null;
      if (cur && cur.firstTokenMs == null) cur.firstTokenMs = ev.time ?? null;
      return null;
    }

    if (ev.type === "assistant/chunk" && data.chunk?.type === "usage") {
      const cur = key ? this.steps.get(key) ?? this.steps.set(key, this.open(sid, null)).get(key)! : null;
      if (cur && !cur.finalized) {
        cur.endTimeMs = ev.time ?? cur.endTimeMs;
        cur.outputTokens = data.chunk.usage?.outputTokens ?? cur.outputTokens;
      }
      return null;
    }

    if (ev.type === "assistant/message" && data.usage) {
      const src = data.message?.source;
      const fb = this.fallbackBySid.get(sid) ?? { provider: "", model: "" };
      const provider = src?.provider ?? fb.provider ?? "";
      const model = src?.model ?? fb.model ?? "";
      if (src?.provider || src?.model) this.setFallback(sid, src?.provider, src?.model);
      const endTimeMs = ev.time ?? null;
      const outputTokens = data.usage.outputTokens ?? 0;

      const cur = key ? this.steps.get(key) : null;
      if (cur) cur.finalized = true;
      const startTimeMs = cur?.startTimeMs ?? null;
      // v3 logs keep the whole stream timeline inside the message; live/v1
      // chunks may already have marked the first token on the open step.
      const first = cur?.firstTokenMs ?? streamFirstToken(data.stream);
      let ttftMs: number | null = null;
      let decodeMs: number | null = null;
      if (first != null && startTimeMs != null) ttftMs = first - startTimeMs;
      if (first != null && endTimeMs != null) decodeMs = endTimeMs - first;
      const dayKey = toDayKey(startTimeMs ?? first ?? endTimeMs ?? Date.now());
      // One sample per step key, LAST write wins: legacy + vN rewrites of the
      // same history collapse here and the newest encoding (fed last) takes
      // over, so a step is never counted twice.
      const fk = key ?? `${sid}::msg:${ev.seq ?? Math.random()}`;
      const sample: HealthSample = {
        key: fk,
        sid,
        dayKey,
        provider,
        model: model || "unknown",
        ttftMs,
        decodeMs,
        outputTokens,
      };
      this.results.set(fk, sample);
      return sample;
    }
    return null;
  }

  private open(_sid: string, startTimeMs: number | null): OpenStep {
    if (this.steps.size > HealthTracker.MAX_OPEN_STEPS) {
      for (const k of this.steps.keys()) {
        if (!this.steps.get(k)!.finalized) continue;
        this.steps.delete(k);
        if (this.steps.size <= HealthTracker.MAX_OPEN_STEPS - 100) break;
      }
      if (this.steps.size > HealthTracker.MAX_OPEN_STEPS) {
        const first = this.steps.keys().next().value;
        if (first !== undefined) this.steps.delete(first);
      }
    }
    return { startTimeMs, firstTokenMs: null, endTimeMs: null, outputTokens: 0, provider: "", model: "", finalized: false };
  }

  private setFallback(sid: string, provider?: string, model?: string) {
    const cur = this.fallbackBySid.get(sid) ?? { provider: "", model: "" };
    if (provider) cur.provider = provider;
    if (model) cur.model = model;
    this.fallbackBySid.set(sid, cur);
  }
}

/**
 * Parse a batch of raw session events into finalized health samples,
 * collapsed one-per-step (duplicated history across log rewrites is safe).
 */
export function parseHealthSteps(events: SessionEvent[]): HealthSample[] {
  const tracker = new HealthTracker();
  for (const ev of events) tracker.feed(ev);
  return tracker.collected();
}

/**
 * Full history: scan `<DSH_HOME>/sessions` (every session, old + new) and merge
 * live in-memory events on top, deduping by `sid:seq`. ctx.sessions.list()
 * returns only LIVE sessions — historical sessions are NOT in it.
 */
export async function readAllHealthSamples(ctx: any): Promise<HealthSample[]> {
  const allEvents: SessionEvent[] = [];
  const seen = new Set<string>();
  const relevant = (o: any) =>
    o.type === "step/start" || o.type === "request/header" || o.type === "request/context" ||
    o.type === "assistant/chunk" || o.type === "assistant/message" ||
    o.type === "text-chunks" || o.type === "reasoning-chunks" || o.type === "tool-call-chunks";

  // Dedupe scope INCLUDES the source file: vN logs restart seq numbering, so a
  // plain sid:seq key would silently drop one file's events on collisions
  // (observed with token-pulse losing post-migration steps). Duplicate CONTENT
  // across files is collapsed later at step level (one sample per turn:step).
  const pushUnique = (sid: string, origin: string, o: any) => {
    if (typeof o?.seq === "number") {
      const key = `${origin}::${sid}:${o.seq}`;
      if (seen.has(key)) return;
      seen.add(key);
    }
    allEvents.push({ ...o, sid });
  };

  // 1) Full history: <DSH_HOME>/sessions
  try {
    const { readdirSync, existsSync, readFileSync } = await import("node:fs");
    const { join, basename, dirname } = await import("node:path");
    const dir = sessionsDir();
    if (existsSync(dir)) {
      // Collect session-log files per directory. ALL format versions are read
      // (vN rewrites may coexist with the legacy file and either side can hold
      // unique steps); per directory they are fed OLDEST format first so at
      // step collapse the NEWEST encoding wins (its embedded stream carries
      // the precise timings). .bak files never match the pattern.
      const byDir = new Map<string, Array<{ rank: number; path: string }>>();
      (function walk(d: string) {
        try {
          for (const entry of readdirSync(d, { withFileTypes: true })) {
            const p = join(d, entry.name);
            if (entry.isDirectory()) {
              walk(p);
              continue;
            }
            const rank = sessionFileRank(entry.name);
            if (rank < 0) continue;
            const list = byDir.get(d) ?? [];
            list.push({ rank, path: p });
            byDir.set(d, list);
          }
        } catch {}
      })(dir);
      const files: string[] = [];
      for (const list of byDir.values()) {
        list.sort((a, b) => a.rank - b.rank || (a.path < b.path ? -1 : 1));
        for (const f of list) files.push(f.path);
      }

      for (const f of files) {
        const sid = basename(dirname(f));
        try {
          let text: string;
          if (f.endsWith(".zstd")) {
            const decoded = await decodeSessionZstd(readFileSync(f));
            if (decoded !== null) {
              text = decoded;
            } else {
              const { execSync } = await import("node:child_process");
              text = execSync(`zstd -dc ${JSON.stringify(f)}`, { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 });
            }
          } else {
            text = readFileSync(f, "utf-8");
          }
          for (const line of text.split("\n")) {
            if (!line.trim()) continue;
            try {
              const obj = JSON.parse(line);
              if (relevant(obj)) pushUnique(sid, f, obj);
            } catch {}
          }
        } catch {}
      }
    }
  } catch {}

  // 2) Live sessions: events not yet flushed to disk (dedupe by sid:seq)
  try {
    if (ctx?.sessions?.list) {
      const sessions = await ctx.sessions.list();
      for (const s of sessions ?? []) {
        const sid = s?.id ?? "live";
        for (const event of (s as any)?.events ?? []) {
          if (relevant(event)) pushUnique(sid, "live", event);
        }
      }
    }
  } catch {}

  return parseHealthSteps(allEvents);
}

/** Live sessions only (cheap — no disk scan). Samples carry sid so the store
 *  can REPLACE a live session's samples instead of double counting. */
export async function readLiveHealthSamples(ctx: any): Promise<HealthSample[]> {
  const events: SessionEvent[] = [];
  const relevant = (o: any) =>
    o.type === "step/start" || o.type === "request/header" || o.type === "request/context" ||
    o.type === "assistant/chunk" || o.type === "assistant/message" ||
    o.type === "text-chunks" || o.type === "reasoning-chunks" || o.type === "tool-call-chunks";
  try {
    if (ctx?.sessions?.list) {
      const sessions = await ctx.sessions.list();
      for (const s of sessions ?? []) {
        const sid = s?.id ?? "live";
        for (const event of (s as any)?.events ?? []) {
          if (relevant(event)) events.push({ ...event, sid });
        }
      }
    }
  } catch {}
  return parseHealthSteps(events);
}
