import * as React from "react";
import type { DayHealth, ModelHealth } from "../types.js";

const LS_INTERVAL_KEY = "dsh-model-health:autoRefreshMinutes";

export function getAutoRefreshMinutes(): number {
  try {
    const v = localStorage.getItem(LS_INTERVAL_KEY);
    if (v === null) return 10;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return 10;
    return Math.min(1440, Math.max(0, Math.round(n)));
  } catch {
    return 10;
  }
}

export function setAutoRefreshMinutes(minutes: number) {
  try {
    localStorage.setItem(LS_INTERVAL_KEY, String(minutes));
  } catch {}
}

const API_TIMEOUT_MS = 5000;

export type HealthData = {
  days: Map<string, DayHealth>;
};

type FetchResult = HealthData | { __notReady: true } | null;

async function fetchFromApi(): Promise<FetchResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), API_TIMEOUT_MS);
  try {
    const res = await fetch("/api/dsh-model-health/health.json", { cache: "no-store", signal: ctrl.signal });
    if (!res.ok) return null;
    const json = await res.json();
    if (!json || !Array.isArray(json.days)) return null;
    // Host still scanning disk: keep the last snapshot and retry shortly
    // instead of caching a partial result.
    if (json.ready === false) return { __notReady: true };
    const days = new Map<string, DayHealth>();
    for (const d of json.days) {
      const models = new Map<string, ModelHealth>();
      for (const [model, h] of Object.entries(d.models ?? {})) {
        models.set(model, {
          model,
          ttftSumMs: (h as any).ttftSumMs ?? 0,
          ttftCount: (h as any).ttftCount ?? 0,
          decodeMsSum: (h as any).decodeMsSum ?? 0,
          decodeTokensSum: (h as any).decodeTokensSum ?? 0,
          steps: (h as any).steps ?? 0,
        });
      }
      days.set(d.dayKey, models);
    }
    return { days };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch + manual/auto refresh. Retries every 2s while the host reports
 *  `ready: false` (initial disk scan in progress). */
export function useHealthData(): {
  data: HealthData | null;
  refreshing: boolean;
  lastRefresh: string | null;
  refresh: () => Promise<void>;
} {
  const [data, setData] = React.useState<HealthData | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);
  const [lastRefresh, setLastRefresh] = React.useState<string | null>(null);
  const aliveRef = React.useRef(true);
  const busyRef = React.useRef(false);

  const doFetch = React.useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setRefreshing(true);
    try {
      const result = await fetchFromApi();
      if (!aliveRef.current) return;
      if (result && "__notReady" in result) {
        // init() still scanning — keep the old data visible, retry in 2s
        setTimeout(() => {
          busyRef.current = false;
          void doFetch();
        }, 2000);
        return;
      }
      if (result) {
        setData(result);
        setLastRefresh(new Date().toLocaleTimeString());
      }
    } finally {
      busyRef.current = false;
      if (aliveRef.current) setRefreshing(false);
    }
  }, []);

  React.useEffect(() => {
    aliveRef.current = true;
    void doFetch();
    return () => {
      aliveRef.current = false;
    };
  }, [doFetch]);

  // auto refresh loop (0 = off)
  React.useEffect(() => {
    const mins = getAutoRefreshMinutes();
    if (mins <= 0) return;
    const timer = setInterval(() => void doFetch(), mins * 60_000);
    return () => clearInterval(timer);
  }, [doFetch]);

  return { data, refreshing, lastRefresh, refresh: doFetch };
}
