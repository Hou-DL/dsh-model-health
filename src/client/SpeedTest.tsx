import * as React from "react";
import { formatMs } from "./trend.js";
import type { SpeedTestState } from "../types.js";

type KnownModel = { provider: string; model: string };

/** Speedtest-dialog styles: pulsing probe dot, indeterminate ring spin. */
const SPEED_CSS = `
@keyframes mhc-pulse { 0%, 100% { opacity: .25; transform: scale(.8); } 50% { opacity: 1; transform: scale(1.2); } }
@keyframes mhc-spin { to { transform: rotate(360deg); } }
.mhc-pulse { animation: mhc-pulse 1s ease-in-out infinite; }
.mhc-spin { animation: mhc-spin 1.1s linear infinite; transform-origin: 50% 50%; }
`;

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
        setModels(Array.isArray(j.models) ? j.models : []);
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

  // elapsed ticker while running
  React.useEffect(() => {
    if (!open || !running) return;
    const startedAt = st?.startedAt ?? Date.now();
    const timer = setInterval(() => setElapsed(Date.now() - startedAt), 100);
    return () => clearInterval(timer);
  }, [open, running, st?.startedAt]);

  const start = async () => {
    if (running || !sel) return;
    const [provider, model] = sel.split("|");
    setErr(null);
    setRunning(true);
    setElapsed(0);
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
          width: 760,
          maxWidth: "94vw",
          boxShadow: "0 12px 40px rgba(0,0,0,0.3)",
          padding: 20,
          display: "flex",
          flexDirection: "column",
          gap: 14,
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

        {/* picker + run */}
        <div style={{ display: "flex", gap: 8 }}>
          <select value={sel} onChange={(e) => setSel(e.target.value)} style={selectStyle} disabled={running}>
            {models.length === 0 ? <option value="">{t("speed.empty")}</option> : null}
            {models.map((m) => (
              <option key={`${m.provider}|${m.model}`} value={`${m.provider}|${m.model}`}>
                {m.model}
              </option>
            ))}
          </select>
          <button
            onClick={() => void start()}
            disabled={running || !sel}
            style={{
              padding: "6px 18px",
              fontSize: 13,
              borderRadius: 8,
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
        <div style={{ display: "flex", justifyContent: "center", paddingTop: 4 }}>
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
              {running ? (
                <circle cx={110} cy={116} r={5} fill="#4c8dff" className="mhc-pulse" />
              ) : null}
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
              <span
                className="mhc-spin"
                style={{
                  position: "absolute",
                  right: 18,
                  top: 4,
                  width: 14,
                  height: 14,
                  border: "2px solid var(--dsw-alias-border-l2)",
                  borderTopColor: "#4c8dff",
                  borderRadius: "50%",
                  display: "inline-block",
                }}
              />
            ) : null}
          </div>
        </div>

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
            {isEn ? "Output" : "输出"}: {st?.outputTokens ?? 0} tok
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

        {failed ? (
          <div style={{ fontSize: 12, color: "#e5534b", textAlign: "center" }}>
            {t("speed.failed")}: {err ?? st?.error}
          </div>
        ) : null}

        <div style={{ fontSize: 11, color: "var(--dsw-alias-label-tertiary)", textAlign: "center" }}>{t("speed.hint")}</div>
      </div>
    </div>
  );
}

export default SpeedTest;
