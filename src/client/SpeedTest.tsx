import * as React from "react";
import { formatMs, formatSpeed } from "./trend.js";
import type { SpeedTestState } from "../types.js";

type KnownModel = { provider: string; model: string };

/** Speedtest-dialog styles (kept minimal — the progress ring is inline SVG). */
const SPEED_CSS = "";

/** Count-up for the TTFT chip (ease-out cubic). */
function useCountUp(target: number | null, run: boolean, dur = 800): number {
  const [v, setV] = React.useState(0);
  React.useEffect(() => {
    if (!run || target == null) {
      setV(0);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / dur);
      setV(target * (1 - Math.pow(1 - p, 3)));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, run, dur]);
  return v;
}

const ARC_R = 104;
const ARC_LEN = Math.PI * ARC_R;

/**
 * Phase 2 speed test as a speedtest-style modal: pick a known route, fire a
 * token-frugal counting prompt via the host llm service, and watch the big
 * tok/s number climb live on a semicircular gauge (the host streams interim
 * metrics per delta), then read TTFT + tokens. Entry button sits at the top
 * of the section; the dialog is closed by overlay click or ✕.
 */
export function SpeedTest({ t, isEn = false, open, onClose }: { t: (k: string, p?: any) => string; isEn?: boolean; open: boolean; onClose: () => void }) {
  const [models, setModels] = React.useState<KnownModel[]>([]);
  const [modelsLoading, setModelsLoading] = React.useState(true);
  /** true only after THIS dialog session started a run — otherwise a shown
   *  result is the previous test and must be labeled as such */
  const [ranHere, setRanHere] = React.useState(false);
  /** browser-clock start reference: server startedAt can be skewed/stale and
   *  made the timer read negative (and the progress ring run backwards) */
  const runStartRef = React.useRef(0);
  const [sel, setSel] = React.useState<string>("");
  const [st, setSt] = React.useState<SpeedTestState | null>(null);
  const [running, setRunning] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [elapsed, setElapsed] = React.useState(0);
  const alive = React.useRef(true);

  // load known routes + current state when the dialog opens
  React.useEffect(() => {
    if (!open) return;
    alive.current = true;
    (async () => {
      try {
        const res = await fetch("/api/dsh-model-health/speed-test", { cache: "no-store" });
        if (!res.ok) return;
        const j = await res.json();
        if (!alive.current) return;
        setModels(Array.isArray(j.models) ? j.models.filter((m: any) => m?.provider && m?.model) : []);
        setModelsLoading(!!j.modelsLoading);
        if (j.test) setSt(j.test);
        setSel((cur) => {
          if (cur) return cur;
          const first = (j.models ?? [])[0];
          return first ? `${first.provider}|${first.model}` : "";
        });
      } catch {}
    })();
    return () => {
      alive.current = false;
    };
  }, [open]);

  // reopening the dialog turns the last result back into "previous test"
  React.useEffect(() => {
    if (!open) setRanHere(false);
  }, [open]);

  // elapsed ticker while running — always relative to THIS dialog's click
  React.useEffect(() => {
    if (!open || !running) return;
    const timer = setInterval(() => setElapsed(Math.max(0, Date.now() - runStartRef.current)), 100);
    return () => clearInterval(timer);
  }, [open, running]);

  // group known models by provider (mirrors the session model picker)
  const groups = React.useMemo(() => {
    const m = new Map<string, KnownModel[]>();
    for (const km of models) {
      const key = km.provider || "—";
      const arr = m.get(key) ?? [];
      arr.push(km);
      m.set(key, arr);
    }
    return [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  }, [models]);

  const start = async () => {
    if (running || !sel) return;
    const [provider, model] = sel.split("|");
    setErr(null);
    setRunning(true);
    setRanHere(true);
    setElapsed(0);
    runStartRef.current = Date.now();
    try {
      const res = await fetch("/api/dsh-model-health/speed-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, model }),
      });
      const j = await res.json();
      if (!alive.current) return;
      setSt(j.test ?? null);
      if (!j.ok) {
        setRunning(false);
        setErr(j.error ?? "busy");
        return;
      }
      while (alive.current) {
        await new Promise((r) => setTimeout(r, 500));
        const p = await fetch("/api/dsh-model-health/speed-test", { cache: "no-store" });
        const pj = await p.json();
        if (!alive.current) return;
        setSt(pj.test ?? null);
        if (pj.test?.status !== "running") break;
      }
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      if (alive.current) setRunning(false);
    }
  };

  const done = st?.status === "done";
  const failed = st?.status === "error" || !!err;
  const live = st?.tokPerSec ?? null;
  const shown = done || running ? (live != null ? live : 0) : null;
  // adaptive gauge max: at least 150 tok/s, gently tracks the live value
  const gaugeMax = Math.max(150, Math.ceil(((live ?? 0) * 1.25) / 50) * 50);
  const progress = shown == null ? 0 : Math.min(1, shown / gaugeMax);
  // hooks MUST run before any conditional return (open flips changed the
  // hook count once and white-screened the whole panel)
  const ttftShown = useCountUp(st?.ttftMs ?? null, done || running);

  if (!open) return null;
  const selectStyle: React.CSSProperties = {
    padding: "6px 10px",
    fontSize: 13,
    borderRadius: 8,
    border: "1px solid var(--dsw-alias-border-l2)",
    background: "var(--dsw-alias-bg-layer-3)",
    color: "var(--dsw-alias-label-primary)",
    flex: 1,
    minWidth: 0,
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        background: "rgba(0,0,0,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("speed.title")}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--dsw-alias-bg-layer-3)",
          border: "1px solid var(--dsw-alias-border-l2)",
          borderRadius: 14,
          width: 560,
          maxWidth: "94vw",
          minHeight: 560,
          boxShadow: "0 12px 40px rgba(0,0,0,0.3)",
          padding: "24px 24px 18px",
          display: "flex",
          flexDirection: "column",
          justifyContent: "flex-start",
          gap: 14,
          userSelect: "none",
        }}
      >
        {/* header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 15, fontWeight: 600, color: "var(--dsw-alias-label-primary)" }}>
            ⚡ {t("speed.title")}
          </span>
          <button
            onClick={onClose}
            aria-label="close"
            style={{ border: "none", background: "transparent", fontSize: 16, cursor: "pointer", color: "var(--dsw-alias-label-tertiary)" }}
          >
            ✕
          </button>
        </div>

        {/* model picker on top, run button below (narrower, spaced, nudged down) */}
        <div style={{ display: "flex", flexDirection: "column", gap: 24, width: "80%", alignSelf: "center", marginTop: 8 }}>
          <select value={sel} onChange={(e) => setSel(e.target.value)} style={{ ...selectStyle, width: "100%" }} disabled={running}>
            {models.length === 0 ? <option value="">{modelsLoading ? t("speed.loading") : t("speed.empty")}</option> : null}
            {groups.map(([provider, list]) => (
              <optgroup key={provider} label={provider}>
                {list.map((m) => {
                  const label = m.model.startsWith(`${provider}/`) ? m.model.slice(provider.length + 1) : m.model;
                  return (
                    <option key={`${m.provider}|${m.model}`} value={`${m.provider}|${m.model}`}>
                      {label}
                    </option>
                  );
                })}
              </optgroup>
            ))}
          </select>
          <button
            onClick={() => void start()}
            disabled={running || !sel}
            style={{
              padding: "11px 18px",
              fontSize: 15,
              fontWeight: 600,
              borderRadius: 10,
              width: "100%",
              border: "1px solid var(--dsw-alias-border-l2)",
              background: running ? "var(--dsw-alias-bg-layer-2)" : "var(--dsw-alias-label-primary)",
              color: running ? "var(--dsw-alias-label-secondary)" : "var(--dsw-alias-bg-layer-3)",
              cursor: running ? "wait" : "pointer",
              whiteSpace: "nowrap",
            }}
          >
            {running ? `${t("speed.running")} ${(elapsed / 1000).toFixed(1)}s` : t("speed.run")}
          </button>
        </div>

        {/* gauge: big live/final tok/s on a semicircular arc */}
        <div style={{ display: "flex", justifyContent: "center", margin: "auto 0" }}>
          <div style={{ position: "relative", width: 340 }}>
            <svg viewBox="0 0 220 126" width="100%" style={{ display: "block" }}>
              <path
                d={`M ${110 - ARC_R} 116 A ${ARC_R} ${ARC_R} 0 0 1 ${110 + ARC_R} 116`}
                fill="none"
                stroke="var(--dsw-alias-border-l2)"
                strokeWidth={12}
                strokeLinecap="round"
              />
              <path
                d={`M ${110 - ARC_R} 116 A ${ARC_R} ${ARC_R} 0 0 1 ${110 + ARC_R} 116`}
                fill="none"
                stroke={failed ? "#e5534b" : done ? "#40c463" : "#4c8dff"}
                strokeWidth={12}
                strokeLinecap="round"
                strokeDasharray={ARC_LEN}
                strokeDashoffset={ARC_LEN * (1 - (running || done ? progress : 0))}
                style={{ transition: "stroke-dashoffset .6s ease, stroke .3s ease" }}
              />
            </svg>
            <div style={{ position: "absolute", left: 0, right: 0, bottom: 6, textAlign: "center" }}>
              <div
                style={{
                  fontSize: 48,
                  fontWeight: 700,
                  fontVariantNumeric: "tabular-nums",
                  color: "var(--dsw-alias-label-primary)",
                  lineHeight: 1,
                }}
              >
                {shown == null ? "—" : shown.toFixed(1)}
              </div>
              <div style={{ fontSize: 12, color: "var(--dsw-alias-label-tertiary)", marginTop: 4 }}>tok/s</div>
            </div>
            {running ? (
              <svg width={26} height={26} viewBox="0 0 26 26" style={{ position: "absolute", right: 12, top: 0 }} aria-hidden>
                <circle cx={13} cy={13} r={10} fill="none" stroke="var(--dsw-alias-border-l2)" strokeWidth={3} />
                <circle
                  cx={13}
                  cy={13}
                  r={10}
                  fill="none"
                  stroke="#4c8dff"
                  strokeWidth={3}
                  strokeLinecap="round"
                  strokeDasharray={2 * Math.PI * 10}
                  strokeDashoffset={2 * Math.PI * 10 * (1 - Math.max(0, Math.min(1, elapsed / 5500)))}
                  style={{ transition: "stroke-dashoffset .15s linear" }}
                />
              </svg>
            ) : null}
          </div>
        </div>

        {/* result block: previous-test label tight above the result chips */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "center" }}>
        {done && st && !ranHere ? (
          <div style={{ fontSize: 11, color: "var(--dsw-alias-label-tertiary)", textAlign: "center" }}>
            {isEn ? "Last test" : "上次测试"} · {st.model} · {new Date(st.startedAt ?? Date.now()).toLocaleString(isEn ? "en" : "zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" })}
          </div>
        ) : null}

        {/* status / result chips */}
        <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
          <span
            style={{
              fontSize: 12,
              padding: "4px 12px",
              borderRadius: 999,
              border: "1px solid var(--dsw-alias-border-l2)",
              color: "var(--dsw-alias-label-secondary)",
            }}
          >
            {t("speed.ttft")}: {st?.ttftMs != null ? formatMs(ttftShown) : "—"}
          </span>
          <span
            style={{
              fontSize: 12,
              padding: "4px 12px",
              borderRadius: 999,
              border: "1px solid var(--dsw-alias-border-l2)",
              color: "var(--dsw-alias-label-secondary)",
            }}
          >
            {t("speed.avg")}: {st?.tokPerSec != null ? formatSpeed(st.tokPerSec) : "—"}
          </span>
          <span
            style={{
              fontSize: 12,
              padding: "4px 12px",
              borderRadius: 999,
              border: "1px solid var(--dsw-alias-border-l2)",
              color: "var(--dsw-alias-label-secondary)",
            }}
          >
            {st?.model || "—"}
          </span>
        </div>
        </div>

        {failed ? (
          <div style={{ fontSize: 12, color: "#e5534b", textAlign: "center" }}>
            {t("speed.failed")}: {err ?? st?.error}
          </div>
        ) : null}

      </div>
    </div>
  );
}

export default SpeedTest;
