import { describe, it, expect } from "vitest";
import { HealthCard } from "./HealthCard.js";
import { TrendChart } from "./TrendChart.js";
import { toDayKey, addDays } from "../date-bucket.js";
import type { DayHealth, ModelHealth } from "../types.js";

type Node = any;

/** Collect every rendered node (jsx mock keeps children in props.children;
 *  a single JSX child is a bare node, not an array). */
function nodes(root: Node): Node[] {
  const out: Node[] = [];
  const visit = (n: Node) => {
    if (n == null || typeof n !== "object") return;
    if (Array.isArray(n)) {
      for (const c of n) visit(c);
      return;
    }
    out.push(n);
    const kids = [...(Array.isArray(n.children) ? n.children : n.children != null ? [n.children] : []),
                  ...(Array.isArray(n.props?.children) ? n.props.children : n.props?.children != null ? [n.props.children] : [])];
    for (const c of kids) visit(c);
    if (typeof n.type === "function") visit(n.type(n.props));
  };
  visit(root);
  return out;
}

/** Render-walk that throws on any render-path error (the "isEn blank page"
 *  regression class), plus structural assertions. */
function renderAndCheck(root: Node): { types: Set<any>; count: number } {
  const ns = nodes(root);
  const types = new Set(ns.map((n) => n.type));
  return { types, count: ns.length };
}

function mh(model: string, over: Partial<ModelHealth> = {}): ModelHealth {
  return {
    model,
    ttftSumMs: 600,
    ttftCount: 2,
    decodeMsSum: 4000,
    decodeTokensSum: 400,
    steps: 3,
    ...over,
  };
}

const today = toDayKey(Date.now());
const y1 = addDays(today, -1);
const y3 = addDays(today, -3);
const y9 = addDays(today, -9);

function richDays(): Map<string, DayHealth> {
  return new Map<string, DayHealth>([
    [y1, new Map([["modelA", mh("modelA")], ["modelB", mh("modelB", { ttftSumMs: 0, ttftCount: 0 })]])],
    [y3, new Map([["modelA", mh("modelA", { decodeMsSum: 0, decodeTokensSum: 0 })], ["modelC", mh("modelC")]])],
    [y9, new Map([["modelB", mh("modelB")]])],
  ]);
}

const t = (k: string) => k;

describe("render walk (deep, with data)", () => {
  it("HealthCard renders its table with rich data", () => {
    const { types, count } = renderAndCheck(HealthCard({ t, days: richDays(), isEn: false } as any));
    expect(count).toBeGreaterThan(5);
    expect(types.has("table")).toBe(true);
  });

  it("TrendChart renders its chart svg with rich data", () => {
    const { types, count } = renderAndCheck(TrendChart({ t, days: richDays(), isEn: true } as any));
    expect(count).toBeGreaterThan(5);
    expect(types.has("svg")).toBe(true);
  });

  it("shows OUTPUT SPEED first (chart default + card columns), ttft after", () => {
    // chart: the first metric chip must be speed
    const chart = nodes(TrendChart({ t, days: richDays(), isEn: false } as any));
    const btnLabels = chart.filter((n) => typeof n.type === "function" && n.type.name === "Button").map(() => null); // placeholder
    const firstBtnText = chart
      .filter((n) => typeof n.type === "string" && n.type === "button")
      .map((n) => JSON.stringify(n.props?.children ?? n.children))
      .find((x) => x.includes("trend.metric"))!;
    expect(firstBtnText).toContain("trend.metric.speed");

    // card: column headers order = model | speed | ttft | samples
    const card = nodes(HealthCard({ t, days: richDays(), isEn: false } as any));
    const thTexts = card.filter((n) => n.type === "th").map((n) => JSON.stringify(n.props?.children ?? n.children));
    const joined = thTexts.join("|");
    expect(joined.indexOf("card.speed")).toBeLessThan(joined.indexOf("card.ttft"));
  });

  it("renders with empty models and with all-null metrics without throwing", () => {
    const empty = new Map<string, DayHealth>([[y1, new Map()]]);
    renderAndCheck(HealthCard({ t, days: empty, isEn: false } as any));
    renderAndCheck(TrendChart({ t, days: empty, isEn: false } as any));

    const nulls = new Map<string, DayHealth>([
      [y1, new Map([["m", mh("m", { ttftSumMs: 0, ttftCount: 0, decodeMsSum: 0, decodeTokensSum: 0 })]])],
    ]);
    renderAndCheck(HealthCard({ t, days: nulls, isEn: true } as any));
    renderAndCheck(TrendChart({ t, days: nulls, isEn: true } as any));
  });
});
