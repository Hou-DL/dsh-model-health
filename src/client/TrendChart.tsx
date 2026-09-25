import * as React from "react";
import type { DayHealth } from "../types.js";
import { toDayKey } from "../date-bucket.ts";
import { recentDayKeys, pickTrendModels, buildSeries, splitSeries, seriesPathFixed, formatMetric, shortModel, type Metric } from "./trend.js";

/** Distinct, colorblind-tolerant series colors. */
const COLORS = [
  "#40c463", "#4c8dff", "#f6a609", "#c956e0", "#ff7a59",
  "#26c6da", "#ff5c8a", "#9ccc65", "#7e57c2", "#ffd54f",
];

/** Round a max up to a friendly axis ceiling. */
function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const unit = Math.pow(10, Math.floor(Math.log10(v))) / 2;
  return Math.ceil(v / unit) * unit;
}

const W = 720;
const H = 280;
const PAD = { top: 10, right: 28, bottom: 34, left: 84 };
const CX_PAD = 8;
/** transition/animation duration for the value/axis morphs (one tempo everywhere) */
const DUR = ".55s";
const T_D = `d ${DUR} ease`;
const T_POINT = `cx ${DUR} ease, cy ${DUR} ease, r .2s ease`;
const T_FADE = `opacity ${DUR} ease`;
const T_SHIFT = `transform ${DUR} ease`;
const GHOST_MS = 650;

/**
 * Stable color assignment per MODEL (not per rank): the same model keeps its
 * color across range/metric/count switches and legend toggles, so the
 * animation never repaints a series. First-seen order locks the palette slot.
 * Module-level so the assignment survives closing/reopening the panel.
 */
const modelColorSlot = new Map<string, number>();
function colorFor(model: string): string {
  let slot = modelColorSlot.get(model);
  if (slot === undefined) {
    slot = modelColorSlot.size % COLORS.length;
    modelColorSlot.set(model, slot);
  }
  return COLORS[slot];
}

/**
 * Animation styles. Elements that ENTER on a switch (CSS transitions only
 * animate elements that already existed) play a keyframe in the same 0.55s
 * tempo as the gliding elements, and the PREVIOUS layout stays mounted for one
 * beat as a "ghost" layer that fades out — so the whole chart moves together
 * instead of mixing instant pops with in-flight marks. The enter classes
 * self-remove on animationend so live styles (hover, legend toggles) keep
 * working afterwards. (Pattern ported from token-pulse's animated chart.)
 */
const ANIM_CSS = `
@keyframes mhc-fadein { from { opacity: 0; } }
@keyframes mhc-fadeout { to { opacity: 0; } }
.mhc-fadein { animation: mhc-fadein ${DUR} ease; }
.mhc-ghost { animation: mhc-fadeout ${DUR} ease forwards; }
`;

/**
 * Health trend chart: one smoothed line per model (range top-N plus the last
 * week's top-3 guaranteed), metric switch (output speed / TTFT), range switch
 * (7 / 30 days), legend chips toggle visibility, count selector (5-10).
 * Switches animate as ONE coordinated beat: retained marks glide by date
 * identity, entering marks fade in, and the previous layout fades out as a
 * ghost overlay. Days without samples: internal gaps drawn as interpolated
 * dashed spans; leading/trailing gaps stay empty. Pure SVG, no dependencies.
 */
export function TrendChart({ t, days, isEn = false }: { t: (k: string, p?: any) => string; days: Map<string, DayHealth>; isEn?: boolean }) {
  const [metric, setMetric] = React.useState<Metric>("speed");
  const [rangeDays, setRangeDays] = React.useState<7 | 30>(7);
  /** how many models to show (5-10); the last week's top-3 always get slots */
  const [count, setCount] = React.useState(5);
  const [hidden, setHidden] = React.useState<ReadonlySet<string>>(new Set());
  const [hover, setHover] = React.useState<{ idx: number; px: number; py: number } | null>(null);
  /** one-beat overlay of the PREVIOUS layout's marks, fading out on switches */
  const [ghost, setGhost] = React.useState<{ marks: React.ReactNode; labels: React.ReactNode } | null>(null);

  const endKey = toDayKey(Date.now());
  const dayKeys = React.useMemo(() => recentDayKeys(endKey, rangeDays), [endKey, rangeDays]);
  const weekKeys = React.useMemo(() => recentDayKeys(endKey, 7), [endKey]);
  const topModels = React.useMemo(() => pickTrendModels(days, dayKeys, weekKeys, count, 3), [days, dayKeys, weekKeys, count]);
  const series = React.useMemo(() => buildSeries(days, dayKeys, topModels, metric), [days, dayKeys, topModels, metric]);

  const wrapRef = React.useRef<HTMLDivElement | null>(null);
  const [wrap, setWrap] = React.useState({ w: 0, h: 0 });
  React.useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setWrap({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // previous-render identity sets (for enter animations) + last-render mark
  // nodes (reused as the ghost overlay on switches)
  const prevDaysRef = React.useRef<string[] | null>(null);
  const prevModelsRef = React.useRef<string[] | null>(null);
  const prevTickRef = React.useRef<string[] | null>(null);
  const marksRef = React.useRef<React.ReactNode>(null);
  const labelsRef = React.useRef<React.ReactNode>(null);

  const toggle = (model: string) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(model)) next.delete(model);
      else next.add(model);
      return next;
    });
  };

  const colorOf = colorFor;
  const visible = series.filter((s) => !hidden.has(s.model));

  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const allVals = visible.flatMap((s) => s.points.filter((v): v is number => v != null));
  const hasPoints = allVals.length > 0;
  const yMax = niceCeil(Math.max(1, ...allVals));
  const step = dayKeys.length > 1 ? plotW / (dayKeys.length - 1) : plotW;
  const xOf = (i: number) => PAD.left + (dayKeys.length > 1 ? i * step : plotW / 2);
  const yOf = (v: number) => PAD.top + (1 - v / yMax) * plotH;

  const fmtDay = (k: string) => `${Number(k.slice(5, 7))}/${Number(k.slice(8, 10))}`;
  const fmtDayLong = (k: string) =>
    isEn ? `${Number(k.slice(5, 7))}/${Number(k.slice(8, 10))}` : `${Number(k.slice(5, 7))}月${Number(k.slice(8, 10))}日`;
  const tickEvery = rangeDays === 7 ? 1 : 5;
  const tickIdx = dayKeys.map((_, i) => i).filter((i) => i % tickEvery === 0 || i === dayKeys.length - 1);

  // enter-anim eligibility: element identities that did not exist last render
  const isNewDay = (k: string) => prevDaysRef.current !== null && !prevDaysRef.current.includes(k);
  const isNewModel = (m: string) => prevModelsRef.current !== null && !prevModelsRef.current.includes(m);
  const isNewTick = (k: string) => prevTickRef.current !== null && !prevTickRef.current.includes(k);
  const enterCls = (isNew: boolean) => (isNew ? "mhc-fadein" : undefined);
  const onAnimEnd = (e: React.AnimationEvent<SVGElement>) => {
    e.currentTarget.classList.remove("mhc-fadein");
  };

  React.useEffect(() => {
    marksRef.current = marksNode;
    labelsRef.current = labelsNode;
    prevDaysRef.current = dayKeys;
    prevModelsRef.current = series.map((s) => s.model);
    prevTickRef.current = tickIdx.map((i) => dayKeys[i]);
  });

  React.useEffect(() => {
    if (!ghost) return;
    const timer = setTimeout(() => setGhost(null), GHOST_MS);
    return () => clearTimeout(timer);
  }, [ghost]);

  const switchTo = (patch: { range?: 7 | 30; metric?: Metric; count?: number }) => {
    // capture the CURRENT layout's mark nodes as the exiting ghost overlay
    setGhost({ marks: marksRef.current, labels: labelsRef.current });
    if (patch.range !== undefined) setRangeDays(patch.range);
    if (patch.metric !== undefined) setMetric(patch.metric);
    if (patch.count !== undefined) setCount(patch.count);
    setHover(null);
  };

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const wrapEl = wrapRef.current;
    if (!wrapEl) return;
    const wrapRect = wrapEl.getBoundingClientRect();
    const svgRect = e.currentTarget.getBoundingClientRect();
    const scale = svgRect.width / W || 1;
    const xvb = (e.clientX - svgRect.left) / scale;
    const i = Math.round((xvb - PAD.left) / step);
    setHover({
      idx: Math.max(0, Math.min(dayKeys.length - 1, i)),
      px: e.clientX - wrapRect.left,
      py: e.clientY - wrapRect.top,
    });
  };

  const hoverRows =
    hover == null
      ? []
      : visible
          .map((s) => ({ model: s.model, color: colorOf(s.model), value: s.points[hover.idx] }))
          .filter((r): r is { model: string; color: string; value: number } => r.value != null)
          .sort((a, b) => (metric === "ttft" ? a.value - b.value : b.value - a.value));

  const tipW = 210;
  const tipH = 48 + hoverRows.length * 19;
  const gap = 14;
  const svgW = Math.max(0, wrap.w - CX_PAD * 2);
  const colPx = hover == null ? 0 : CX_PAD + (xOf(hover.idx) / W) * svgW;
  let tipLeft = hover == null ? 0 : colPx + gap;
  if (hover != null && tipLeft + tipW > wrap.w - 4) tipLeft = colPx - gap - tipW;
  tipLeft = Math.max(4, tipLeft);
  const tipTop = hover == null ? 0 : Math.max(4, Math.min(hover.py - tipH / 2, Math.max(4, wrap.h - tipH - 4)));

  const segStyle: React.CSSProperties = {
    padding: "2px 8px",
    fontSize: 12,
    border: "none",
    cursor: "pointer",
    borderRadius: 5,
    background: "transparent",
    color: "var(--dsw-alias-label-secondary)",
    transition: "background .25s ease, color .25s ease",
  };
  const segActive: React.CSSProperties = {
    background: "var(--dsw-alias-label-primary)",
    color: "var(--dsw-alias-bg-layer-3)",
  };

  // ---- mark nodes (also captured as the ghost overlay on switches) ----
  const labelsNode = (
    <>
      {tickIdx.map((i) => (
        <text
          key={dayKeys[i]}
          x={0}
          y={0}
          textAnchor="middle"
          fontSize={14}
          fill="var(--dsw-alias-label-tertiary)"
          className={enterCls(isNewTick(dayKeys[i]))}
          onAnimationEnd={onAnimEnd}
          style={{ transform: `translate(${xOf(i)}px, ${H - 10}px)`, transition: T_SHIFT }}
        >
          {fmtDay(dayKeys[i])}
        </text>
      ))}
    </>
  );

  const marksNode = (
    <>
      {series.map((s) => {
        const color = colorOf(s.model);
        const off = hidden.has(s.model);
        const seg = splitSeries(s.points);
        const modelNew = isNewModel(s.model);
        const xy = (idxs: number[], values: number[]): Array<[number, number]> =>
          idxs.map((ix, j) => [xOf(ix), yOf(values[j])]);
        const dashProps = {
          fill: "none",
          stroke: color,
          strokeWidth: 2,
          strokeLinecap: "round" as const,
          strokeLinejoin: "round" as const,
          strokeDasharray: "5 4",
          opacity: 0.35,
          style: { transition: T_D },
        };
        return (
          <g
            key={s.model}
            opacity={off ? 0 : 0.8}
            className={enterCls(modelNew)}
            onAnimationEnd={onAnimEnd}
            style={{ transition: T_FADE }}
          >
            {/* estimated spans (internal interpolated gaps): dashed + faded */}
            {seg.interpolations.map((g, j) => (
              <path key={`i${j}`} d={seriesPathFixed(xy(g.idxs, g.values))} {...dashProps} />
            ))}
            {/* observed runs: solid */}
            {seg.runs.map((run, j) =>
              run.length > 1 ? (
                <path
                  key={`r${j}`}
                  d={seriesPathFixed(run.map((p) => [xOf(p.i), yOf(p.v)]))}
                  fill="none"
                  stroke={color}
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ transition: T_D }}
                />
              ) : null,
            )}
            {/* points keyed by day: they slide along x across range switches */}
            {s.points.map((v, i) =>
              v != null ? (
                <circle
                  key={dayKeys[i]}
                  cx={xOf(i)}
                  cy={yOf(v)}
                  r={hover?.idx === i ? 4 : 2}
                  fill={color}
                  className={enterCls(!modelNew && isNewDay(dayKeys[i]))}
                  onAnimationEnd={onAnimEnd}
                  style={{ transition: T_POINT }}
                />
              ) : null,
            )}
          </g>
        );
      })}
    </>
  );

  return (
    <div
      style={{
        border: "1px solid var(--dsw-alias-border-l2)",
        background: "var(--dsw-alias-bg-layer-3)",
        borderRadius: 12,
        overflow: "hidden",
      }}
    >
      <style>{ANIM_CSS}</style>
      {/* header: title + metric switch + range switch + count selector */}
      <div
        style={{
          padding: "12px 16px 8px",
          borderBottom: "1px solid var(--dsw-alias-border-l2)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-label-primary)" }}>{t("trend.title")}</span>
          <span style={{ fontSize: 12, color: "var(--dsw-alias-label-tertiary)" }}>{t("trend.hint")}</span>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <div style={{ display: "inline-flex", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 6, overflow: "hidden" }}>
            {(["speed", "ttft"] as const).map((m) => (
              <button key={m} onClick={() => switchTo({ metric: m })} style={{ ...segStyle, ...(metric === m ? segActive : null) }}>
                {m === "ttft" ? t("trend.metric.ttft") : t("trend.metric.speed")}
              </button>
            ))}
          </div>
          <div style={{ display: "inline-flex", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 6, overflow: "hidden" }}>
            {([7, 30] as const).map((n) => (
              <button key={n} onClick={() => switchTo({ range: n })} style={{ ...segStyle, ...(rangeDays === n ? segActive : null) }}>
                {n === 7 ? t("trend.range7") : t("trend.range30")}
              </button>
            ))}
          </div>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, color: "var(--dsw-alias-label-secondary)" }}>
            {t("trend.count")}
            <select
              value={count}
              onChange={(e) => switchTo({ count: Number(e.target.value) })}
              style={{ padding: "2px 6px", fontSize: 12, borderRadius: 6, border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-3)", color: "var(--dsw-alias-label-primary)" }}
            >
              {[5, 6, 7, 8, 9, 10].map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {/* legend chips: short names, click to toggle a line */}
      <div style={{ padding: "10px 16px 4px" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))", gap: 6 }}>
          {series.map((s) => {
            const off = hidden.has(s.model);
            return (
              <button
                key={s.model}
                onClick={() => toggle(s.model)}
                title={s.model}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "3px 10px",
                  borderRadius: 999,
                  border: "1px solid var(--dsw-alias-border-l2)",
                  background: "transparent",
                  cursor: "pointer",
                  opacity: off ? 0.35 : 1,
                  transition: T_FADE,
                  fontSize: 13,
                  color: "var(--dsw-alias-label-primary)",
                  minWidth: 0,
                }}
              >
                <span style={{ width: 8, height: 8, borderRadius: 4, background: colorOf(s.model), flexShrink: 0 }} />
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "left", textDecoration: off ? "line-through" : "none" }}>
                  {shortModel(s.model)}
                </span>
              </button>
            );
          })}
        </div>
        {series.length === 0 ? null : (
          <div style={{ fontSize: 10, color: "var(--dsw-alias-label-tertiary)", marginTop: 4 }}>{t("trend.legend.hint")}</div>
        )}
      </div>

      {/* chart + hover tooltip */}
      <div ref={wrapRef} style={{ position: "relative", padding: `4px ${CX_PAD}px 12px` }}>
        {!hasPoints ? (
          <div style={{ padding: 24, textAlign: "center", fontSize: 14, color: "var(--dsw-alias-label-tertiary)" }}>{t("trend.empty")}</div>
        ) : (
          <svg
            viewBox={`0 0 ${W} ${H}`}
            width="100%"
            style={{ display: "block" }}
            role="img"
            aria-label={t("trend.title")}
            onMouseMove={onMove}
            onMouseLeave={() => setHover(null)}
          >
            {/* y grid + labels (path/transform so axis rescaling morphs smoothly) */}
            {[0, 0.25, 0.5, 0.75, 1].map((f) => {
              const y = PAD.top + (1 - f) * plotH;
              return (
                <g key={f}>
                  <path
                    d={`M ${PAD.left} ${y} L ${W - PAD.right} ${y}`}
                    fill="none"
                    stroke="var(--dsw-alias-border-l2)"
                    strokeWidth={1}
                    strokeDasharray={f === 0 ? undefined : "3 3"}
                    style={{ transition: T_D }}
                  />
                  <text
                    x={0}
                    y={0}
                    textAnchor="end"
                    fontSize={15}
                    fill="var(--dsw-alias-label-tertiary)"
                    style={{ transform: `translate(${PAD.left - 8}px, ${y + 6}px)`, transition: T_SHIFT }}
                  >
                    {formatMetric(yMax * f, metric)}
                  </text>
                </g>
              );
            })}

            {/* ghost overlay: the previous layout's marks, fading out */}
            {ghost ? (
              <>
                <g className="mhc-ghost">{ghost.marks}</g>
                <g className="mhc-ghost">{ghost.labels}</g>
              </>
            ) : null}

            {labelsNode}
            {marksNode}

            {/* hovered column guide */}
            {hover != null ? (
              <path
                d={`M ${xOf(hover.idx)} ${PAD.top} L ${xOf(hover.idx)} ${PAD.top + plotH}`}
                fill="none"
                stroke="var(--dsw-alias-label-tertiary)"
                strokeWidth={1}
                strokeDasharray="4 3"
                opacity={0.6}
                style={{ transition: T_D }}
              />
            ) : null}

            {visible.length === 0 ? (
              <text x={W / 2} y={PAD.top + plotH / 2} textAnchor="middle" fontSize={13} fill="var(--dsw-alias-label-tertiary)">
                {t("trend.legend.hint")}
              </text>
            ) : null}
          </svg>
        )}

        {hover != null && topModels.length > 0 ? (
          <div
            style={{
              position: "absolute",
              left: tipLeft,
              top: tipTop,
              width: tipW,
              opacity: 0.7,
              pointerEvents: "none",
              background: "var(--dsw-alias-bg-layer-3)",
              border: "1px solid var(--dsw-alias-border-l2)",
              borderRadius: 8,
              boxShadow: "0 6px 18px rgba(0,0,0,0.25)",
              padding: "6px 10px",
              fontSize: 11,
              lineHeight: 1.5,
              color: "var(--dsw-alias-label-primary)",
              zIndex: 5,
            }}
          >
            <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 4 }}>{fmtDayLong(dayKeys[hover.idx])}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              {hoverRows.length === 0 ? (
                <span style={{ color: "var(--dsw-alias-label-tertiary)" }}>{t("trend.empty")}</span>
              ) : (
                hoverRows.map((r) => (
                  <div key={r.model} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ width: 7, height: 7, borderRadius: 4, background: r.color, flexShrink: 0 }} />
                    <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.model}>
                      {shortModel(r.model)}
                    </span>
                    <span style={{ fontWeight: 500, whiteSpace: "nowrap" }}>{formatMetric(r.value, metric)}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default TrendChart;
