import { describe, it, expect } from "vitest";
import { parseHealthSteps } from "./session-reader.js";
import type { HealthSample } from "../types.js";

function ev(type: string, time: number, data: any, seq?: number) {
  return { type, time, seq, data };
}

const t0 = Date.UTC(2026, 7, 30, 8, 0, 0);

function stepLifecycle(overrides: {
  sid?: string;
  startTime?: number;
  reasoningAt?: number | null;
  whitespaceAt?: number | null;
  textAt?: number | null;
  usageAt?: number;
  usageOutput?: number;
  msgAt?: number;
  msgOutput?: number;
  provider?: string;
  model?: string;
}) {
  const sid = overrides.sid ?? "s1";
  const p = overrides.provider ?? "provA";
  const m = overrides.model ?? "modelA";
  const out: any[] = [
    ev("request/header", overrides.startTime ?? t0, { header: { config: { provider: p, model: m } } }),
    ev("step/start", overrides.startTime ?? t0, { turn: 1, step: 1 }),
  ];
  if (overrides.reasoningAt != null) out.push(ev("assistant/chunk", overrides.reasoningAt, { turn: 1, step: 1, chunk: { type: "reasoning-delta", index: 0, text: "思考" } }));
  if (overrides.whitespaceAt != null) out.push(ev("assistant/chunk", overrides.whitespaceAt, { turn: 1, step: 1, chunk: { type: "text-delta", index: 1, text: " " } }));
  if (overrides.textAt != null) out.push(ev("assistant/chunk", overrides.textAt, { turn: 1, step: 1, chunk: { type: "text-delta", index: 1, text: "你好" } }));
  if (overrides.usageAt != null) out.push(ev("assistant/chunk", overrides.usageAt, { turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: 10, outputTokens: overrides.usageOutput ?? 200 } } }));
  out.push(ev("assistant/message", overrides.msgAt ?? t0 + 2400, {
    turn: 1,
    step: 1,
    message: { source: { provider: p, model: m } },
    usage: { inputTokens: 10, outputTokens: overrides.msgOutput ?? overrides.usageOutput ?? 200 },
  }));
  return out.map((e) => ({ ...e, sid }));
}

describe("parseHealthSteps", () => {
  it("computes TTFT (first non-empty delta incl. reasoning) and decode speed window per step", () => {
    const events = stepLifecycle({
      startTime: t0,
      reasoningAt: t0 + 300,   // first non-empty delta — counts as first token
      whitespaceAt: t0 + 400,  // whitespace-only: ignored
      textAt: t0 + 500,
      usageAt: t0 + 2300,
      msgAt: t0 + 2400,
    });
    const out = parseHealthSteps(events);
    expect(out.length).toBe(1);
    const s = out[0];
    expect(s.model).toBe("modelA");
    expect(s.provider).toBe("provA");
    expect(s.ttftMs).toBe(300);      // firstToken(+300) - start
    expect(s.decodeMs).toBe(2100);   // msg(+2400) - firstToken(+300)
    expect(s.outputTokens).toBe(200);
  });

  it("whitespace-only deltas do not start the first-token clock", () => {
    const events = stepLifecycle({
      startTime: t0,
      whitespaceAt: t0 + 100,
      textAt: t0 + 500,
      msgAt: t0 + 1500,
    });
    const out = parseHealthSteps(events);
    expect(out[0].ttftMs).toBe(500); // from first real text, not the blank delta
    expect(out[0].decodeMs).toBe(1000);
  });

  it("emits ONE sample per step: assistant/message usage is authoritative over the usage chunk", () => {
    const events = stepLifecycle({
      startTime: t0,
      textAt: t0 + 300,
      usageAt: t0 + 2300,
      usageOutput: 200,
      msgAt: t0 + 2400,
      msgOutput: 250,
    });
    const out = parseHealthSteps(events);
    expect(out.length).toBe(1);
    expect(out[0].outputTokens).toBe(250); // message wins over provisional chunk
  });

  it("keys steps per session: two sessions with the same turn:step both count", () => {
    const a = stepLifecycle({ sid: "sa", startTime: t0, textAt: t0 + 300, msgAt: t0 + 1300 });
    const b = stepLifecycle({ sid: "sb", startTime: t0, textAt: t0 + 400, msgAt: t0 + 1400, model: "modelB" });
    const out = parseHealthSteps([...a, ...b]);
    expect(out.length).toBe(2);
    expect(out.map((s: HealthSample) => s.model).sort()).toEqual(["modelA", "modelB"]);
  });

  it("buckets the sample day by step START time in Asia/Shanghai", () => {
    // 23:59 Shanghai 08-30 = UTC 15:59; message lands after Shanghai midnight
    const start = Date.UTC(2026, 7, 30, 15, 59, 0);
    const events = stepLifecycle({
      startTime: start,
      textAt: start + 300,
      msgAt: Date.UTC(2026, 7, 30, 16, 30, 0), // 00:30 Shanghai 08-31
    });
    const out = parseHealthSteps(events);
    expect(out.length).toBe(1);
    expect(out[0].dayKey).toBe("2026-08-30"); // start-day, not end-day
  });

  it("a step without a first token still yields a sample with null ttft", () => {
    const events = stepLifecycle({ startTime: t0, textAt: null, reasoningAt: null, msgAt: t0 + 900 });
    const out = parseHealthSteps(events);
    expect(out.length).toBe(1);
    expect(out[0].ttftMs).toBeNull();
    expect(out[0].decodeMs).toBeNull();
  });

  it("batched *-chunks events mark first token at the first non-empty piece (time0 + dt gaps)", () => {
    // compacted logs carry batches: time0 = first piece, dt[i] = gap before piece i+1
    const events = [
      ev("step/start", t0, { turn: 1, step: 1 }),
      {
        type: "text-chunks",
        time0: t0 + 300,
        data: {
          turn: 1, step: 1, index: 1,
          dt: [10, 20],
          texts: ["  ", "\n", "你好"], // first two pieces are whitespace
        },
      },
      ev("assistant/message", t0 + 1300, {
        turn: 1, step: 1,
        message: { source: { provider: "p", model: "m" } },
        usage: { inputTokens: 5, outputTokens: 50 },
      }),
    ].map((e: any) => ({ ...e, sid: "s1" }));
    const out = parseHealthSteps(events);
    expect(out.length).toBe(1);
    // first non-empty piece is texts[2] at time0 + dt[0] + dt[1] = t0+330 → ttft 330
    expect(out[0].ttftMs).toBe(330);
  });

  it("tool-call output (tool-call-chunks / tool-call-delta) counts as first token", () => {
    const batched = [
      ev("step/start", t0, { turn: 1, step: 1 }),
      {
        type: "tool-call-chunks",
        time0: t0 + 250,
        data: { turn: 1, step: 1, index: 1, id: "call_1", name: "do", dt: [0], args: ["", "{"] },
      },
      ev("assistant/message", t0 + 1250, {
        turn: 1, step: 1,
        message: { source: { provider: "p", model: "m" } },
        usage: { inputTokens: 5, outputTokens: 30 },
      }),
    ].map((e: any) => ({ ...e, sid: "s1" }));
    const out1 = parseHealthSteps(batched);
    expect(out1.length).toBe(1);
    expect(out1[0].ttftMs).toBe(250); // tool-call batch starts at time0

    const raw = [
      ev("step/start", t0, { turn: 1, step: 1 }),
      ev("assistant/chunk", t0 + 400, { turn: 1, step: 1, chunk: { type: "tool-call-delta", index: 1, id: "call_2", name: "do", argumentsDelta: "" } }),
      ev("assistant/message", t0 + 1400, {
        turn: 1, step: 1,
        message: { source: { provider: "p", model: "m" } },
        usage: { inputTokens: 5, outputTokens: 30 },
      }),
    ].map((e: any) => ({ ...e, sid: "s2" }));
    const out2 = parseHealthSteps(raw);
    expect(out2.length).toBe(1);
    expect(out2[0].ttftMs).toBe(400);
  });
});

describe("v3 session logs (stream embedded in assistant/message)", () => {
  it("derives ttft/decode from message.data.stream (raw chunks + batched items)", () => {
    const stream = [
      { type: "text-chunks", time0: t0 + 400, index: 0, dt: [10, 20], texts: ["  ", "\n", "你好"] },
      { type: "chunk", time: t0 + 1900, chunk: { type: "usage", usage: { inputTokens: 5, outputTokens: 50 } } },
    ];
    const events = [
      ev("step/start", t0, { turn: 1, step: 1 }),
      ev("assistant/message", t0 + 2000, {
        turn: 1, step: 1,
        message: { source: { provider: "pN", model: "mN" } },
        usage: { inputTokens: 5, outputTokens: 50 },
        stream,
      }),
    ].map((e: any) => ({ ...e, sid: "sv3" }));
    const out = parseHealthSteps(events);
    expect(out.length).toBe(1);
    // first non-empty = texts[2] at time0 + 10 + 20 = t0+430
    expect(out[0].ttftMs).toBe(430);        // 430 - 0
    expect(out[0].decodeMs).toBe(1570);     // 2000 - 430
    expect(out[0].outputTokens).toBe(50);
    expect(out[0].model).toBe("mN");
  });

  it("raw tool-call-delta inside stream counts as first token; decode works even without step/start", () => {
    const stream = [
      { type: "chunk", time: t0 + 250, chunk: { type: "tool-call-delta", index: 1, id: "c1", name: "do", argumentsDelta: "" } },
    ];
    const events = [
      ev("assistant/message", t0 + 1250, {
        turn: 1, step: 1,
        message: { source: { provider: "pN", model: "mN" } },
        usage: { outputTokens: 30 },
        stream,
      }),
    ].map((e: any) => ({ ...e, sid: "sv3b" }));
    const out = parseHealthSteps(events);
    expect(out.length).toBe(1);
    expect(out[0].ttftMs).toBeNull();   // no step/start
    expect(out[0].decodeMs).toBe(1000); // 1250 - 250
  });
});

describe("session file discovery (read ALL versions, newest wins per step)", () => {
  it("collapses legacy+v3 duplicates, keeps each file's unique steps, and never drops v3 on seq collisions", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { zstdCompressSync } = await import("node:zlib");
    const home = mkdtempSync(join(tmpdir(), "mh-v3-"));
    const sid = "dual-file-sid";
    const dir = join(home, "sessions", "--ws--", sid);
    mkdirSync(dir, { recursive: true });
    // legacy log: step 1 (mL) AND a legacy-only step 9 (mL9); seq 1..8
    const legacy = [
      JSON.stringify({ type: "session", version: 0, id: sid, createdAt: 1 }),
      JSON.stringify({ ...ev("step/start", t0, { turn: 1, step: 1 }), seq: 1 }),
      JSON.stringify({ ...ev("assistant/message", t0 + 1000, {
        turn: 1, step: 1,
        message: { source: { provider: "pL", model: "mL" } },
        usage: { outputTokens: 10 },
      }), seq: 2 }),
      JSON.stringify({ ...ev("step/start", t0 + 5000, { turn: 1, step: 9 }), seq: 7 }),
      JSON.stringify({ ...ev("assistant/message", t0 + 6000, {
        turn: 1, step: 9,
        message: { source: { provider: "pL", model: "mL9" } },
        usage: { outputTokens: 9 },
      }), seq: 8 }),
    ].join("\n") + "\n";
    writeFileSync(join(dir, "session.jsonl.zstd"), zstdCompressSync(Buffer.from(legacy)));
    // v3 log: same step 1 (mN with stream) at COLLIDING seq 1..2, plus step 2 (mN2) at seq 3..4
    const v3 = [
      JSON.stringify({ type: "session", version: 3, id: sid, createdAt: 1 }),
      JSON.stringify({ ...ev("step/start", t0, { turn: 1, step: 1 }), seq: 1 }),
      JSON.stringify({ ...ev("assistant/message", t0 + 2000, {
        turn: 1, step: 1,
        message: { source: { provider: "pN", model: "mN" } },
        usage: { outputTokens: 50 },
        stream: [{ type: "chunk", time: t0 + 400, chunk: { type: "text-delta", index: 0, text: "hi" } }],
      }), seq: 2 }),
      JSON.stringify({ ...ev("step/start", t0 + 9000, { turn: 1, step: 2 }), seq: 3 }),
      JSON.stringify({ ...ev("assistant/message", t0 + 10000, {
        turn: 1, step: 2,
        message: { source: { provider: "pN", model: "mN2" } },
        usage: { outputTokens: 70 },
        stream: [{ type: "chunk", time: t0 + 9400, chunk: { type: "text-delta", index: 0, text: "yo" } }],
      }), seq: 4 }),
    ].join("\n") + "\n";
    writeFileSync(join(dir, "session.v3.jsonl.zstd"), zstdCompressSync(Buffer.from(v3)));

    const prev = process.env.DSH_HOME;
    process.env.DSH_HOME = home;
    try {
      const { readAllHealthSamples } = await import("./session-reader.js");
      const out = await readAllHealthSamples({ sessions: { list: async () => [] } } as any);
      const byModel = new Map(out.map((x: any) => [x.model, x]));
      // step 1 collapses to ONE sample and the newest (v3, stream-derived) wins
      expect(out.filter((x: any) => x.model === "mL").length).toBe(0);
      expect(byModel.get("mN")!.ttftMs).toBe(400);
      expect(byModel.get("mN")!.decodeMs).toBe(1600);
      // v3-only step survives despite seq numbers colliding with the legacy file
      expect(byModel.has("mN2")).toBe(true);
      // legacy-only step survives too (older file unique content is kept)
      expect(byModel.get("mL9")!.outputTokens).toBe(9);
      expect(out.length).toBe(3);
    } finally {
      if (prev === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = prev;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("accepts any future session.vN.jsonl[.zstd] name", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const home = mkdtempSync(join(tmpdir(), "mh-v4-"));
    const dir = join(home, "sessions", "--ws--", "future-sid");
    mkdirSync(dir, { recursive: true });
    const lines = [
      JSON.stringify({ type: "session", version: 4, id: "future-sid", createdAt: 1 }),
      JSON.stringify({ ...ev("step/start", t0, { turn: 1, step: 1 }), seq: 1 }),
      JSON.stringify({ ...ev("assistant/message", t0 + 800, {
        turn: 1, step: 1,
        message: { source: { provider: "pF", model: "mF" } },
        usage: { outputTokens: 5 },
        stream: [{ type: "chunk", time: t0 + 100, chunk: { type: "text-delta", index: 0, text: "f" } }],
      }), seq: 2 }),
    ].join("\n") + "\n";
    writeFileSync(join(dir, "session.v4.jsonl"), lines); // plain jsonl, future version
    const prev = process.env.DSH_HOME;
    process.env.DSH_HOME = home;
    try {
      const { readAllHealthSamples } = await import("./session-reader.js");
      const out = await readAllHealthSamples({ sessions: { list: async () => [] } } as any);
      expect(out.length).toBe(1);
      expect(out[0].model).toBe("mF");
      expect(out[0].ttftMs).toBe(100);
    } finally {
      if (prev === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = prev;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
