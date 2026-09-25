import * as React from "react";
import type { DayHealth } from "../types.js";
import { toDayKey } from "../date-bucket.ts";
import { recentDayKeys, summarize, dayMetric, formatMs, formatSpeed } from "./trend.js";

type WindowKind = 1 | 7 | 30 | 0; // 0 = all

/**
 * Health overview card: per-model avg TTFT / avg output speed / sample count
 * over a selectable window (today / 7d / 30d / all), busiest models first.
 */
export function HealthCard({ t, days, isEn = false }: { t: (k: string, p?: any) => string; days: Map<string, DayHealth>; isEn?: boolean }) {
  const [win, setWin] = React.useState<WindowKind>(7);

  const todayKey = toDayKey(Date.now());
  const dayKeys = React.useMemo(() => {
    if (win === 0) return [...days.keys()].sort();
    return recentDayKeys(todayKey, win).filter((k) => days.has(k));
  }, [days, win, todayKey]);

  const rows = React.useMemo(() => {
    // all-window needs every key (including ones outside recentDayKeys)
    const keys = win === 0 ? [...days.keys()] : dayKeys;
    return [...summarize(days, keys).values()]
      .sort((a, b) => b.steps - a.steps || (a.model < b.model ? -1 : 1))
      .slice(0, 8);
  }, [days, dayKeys, win]);

  const cell: React.CSSProperties = {
    padding: "6px 10px",
    fontSize: 12,
    color: "var(--dsw-alias-label-primary)",
    whiteSpace: "nowrap",
  };
  const headCell: React.CSSProperties = {
    ...cell,
    color: "var(--dsw-alias-label-secondary)",
    fontWeight: 600,
    borderBottom: "1px solid var(--dsw-alias-border-l2)",
    textAlign: "left",
  };
  const segStyle: React.CSSProperties = {
    padding: "2px 8px",
    fontSize: 12,
    border: "none",
    cursor: "pointer",
    borderRadius: 5,
    background: "transparent",
    color: "var(--dsw-alias-label-secondary)",
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
      <div
        style={{
          padding: "12px 16px 8px",
          borderBottom: "1px solid var(--dsw-alias-border-l2)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-label-primary)" }}>{t("card.title")}</span>
          <span style={{ fontSize: 12, color: "var(--dsw-alias-label-tertiary)" }}>{t("card.hint")}</span>
        </div>
        <div style={{ display: "inline-flex", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 6, overflow: "hidden" }}>
          {([1, 7, 30, 0] as const).map((w) => (
            <button
              key={w}
              onClick={() => setWin(w)}
              style={{
                ...segStyle,
                background: win === w ? "var(--dsw-alias-label-primary)" : "transparent",
                color: win === w ? "var(--dsw-alias-bg-layer-3)" : "var(--dsw-alias-label-secondary)",
              }}
            >
              {w === 1 ? t("card.window.today") : w === 7 ? t("card.window.7") : w === 30 ? t("card.window.30") : t("card.window.all")}
            </button>
          ))}
        </div>
      </div>
      {rows.length === 0 ? (
        <div style={{ padding: 24, textAlign: "center", fontSize: 13, color: "var(--dsw-alias-label-tertiary)" }}>{t("card.empty")}</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={headCell}>{t("card.model")}</th>
                <th style={{ ...headCell, textAlign: "right" }}>{t("card.speed")}</th>
                <th style={{ ...headCell, textAlign: "right" }}>{t("card.ttft")}</th>
                <th style={{ ...headCell, textAlign: "right" }}>{t("card.samples")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((h, i) => {
                const ttft = dayMetric(h, "ttft");
                const speed = dayMetric(h, "speed");
                return (
                  <tr key={h.model} style={{ borderTop: i === 0 ? "none" : "1px solid var(--dsw-alias-border-l2)" }}>
                    <td style={{ ...cell, maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis" }} title={h.model}>
                      {h.model}
                    </td>
                    <td style={{ ...cell, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{speed != null ? formatSpeed(speed) : "—"}</td>
                    <td style={{ ...cell, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{ttft != null ? formatMs(ttft) : "—"}</td>
                    <td style={{ ...cell, textAlign: "right", fontVariantNumeric: "tabular-nums", color: "var(--dsw-alias-label-secondary)" }}>
                      {h.steps}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default HealthCard;
