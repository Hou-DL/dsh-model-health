import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
//#region src/date-bucket.ts
const TZ = "Asia/Shanghai";
function toDayKey(ms, tz = TZ) {
	return new Intl.DateTimeFormat("en-CA", {
		timeZone: tz,
		year: "numeric",
		month: "2-digit",
		day: "2-digit"
	}).format(new Date(ms));
}
//#endregion
//#region src/host/dsh-home.ts
/**
* Resolve the DSH home directory. A machine may run several independent DSH
* installs side by side; the active one advertises itself via `$DSH_HOME`, so
* every path this plugin touches derives from it. Fallback `~/.dsh` only when
* the variable is absent (mirrors core).
*/
function dshHome() {
	const env = process.env.DSH_HOME?.trim();
	if (env) return env;
	return join(homedir(), ".dsh");
}
function sessionsDir() {
	return join(dshHome(), "sessions");
}
//#endregion
//#region src/host/session-reader.ts
/** zstd frame magic: bytes 28 B5 2F FD, read as UInt32LE. */
const ZSTD_MAGIC = 4247762216;
/**
* Locate complete zstd frames inside a concatenated-frame container (DSH's
* session.jsonl.zstd format: every appended batch is its own compressed
* frame). Node's one-shot decompress reads only frame 1, so callers decode
* each frame separately. Mirrors dsh-session-persistence-jsonl's scanZstdFrames.
*/
function scanZstdFrames(buffer) {
	const frames = [];
	let offset = 0;
	while (offset < buffer.length) {
		const start = offset;
		if (buffer.length - offset < 4) break;
		if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) break;
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
		const contentSizeBytes = contentSizeFlag === 0 ? singleSegment ? 1 : 0 : 1 << contentSizeFlag;
		const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
		if (buffer.length - offset < remainingHeaderBytes) break;
		offset += remainingHeaderBytes;
		for (;;) {
			if (buffer.length - offset < 3) break;
			const blockHeader = buffer.readUIntLE(offset, 3);
			offset += 3;
			const lastBlock = (blockHeader & 1) !== 0;
			const blockType = blockHeader >>> 1 & 3;
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
		frames.push({
			start,
			end: offset
		});
	}
	return frames;
}
/** Decode a concatenated-frame zstd log to full UTF-8 text; null on failure. */
async function decodeSessionZstd(buffer) {
	const zlib = await import("node:zlib");
	if (typeof zlib.zstdDecompressSync !== "function") return null;
	const frames = scanZstdFrames(buffer);
	if (frames.length === 0) return null;
	const parts = [];
	for (const { start, end } of frames) try {
		parts.push(zlib.zstdDecompressSync(buffer.subarray(start, end)).toString("utf-8"));
	} catch {
		return null;
	}
	return parts.join("");
}
/**
* Timestamp of the first non-empty piece in a batched "*-chunks" event:
* `time0` is piece 0's time and `dt[i]` is the gap between piece i and i+1.
* Whitespace-only pieces do not count as output (matches dsh-session-stats'
* "first non-empty delta chunk").
*/
function firstNonEmptyTime(time0, dt, pieces) {
	if (!Array.isArray(pieces)) return null;
	const gaps = Array.isArray(dt) ? dt : [];
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
function streamFirstToken(stream) {
	if (!Array.isArray(stream)) return null;
	for (const raw of stream) {
		if (!raw || typeof raw !== "object") continue;
		const c = raw.chunk;
		if (c && (c.type === "text-delta" || c.type === "reasoning-delta")) {
			if (typeof c.text === "string" && c.text.trim() !== "" && typeof raw.time === "number") return raw.time;
		} else if (c && c.type === "tool-call-delta") {
			if (typeof raw.time === "number") return raw.time;
		} else if (!c && (raw.type === "text-chunks" || raw.type === "reasoning-chunks" || raw.type === "tool-call-chunks")) {
			const src = raw.data ?? raw;
			const pieces = raw.type === "tool-call-chunks" ? src.args : src.texts;
			const t = firstNonEmptyTime(typeof raw.time0 === "number" ? raw.time0 : typeof raw.time === "number" ? raw.time : 0, src.dt, pieces);
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
function sessionFileRank(name) {
	const m = /^session(?:\.v(\d+))?\.jsonl(?:\.zstd)?$/.exec(name);
	if (!m) return -1;
	return m[1] ? Number(m[1]) : 0;
}
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
var HealthTracker = class HealthTracker {
	fallbackBySid = /* @__PURE__ */ new Map();
	steps = /* @__PURE__ */ new Map();
	results = /* @__PURE__ */ new Map();
	static MAX_OPEN_STEPS = 5e3;
	/** Finalized samples collapsed by step key (one per step, newest wins). */
	collected() {
		return [...this.results.values()];
	}
	feed(ev) {
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
		const key = typeof turn === "number" && typeof step === "number" ? `${sid}::${turn}:${step}` : null;
		if (ev.type === "step/start" && key) {
			const cur = this.steps.get(key);
			if (!cur) this.steps.set(key, this.open(sid, ev.time ?? null));
			else if (cur.startTimeMs == null) cur.startTimeMs = ev.time ?? null;
			return null;
		}
		if (ev.type === "assistant/chunk" && (data.chunk?.type === "text-delta" || data.chunk?.type === "reasoning-delta")) {
			const cur = key ? this.steps.get(key) ?? this.steps.set(key, this.open(sid, null)).get(key) : null;
			if (cur && cur.firstTokenMs == null && typeof data.chunk.text === "string" && data.chunk.text.trim() !== "") cur.firstTokenMs = ev.time ?? null;
			return null;
		}
		if (ev.type === "text-chunks" || ev.type === "reasoning-chunks" || ev.type === "tool-call-chunks") {
			const cur = key ? this.steps.get(key) ?? this.steps.set(key, this.open(sid, null)).get(key) : null;
			if (cur && cur.firstTokenMs == null) {
				const pieces = ev.type === "tool-call-chunks" ? data.args : data.texts;
				const t = firstNonEmptyTime(ev.time0 ?? ev.time ?? 0, data.dt, pieces);
				if (t != null) cur.firstTokenMs = t;
			}
			return null;
		}
		if (ev.type === "assistant/chunk" && data.chunk?.type === "tool-call-delta") {
			const cur = key ? this.steps.get(key) ?? this.steps.set(key, this.open(sid, null)).get(key) : null;
			if (cur && cur.firstTokenMs == null) cur.firstTokenMs = ev.time ?? null;
			return null;
		}
		if (ev.type === "assistant/chunk" && data.chunk?.type === "usage") {
			const cur = key ? this.steps.get(key) ?? this.steps.set(key, this.open(sid, null)).get(key) : null;
			if (cur && !cur.finalized) {
				cur.endTimeMs = ev.time ?? cur.endTimeMs;
				cur.outputTokens = data.chunk.usage?.outputTokens ?? cur.outputTokens;
			}
			return null;
		}
		if (ev.type === "assistant/message" && data.usage) {
			const src = data.message?.source;
			const fb = this.fallbackBySid.get(sid) ?? {
				provider: "",
				model: ""
			};
			const provider = src?.provider ?? fb.provider ?? "";
			const model = src?.model ?? fb.model ?? "";
			if (src?.provider || src?.model) this.setFallback(sid, src?.provider, src?.model);
			const endTimeMs = ev.time ?? null;
			const outputTokens = data.usage.outputTokens ?? 0;
			const cur = key ? this.steps.get(key) : null;
			if (cur) cur.finalized = true;
			const startTimeMs = cur?.startTimeMs ?? null;
			const first = cur?.firstTokenMs ?? streamFirstToken(data.stream);
			let ttftMs = null;
			let decodeMs = null;
			if (first != null && startTimeMs != null) ttftMs = first - startTimeMs;
			if (first != null && endTimeMs != null) decodeMs = endTimeMs - first;
			const dayKey = toDayKey(startTimeMs ?? first ?? endTimeMs ?? Date.now());
			const fk = key ?? `${sid}::msg:${ev.seq ?? Math.random()}`;
			const sample = {
				key: fk,
				sid,
				dayKey,
				provider,
				model: model || "unknown",
				ttftMs,
				decodeMs,
				outputTokens
			};
			this.results.set(fk, sample);
			return sample;
		}
		return null;
	}
	open(_sid, startTimeMs) {
		if (this.steps.size > HealthTracker.MAX_OPEN_STEPS) {
			for (const k of this.steps.keys()) {
				if (!this.steps.get(k).finalized) continue;
				this.steps.delete(k);
				if (this.steps.size <= HealthTracker.MAX_OPEN_STEPS - 100) break;
			}
			if (this.steps.size > HealthTracker.MAX_OPEN_STEPS) {
				const first = this.steps.keys().next().value;
				if (first !== void 0) this.steps.delete(first);
			}
		}
		return {
			startTimeMs,
			firstTokenMs: null,
			endTimeMs: null,
			outputTokens: 0,
			provider: "",
			model: "",
			finalized: false
		};
	}
	setFallback(sid, provider, model) {
		const cur = this.fallbackBySid.get(sid) ?? {
			provider: "",
			model: ""
		};
		if (provider) cur.provider = provider;
		if (model) cur.model = model;
		this.fallbackBySid.set(sid, cur);
	}
};
/**
* Parse a batch of raw session events into finalized health samples,
* collapsed one-per-step (duplicated history across log rewrites is safe).
*/
function parseHealthSteps(events) {
	const tracker = new HealthTracker();
	for (const ev of events) tracker.feed(ev);
	return tracker.collected();
}
/**
* Full history: scan `<DSH_HOME>/sessions` (every session, old + new) and merge
* live in-memory events on top, deduping by `sid:seq`. ctx.sessions.list()
* returns only LIVE sessions — historical sessions are NOT in it.
*/
async function readAllHealthSamples(ctx) {
	const allEvents = [];
	const seen = /* @__PURE__ */ new Set();
	const relevant = (o) => o.type === "step/start" || o.type === "request/header" || o.type === "request/context" || o.type === "assistant/chunk" || o.type === "assistant/message" || o.type === "text-chunks" || o.type === "reasoning-chunks" || o.type === "tool-call-chunks";
	const pushUnique = (sid, origin, o) => {
		if (typeof o?.seq === "number") {
			const key = `${origin}::${sid}:${o.seq}`;
			if (seen.has(key)) return;
			seen.add(key);
		}
		allEvents.push({
			...o,
			sid
		});
	};
	try {
		const { readdirSync, existsSync, readFileSync } = await import("node:fs");
		const { join, basename, dirname } = await import("node:path");
		const dir = sessionsDir();
		if (existsSync(dir)) {
			const byDir = /* @__PURE__ */ new Map();
			(function walk(d) {
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
						list.push({
							rank,
							path: p
						});
						byDir.set(d, list);
					}
				} catch {}
			})(dir);
			const files = [];
			for (const list of byDir.values()) {
				list.sort((a, b) => a.rank - b.rank || (a.path < b.path ? -1 : 1));
				for (const f of list) files.push(f.path);
			}
			for (const f of files) {
				const sid = basename(dirname(f));
				try {
					let text;
					if (f.endsWith(".zstd")) {
						const decoded = await decodeSessionZstd(readFileSync(f));
						if (decoded !== null) text = decoded;
						else {
							const { execSync } = await import("node:child_process");
							text = execSync(`zstd -dc ${JSON.stringify(f)}`, {
								encoding: "utf-8",
								maxBuffer: 52428800
							});
						}
					} else text = readFileSync(f, "utf-8");
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
	try {
		if (ctx?.sessions?.list) {
			const sessions = await ctx.sessions.list();
			for (const s of sessions ?? []) {
				const sid = s?.id ?? "live";
				for (const event of s?.events ?? []) if (relevant(event)) pushUnique(sid, "live", event);
			}
		}
	} catch {}
	return parseHealthSteps(allEvents);
}
/** Live sessions only (cheap — no disk scan). Samples carry sid so the store
*  can REPLACE a live session's samples instead of double counting. */
async function readLiveHealthSamples(ctx) {
	const events = [];
	const relevant = (o) => o.type === "step/start" || o.type === "request/header" || o.type === "request/context" || o.type === "assistant/chunk" || o.type === "assistant/message" || o.type === "text-chunks" || o.type === "reasoning-chunks" || o.type === "tool-call-chunks";
	try {
		if (ctx?.sessions?.list) {
			const sessions = await ctx.sessions.list();
			for (const s of sessions ?? []) {
				const sid = s?.id ?? "live";
				for (const event of s?.events ?? []) if (relevant(event)) events.push({
					...event,
					sid
				});
			}
		}
	} catch {}
	return parseHealthSteps(events);
}
//#endregion
//#region src/host/persist.ts
function persistPath() {
	return join(dshHome(), "storages", "dsh-model-health", "health.json");
}
function emptyHealth(model) {
	return {
		model,
		ttftSumMs: 0,
		ttftCount: 0,
		decodeMsSum: 0,
		decodeTokensSum: 0,
		steps: 0
	};
}
/** Per model per field: MAX merge. Persisted is cumulative truth that never
*  shrinks, so deleting sessions keeps history while new steps still grow. */
function mergeDayHealth(persisted, live) {
	const result = /* @__PURE__ */ new Map();
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
			steps: Math.max(p.steps, l.steps)
		});
	}
	return result;
}
/** Merge whole day maps with per-day max semantics. */
function mergeDays(persisted, live) {
	const result = /* @__PURE__ */ new Map();
	for (const [day, dh] of persisted) result.set(day, new Map([...dh].map(([k, v]) => [k, { ...v }])));
	for (const [day, liveDh] of live) result.set(day, mergeDayHealth(result.get(day) ?? /* @__PURE__ */ new Map(), liveDh));
	return result;
}
/** Aggregate raw samples into day -> model counters. */
function aggregateSamples(samples) {
	const days = /* @__PURE__ */ new Map();
	for (const s of samples) {
		if (!s.model) continue;
		let dh = days.get(s.dayKey);
		if (!dh) {
			dh = /* @__PURE__ */ new Map();
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
function loadPersisted() {
	try {
		const p = persistPath();
		if (!existsSync(p)) return /* @__PURE__ */ new Map();
		const parsed = JSON.parse(readFileSync(p, "utf-8"));
		if (!parsed || typeof parsed.days !== "object") return /* @__PURE__ */ new Map();
		const out = /* @__PURE__ */ new Map();
		for (const [day, models] of Object.entries(parsed.days)) {
			const dh = /* @__PURE__ */ new Map();
			for (const [model, h] of Object.entries(models ?? {})) dh.set(model, {
				...emptyHealth(model),
				...h,
				model
			});
			out.set(day, dh);
		}
		return out;
	} catch {
		return /* @__PURE__ */ new Map();
	}
}
function savePersisted(days) {
	try {
		const out = {
			version: 1,
			days: Object.fromEntries([...days.entries()].map(([day, dh]) => [day, Object.fromEntries(dh)]))
		};
		const json = JSON.stringify(out, null, 2);
		const p = persistPath();
		mkdirSync(dirname(p), { recursive: true });
		const tmp = p + ".tmp";
		writeFileSync(tmp, json, "utf-8");
		renameSync(tmp, p);
	} catch {}
}
//#endregion
//#region src/host/store.ts
var HealthStore = class HealthStore {
	samples = [];
	persisted = /* @__PURE__ */ new Map();
	tracker = new HealthTracker();
	ctx;
	/** True after init() finished scanning disk; API reports it as `ready` so
	*  the client keeps retrying instead of caching a partial snapshot. */
	initialized = false;
	cachedDays = null;
	cachedAt = 0;
	static CACHE_TTL_MS = 3e4;
	constructor(ctx) {
		this.ctx = ctx;
	}
	async init() {
		this.persisted = loadPersisted();
		const samples = await readAllHealthSamples(this.ctx);
		this.samples = samples;
		this.rebuild();
		this.initialized = true;
	}
	/** Refresh from LIVE sessions only (the full disk scan happens once at init).
	*  A live session's snapshot is complete, so REPLACE its samples in place —
	*  samples of sessions no longer live are kept as-is from init(). */
	async refresh() {
		try {
			const live = await readLiveHealthSamples(this.ctx);
			const liveSids = new Set(live.map((s) => s.sid));
			this.samples = [...this.samples.filter((s) => !liveSids.has(s.sid)), ...live];
			this.rebuild();
		} catch (e) {
			this.ctx?.logger?.warn?.(`dsh-model-health refresh failed: ${String(e)}`);
		}
	}
	rebuild() {
		this.invalidateCache();
		const liveDays = aggregateSamples(this.samples);
		const prev = this.persisted;
		const merged = mergeDays(prev, liveDays);
		this.persisted = merged;
		if (grew(prev, merged)) savePersisted(merged);
	}
	/** Incremental ingest from `session/event`. Emits one sample when an
	*  assistant/message finalizes a tracked step. */
	ingest(event) {
		const sample = this.tracker.feed(event);
		if (!sample) return;
		const i = this.samples.findIndex((s) => s.key === sample.key);
		if (i >= 0) this.samples[i] = sample;
		else this.samples.push(sample);
		this.persisted = mergeDays(this.persisted, aggregateSamples([sample]));
		savePersisted(this.persisted);
		this.invalidateCache();
	}
	isReady() {
		return this.initialized;
	}
	getDays() {
		if (!this.initialized) return /* @__PURE__ */ new Map();
		const now = Date.now();
		if (this.cachedDays && now - this.cachedAt < HealthStore.CACHE_TTL_MS) return this.cachedDays;
		this.cachedDays = mergeDays(this.persisted, aggregateSamples(this.samples));
		this.cachedAt = now;
		return this.cachedDays;
	}
	invalidateCache() {
		this.cachedDays = null;
		this.cachedAt = 0;
	}
	dispose() {}
};
/** True when any model's counters grew (only then a persist write is needed). */
function grew(prev, next) {
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
//#endregion
//#region src/index.ts
const name = "dsh-model-health";
const inject = ["sessions"];
function apply(ctx) {
	const store = new HealthStore(ctx);
	ctx.provide("modelHealthStore", store);
	store.init().catch((e) => {
		ctx.logger?.warn?.(`dsh-model-health init failed: ${String(e)}`);
	});
	ctx.on("session/event", (session, event) => {
		store.ingest({
			...event,
			sid: session?.id ?? ""
		});
	});
	let unregisterRoute = null;
	ctx.inject(["webServer"], (wsCtx) => {
		try {
			const handler = (_req, res) => {
				try {
					const days = store.getDays();
					const body = JSON.stringify({
						version: 1,
						ready: store.isReady(),
						days: [...days.entries()].map(([dayKey, models]) => ({
							dayKey,
							models: Object.fromEntries(models)
						}))
					});
					res.writeHead(200, {
						"Content-Type": "application/json",
						"Cache-Control": "no-store"
					});
					res.end(body);
				} catch (e) {
					res.writeHead(500, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: String(e) }));
				}
			};
			unregisterRoute = wsCtx.webServer.register({
				kind: "exact",
				path: "/api/dsh-model-health/health.json",
				handler
			});
			ctx.logger.info("dsh-model-health: registered /api/dsh-model-health/health.json");
		} catch (e) {
			ctx.logger?.warn?.(`dsh-model-health route register failed: ${String(e)}`);
		}
	});
	ctx.effect(() => () => {
		store.dispose();
		if (unregisterRoute) try {
			unregisterRoute();
		} catch {}
	}, "dsh-model-health.dispose");
	ctx.logger.info("dsh-model-health host up");
}
//#endregion
export { apply, inject, name };

//# sourceMappingURL=index.mjs.map