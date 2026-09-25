import * as React from "react";
import { formatMs } from "./trend.js";

type TestState = {
  status: "idle" | "running" | "done" | "error";
  provider: string;
  model: string;
  startedAt: number | null;
  ttftMs: number | null;
  decodeMs: number | null;
  outputTokens: number;
  tokPerSec: number | null;
  error: string | null;
};

type KnownModel = { provider: string; model: string };

/** Pulse + shimmer styles for the running state (scoped keyframe names). */
const SPEED_CSS = `
@keyframes mhc-pulse { 0%, 100% { opacity: .25; transform: scale(.8); } 50% { opacity: 1; transform: scale(1.2); } }
@keyframes mhc-shimmer { from { background-position: -320px 0; } to { background-position: 320px 0; } }
.mhc-pulse { animation: mhc-pulse 1s ease-in-out infinite; }
.mhc-shimmer {
  background: linear-gradient(90deg, var(--dsw-alias-border-l2) 25%, var(--dsw-alias-label-tertiary) 50%, var(--dsw-alias-border-l2) 75%);
  background-size: 320px 100%;
  animation: mhc-shimmer 1.1s linear infinite;
}
`;

/** Count-up animation for result numbers (ease-out cubic). */
function useCountUp(target: number | null, run: boolean, dur = 900): number {
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
      const eased = 1 - Math.pow(1 - p, 3);
      setV(target * eased);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, run, dur]);
  return v;
}

/**
 * Phase 2 speed test: pick a known provider/model route, fire a token-frugal
 * counting prompt through the host llm service, and show TTFT + output speed
 * with a pulsing/shimmer running state and count-up result tiles.
 */
export function SpeedTest({ t, isEn = false }: { t: (k: string, p?: any) => string; isEn?: boolean }) {
  const [models, setModels] = React.useState<KnownModel[]>([]);
  const [sel, setSel] = React.useState<string>("");
  const [st, setSt] = React.useState<TestState | null>(null);
  const [running, setRunning] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [elapsed, setElapsed] = React.useState(0);
  const alive = React.useRef(true);

  React.useEffect(() => {
    alive.current = true;
    (async () => {
      try {
        const res = await fetch("/api/dsh-model-health/speed-test", { cache: "no-store" });
        if (!res.ok) return;
        const j = await res.json();
        if (!alive.current) return;
        setModels(Array.isArray(j.models) ? j.models : []);
        if (j.test) setSt(j.test);
        const first = (j.models ?? [])[0];
        if (first) setSel(`${first.provider}|${first.model}`);
      } catch {}
    })();
    return () => {
      alive.current = false;
    };
  }, []);

  // elapsed ticker while running
  React.useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      const startedAt = st?.startedAt ?? Date.now();
      setElapsed(Date.now() - startedAt);
    }, 100);
    return () => clearInterval(timer);
  }, [running, st?.startedAt]);

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
      // poll until the probe settles
      while (alive.current) {
        await new Promise((r) => setTimeout(r, 600));
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
  const speedShown = useCountUp(st?.tokPerSec ?? null, done);
  const ttftShown = useCountUp(st?.ttftMs ?? null, done);
  const speedBar = Math.min(100, ((st?.tokPerSec ?? 0) / Math.max(100, st?.tokPerSec ?? 100)) * 100);
  const ttftBar = Math.min(100, ((st?.ttftMs ?? 0) / Math.max(2000, st?.ttftMs ?? 2000)) * 100);

  const tile = (label: string, value: string, barPct: number, color: string) => (
    <div
      style={{
        flex: 1,
        minWidth: 150,
        border: "1px solid var(--dsw-alias-border-l2)",
        borderRadius: 10,
        padding: "10px 12px",
        background: "var(--dsw-alias-bg-layer-2)",
      }}
    >
      <div style={{ fontSize: 11, color: "var(--dsw-alias-label-tertiary)", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 600, fontVariantNumeric: "tabular-nums", color: "var(--dsw-alias-label-primary)", lineHeight: 1.2 }}>
        {value}
      </div>
      <div style={{ marginTop: 8, height: 6, borderRadius: 3, background: "var(--dsw-alias-border-l2)", overflow: "hidden" }}>
        <div
          style={{
            width: `${barPct}%`,
            height: "100%",
            borderRadius: 3,
            background: color,
            transition: "width .9s cubic-bezier(.22,1,.36,1)",
          }}
        />
      </div>
    </div>
  );

  const selectStyle: React.CSSProperties = {
    padding: "5px 8px",
    fontSize: 13,
    borderRadius: 6,
    border: "1px solid var(--dsw-alias-border-l2)",
    background: "var(--dsw-alias-bg-layer-3)",
    color: "var(--dsw-alias-label-primary)",
    maxWidth: 320,
  };

  return (
    <div
      style={{
        border: "1px solid var(--dsw-alias-border-l2)",
        background: "var(--dsw-alias-bg-layer-3)",
        borderRadius: 12,
        overflow: "hidden",
      }}
    >
      <style>{SPEED_CSS}</style>
      <div
        style={{
          padding: "12px 16px 8px",
          borderBottom: "1px solid var(--dsw-alias-border-l2)",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-label-primary)" }}>{t("speed.title")}</span>
        <span style={{ fontSize: 12, color: "var(--dsw-alias-label-tertiary)" }}>{t("speed.hint")}</span>
      </div>

      <div style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
        {/* picker + run button */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <select value={sel} onChange={(e) => setSel(e.target.value)} style={selectStyle} title={sel.split("|")[1] ?? sel}>
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
              padding: "6px 16px",
              fontSize: 13,
              borderRadius: 8,
              border: "1px solid var(--dsw-alias-border-l2)",
              background: running ? "var(--dsw-alias-bg-layer-2)" : "var(--dsw-alias-bg-layer-3)",
              color: "var(--dsw-alias-label-primary)",
              cursor: running ? "wait" : "pointer",
            }}
          >
            {running ? `${t("speed.running")} ${(elapsed / 1000).toFixed(1)}s` : t("speed.run")}
          </button>
          {running ? (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--dsw-alias-label-secondary)" }}>
              <span className="mhc-pulse" style={{ width: 10, height: 10, borderRadius: 5, background: "#40c463", display: "inline-block" }} />
              <span
                className="mhc-shimmer"
                style={{ width: 140, height: 6, borderRadius: 3, display: "inline-block" }}
              />
            </span>
          ) : null}
        </div>

        {/* results */}
        {done ? (
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            {tile(t("speed.output"), `${speedShown.toFixed(1)} tok/s`, speedBar, "#40c463")}
            {tile(t("speed.ttft"), formatMs(ttftShown), ttftBar, "#4c8dff")}
          </div>
        ) : null}
        {done && st ? (
          <div style={{ fontSize: 11, color: "var(--dsw-alias-label-tertiary)", marginTop: -6 }}>
            {isEn
              ? `${st.model} · ${st.outputTokens} tok out · window ${(st.decodeMs! / 1000).toFixed(2)}s`
              : `${st.model} · 输出 ${st.outputTokens} tok · 计时窗口 ${(st.decodeMs! / 1000).toFixed(2)}s`}
          </div>
        ) : null}

        {st?.status === "error" || err ? (
          <div style={{ fontSize: 12, color: "#e5534b" }}>
            {t("speed.failed")}: {err ?? st?.error}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default SpeedTest;
