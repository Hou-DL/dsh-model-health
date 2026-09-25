window.__ModuleLoader__.load({
	id: "dsh-model-health",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region \0rolldown/runtime.js
		var __create = Object.create;
		var __defProp = Object.defineProperty;
		var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
		var __getOwnPropNames = Object.getOwnPropertyNames;
		var __getProtoOf = Object.getPrototypeOf;
		var __hasOwnProp = Object.prototype.hasOwnProperty;
		var __copyProps = (to, from, except, desc) => {
			if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
				key = keys[i];
				if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
					get: ((k) => from[k]).bind(null, key),
					enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
				});
			}
			return to;
		};
		var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule || !__hasOwnProp.call(mod, "default") ? __defProp(target, "default", {
			value: mod,
			enumerable: true
		}) : target, mod));
		//#endregion
		let react = require("react");
		react = __toESM(react, 1);
		let react_jsx_runtime = require("react/jsx-runtime");
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
		function dayKeyToDate(key, _tz = TZ) {
			return /* @__PURE__ */ new Date(key + "T12:00:00+08:00");
		}
		function addDays(dayKey, n) {
			const d = dayKeyToDate(dayKey);
			d.setDate(d.getDate() + n);
			return toDayKey(d.getTime());
		}
		//#endregion
		//#region src/client/trend.ts
		/** Per-day metric value: avg TTFT (ms) or avg output speed (tok/s); null when
		*  the day has no usable samples for the metric. */
		function dayMetric(h, metric) {
			if (!h) return null;
			if (metric === "ttft") return h.ttftCount > 0 ? h.ttftSumMs / h.ttftCount : null;
			return h.decodeMsSum > 0 ? h.decodeTokensSum / h.decodeMsSum * 1e3 : null;
		}
		/** Sum each model's counters over `dayKeys` (window summary for the card). */
		function summarize(days, dayKeys) {
			const out = /* @__PURE__ */ new Map();
			for (const k of dayKeys) {
				const dh = days.get(k);
				if (!dh) continue;
				for (const [model, h] of dh) {
					const cur = out.get(model) ?? {
						model,
						ttftSumMs: 0,
						ttftCount: 0,
						decodeMsSum: 0,
						decodeTokensSum: 0,
						steps: 0
					};
					cur.ttftSumMs += h.ttftSumMs;
					cur.ttftCount += h.ttftCount;
					cur.decodeMsSum += h.decodeMsSum;
					cur.decodeTokensSum += h.decodeTokensSum;
					cur.steps += h.steps;
					out.set(model, cur);
				}
			}
			return out;
		}
		/** Up to `k` busiest models of the window (by sample steps) — the legend set. */
		function pickTopModels(days, dayKeys, k = 5) {
			return [...summarize(days, dayKeys).entries()].sort((a, b) => b[1].steps - a[1].steps || (a[0] < b[0] ? -1 : 1)).slice(0, k).map(([model]) => model);
		}
		/** One series per model: its daily metric aligned to `dayKeys`, null on gaps. */
		function buildSeries(days, dayKeys, models, metric) {
			return models.map((model) => ({
				model,
				points: dayKeys.map((k) => dayMetric(days.get(k)?.get(model), metric))
			}));
		}
		/** N consecutive day keys ending at `endKey` (inclusive). */
		function recentDayKeys(endKey, n) {
			const out = [];
			for (let i = n - 1; i >= 0; i--) out.push(addDays(endKey, -i));
			return out;
		}
		/**
		* Monotone cubic (Fritsch–Carlson) Hermite interpolation as cubic bezier
		* segments — a smooth trend line must NOT overshoot (no fake troughs/peaks).
		*/
		function monotoneSegments(pts) {
			const n = pts.length;
			if (n < 2) return [];
			const h = [];
			const delta = [];
			for (let i = 0; i < n - 1; i++) {
				const dx = pts[i + 1][0] - pts[i][0];
				h.push(dx);
				delta.push(dx === 0 ? 0 : (pts[i + 1][1] - pts[i][1]) / dx);
			}
			const m = new Array(n);
			m[0] = delta[0];
			m[n - 1] = delta[n - 2];
			for (let i = 1; i < n - 1; i++) m[i] = delta[i - 1] * delta[i] <= 0 ? 0 : (delta[i - 1] + delta[i]) / 2;
			for (let i = 0; i < n - 1; i++) {
				if (delta[i] === 0) {
					m[i] = 0;
					m[i + 1] = 0;
					continue;
				}
				const a = m[i] / delta[i];
				const b = m[i + 1] / delta[i];
				const s = a * a + b * b;
				if (s > 9) {
					const t = 3 / Math.sqrt(s);
					m[i] = t * a * delta[i];
					m[i + 1] = t * b * delta[i];
				}
			}
			const segs = [];
			for (let i = 0; i < n - 1; i++) {
				const [x0, y0] = pts[i];
				const [x1, y1] = pts[i + 1];
				const dx = (x1 - x0) / 3;
				segs.push({
					p0: [x0, y0],
					c1: [x0 + dx, y0 + m[i] * (x1 - x0) / 3],
					c2: [x1 - dx, y1 - m[i + 1] * (x1 - x0) / 3],
					p1: [x1, y1]
				});
			}
			return segs;
		}
		const fmtNum = (v) => Math.round(v * 100) / 100;
		/** "320 ms" / "1.24 s" */
		function formatMs(ms) {
			if (ms >= 1e3) return `${(ms / 1e3).toFixed(2)} s`;
			return `${Math.round(ms)} ms`;
		}
		/** "45.2 tok/s" */
		function formatSpeed(v) {
			return `${v.toFixed(1)} tok/s`;
		}
		/** Axis/tooltip formatting for a metric value. */
		function formatMetric(v, metric) {
			return metric === "ttft" ? formatMs(v) : formatSpeed(v);
		}
		/**
		* Legend set for the trend chart: the range's top-`k` models PLUS the last
		* week's top-`weekTopN` guaranteed (a model that took over this week must stay
		* visible in a 30-day view). If the union would exceed `k`, the weakest
		* range-ranked models give up their slots. Result: at most `k` names, ordered
		* by range steps desc.
		*/
		function pickTrendModels(days, dayKeys, weekKeys, k = 5, weekTopN = 3) {
			const totals = summarize(days, dayKeys);
			const ranked = [...totals.entries()].sort((a, b) => b[1].steps - a[1].steps || (a[0] < b[0] ? -1 : 1)).map(([m]) => m);
			const weekTop = pickTopModels(days, weekKeys, weekTopN);
			const selected = new Set(weekTop);
			for (const m of ranked) {
				if (selected.size >= k) break;
				selected.add(m);
			}
			return [...selected].sort((a, b) => (totals.get(b)?.steps ?? 0) - (totals.get(a)?.steps ?? 0) || (a < b ? -1 : 1));
		}
		const r2 = (v) => Math.round(v * 100) / 100;
		/** Split one series into observed runs and estimated (dashed) spans. */
		function splitSeries(points) {
			const runs = [];
			let cur = [];
			points.forEach((v, i) => {
				if (v != null) cur.push({
					i,
					v
				});
				else if (cur.length) {
					runs.push(cur);
					cur = [];
				}
			});
			if (cur.length) runs.push(cur);
			const interpolations = [];
			for (let r = 0; r + 1 < runs.length; r++) {
				const a = runs[r][runs[r].length - 1];
				const b = runs[r + 1][0];
				const idxs = [];
				const values = [];
				for (let i = a.i; i <= b.i; i++) {
					idxs.push(i);
					const t = (i - a.i) / (b.i - a.i);
					values.push(r2(a.v + (b.v - a.v) * t));
				}
				interpolations.push({
					idxs,
					values
				});
			}
			return {
				runs,
				interpolations
			};
		}
		/** Display name for legend chips: only the part after the last "/" (provider
		*  prefixes make real names too long to fit). Bare names stay untouched. */
		function shortModel(name) {
			const i = name.lastIndexOf("/");
			return i >= 0 ? name.slice(i + 1) : name;
		}
		/**
		* Resample the monotone curve at a FIXED number of x samples (M + N L
		* commands). CSS `transition: d` can then morph lines across range switches
		* too — where raw bezier paths (M + n-1 C) have mismatched structures and
		* would jump. Learned from token-pulse's animated trend chart.
		*/
		function seriesPathFixed(points, samples = 89) {
			if (points.length === 0) return "";
			const x0 = points[0][0];
			const x1 = points[points.length - 1][0];
			const head = `M ${fmtNum(x0)} ${fmtNum(points[0][1])}`;
			if (points.length === 1) return head;
			const segs = monotoneSegments(points);
			let out = "";
			let seg = 0;
			for (let s = 1; s <= samples; s++) {
				const x = x0 + (x1 - x0) * s / samples;
				while (seg < segs.length - 1 && x > segs[seg].p1[0]) seg++;
				const g = segs[seg];
				const t = g.p1[0] === g.p0[0] ? 0 : Math.min(1, Math.max(0, (x - g.p0[0]) / (g.p1[0] - g.p0[0])));
				const mt = 1 - t;
				const y = mt * mt * mt * g.p0[1] + 3 * mt * mt * t * g.c1[1] + 3 * mt * t * t * g.c2[1] + t * t * t * g.p1[1];
				out += ` L ${fmtNum(x)} ${fmtNum(y)}`;
			}
			return head + out;
		}
		//#endregion
		//#region src/client/HealthCard.tsx
		/**
		* Health overview card: per-model avg TTFT / avg output speed / sample count
		* over a selectable window (today / 7d / 30d / all), busiest models first.
		*/
		function HealthCard({ t, days, isEn = false }) {
			const [win, setWin] = react.useState(7);
			const todayKey = toDayKey(Date.now());
			const dayKeys = react.useMemo(() => {
				if (win === 0) return [...days.keys()].sort();
				return recentDayKeys(todayKey, win).filter((k) => days.has(k));
			}, [
				days,
				win,
				todayKey
			]);
			const rows = react.useMemo(() => {
				return [...summarize(days, win === 0 ? [...days.keys()] : dayKeys).values()].sort((a, b) => b.steps - a.steps || (a.model < b.model ? -1 : 1)).slice(0, 8);
			}, [
				days,
				dayKeys,
				win
			]);
			const cell = {
				padding: "6px 10px",
				fontSize: 12,
				color: "var(--dsw-alias-label-primary)",
				whiteSpace: "nowrap"
			};
			const headCell = {
				...cell,
				color: "var(--dsw-alias-label-secondary)",
				fontWeight: 600,
				borderBottom: "1px solid var(--dsw-alias-border-l2)",
				textAlign: "left"
			};
			const segStyle = {
				padding: "2px 8px",
				fontSize: 12,
				border: "none",
				cursor: "pointer",
				borderRadius: 5,
				background: "transparent",
				color: "var(--dsw-alias-label-secondary)"
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					border: "1px solid var(--dsw-alias-border-l2)",
					background: "var(--dsw-alias-bg-layer-3)",
					borderRadius: 12,
					overflow: "hidden"
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						padding: "12px 16px 8px",
						borderBottom: "1px solid var(--dsw-alias-border-l2)",
						display: "flex",
						alignItems: "center",
						justifyContent: "space-between",
						gap: 8
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							alignItems: "center",
							gap: 8
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: {
								fontSize: 13,
								fontWeight: 600,
								color: "var(--dsw-alias-label-primary)"
							},
							children: t("card.title")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: {
								fontSize: 12,
								color: "var(--dsw-alias-label-tertiary)"
							},
							children: t("card.hint")
						})]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							display: "inline-flex",
							border: "1px solid var(--dsw-alias-border-l2)",
							borderRadius: 6,
							overflow: "hidden"
						},
						children: [
							1,
							7,
							30,
							0
						].map((w) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							onClick: () => setWin(w),
							style: {
								...segStyle,
								background: win === w ? "var(--dsw-alias-label-primary)" : "transparent",
								color: win === w ? "var(--dsw-alias-bg-layer-3)" : "var(--dsw-alias-label-secondary)"
							},
							children: w === 1 ? t("card.window.today") : w === 7 ? t("card.window.7") : w === 30 ? t("card.window.30") : t("card.window.all")
						}, w))
					})]
				}), rows.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: {
						padding: 24,
						textAlign: "center",
						fontSize: 13,
						color: "var(--dsw-alias-label-tertiary)"
					},
					children: t("card.empty")
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: { overflowX: "auto" },
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("table", {
						style: {
							width: "100%",
							borderCollapse: "collapse"
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("thead", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
								style: headCell,
								children: t("card.model")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
								style: {
									...headCell,
									textAlign: "right"
								},
								children: t("card.speed")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
								style: {
									...headCell,
									textAlign: "right"
								},
								children: t("card.ttft")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
								style: {
									...headCell,
									textAlign: "right"
								},
								children: t("card.samples")
							})
						] }) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("tbody", { children: rows.map((h, i) => {
							const ttft = dayMetric(h, "ttft");
							const speed = dayMetric(h, "speed");
							return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", {
								style: { borderTop: i === 0 ? "none" : "1px solid var(--dsw-alias-border-l2)" },
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
										style: {
											...cell,
											maxWidth: 260,
											overflow: "hidden",
											textOverflow: "ellipsis"
										},
										title: h.model,
										children: h.model
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
										style: {
											...cell,
											textAlign: "right",
											fontVariantNumeric: "tabular-nums"
										},
										children: speed != null ? formatSpeed(speed) : "—"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
										style: {
											...cell,
											textAlign: "right",
											fontVariantNumeric: "tabular-nums"
										},
										children: ttft != null ? formatMs(ttft) : "—"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
										style: {
											...cell,
											textAlign: "right",
											fontVariantNumeric: "tabular-nums",
											color: "var(--dsw-alias-label-secondary)"
										},
										children: h.steps
									})
								]
							}, h.model);
						}) })]
					})
				})]
			});
		}
		//#endregion
		//#region src/client/TrendChart.tsx
		/** Distinct, colorblind-tolerant series colors. */
		const COLORS = [
			"#40c463",
			"#4c8dff",
			"#f6a609",
			"#c956e0",
			"#ff7a59",
			"#26c6da",
			"#ff5c8a",
			"#9ccc65",
			"#7e57c2",
			"#ffd54f"
		];
		/** Round a max up to a friendly axis ceiling. */
		function niceCeil(v) {
			if (v <= 0) return 1;
			const unit = Math.pow(10, Math.floor(Math.log10(v))) / 2;
			return Math.ceil(v / unit) * unit;
		}
		const W = 720;
		const H = 280;
		const PAD = {
			top: 10,
			right: 28,
			bottom: 34,
			left: 84
		};
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
		const modelColorSlot = /* @__PURE__ */ new Map();
		function colorFor(model) {
			let slot = modelColorSlot.get(model);
			if (slot === void 0) {
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
		function TrendChart({ t, days, isEn = false }) {
			const [metric, setMetric] = react.useState("speed");
			const [rangeDays, setRangeDays] = react.useState(7);
			/** how many models to show (5-10); the last week's top-3 always get slots */
			const [count, setCount] = react.useState(5);
			const [hidden, setHidden] = react.useState(/* @__PURE__ */ new Set());
			const [hover, setHover] = react.useState(null);
			/** one-beat overlay of the PREVIOUS layout's marks, fading out on switches */
			const [ghost, setGhost] = react.useState(null);
			const endKey = toDayKey(Date.now());
			const dayKeys = react.useMemo(() => recentDayKeys(endKey, rangeDays), [endKey, rangeDays]);
			const weekKeys = react.useMemo(() => recentDayKeys(endKey, 7), [endKey]);
			const topModels = react.useMemo(() => pickTrendModels(days, dayKeys, weekKeys, count, 3), [
				days,
				dayKeys,
				weekKeys,
				count
			]);
			const series = react.useMemo(() => buildSeries(days, dayKeys, topModels, metric), [
				days,
				dayKeys,
				topModels,
				metric
			]);
			const wrapRef = react.useRef(null);
			const [wrap, setWrap] = react.useState({
				w: 0,
				h: 0
			});
			react.useEffect(() => {
				const el = wrapRef.current;
				if (!el) return;
				const measure = () => setWrap({
					w: el.clientWidth,
					h: el.clientHeight
				});
				measure();
				const ro = new ResizeObserver(measure);
				ro.observe(el);
				return () => ro.disconnect();
			}, []);
			const prevDaysRef = react.useRef(null);
			const prevModelsRef = react.useRef(null);
			const prevTickRef = react.useRef(null);
			const marksRef = react.useRef(null);
			const labelsRef = react.useRef(null);
			const toggle = (model) => {
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
			const allVals = visible.flatMap((s) => s.points.filter((v) => v != null));
			const hasPoints = allVals.length > 0;
			const yMax = niceCeil(Math.max(1, ...allVals));
			const step = dayKeys.length > 1 ? plotW / (dayKeys.length - 1) : plotW;
			const xOf = (i) => PAD.left + (dayKeys.length > 1 ? i * step : plotW / 2);
			const yOf = (v) => PAD.top + (1 - v / yMax) * plotH;
			const fmtDay = (k) => `${Number(k.slice(5, 7))}/${Number(k.slice(8, 10))}`;
			const fmtDayLong = (k) => isEn ? `${Number(k.slice(5, 7))}/${Number(k.slice(8, 10))}` : `${Number(k.slice(5, 7))}月${Number(k.slice(8, 10))}日`;
			const tickEvery = rangeDays === 7 ? 1 : 5;
			const tickIdx = dayKeys.map((_, i) => i).filter((i) => i % tickEvery === 0 || i === dayKeys.length - 1);
			const isNewDay = (k) => prevDaysRef.current !== null && !prevDaysRef.current.includes(k);
			const isNewModel = (m) => prevModelsRef.current !== null && !prevModelsRef.current.includes(m);
			const isNewTick = (k) => prevTickRef.current !== null && !prevTickRef.current.includes(k);
			const enterCls = (isNew) => isNew ? "mhc-fadein" : void 0;
			const onAnimEnd = (e) => {
				e.currentTarget.classList.remove("mhc-fadein");
			};
			react.useEffect(() => {
				marksRef.current = marksNode;
				labelsRef.current = labelsNode;
				prevDaysRef.current = dayKeys;
				prevModelsRef.current = series.map((s) => s.model);
				prevTickRef.current = tickIdx.map((i) => dayKeys[i]);
			});
			react.useEffect(() => {
				if (!ghost) return;
				const timer = setTimeout(() => setGhost(null), GHOST_MS);
				return () => clearTimeout(timer);
			}, [ghost]);
			const switchTo = (patch) => {
				setGhost({
					marks: marksRef.current,
					labels: labelsRef.current
				});
				if (patch.range !== void 0) setRangeDays(patch.range);
				if (patch.metric !== void 0) setMetric(patch.metric);
				if (patch.count !== void 0) setCount(patch.count);
				setHover(null);
			};
			const onMove = (e) => {
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
					py: e.clientY - wrapRect.top
				});
			};
			const hoverRows = hover == null ? [] : visible.map((s) => ({
				model: s.model,
				color: colorOf(s.model),
				value: s.points[hover.idx]
			})).filter((r) => r.value != null).sort((a, b) => metric === "ttft" ? a.value - b.value : b.value - a.value);
			const tipW = 210;
			const tipH = 48 + hoverRows.length * 19;
			const gap = 14;
			const svgW = Math.max(0, wrap.w - 16);
			const colPx = hover == null ? 0 : CX_PAD + xOf(hover.idx) / W * svgW;
			let tipLeft = hover == null ? 0 : colPx + gap;
			if (hover != null && tipLeft + tipW > wrap.w - 4) tipLeft = colPx - gap - tipW;
			tipLeft = Math.max(4, tipLeft);
			const tipTop = hover == null ? 0 : Math.max(4, Math.min(hover.py - tipH / 2, Math.max(4, wrap.h - tipH - 4)));
			const segStyle = {
				padding: "2px 8px",
				fontSize: 12,
				border: "none",
				cursor: "pointer",
				borderRadius: 5,
				background: "transparent",
				color: "var(--dsw-alias-label-secondary)",
				transition: "background .25s ease, color .25s ease"
			};
			const segActive = {
				background: "var(--dsw-alias-label-primary)",
				color: "var(--dsw-alias-bg-layer-3)"
			};
			const labelsNode = /* @__PURE__ */ (0, react_jsx_runtime.jsx)(react_jsx_runtime.Fragment, { children: tickIdx.map((i) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("text", {
				x: 0,
				y: 0,
				textAnchor: "middle",
				fontSize: 14,
				fill: "var(--dsw-alias-label-tertiary)",
				className: enterCls(isNewTick(dayKeys[i])),
				onAnimationEnd: onAnimEnd,
				style: {
					transform: `translate(${xOf(i)}px, 270px)`,
					transition: T_SHIFT
				},
				children: fmtDay(dayKeys[i])
			}, dayKeys[i])) });
			const marksNode = /* @__PURE__ */ (0, react_jsx_runtime.jsx)(react_jsx_runtime.Fragment, { children: series.map((s) => {
				const color = colorOf(s.model);
				const off = hidden.has(s.model);
				const seg = splitSeries(s.points);
				const modelNew = isNewModel(s.model);
				const xy = (idxs, values) => idxs.map((ix, j) => [xOf(ix), yOf(values[j])]);
				const dashProps = {
					fill: "none",
					stroke: color,
					strokeWidth: 2,
					strokeLinecap: "round",
					strokeLinejoin: "round",
					strokeDasharray: "5 4",
					opacity: .35,
					style: { transition: T_D }
				};
				return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("g", {
					opacity: off ? 0 : .8,
					className: enterCls(modelNew),
					onAnimationEnd: onAnimEnd,
					style: { transition: T_FADE },
					children: [
						seg.interpolations.map((g, j) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
							d: seriesPathFixed(xy(g.idxs, g.values)),
							...dashProps
						}, `i${j}`)),
						seg.runs.map((run, j) => run.length > 1 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
							d: seriesPathFixed(run.map((p) => [xOf(p.i), yOf(p.v)])),
							fill: "none",
							stroke: color,
							strokeWidth: 2,
							strokeLinecap: "round",
							strokeLinejoin: "round",
							style: { transition: T_D }
						}, `r${j}`) : null),
						s.points.map((v, i) => v != null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
							cx: xOf(i),
							cy: yOf(v),
							r: hover?.idx === i ? 4 : 2,
							fill: color,
							className: enterCls(!modelNew && isNewDay(dayKeys[i])),
							onAnimationEnd: onAnimEnd,
							style: { transition: T_POINT }
						}, dayKeys[i]) : null)
					]
				}, s.model);
			}) });
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					border: "1px solid var(--dsw-alias-border-l2)",
					background: "var(--dsw-alias-bg-layer-3)",
					borderRadius: 12,
					overflow: "hidden"
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("style", { children: ANIM_CSS }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							padding: "12px 16px 8px",
							borderBottom: "1px solid var(--dsw-alias-border-l2)",
							display: "flex",
							alignItems: "center",
							justifyContent: "space-between",
							gap: 8,
							flexWrap: "wrap"
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								alignItems: "center",
								gap: 8
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: {
									fontSize: 13,
									fontWeight: 600,
									color: "var(--dsw-alias-label-primary)"
								},
								children: t("trend.title")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: {
									fontSize: 12,
									color: "var(--dsw-alias-label-tertiary)"
								},
								children: t("trend.hint")
							})]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								gap: 8,
								flexWrap: "wrap"
							},
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									style: {
										display: "inline-flex",
										border: "1px solid var(--dsw-alias-border-l2)",
										borderRadius: 6,
										overflow: "hidden"
									},
									children: ["speed", "ttft"].map((m) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										onClick: () => switchTo({ metric: m }),
										style: {
											...segStyle,
											...metric === m ? segActive : null
										},
										children: m === "ttft" ? t("trend.metric.ttft") : t("trend.metric.speed")
									}, m))
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									style: {
										display: "inline-flex",
										border: "1px solid var(--dsw-alias-border-l2)",
										borderRadius: 6,
										overflow: "hidden"
									},
									children: [7, 30].map((n) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										onClick: () => switchTo({ range: n }),
										style: {
											...segStyle,
											...rangeDays === n ? segActive : null
										},
										children: n === 7 ? t("trend.range7") : t("trend.range30")
									}, n))
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
									style: {
										display: "inline-flex",
										alignItems: "center",
										gap: 4,
										fontSize: 12,
										color: "var(--dsw-alias-label-secondary)"
									},
									children: [t("trend.count"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
										value: count,
										onChange: (e) => switchTo({ count: Number(e.target.value) }),
										style: {
											padding: "2px 6px",
											fontSize: 12,
											borderRadius: 6,
											border: "1px solid var(--dsw-alias-border-l2)",
											background: "var(--dsw-alias-bg-layer-3)",
											color: "var(--dsw-alias-label-primary)"
										},
										children: [
											5,
											6,
											7,
											8,
											9,
											10
										].map((n) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: n,
											children: n
										}, n))
									})]
								})
							]
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: { padding: "10px 16px 4px" },
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								display: "grid",
								gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))",
								gap: 6
							},
							children: series.map((s) => {
								const off = hidden.has(s.model);
								return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
									onClick: () => toggle(s.model),
									title: s.model,
									style: {
										display: "inline-flex",
										alignItems: "center",
										gap: 6,
										padding: "3px 10px",
										borderRadius: 999,
										border: "1px solid var(--dsw-alias-border-l2)",
										background: "transparent",
										cursor: "pointer",
										opacity: off ? .35 : 1,
										transition: T_FADE,
										fontSize: 13,
										color: "var(--dsw-alias-label-primary)",
										minWidth: 0
									},
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: {
										width: 8,
										height: 8,
										borderRadius: 4,
										background: colorOf(s.model),
										flexShrink: 0
									} }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: {
											flex: 1,
											minWidth: 0,
											overflow: "hidden",
											textOverflow: "ellipsis",
											whiteSpace: "nowrap",
											textAlign: "left",
											textDecoration: off ? "line-through" : "none"
										},
										children: shortModel(s.model)
									})]
								}, s.model);
							})
						}), series.length === 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								fontSize: 10,
								color: "var(--dsw-alias-label-tertiary)",
								marginTop: 4
							},
							children: t("trend.legend.hint")
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						ref: wrapRef,
						style: {
							position: "relative",
							padding: `4px ${CX_PAD}px 12px`
						},
						children: [!hasPoints ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								padding: 24,
								textAlign: "center",
								fontSize: 14,
								color: "var(--dsw-alias-label-tertiary)"
							},
							children: t("trend.empty")
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
							viewBox: `0 0 ${W} ${H}`,
							width: "100%",
							style: { display: "block" },
							role: "img",
							"aria-label": t("trend.title"),
							onMouseMove: onMove,
							onMouseLeave: () => setHover(null),
							children: [
								[
									0,
									.25,
									.5,
									.75,
									1
								].map((f) => {
									const y = PAD.top + (1 - f) * plotH;
									return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("g", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
										d: `M ${PAD.left} ${y} L ${W - PAD.right} ${y}`,
										fill: "none",
										stroke: "var(--dsw-alias-border-l2)",
										strokeWidth: 1,
										strokeDasharray: f === 0 ? void 0 : "3 3",
										style: { transition: T_D }
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("text", {
										x: 0,
										y: 0,
										textAnchor: "end",
										fontSize: 15,
										fill: "var(--dsw-alias-label-tertiary)",
										style: {
											transform: `translate(${PAD.left - 8}px, ${y + 6}px)`,
											transition: T_SHIFT
										},
										children: formatMetric(yMax * f, metric)
									})] }, f);
								}),
								ghost ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("g", {
									className: "mhc-ghost",
									children: ghost.marks
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("g", {
									className: "mhc-ghost",
									children: ghost.labels
								})] }) : null,
								labelsNode,
								marksNode,
								hover != null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
									d: `M ${xOf(hover.idx)} ${PAD.top} L ${xOf(hover.idx)} ${PAD.top + plotH}`,
									fill: "none",
									stroke: "var(--dsw-alias-label-tertiary)",
									strokeWidth: 1,
									strokeDasharray: "4 3",
									opacity: .6,
									style: { transition: T_D }
								}) : null,
								visible.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("text", {
									x: W / 2,
									y: PAD.top + plotH / 2,
									textAnchor: "middle",
									fontSize: 13,
									fill: "var(--dsw-alias-label-tertiary)",
									children: t("trend.legend.hint")
								}) : null
							]
						}), hover != null && topModels.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								position: "absolute",
								left: tipLeft,
								top: tipTop,
								width: tipW,
								opacity: .7,
								pointerEvents: "none",
								background: "var(--dsw-alias-bg-layer-3)",
								border: "1px solid var(--dsw-alias-border-l2)",
								borderRadius: 8,
								boxShadow: "0 6px 18px rgba(0,0,0,0.25)",
								padding: "6px 10px",
								fontSize: 11,
								lineHeight: 1.5,
								color: "var(--dsw-alias-label-primary)",
								zIndex: 5
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: {
									fontWeight: 600,
									fontSize: 12,
									marginBottom: 4
								},
								children: fmtDayLong(dayKeys[hover.idx])
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: {
									display: "flex",
									flexDirection: "column",
									gap: 3
								},
								children: hoverRows.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: { color: "var(--dsw-alias-label-tertiary)" },
									children: t("trend.empty")
								}) : hoverRows.map((r) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: {
										display: "flex",
										alignItems: "center",
										gap: 6
									},
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: {
											width: 7,
											height: 7,
											borderRadius: 4,
											background: r.color,
											flexShrink: 0
										} }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											style: {
												flex: 1,
												minWidth: 0,
												overflow: "hidden",
												textOverflow: "ellipsis",
												whiteSpace: "nowrap"
											},
											title: r.model,
											children: shortModel(r.model)
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											style: {
												fontWeight: 500,
												whiteSpace: "nowrap"
											},
											children: formatMetric(r.value, metric)
										})
									]
								}, r.model))
							})]
						}) : null]
					})
				]
			});
		}
		//#endregion
		//#region src/client/SpeedTest.tsx
		/** Count-up for the TTFT chip (ease-out cubic). */
		function useCountUp(target, run, dur = 800) {
			const [v, setV] = react.useState(0);
			react.useEffect(() => {
				if (!run || target == null) {
					setV(0);
					return;
				}
				let raf = 0;
				const t0 = performance.now();
				const tick = (now) => {
					const p = Math.min(1, (now - t0) / dur);
					setV(target * (1 - Math.pow(1 - p, 3)));
					if (p < 1) raf = requestAnimationFrame(tick);
				};
				raf = requestAnimationFrame(tick);
				return () => cancelAnimationFrame(raf);
			}, [
				target,
				run,
				dur
			]);
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
		function SpeedTest({ t, isEn = false, open, onClose }) {
			const [models, setModels] = react.useState([]);
			const [sel, setSel] = react.useState("");
			const [st, setSt] = react.useState(null);
			const [running, setRunning] = react.useState(false);
			const [err, setErr] = react.useState(null);
			const [elapsed, setElapsed] = react.useState(0);
			const alive = react.useRef(true);
			react.useEffect(() => {
				if (!open) return;
				alive.current = true;
				(async () => {
					try {
						const res = await fetch("/api/dsh-model-health/speed-test", { cache: "no-store" });
						if (!res.ok) return;
						const j = await res.json();
						if (!alive.current) return;
						setModels(Array.isArray(j.models) ? j.models.filter((m) => m?.provider && m?.model) : []);
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
			react.useEffect(() => {
				if (!open || !running) return;
				const startedAt = st?.startedAt ?? Date.now();
				const timer = setInterval(() => setElapsed(Date.now() - startedAt), 100);
				return () => clearInterval(timer);
			}, [
				open,
				running,
				st?.startedAt
			]);
			const groups = react.useMemo(() => {
				const m = /* @__PURE__ */ new Map();
				for (const km of models) {
					const key = km.provider || "—";
					const arr = m.get(key) ?? [];
					arr.push(km);
					m.set(key, arr);
				}
				return [...m.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1);
			}, [models]);
			const start = async () => {
				if (running || !sel) return;
				const [provider, model] = sel.split("|");
				setErr(null);
				setRunning(true);
				setElapsed(0);
				try {
					const j = await (await fetch("/api/dsh-model-health/speed-test", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							provider,
							model
						})
					})).json();
					if (!alive.current) return;
					setSt(j.test ?? null);
					if (!j.ok) {
						setRunning(false);
						setErr(j.error ?? "busy");
						return;
					}
					while (alive.current) {
						await new Promise((r) => setTimeout(r, 500));
						const pj = await (await fetch("/api/dsh-model-health/speed-test", { cache: "no-store" })).json();
						if (!alive.current) return;
						setSt(pj.test ?? null);
						if (pj.test?.status !== "running") break;
					}
				} catch (e) {
					setErr(String(e?.message ?? e));
				} finally {
					if (alive.current) setRunning(false);
				}
			};
			const done = st?.status === "done";
			const failed = st?.status === "error" || !!err;
			const live = st?.tokPerSec ?? null;
			const shown = done || running ? live != null ? live : 0 : null;
			const gaugeMax = Math.max(150, Math.ceil((live ?? 0) * 1.25 / 50) * 50);
			const progress = shown == null ? 0 : Math.min(1, shown / gaugeMax);
			const ttftShown = useCountUp(st?.ttftMs ?? null, done || running);
			if (!open) return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				onClick: onClose,
				style: {
					position: "fixed",
					inset: 0,
					zIndex: 60,
					background: "rgba(0,0,0,0.45)",
					display: "flex",
					alignItems: "center",
					justifyContent: "center"
				},
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					role: "dialog",
					"aria-modal": "true",
					"aria-label": t("speed.title"),
					onClick: (e) => e.stopPropagation(),
					style: {
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
						justifyContent: "space-between",
						gap: 18
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								alignItems: "center",
								justifyContent: "space-between"
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								style: {
									fontSize: 15,
									fontWeight: 600,
									color: "var(--dsw-alias-label-primary)"
								},
								children: ["⚡ ", t("speed.title")]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								onClick: onClose,
								"aria-label": "close",
								style: {
									border: "none",
									background: "transparent",
									fontSize: 16,
									cursor: "pointer",
									color: "var(--dsw-alias-label-tertiary)"
								},
								children: "✕"
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								gap: 8
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
								value: sel,
								onChange: (e) => setSel(e.target.value),
								style: {
									padding: "6px 10px",
									fontSize: 13,
									borderRadius: 8,
									border: "1px solid var(--dsw-alias-border-l2)",
									background: "var(--dsw-alias-bg-layer-3)",
									color: "var(--dsw-alias-label-primary)",
									flex: 1,
									minWidth: 0
								},
								disabled: running,
								children: [models.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "",
									children: t("speed.empty")
								}) : null, groups.map(([provider, list]) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("optgroup", {
									label: provider,
									children: list.map((m) => {
										const label = m.model.startsWith(`${provider}/`) ? m.model.slice(provider.length + 1) : m.model;
										return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: `${m.provider}|${m.model}`,
											children: label
										}, `${m.provider}|${m.model}`);
									})
								}, provider))]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								onClick: () => void start(),
								disabled: running || !sel,
								style: {
									padding: "6px 18px",
									fontSize: 13,
									borderRadius: 8,
									border: "1px solid var(--dsw-alias-border-l2)",
									background: running ? "var(--dsw-alias-bg-layer-2)" : "var(--dsw-alias-label-primary)",
									color: running ? "var(--dsw-alias-label-secondary)" : "var(--dsw-alias-bg-layer-3)",
									cursor: running ? "wait" : "pointer",
									whiteSpace: "nowrap"
								},
								children: running ? `${t("speed.running")} ${(elapsed / 1e3).toFixed(1)}s` : t("speed.run")
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								display: "flex",
								justifyContent: "center",
								paddingTop: 4
							},
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									position: "relative",
									width: 340
								},
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
										viewBox: "0 0 220 126",
										width: "100%",
										style: { display: "block" },
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
												d: `M 6 116 A ${ARC_R} ${ARC_R} 0 0 1 214 116`,
												fill: "none",
												stroke: "var(--dsw-alias-border-l2)",
												strokeWidth: 12,
												strokeLinecap: "round"
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
												d: `M 6 116 A ${ARC_R} ${ARC_R} 0 0 1 214 116`,
												fill: "none",
												stroke: failed ? "#e5534b" : done ? "#40c463" : "#4c8dff",
												strokeWidth: 12,
												strokeLinecap: "round",
												strokeDasharray: ARC_LEN,
												strokeDashoffset: ARC_LEN * (1 - (running || done ? progress : 0)),
												style: { transition: "stroke-dashoffset .6s ease, stroke .3s ease" }
											}),
											running ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
												cx: 110,
												cy: 116,
												r: 5,
												fill: "#4c8dff",
												className: "mhc-pulse"
											}) : null
										]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										style: {
											position: "absolute",
											left: 0,
											right: 0,
											bottom: 6,
											textAlign: "center"
										},
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											style: {
												fontSize: 48,
												fontWeight: 700,
												fontVariantNumeric: "tabular-nums",
												color: "var(--dsw-alias-label-primary)",
												lineHeight: 1
											},
											children: shown == null ? "—" : shown.toFixed(1)
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											style: {
												fontSize: 12,
												color: "var(--dsw-alias-label-tertiary)",
												marginTop: 4
											},
											children: "tok/s"
										})]
									}),
									running ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "mhc-spin",
										style: {
											position: "absolute",
											right: 18,
											top: 4,
											width: 14,
											height: 14,
											border: "2px solid var(--dsw-alias-border-l2)",
											borderTopColor: "#4c8dff",
											borderRadius: "50%",
											display: "inline-block"
										}
									}) : null
								]
							})
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								gap: 10,
								justifyContent: "center",
								flexWrap: "wrap"
							},
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									style: {
										fontSize: 12,
										padding: "4px 12px",
										borderRadius: 999,
										border: "1px solid var(--dsw-alias-border-l2)",
										color: "var(--dsw-alias-label-secondary)"
									},
									children: [
										t("speed.ttft"),
										": ",
										st?.ttftMs != null ? formatMs(ttftShown) : "—"
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									style: {
										fontSize: 12,
										padding: "4px 12px",
										borderRadius: 999,
										border: "1px solid var(--dsw-alias-border-l2)",
										color: "var(--dsw-alias-label-secondary)"
									},
									children: [
										isEn ? "Output" : "输出",
										": ",
										st?.outputTokens ?? 0,
										" tok"
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: {
										fontSize: 12,
										padding: "4px 12px",
										borderRadius: 999,
										border: "1px solid var(--dsw-alias-border-l2)",
										color: "var(--dsw-alias-label-secondary)"
									},
									children: st?.model || "—"
								})
							]
						}),
						failed ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								fontSize: 12,
								color: "#e5534b",
								textAlign: "center"
							},
							children: [
								t("speed.failed"),
								": ",
								err ?? st?.error
							]
						}) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								fontSize: 11,
								color: "var(--dsw-alias-label-tertiary)",
								textAlign: "center"
							},
							children: t("speed.hint")
						})
					]
				})
			});
		}
		//#endregion
		//#region src/client/hooks.ts
		const LS_INTERVAL_KEY = "dsh-model-health:autoRefreshMinutes";
		function getAutoRefreshMinutes() {
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
		function setAutoRefreshMinutes(minutes) {
			try {
				localStorage.setItem(LS_INTERVAL_KEY, String(minutes));
			} catch {}
		}
		const API_TIMEOUT_MS = 5e3;
		async function fetchFromApi() {
			const ctrl = new AbortController();
			const timer = setTimeout(() => ctrl.abort(), API_TIMEOUT_MS);
			try {
				const res = await fetch("/api/dsh-model-health/health.json", {
					cache: "no-store",
					signal: ctrl.signal
				});
				if (!res.ok) return null;
				const json = await res.json();
				if (!json || !Array.isArray(json.days)) return null;
				if (json.ready === false) return { __notReady: true };
				const days = /* @__PURE__ */ new Map();
				for (const d of json.days) {
					const models = /* @__PURE__ */ new Map();
					for (const [model, h] of Object.entries(d.models ?? {})) models.set(model, {
						model,
						ttftSumMs: h.ttftSumMs ?? 0,
						ttftCount: h.ttftCount ?? 0,
						decodeMsSum: h.decodeMsSum ?? 0,
						decodeTokensSum: h.decodeTokensSum ?? 0,
						steps: h.steps ?? 0
					});
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
		function useHealthData() {
			const [data, setData] = react.useState(null);
			const [refreshing, setRefreshing] = react.useState(false);
			const [lastRefresh, setLastRefresh] = react.useState(null);
			const aliveRef = react.useRef(true);
			const busyRef = react.useRef(false);
			const doFetch = react.useCallback(async () => {
				if (busyRef.current) return;
				busyRef.current = true;
				setRefreshing(true);
				try {
					const result = await fetchFromApi();
					if (!aliveRef.current) return;
					if (result && "__notReady" in result) {
						setTimeout(() => {
							busyRef.current = false;
							doFetch();
						}, 2e3);
						return;
					}
					if (result) {
						setData(result);
						setLastRefresh((/* @__PURE__ */ new Date()).toLocaleTimeString());
					}
				} finally {
					busyRef.current = false;
					if (aliveRef.current) setRefreshing(false);
				}
			}, []);
			react.useEffect(() => {
				aliveRef.current = true;
				doFetch();
				return () => {
					aliveRef.current = false;
				};
			}, [doFetch]);
			react.useEffect(() => {
				const mins = getAutoRefreshMinutes();
				if (mins <= 0) return;
				const timer = setInterval(() => void doFetch(), mins * 6e4);
				return () => clearInterval(timer);
			}, [doFetch]);
			return {
				data,
				refreshing,
				lastRefresh,
				refresh: doFetch
			};
		}
		//#endregion
		//#region src/client/SettingsSection.tsx
		function SettingsSection({ t }) {
			const [speedOpen, setSpeedOpen] = react.useState(false);
			const { data, refreshing, lastRefresh, refresh } = useHealthData();
			const [intervalMins, setIntervalMins] = react.useState(() => getAutoRefreshMinutes());
			const [lang, setLang] = react.useState(() => {
				try {
					return localStorage.getItem("dsh-model-health:lang") === "en" ? "en" : "zh";
				} catch {
					return "zh";
				}
			});
			const tt = (key, params) => lang === "en" ? enOf(key, params) : t(key, params);
			const handleIntervalChange = (e) => {
				const v = Number(e.target.value);
				setAutoRefreshMinutes(v);
				setIntervalMins(v);
			};
			const handleLangChange = (e) => {
				const v = e.target.value;
				setLang(v);
				try {
					localStorage.setItem("dsh-model-health:lang", v);
				} catch {}
			};
			const selectStyle = {
				padding: "4px 8px",
				fontSize: 12,
				borderRadius: 6,
				border: "1px solid var(--dsw-alias-border-l2)",
				background: "var(--dsw-alias-bg-layer-3)",
				color: "var(--dsw-alias-label-primary)"
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				"aria-labelledby": "model-health-title",
				style: {
					display: "flex",
					flexDirection: "column",
					gap: 16
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							alignItems: "flex-start",
							justifyContent: "space-between",
							gap: 12
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("h2", {
							id: "model-health-title",
							style: {
								margin: 0,
								fontSize: 16,
								fontWeight: 600,
								color: "var(--dsw-alias-label-primary)"
							},
							children: [tt("health.title"), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								style: {
									marginLeft: 8,
									fontSize: 11,
									fontWeight: 400,
									color: "var(--dsw-alias-label-tertiary)",
									verticalAlign: "middle"
								},
								children: ["v", "0.1.0-beta"]
							})]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: {
								margin: "4px 0 0",
								fontSize: 13,
								color: "var(--dsw-alias-label-tertiary)",
								lineHeight: 1.5
							},
							children: tt("health.subtitle")
						})] }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							style: {
								display: "flex",
								alignItems: "center",
								gap: 6,
								fontSize: 12,
								color: "var(--dsw-alias-label-secondary)",
								flexShrink: 0
							},
							children: [lang === "en" ? "Language" : "语言", /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
								value: lang,
								onChange: handleLangChange,
								style: selectStyle,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "zh",
									children: "中文"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "en",
									children: "English"
								})]
							})]
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							alignItems: "center",
							gap: 8,
							flexWrap: "wrap"
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
								onClick: () => setSpeedOpen(true),
								style: {
									padding: "6px 14px",
									fontSize: 13,
									borderRadius: 8,
									border: "1px solid var(--dsw-alias-border-l2)",
									background: "var(--dsw-alias-bg-layer-3)",
									color: "var(--dsw-alias-label-primary)",
									cursor: "pointer"
								},
								children: ["⚡ ", tt("speed.title")]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								onClick: () => void refresh(),
								disabled: refreshing,
								style: {
									padding: "6px 14px",
									fontSize: 13,
									borderRadius: 8,
									border: "1px solid var(--dsw-alias-border-l2)",
									background: refreshing ? "var(--dsw-alias-bg-layer-2)" : "var(--dsw-alias-bg-layer-3)",
									color: "var(--dsw-alias-label-primary)",
									cursor: refreshing ? "wait" : "pointer"
								},
								children: lang === "en" ? refreshing ? "Refreshing…" : "Refresh" : refreshing ? tt("health.refreshing") : tt("health.refresh")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: {
									fontSize: 12,
									color: "var(--dsw-alias-label-tertiary)"
								},
								children: lastRefresh ? lang === "en" ? `Last refresh: ${lastRefresh}` : tt("health.lastRefresh", { time: lastRefresh }) : ""
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: { flex: 1 } }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								style: {
									display: "flex",
									alignItems: "center",
									gap: 6,
									fontSize: 12,
									color: "var(--dsw-alias-label-secondary)"
								},
								children: [tt("health.autoRefresh"), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
									value: intervalMins,
									onChange: handleIntervalChange,
									style: selectStyle,
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: 0,
											children: tt("health.autoRefresh.off")
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: 5,
											children: "5 min"
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: 10,
											children: "10 min"
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: 30,
											children: "30 min"
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: 60,
											children: "60 min"
										})
									]
								})]
							})
						]
					}),
					data && data.days.size > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(HealthCard, {
						t: tt,
						days: data.days,
						isEn: lang === "en"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TrendChart, {
						t: tt,
						days: data.days,
						isEn: lang === "en"
					})] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							border: "1px solid var(--dsw-alias-border-l2)",
							background: "var(--dsw-alias-bg-layer-3)",
							borderRadius: 12,
							padding: 24,
							color: "var(--dsw-alias-label-tertiary)",
							fontSize: 13
						},
						children: tt("health.empty")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SpeedTest, {
						t: tt,
						isEn: lang === "en",
						open: speedOpen,
						onClose: () => setSpeedOpen(false)
					})
				]
			});
		}
		/** English strings for keys the host locale may not carry (lang=EN mode). */
		function enOf(key, params) {
			let s = (globalThis.__mh_en ?? {})[key] ?? key;
			if (params) for (const [k, v] of Object.entries(params)) s = s.replace(`{${k}}`, String(v));
			return s;
		}
		//#endregion
		//#region src/client/locales.ts
		const zh = {
			"nav": "模型健康度",
			"health.title": "模型健康度",
			"health.subtitle": "基于本地会话日志被动记录：首字延迟（TTFT）与输出速度，北京时间自然日分桶，零网络零计费。",
			"health.empty": "暂无健康度数据，开始一次对话后这里会出现记录。",
			"health.refresh": "刷新",
			"health.refreshing": "刷新中…",
			"health.lastRefresh": "上次刷新：{time}",
			"health.autoRefresh": "自动刷新",
			"health.autoRefresh.off": "关闭",
			"card.title": "健康度概览",
			"card.window.today": "今日",
			"card.window.7": "近7天",
			"card.window.30": "近30天",
			"card.window.all": "全部",
			"card.model": "模型",
			"card.ttft": "首字延迟",
			"card.speed": "输出速度",
			"card.samples": "样本",
			"card.empty": "所选范围内暂无数据",
			"card.hint": "均值 · 样本 = LLM 步数",
			"trend.title": "健康趋势",
			"trend.hint": "按模型的每日均值",
			"trend.metric.ttft": "首字延迟",
			"trend.metric.speed": "输出速度",
			"trend.count": "模型数",
			"trend.range7": "近一周",
			"trend.range30": "近一月",
			"trend.empty": "所选范围内暂无数据",
			"trend.legend.hint": "点击图例可显示/隐藏",
			"speed.title": "模型测速",
			"speed.hint": "轻量探测：一条数数指令，约消耗几十个 token",
			"speed.model": "模型",
			"speed.run": "开始测速",
			"speed.running": "测速中",
			"speed.ttft": "首字延迟",
			"speed.output": "输出速度",
			"speed.failed": "测速失败",
			"speed.empty": "暂无历史模型，先跑一次对话"
		};
		const en = {
			"nav": "Model Health",
			"health.title": "Model Health",
			"health.subtitle": "Passively recorded from local session logs: TTFT and output speed, bucketed by Asia/Shanghai days. No network, no billing.",
			"health.empty": "No health data yet. Start a conversation and records will appear here.",
			"health.refresh": "Refresh",
			"health.refreshing": "Refreshing…",
			"health.lastRefresh": "Last refresh: {time}",
			"health.autoRefresh": "Auto refresh",
			"health.autoRefresh.off": "Off",
			"card.title": "Health Overview",
			"card.window.today": "Today",
			"card.window.7": "7 days",
			"card.window.30": "30 days",
			"card.window.all": "All",
			"card.model": "Model",
			"card.ttft": "TTFT",
			"card.speed": "Speed",
			"card.samples": "Samples",
			"card.empty": "No data in this range",
			"card.hint": "Averages · samples = LLM steps",
			"trend.title": "Health Trend",
			"trend.hint": "Daily averages per model",
			"trend.metric.ttft": "TTFT",
			"trend.metric.speed": "Output speed",
			"trend.count": "Models",
			"trend.range7": "7 days",
			"trend.range30": "30 days",
			"trend.empty": "No data in this range",
			"trend.legend.hint": "Click legend to toggle",
			"speed.title": "Model Speed Test",
			"speed.hint": "Light probe: one counting prompt, costs a few dozen tokens",
			"speed.model": "Model",
			"speed.run": "Run test",
			"speed.running": "Testing",
			"speed.ttft": "TTFT",
			"speed.output": "Output speed",
			"speed.failed": "Test failed",
			"speed.empty": "No known models yet"
		};
		//#endregion
		//#region src/client/index.ts
		const NS = "dsh-model-health";
		const inject = ["locale", "slots"];
		const NAV_CSS = `
[data-dsh-model-health-nav] > svg:first-child { display: none; }
[data-dsh-model-health-nav]::before {
  content: ''; flex: none; width: 16px; height: 16px; background: currentColor;
  -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M22 12h-4l-3 9L9 3l-3 9H2'/%3E%3C/svg%3E") center / contain no-repeat;
  mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M22 12h-4l-3 9L9 3l-3 9H2'/%3E%3C/svg%3E") center / contain no-repeat;
}
`;
		function injectNavCss() {
			if (typeof document === "undefined") return;
			const id = "dsh-model-health-nav-css";
			if (document.getElementById(id)) return;
			const el = document.createElement("style");
			el.id = id;
			el.textContent = NAV_CSS;
			document.head.appendChild(el);
		}
		let t_global = (k) => k;
		function markNavRow() {
			if (typeof document === "undefined") return;
			const labels = [
				t_global("nav"),
				"模型健康度",
				"Model Health"
			].filter(Boolean);
			for (const l of labels) {
				const btn = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim().includes(l));
				if (btn) btn.setAttribute("data-dsh-model-health-nav", "");
			}
		}
		function apply(ctx) {
			injectNavCss();
			globalThis.__mh_en = en;
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "dsh-model-health: dictionaries");
			const t = ctx.locale.bind(NS);
			t_global = t;
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "modelHealth",
				order: 56,
				label: () => t("nav"),
				locale: NS
			}, (props) => {
				setTimeout(markNavRow, 50);
				return react.createElement(SettingsSection, {
					t,
					ctx,
					...props
				});
			}));
			if (typeof document !== "undefined") {
				const mo = new MutationObserver(() => markNavRow());
				mo.observe(document.documentElement, {
					childList: true,
					subtree: true
				});
				setTimeout(() => mo.disconnect(), 3e4);
			}
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map