declare const __PLUGIN_VERSION__: string;

import * as React from "react";
import { HealthCard } from "./HealthCard.js";
import { TrendChart } from "./TrendChart.js";
import { useHealthData, getAutoRefreshMinutes, setAutoRefreshMinutes } from "./hooks.js";

type Props = {
  t: (key: string, params?: Record<string, any>) => string;
  ctx?: any;
};

export function SettingsSection({ t }: Props) {
  const { data, refreshing, lastRefresh, refresh } = useHealthData();
  const [intervalMins, setIntervalMins] = React.useState(() => getAutoRefreshMinutes());
  const [lang, setLang] = React.useState<"zh" | "en">(() => {
    try {
      const v = localStorage.getItem("dsh-model-health:lang");
      return v === "en" ? "en" : "zh";
    } catch {
      return "zh";
    }
  });

  const tt = (key: string, params?: Record<string, any>) => (lang === "en" ? enOf(key, params) : t(key, params));

  const handleIntervalChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const v = Number(e.target.value);
    setAutoRefreshMinutes(v);
    setIntervalMins(v);
  };

  const handleLangChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const v = e.target.value as "zh" | "en";
    setLang(v);
    try {
      localStorage.setItem("dsh-model-health:lang", v);
    } catch {}
  };

  const selectStyle: React.CSSProperties = {
    padding: "4px 8px",
    fontSize: 12,
    borderRadius: 6,
    border: "1px solid var(--dsw-alias-border-l2)",
    background: "var(--dsw-alias-bg-layer-3)",
    color: "var(--dsw-alias-label-primary)",
  };

  return (
    <section aria-labelledby="model-health-title" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <div>
          <h2 id="model-health-title" style={{ margin: 0, fontSize: 16, fontWeight: 600, color: "var(--dsw-alias-label-primary)" }}>
            {tt("health.title")}
            <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 400, color: "var(--dsw-alias-label-tertiary)", verticalAlign: "middle" }}>
              v{__PLUGIN_VERSION__}
            </span>
          </h2>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--dsw-alias-label-tertiary)", lineHeight: 1.5 }}>{tt("health.subtitle")}</p>
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--dsw-alias-label-secondary)", flexShrink: 0 }}>
          {lang === "en" ? "Language" : "语言"}
          <select value={lang} onChange={handleLangChange} style={selectStyle}>
            <option value="zh">中文</option>
            <option value="en">English</option>
          </select>
        </label>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <button
          onClick={() => void refresh()}
          disabled={refreshing}
          style={{
            padding: "6px 14px",
            fontSize: 13,
            borderRadius: 8,
            border: "1px solid var(--dsw-alias-border-l2)",
            background: refreshing ? "var(--dsw-alias-bg-layer-2)" : "var(--dsw-alias-bg-layer-3)",
            color: "var(--dsw-alias-label-primary)",
            cursor: refreshing ? "wait" : "pointer",
          }}
        >
          {lang === "en" ? (refreshing ? "Refreshing…" : "Refresh") : refreshing ? tt("health.refreshing") : tt("health.refresh")}
        </button>
        <span style={{ fontSize: 12, color: "var(--dsw-alias-label-tertiary)" }}>
          {lastRefresh ? (lang === "en" ? `Last refresh: ${lastRefresh}` : tt("health.lastRefresh", { time: lastRefresh })) : ""}
        </span>
        <span style={{ flex: 1 }} />
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--dsw-alias-label-secondary)" }}>
          {tt("health.autoRefresh")}
          <select value={intervalMins} onChange={handleIntervalChange} style={selectStyle}>
            <option value={0}>{tt("health.autoRefresh.off")}</option>
            <option value={5}>5 min</option>
            <option value={10}>10 min</option>
            <option value={30}>30 min</option>
            <option value={60}>60 min</option>
          </select>
        </label>
      </div>

      {data && data.days.size > 0 ? (
        <>
          <HealthCard t={tt} days={data.days} isEn={lang === "en"} />
          <TrendChart t={tt} days={data.days} isEn={lang === "en"} />
        </>
      ) : (
        <div
          style={{
            border: "1px solid var(--dsw-alias-border-l2)",
            background: "var(--dsw-alias-bg-layer-3)",
            borderRadius: 12,
            padding: 24,
            color: "var(--dsw-alias-label-tertiary)",
            fontSize: 13,
          }}
        >
          {tt("health.empty")}
        </div>
      )}
    </section>
  );
}

/** English strings for keys the host locale may not carry (lang=EN mode). */
function enOf(key: string, params?: Record<string, any>): string {
  const enDict: Record<string, string> = (globalThis as any).__mh_en ?? {};
  let s = enDict[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) s = s.replace(`{${k}}`, String(v));
  return s;
}

export default SettingsSection;
