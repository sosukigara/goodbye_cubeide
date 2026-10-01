// Graph panel (D1): a real webview panel in the editor area, not a thumbnail
// inside the 300px sidebar. The sidebar keeps the control/status surface; this
// file owns the whole graph surface — axes, legend, readout, controls.
//
// Host -> webview messages consumed (design 3.3):
//   live-sample   { samples: LiveSample[] }                    appended, no redraw
//   live-types    { tree, index: Record<string, LeafMeta> }     type decoding
//   graph-series  { series: {name,color,visible}[] }            authoritative set
// webview -> host messages produced (see parseGraphPanelMessage):
//   graph-add / graph-remove   { name }   one message per leaf
//   graph-download-csv         {}         no payload: the host owns the archive
//   var-pick                   { query }  the series input asks the host for the
//                                         QuickPick, as the variable tab does
//
// Value decoding follows 3.4: hex -> BigInt, float little-endian through a
// DataView, enum through the enumerator table, signed scalars via asIntN.
// Raw hex is never plotted as-is (the old num() did that and turned a float
// into its bit pattern).
//
// The script below is written without template literals on purpose: it is
// inlined into a <script> block, so `${` and backticks would break the host
// string builder and a stray `</script>` would truncate the page.

import { NAME_PATH_JS } from "./namePath.js";
import { EXT_VERSION } from "../version.js";

/** viewType the host registers in the editor area. */
export const GRAPH_PANEL_VIEW_TYPE = "stm32ext.graph";
export const GRAPH_PANEL_TITLE = "STM32 Graph";

/** Default series colours. The host may override per series via `graph-series`. */
export const GRAPH_SERIES_COLORS: readonly string[] = [
  "#4c9aff", "#f78166", "#c586c0", "#6ac47c", "#d7ba7d", "#9cdcfe",
  "#e5e510", "#ce9178", "#b5cea8", "#f44747", "#8bd5ca", "#ffea7f",
];

/**
 * Time windows the selector offers, in ms. Single source of truth: the
 * `<option>` list AND the webview's per-series retention cap are both derived
 * from it, so adding a window can never leave the buffer too short to fill it.
 */
const GRAPH_WINDOW_OPTIONS: readonly number[] = [1000, 5000, 10000, 30000, 60000];
const DEFAULT_WINDOW_MS = 10000;
/** Fastest rate the sidecar can run at: stm32ext.pollHz has a maximum of 200. */
const POLL_HZ_MAX = 200;
/** Points dropped per prune tick, and the headroom the cap keeps above the window. */
const PRUNE_BATCH = 256;
/**
 * Points one series retains. INVARIANT: at least
 * (widest offered window / 1000) x poll rate, so no selectable window can be
 * silently shorter than the user asked for, plus one prune batch so the batched
 * trim can never dip below it either. 1500 satisfied that only at the old 50Hz
 * default (30s): at 100Hz it is 15s, which is why 30s and 60s could not be
 * honoured. This is a backstop, not the working size: prune() also cuts the
 * stale prefix on every sample, so the buffer settles at window x rate.
 */
const MAX_POINTS = Math.max(...GRAPH_WINDOW_OPTIONS) / 1000 * POLL_HZ_MAX + PRUNE_BATCH;

const GRAPH_CSS = `<style>`
  + `html,body{height:100%}`
  + `body{--axis-text:var(--vscode-foreground,#ccc);font-family:var(--vscode-font-family,sans-serif);font-size:var(--vscode-font-size,13px);color:var(--vscode-foreground,#ccc);margin:0;padding:16px 20px 10px;line-height:1.4;display:flex;flex-direction:column;box-sizing:border-box;overflow:hidden}`
  + `h1{font-size:1.1em;font-weight:700;margin:0 0 2px;padding:0 0 0 10px;border-left:3px solid var(--vscode-textLink-foreground,#3794ff);letter-spacing:.03em}`
  + `h1 .ver{font-weight:400;font-size:.8em;opacity:.5}`
  + `.bar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:12px 0 10px;padding:10px 12px;background:rgba(127,127,127,.07);border:1px solid rgba(127,127,127,.2);border-radius:10px}`
  + `.grp{display:flex;gap:6px;align-items:center;flex-wrap:wrap}`
  + `.lbl{font-size:.82em;font-weight:700;letter-spacing:.08em;white-space:nowrap}`
  + `input,select,button{font:inherit;background:var(--vscode-input-background,#3c3c3c);color:var(--vscode-input-foreground,#ccc);border:1px solid var(--vscode-input-border,rgba(128,128,128,.35));border-radius:6px;padding:4px 8px}`
  + `button{cursor:pointer;background:var(--vscode-button-secondaryBackground,#3a3d41);color:var(--vscode-button-secondaryForeground,#ccc);border-color:transparent;transition:filter .12s ease}`
  + `button:hover{filter:brightness(1.15)}`
  + `button.primary{background:var(--vscode-button-background,#0e639c);color:var(--vscode-button-foreground,#fff)}`
  + `button:focus-visible,input:focus-visible,select:focus-visible{outline:1px solid var(--vscode-focusBorder,#007fd4)}`
  + `.wrap{flex:1 1 auto;min-height:180px;position:relative;margin:2px 0 8px}`
  + `canvas{position:absolute;left:0;top:0;width:100%;height:100%;display:block;border:1px solid rgba(127,127,127,.22);border-radius:10px;background:var(--vscode-editor-background,#1e1e1e)}`
  + `ul.series{list-style:none;margin:2px 0 0;padding:0;display:flex;flex-wrap:wrap;gap:6px}`
  + `ul.series li{display:flex;align-items:center;gap:7px;border:1px solid rgba(127,127,127,.25);background:rgba(127,127,127,.08);border-radius:999px;padding:3px 6px 3px 10px;cursor:pointer;max-width:100%;transition:background .12s ease}`
  + `ul.series li:hover{background:rgba(127,127,127,.16)}`
  + `ul.series li[data-visible="false"]{opacity:.4}`
  + `ul.series li[data-kind="enum"]{border-style:dashed}`
  + `ul.series li button{padding:0 7px;line-height:1.3;border-radius:999px}`
  + `.sw{width:10px;height:10px;border-radius:3px;display:inline-block;flex:0 0 auto}`
  + `span.nm{font-family:var(--vscode-editor-font-family,monospace);font-size:.9em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`
  + `table.read{width:100%;border-collapse:separate;border-spacing:0;margin-top:8px;font-size:.9em;background:rgba(127,127,127,.05);border:1px solid rgba(127,127,127,.2);border-radius:10px;overflow:hidden}`
  + `table.read th{font-weight:700;font-size:.8em;letter-spacing:.08em;text-align:right;padding:7px 10px;background:rgba(127,127,127,.08)}`
  + `table.read th:first-child{text-align:left}`
  + `table.read td{padding:5px 10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:44%}`
  + `table.read tbody tr:hover td{background:rgba(127,127,127,.09)}`
  + `td.n{width:auto}`
  + `td.v{font-family:var(--vscode-editor-font-family,monospace);font-variant-numeric:tabular-nums;text-align:right;width:104px;font-weight:600}`
  + `td.u{width:64px;text-align:right}`
  + `.msg{min-height:1.2em;margin:2px 0;font-size:.9em}`
  + `.err{color:var(--vscode-testing-iconFailed,#f14c4c)}`
  + `.note{opacity:.75}`
  + `footer{display:flex;gap:14px;flex-wrap:wrap;align-items:baseline;font-size:.85em;opacity:.8;margin-top:4px}`
  + `footer .stat{font-family:var(--vscode-editor-font-family,monospace);font-variant-numeric:tabular-nums}`
  + `::-webkit-scrollbar{width:10px;height:10px}`
  + `::-webkit-scrollbar-thumb{background:rgba(127,127,127,.35);border-radius:999px;border:2px solid transparent;background-clip:content-box}`
  + `::-webkit-scrollbar-track{background:transparent}`
  + `</style>`;

// The whole webview program. Kept as one string so the host owns exactly one
// place where HTML and script can drift apart.
const GRAPH_SCRIPT = `var __SEED = __GRAPH_SEED__;`
  // Shared hierarchy logic (src/live/namePath.ts): concatenated, not nested
  // as a template literal, so `${`/backticks can never break the builder.
  + NAME_PATH_JS
  + `const vscode = acquireVsCodeApi();`
+ `const q = (s) => document.querySelector(s);`
+ `const mk = (t) => document.createElement(t);`
+ `const clamp = (v, lo, hi) => (v < lo ? lo : (v > hi ? hi : v));`

  + `const PALETTE = ['#4c9aff', '#f78166', '#c586c0', '#6ac47c', '#d7ba7d', '#9cdcfe', '#e5e510', '#ce9178', '#b5cea8', '#f44747', '#8bd5ca', '#ffea7f'];`
  // Retention, interpolated by the host from the offered window list: the cap is
  // widest window x fastest poll rate + one prune batch, so it can never be
  // shorter than the window the user selected. prune() below also drops the
  // stale prefix on every sample, so a narrower window costs less than the cap.
  + `const MAX_POINTS = __MAX_POINTS__;`
  + `const PRUNE_BATCH = __PRUNE_BATCH__;`
  // Enum lanes under the numeric plot: four is as many as stay legible in the
  // space the footer leaves below it.
  + `const MAX_LANES = 4;`
  // One readout per host poll period. The sidecar runs at 100Hz and the host
  // tail tick is 10ms, so anything slower here hides samples that have already
  // been read. Batches inside one window coalesce into a single readout.
+ `const READOUT_MS = 10;`
  + `const STALE_SLACK = 0.05;`
  + `const DEF_W = 960;`
  + `const DEF_H = 440;`
  + `const PAD = { l: 66, r: 12, t: 12, b: 26 };`
  + `const LANE_H = 20;`
  + `const GRID = 'rgba(128,128,128,0.28)';`
  // Axis text is not a grid line. GRID at 0.28 alpha is unreadable as a digit,
  // so the labels take the page foreground: the value the token resolves to on
  // the active theme, read back from CSS because canvas fillStyle ignores
  // custom properties.
  + `let AXIS_TEXT = '#cccccc';`
  + `function resolveAxisText() {`
  + ` try {`
  + `  if (typeof getComputedStyle !== 'function') return;`
  + `  const cs = getComputedStyle(document.body);`
  + `  const named = String(cs.getPropertyValue('--axis-text') || '').trim();`
  + `  if (named !== '') { AXIS_TEXT = named; return; }`
  + `  const fg = String(cs.color || '').trim();`
  + `  if (fg !== '') AXIS_TEXT = fg;`
  + ` } catch (e) { /* keep the last good colour */ }`
  + `}`
  // DWARF carries no unit, so the unit is derived from the symbol suffix.
  + `const UNITS = [['_khz', 'kHz'], ['_hz', 'Hz'], ['_ms', 'ms'], ['_us', 'us'], ['_ns', 'ns'], ['_pct', '%'], ['_percent', '%'], ['_degc', 'degC'], ['_celsius', 'degC'], ['_temp', 'degC'], ['_volt', 'V'], ['_voltage', 'V'], ['_current', 'A'], ['_amps', 'A'], ['_rpm', 'rpm'], ['_mm', 'mm']];`
  + `const G = { series: new Map(), order: [], types: new Map(), windowMs: __DEFAULT_WINDOW_MS__, queued: 0, readoutQueued: 0, dpr: 0, unknown: new Set() };`
  + `const canvas = q('[data-testid="graph-canvas"]');`
  + `const wrap = q('[data-testid="graph-wrap"]');`
  + `const legend = q('[data-testid="graph-selected"]');`
  + `const readout = q('[data-testid="graph-readout"]');`
  + `const errBox = q('[data-testid="graph-error"]');`
+ `const noteBox = q('[data-testid="graph-note"]');`
+ `const unitBox = q('[data-testid="graph-y-unit"]');`
+ `const statusBox = q('[data-testid="graph-status"]');`
+ `const picker = q('[data-testid="graph-var-picker"]');`

  + `const winSel = q('[data-testid="graph-window"]');`
  + `const ctx = canvas ? canvas.getContext('2d') : null;`
  + `const unitOf = (name) => { const n = String(name).toLowerCase(); for (let i = 0; i < UNITS.length; i += 1) { if (n.endsWith(UNITS[i][0])) return UNITS[i][1]; } return ''; };`
  + `const kindOf = (meta) => (meta && typeof meta.kind === 'string' && meta.kind !== '' ? meta.kind : 'scalar');`
  // hex string -> {plottable, v, label}. v is the number for numeric kinds and
  // the enumerator ordinal for enums (the step lane plots the ordinal).
  + `function decode(name, raw) {`
  + ` const meta = G.types.get(name) || null;`
  + ` const kind = kindOf(meta);`
  + ` const str = String(raw === undefined || raw === null ? '' : raw).trim();`
  + ` const hex = /^0x([0-9a-fA-F]+)$/.exec(str);`
  + ` if (kind === 'string' && hex) {`
  + `  const size0 = (meta && typeof meta.size === 'number' && meta.size > 0) ? meta.size : (hex[1].length >> 1);`
  + `  let b0 = 0n;`
  + `  try { b0 = BigInt('0x' + hex[1]); } catch (e) { return { plottable: false, v: 0, label: str }; }`
  + `  return { plottable: false, v: 0, label: textOf(b0, size0) }; }`
  + ` if (kind === 'string') return { plottable: false, v: 0, label: str };`
  + ` if (!hex) { const f = parseFloat(str);`
  + `  return Number.isFinite(f) ? { plottable: true, v: f, label: String(f) } : { plottable: false, v: 0, label: str }; }`
  + ` const digits = hex[1].length;`
  + ` const size = (meta && typeof meta.size === 'number' && meta.size > 0) ? meta.size : (digits >> 1);`
  + ` let big = 0n;`
  + ` try { big = BigInt('0x' + hex[1]); } catch (e) { return { plottable: false, v: 0, label: str }; }`
  // Bitfield before bool/float/enum: a 1-bit bool field inside a word must not
  // be read as the whole word. Shifts are BigInt on purpose - the 32-bit JS
  // operators are wrong for bitSize 32 and for any 8-byte member.
  + ` if (kind === 'bitfield' || (meta && typeof meta.bitSize === 'number' && meta.bitSize > 0)) {`
  + `  const w = BigInt(meta && typeof meta.bitSize === 'number' && meta.bitSize > 0 ? meta.bitSize : digits * 4);`
  + `  const at = BigInt(meta && typeof meta.bitOffset === 'number' ? meta.bitOffset : 0);`
  + `  const raw = (big >> at) & ((1n << w) - 1n);`
  + `  const sv = (meta && meta.signed) ? BigInt.asIntN(Number(w), raw) : raw;`
  + `  return { plottable: true, v: Number(sv), label: sv.toString(10) }; }`
  + ` if (kind === 'bool') { const b = big !== 0n; return { plottable: true, v: b ? 1 : 0, label: b ? 'true' : 'false' }; }`
  + ` if (kind === 'float') {`
  + `  const f = toFloat(big, size);`
  + `  if (f === null) return { plottable: false, v: 0, label: str + ' (型不明)' };`
  + `  return { plottable: true, v: f, label: f.toPrecision(6) }; }`
  + ` if (kind === 'enum') {`
  + `  const en = (meta && Array.isArray(meta.enumerators)) ? meta.enumerators : [];`
  + `  for (let i = 0; i < en.length; i += 1) {`
  + `   if (BigInt(en[i].value) === big) return { plottable: false, v: i, label: String(en[i].name) }; }`
  + `  return { plottable: false, v: -1, label: big.toString(10) + ' (unknown)' }; }`
  + ` if (kind !== 'scalar' || !meta) return { plottable: false, v: 0, label: str + ' 型不明' };`
  + ` if (meta.signed) { const sv = BigInt.asIntN(size * 8, big); return { plottable: true, v: Number(sv), label: sv.toString(10) }; }`
  + ` return { plottable: true, v: Number(big), label: big.toString(10) };`
  + `}`
  // Little-endian bytes out of a BigInt: JS bit operators stop at 32 bits, so
  // every byte is extracted with a BigInt shift.
  + `function bytesOf(big, size) {`
  + ` const out = new Uint8Array(size);`
  + ` let rest = big;`
  + ` for (let i = 0; i < size; i += 1) { out[i] = Number(rest & 255n); rest = rest >> 8n; }`
  + ` return out;`
  + `}`
  + `function toFloat(big, size) {`
  + ` if (size !== 4 && size !== 8) return null;`
  + ` const view = new DataView(bytesOf(big, size).buffer);`
  + ` return size === 4 ? view.getFloat32(0, true) : view.getFloat64(0, true);`
  + `}`
  // 3.4: a char array reads as UTF-8 from the first NUL onwards.
  + `function textOf(big, size) {`
  + ` const b = bytesOf(big, size);`
  + ` let end = b.length;`
  + ` for (let i = 0; i < b.length; i += 1) { if (b[i] === 0) { end = i; break; } }`
  + ` const s = new TextDecoder('utf-8').decode(b.subarray(0, end));`
  + ` return s === '' ? '(空)' : s;`
  + `}`
  + `function lowerBound(pts, t) { let lo = 0, hi = pts.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (pts[mid].t < t) lo = mid + 1; else hi = mid; } return lo; }`
  + `function seriesFor(name) {`
  + ` let s = G.series.get(name);`
  + ` if (s) return s;`
  + ` const meta = G.types.get(name) || null;`
  + ` s = { name: name, color: PALETTE[G.order.length % PALETTE.length], visible: true, kind: kindOf(meta), meta: meta,`
  + `  pts: [], min: 0, max: 0, hasRange: false, dirty: true, lastLabel: '', row: null, li: null };`
  + ` G.series.set(name, s);`
  + ` G.order.push(name);`
  + ` return s;`
  + `}`
  // Min/max is maintained on append; the full pass only runs after a prune has
  // invalidated it. No Math.min(...pts) spread, no per-point array.
  + `function ensureRange(s) {`
  + ` if (!s.dirty) return;`
  + ` let lo = Infinity, hi = -Infinity;`
  + ` for (let i = 0; i < s.pts.length; i += 1) { const v = s.pts[i].v; if (v < lo) lo = v; if (v > hi) hi = v; }`
  + ` s.hasRange = s.pts.length > 0;`
  + ` s.min = lo; s.max = hi;`
  + ` s.dirty = false;`
  + `}`
  + `function prune(s, t) {`
  + ` const over = s.pts.length - MAX_POINTS;`
  + ` const stale = s.pts.length > 2 && s.pts[0].t < t - G.windowMs * (1 + STALE_SLACK);`
  + ` if (over <= 0 && !stale) return;`
  + ` let cut = 0;`
  + ` if (over > 0) cut = s.pts.length - (MAX_POINTS - PRUNE_BATCH);`
  + ` if (stale) { const i = lowerBound(s.pts, t - G.windowMs); if (i > cut) cut = i; }`
  + ` if (cut <= 0) return;`
  + ` s.pts.splice(0, cut);`
  + ` s.dirty = true;`
  + `}`
  + `function ingest(sm) {`
  + ` if (!sm || typeof sm.name !== 'string' || sm.name === '') return;`
  + ` const s = G.series.get(sm.name);`
  + ` if (!s) { G.unknown.add(sm.name); return; }`
  + ` const d = decode(sm.name, sm.value);`
  + ` s.lastLabel = d.label;`
  + ` const t = Date.parse(sm.timestamp);`
  + ` if (!d.plottable && s.kind !== 'enum') return;`
  + ` if (!(t > 0)) return;`
  + ` s.pts.push({ t: t, v: d.v });`
  + ` if (!s.dirty) {`
  + `  if (!s.hasRange) { s.min = d.v; s.max = d.v; s.hasRange = true; }`
  + `  else { if (d.v < s.min) s.min = d.v; if (d.v > s.max) s.max = d.v; }`
  + ` }`
  + ` prune(s, t);`
  + `}`
  + `function visible() {`
  + ` const out = [];`
  + ` for (let i = 0; i < G.order.length; i += 1) { const s = G.series.get(G.order[i]); if (s && s.visible) out.push(s); }`
  + ` return out;`
  + `}`
  + `function niceStep(span, count) {`
  + ` const raw = span / count;`
  + ` if (!(raw > 0) || !Number.isFinite(raw)) return 1;`
  + ` const mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));`
  + ` const n = raw / mag;`
  + ` return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;`
  + `}`
  + `function decimalsOf(step) { const d = -Math.floor(Math.log(step) / Math.LN10 + 1e-9); return d < 0 ? 0 : (d > 6 ? 6 : d); }`
  + `function fmtTick(v, step) { const d = decimalsOf(step); return (Math.abs(v) < step * 1e-9 ? 0 : v).toFixed(d); }`
  // Readout precision follows the data (D10), not the axis step: a float shows
  // 6 significant digits, an integer stays an integer.
  + `const fmtValue = (v, kind) => (kind === 'float' ? v.toPrecision(6) : (Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(6)))));`
  + `function syncCanvas() {`
  + ` const r = (typeof canvas.getBoundingClientRect === 'function') ? canvas.getBoundingClientRect() : null;`
  + ` const w = Math.max(120, Math.floor((r && r.width) ? r.width : (canvas.clientWidth || DEF_W)));`
  + ` const h = Math.max(120, Math.floor((r && r.height) ? r.height : (canvas.clientHeight || DEF_H)));`
  + ` const d = (typeof devicePixelRatio === 'number' && devicePixelRatio > 0) ? devicePixelRatio : 1;`
  + ` const bw = Math.round(w * d), bh = Math.round(h * d);`
  + ` if (canvas.width !== bw || canvas.height !== bh || G.dpr !== d) {`
  + `  canvas.width = bw; canvas.height = bh; G.dpr = d;`
  + `  if (ctx.setTransform) ctx.setTransform(d, 0, 0, d, 0, 0);`
  + ` }`
  + ` return { w: w, h: h };`
  + `}`
  + `function draw() {`
  + ` if (!ctx) return;`
  + ` const size = syncCanvas();`
  + ` const W = size.w, H = size.h;`
  + ` ctx.clearRect(0, 0, W, H);`
  + ` const vis = visible();`
  + ` const nums = [], enums = [];`
  + ` for (let i = 0; i < vis.length; i += 1) { if (vis[i].kind === 'enum') enums.push(vis[i]); else nums.push(vis[i]); }`
  + ` const laneN = Math.min(enums.length, MAX_LANES);`
  + ` const plotTop = PAD.t;`
  + ` const plotBottom = Math.max(plotTop + 30, H - PAD.b - (laneN ? laneN * LANE_H : 0));`
  + ` const plotLeft = PAD.l, plotRight = Math.max(plotLeft + 40, W - PAD.r);`
  + ` const plotW = plotRight - plotLeft, plotH = plotBottom - plotTop;`
  + ` let xLast = -Infinity, xFirst = Infinity, lo = Infinity, hi = -Infinity;`
  + ` for (let i = 0; i < vis.length; i += 1) {`
  + `  const s = vis[i];`
  + `  if (s.kind !== 'enum') { ensureRange(s); if (s.hasRange) { if (s.min < lo) lo = s.min; if (s.max > hi) hi = s.max; } }`
  + `  for (let k = 0; k < s.pts.length; k += 1) { const p = s.pts[k]; if (p.t > xLast) xLast = p.t; if (p.t < xFirst) xFirst = p.t; }`
  + ` }`
  + ` if (!Number.isFinite(xLast)) { xLast = 0; xFirst = 0; }`
  + ` const x0 = xFirst < xLast - G.windowMs ? xLast - G.windowMs : xFirst;`
  + ` const spanX = (xLast - x0) || 1;`
  + ` if (!Number.isFinite(lo)) { lo = 0; hi = 1; }`
  + ` if (hi === lo) hi = lo + 1;`
  + ` const step = niceStep(hi - lo, 5);`
  + ` const yMin = Math.floor(lo / step) * step;`
  + ` const yMax = Math.ceil(hi / step) * step;`
  + ` const ySpan = (yMax - yMin) || 1;`
  + ` const yOf = (v) => plotBottom - ((v - yMin) / ySpan) * plotH;`
  + ` const xOf = (t) => plotLeft + ((t - x0) / spanX) * plotW;`
  // A CSS variable is not valid in ctx.font and would be dropped silently, so
  // the tick labels ask for a concrete monospace stack instead.
  + ` ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';`
  + ` ctx.textBaseline = 'middle';`
  + ` ctx.lineWidth = 1;`
  + ` ctx.fillStyle = AXIS_TEXT;`
  + ` ctx.strokeStyle = GRID;`
  + ` const first = Math.ceil(yMin / step - 1e-9) * step;`
  + ` for (let v = first, n = 0; v <= yMax + step * 1e-9 && n < 24; v += step, n += 1) {`
  + `  const y = Math.round(yOf(v)) + 0.5;`
  + `  ctx.beginPath(); ctx.moveTo(plotLeft, y); ctx.lineTo(plotRight, y); ctx.stroke();`
  + `  ctx.fillText(fmtTick(v, step), plotLeft - 6, y);`
  + ` }`
  + ` ctx.textAlign = 'left';`
  + ` const spanSec = spanX / 1000;`
  + ` for (let k = 0; k <= 4; k += 1) {`
  + `  const x = plotLeft + (plotW * k) / 4;`
  + `  const back = (xLast - (x0 + (spanX * k) / 4)) / 1000;`
  + `  ctx.fillText(back === 0 ? '0.0s' : '-' + back.toFixed(spanSec < 2 ? 2 : 1) + 's', clamp(x - 10, plotLeft, plotRight - 34), plotBottom + 13);`
  + ` }`
  + ` for (let i = 0; i < nums.length; i += 1) {`
  + `  const s = nums[i];`
  + `  if (!s.hasRange) continue;`
  + `  const pts = s.pts;`
  + `  let k = lowerBound(pts, x0);`
  + `  const count = pts.length - k;`
  + `  if (count < 1) continue;`
  + `  const stride = count > plotW * 2 ? Math.ceil(count / Math.max(64, plotW * 2)) : 1;`
  + `  ctx.strokeStyle = s.color;`
  + `  ctx.lineWidth = 1.5;`
  + `  ctx.beginPath();`
  + `  let started = false;`
  + `  for (; k < pts.length; k += stride) {`
  + `   const p = pts[k];`
  + `   const x = xOf(p.t), y = clamp(yOf(p.v), plotTop, plotBottom);`
  + `   if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);`
  + `  }`
  + `  if (started) {`
  + `   if (stride > 1) { const p = pts[pts.length - 1]; ctx.lineTo(xOf(p.t), clamp(yOf(p.v), plotTop, plotBottom)); }`
  + `   ctx.stroke();`
  + `  }`
  + ` }`
  // Enum series get their own lane under the numeric plot: a step line keyed to
  // the enumerator ordinal with the current name written at the right edge.
  + ` for (let i = 0; i < laneN; i += 1) {`
  + `  const s = enums[i];`
  + `  const top = plotBottom + 6 + i * LANE_H;`
  + `  const bot = top + LANE_H - 4;`
  + `  const en = (s.meta && Array.isArray(s.meta.enumerators)) ? s.meta.enumerators : [];`
  + `  const ordMax = Math.max(1, en.length - 1);`
  + `  const yOrd = (v) => (v < 0 ? bot : bot - (v / ordMax) * (bot - top));`
  + `  ctx.fillStyle = GRID;`
  + `  ctx.fillRect(plotLeft, Math.round(bot) + 0.5, plotW, 1);`
  + `  ctx.save();`
  + `  ctx.beginPath(); ctx.rect(plotLeft, top, plotW, bot - top); ctx.clip();`
  + `  ctx.strokeStyle = s.color;`
  + `  ctx.lineWidth = 1.5;`
  + `  ctx.beginPath();`
  + `  let py = null, started = false;`
  + `  for (let k = 0; k < s.pts.length; k += 1) {`
  + `   const p = s.pts[k];`
  + `   if (p.t < x0) continue;`
  + `   const x = xOf(p.t), y = clamp(yOrd(p.v), top, bot);`
  + `   if (!started) { ctx.moveTo(x, y); started = true; } else { ctx.lineTo(x, py); ctx.lineTo(x, y); }`
  + `   py = y;`
  + `  }`
  + `  if (started) ctx.stroke();`
  + `  ctx.restore();`
  + `  ctx.textAlign = 'right';`
  + `  ctx.fillStyle = s.color;`
  + `  ctx.fillText(s.lastLabel, plotRight, top + 6, plotW * 0.4);`
  + `  ctx.textAlign = 'left';`
  + ` }`
  + ` if (vis.length === 0) {`
  + `  ctx.fillStyle = AXIS_TEXT;`
  + `  ctx.textAlign = 'center';`
  + `  ctx.fillText('系列未選択', plotLeft + plotW / 2, plotTop + plotH / 2);`
  + `  ctx.textAlign = 'left';`
  + ` }`
  + ` paintStatus();`
  + `}`
  // The enum lane separator above stays GRID: it is a 1px plot line like the
  // grid, and its label is drawn in the series colour just above it.
  + `function paintStatus() {`
  + ` if (!statusBox) return;`
  + ` const miss = G.unknown.size;`
  + ` statusBox.textContent = '系列 ' + G.order.length + ' / 表示 ' + visible().length`
  + `  + ' / 保持上限 ' + MAX_POINTS + '点' + (miss > 0 ? ' / 未登録 ' + miss : '');`
  + `}`
  + `function fail(msg) { if (errBox) { errBox.textContent = msg; errBox.className = 'err'; } }`
  + `function note(msg) { if (noteBox) { noteBox.textContent = msg; noteBox.className = 'note'; } }`
+ `function clearErr() { if (errBox) { errBox.textContent = ''; errBox.className = 'err'; } }`
  // One timer per poll period, coalescing every batch that lands inside it.
  // A rAF-driven repaint would cap the table at the display refresh, so the
  // readout is on its own clock: 100Hz values on a 60Hz screen.
  + `function scheduleReadout() {`
  + ` if (G.readoutQueued) return;`
  + ` G.readoutQueued = 1;`
  + ` if (typeof setTimeout !== 'function') { runReadout(); return; }`
  + ` setTimeout(runReadout, READOUT_MS);`
  + `}`
  + `function runReadout() {`
  + ` G.readoutQueued = 0;`
  + ` paintReadout();`
  + `}`
+ `function paintReadout() {`

  + ` let shared = '', mixed = false;`
  + ` for (let i = 0; i < G.order.length; i += 1) {`
  + `  const s = G.series.get(G.order[i]);`
  + `  const u = !s.meta ? '型不明' : (s.kind === 'enum' ? 'enum' : (s.kind === 'string' ? 'string' : (s.kind === 'bitfield' ? 'bit' : unitOf(s.name))));`
  + `  if (s.meta && s.kind !== 'enum' && s.kind !== 'string' && u !== '') { if (shared === '') shared = u; else if (shared !== u) mixed = true; }`
  + `  if (!s.row) continue;`
  + `  ensureRange(s);`
  + `  const numeric = s.kind !== 'enum' && s.kind !== 'string' && s.hasRange;`
  + `  s.row.min.textContent = numeric ? fmtValue(s.min, s.kind) : '-';`
  + `  s.row.max.textContent = numeric ? fmtValue(s.max, s.kind) : '-';`
  + `  s.row.last.textContent = s.lastLabel === '' ? '-' : s.lastLabel;`
  + `  s.row.unit.textContent = u;`
  + ` }`
  + ` if (unitBox) unitBox.textContent = mixed ? '(単位混在)' : shared;`
  + `}`
  + `function toggle(name) {`
  + ` const s = G.series.get(name);`
  + ` if (!s) return;`
  + ` s.visible = !s.visible;`
  + ` if (s.li) s.li.setAttribute('data-visible', s.visible ? 'true' : 'false');`
  + ` schedule();`
  + `}`
  + `function dropSeries(names) {`
  + ` for (let i = 0; i < names.length; i += 1) G.series.delete(names[i]);`
  + ` G.order = G.order.filter((n) => G.series.has(n));`
  + `}`
  + `function rebuild() {`
  + ` legend.textContent = '';`
  + ` for (let i = 0; i < G.order.length; i += 1) {`
  + `  const s = G.series.get(G.order[i]);`
  + `  const li = mk('li');`
  + `  li.setAttribute('data-name', s.name);`
  + `  li.setAttribute('data-visible', s.visible ? 'true' : 'false');`
  + `  li.setAttribute('data-kind', s.kind);`
  + `  const sw = mk('span'); sw.className = 'sw'; sw.style.background = s.color;`
  + `  const nm = mk('span'); nm.className = 'nm'; nm.textContent = s.name; nm.title = s.name;`
  + `  const x = mk('button'); x.textContent = '\\u00d7'; x.title = s.name + ' を削除';`
  + `  x.addEventListener('click', (e) => { if (e && e.stopPropagation) e.stopPropagation(); remove(s.name); });`
  + `  li.appendChild(sw); li.appendChild(nm); li.appendChild(x);`
  + `  li.addEventListener('click', () => toggle(s.name));`
  + `  legend.appendChild(li);`
  + `  s.li = li;`
  + ` }`
  + ` const stale = Array.prototype.slice.call(readout.children).filter((el) => el.dataset && el.dataset.gen === '1');`
  + ` for (let i = 0; i < stale.length; i += 1) readout.removeChild(stale[i]);`
  + ` for (let i = 0; i < G.order.length; i += 1) {`
  + `  const s = G.series.get(G.order[i]);`
  + `  const tr = mk('tr');`
  + `  tr.dataset.gen = '1';`
  + `  tr.setAttribute('data-name', s.name);`
  + `  const cells = {};`
  + `  const put = (key, cls, text) => { const td = mk('td'); td.className = cls; td.textContent = text; tr.appendChild(td); cells[key] = td; };`
  + `  put('n', 'n', s.name);`
  + `  put('min', 'v', '-');`
  + `  put('max', 'v', '-');`
  + `  put('last', 'v', '-');`
  + `  put('unit', 'u', '');`
  + `  readout.appendChild(tr);`
  + `  s.row = cells;`
  + ` }`
  + ` paintReadout();`
  + `}`
  + `function refreshKind(name) {`
  + ` const s = G.series.get(name);`
  + ` if (!s) return;`
  + ` s.meta = G.types.get(name) || null;`
  + ` s.kind = kindOf(s.meta);`
  + ` if (s.li) s.li.setAttribute('data-kind', s.kind);`
  + `}`
  // A trailing segment typed in the picker (`drive_target_radps[0]`) back to
  // the full paths it names. Exact full paths never reach here: the caller
  // checks those first, so this is only the segment-completion half.
  + `function expandSegment(name) {`
  + ` const keys = Array.from(G.types.keys());`
  + ` const cands = npCandidates(keys);`
  + ` const full = [];`
  + ` for (let i = 0; i < cands.length; i += 1) if (npLastSegment(cands[i]) === name) full.push(cands[i]);`
  + ` const out = [];`
  + ` const seen = Object.create(null);`
  + ` const take = (v) => { if (!seen[v]) { seen[v] = true; out.push(v); } };`
  + ` for (let i = 0; i < full.length; i += 1) {`
  + `  if (G.types.has(full[i])) { take(full[i]); continue; }`
  + `  const kids = npDescendantsOf(full[i], keys);`
  + `  for (let k = 0; k < kids.length; k += 1) take(kids[k]);`
  + ` }`
  + ` return out;`
  + `}`
  + `function onTypes(m) {`
  + ` const idx = m.index;`
  + ` if (idx && typeof idx === 'object') {`
  + `  const next = new Map();`
  + `  const keys = Object.keys(idx);`
  + `  for (let i = 0; i < keys.length; i += 1) next.set(keys[i], idx[keys[i]]);`
  + `  G.types = next;`
  + ` }`
  + ` for (let i = 0; i < G.order.length; i += 1) refreshKind(G.order[i]);`
  + ` rebuild();`
  + ` schedule();`
  + `}`
  + `function onSeries(m) {`
  + ` const arr = m.series;`
  + ` if (!Array.isArray(arr)) return;`
  // Membership is the host's call, empty list included: this panel is seeded
  // from the same list, so "empty" can only mean "the host has none left"
  // (e.g. the last series was removed from the sidebar). Ignoring it would
  // leave a line on screen that the user just deleted.
  + ` const keep = Object.create(null);`
  + ` for (let i = 0; i < arr.length; i += 1) {`
  + `  const d = arr[i];`
  + `  if (!d || typeof d.name !== 'string' || d.name === '') continue;`
  + `  const fresh = !G.series.has(d.name);`
  + `  const s = seriesFor(d.name);`
  + `  if (typeof d.color === 'string' && d.color !== '') s.color = d.color;`
  // visible is honoured on first sight only: the host echoes visible:true for
  // every series on every change, and re-applying it would undo a local toggle.
  + `  if (fresh && typeof d.visible === 'boolean') s.visible = d.visible;`
  + `  keep[d.name] = true;`
  + ` }`
  + ` dropSeries(G.order.filter((n) => !keep[n]));`
  + ` rebuild();`
  + ` schedule();`
  + `}`
  // The series picker is the host's QuickPick (var-pick), exactly like the
  // variable-monitor tab: the in-page datalist rendered at odd offsets and its
  // option list could not express what a group name expands to.
  + `function pickVars() {`
  + ` const query = picker ? String(picker.value === undefined || picker.value === null ? '' : picker.value) : '';`
  + ` vscode.postMessage({ kind: 'var-pick', query: query.trim() });`
  + `}`
  + `function remove(raw) {`
  + ` const name = String(raw === undefined || raw === null ? '' : raw).trim();`
  + ` if (name === '') { fail('系列名が空です'); return; }`
  + ` let hit = G.order.filter((n) => npIsUnder(n, name));`
  + ` if (hit.length === 0) {`
  + `  const seg = expandSegment(name);`
  + `  if (seg.length > 0) hit = G.order.filter((n) => { for (let i = 0; i < seg.length; i += 1) if (npIsUnder(n, seg[i])) return true; return false; });`
  + ` }`
  + ` if (hit.length === 0) { fail('未登録の系列: ' + name); return; }`
  + ` dropSeries(hit);`
  + ` rebuild();`
  + ` schedule();`
  + ` for (let i = 0; i < hit.length; i += 1) vscode.postMessage({ kind: 'graph-remove', name: hit[i] });`
  + ` clearErr();`
  + `}`
  + `function removeAll() {`
  + ` if (G.order.length === 0) { note('削除する系列がありません'); return; }`
  + ` const hit = G.order.slice();`
  + ` dropSeries(hit);`
  + ` rebuild();`
  + ` schedule();`
  + ` for (let i = 0; i < hit.length; i += 1) vscode.postMessage({ kind: 'graph-remove', name: hit[i] });`
  + ` note(hit.length + ' 件の系列を削除しました');`
  + ` clearErr();`
  + `}`
  // The host owns the archive and the save dialog; the panel only asks.
  + `function downloadCsv() {`
  + ` vscode.postMessage({ kind: 'graph-download-csv' });`
  + ` note('CSV書き出しを要求しました');`
  + `}`
  + `function setWindow(ms) {`
  + ` if (!(ms > 0)) return;`
  + ` G.windowMs = ms;`
  + ` for (let i = 0; i < G.order.length; i += 1) {`
  + `  const s = G.series.get(G.order[i]);`
  + `  s.dirty = true;`
  + `  const cut = lowerBound(s.pts, s.pts.length ? s.pts[s.pts.length - 1].t - ms : 0);`
  + `  if (cut > 0) s.pts.splice(0, cut);`
  + ` }`
  // Pruning to the window changed every min/max, so the table owes a repaint.
  + ` scheduleReadout();`
  + ` schedule();`
  + `}`
  + `function schedule() {`
  + ` if (G.queued) return;`
  + ` G.queued = 1;`
  + ` if (typeof requestAnimationFrame === 'function') requestAnimationFrame(frame);`
  + ` else frame();`
  + `}`
  + `function frame() { G.queued = 0; draw(); }`
  + `window.addEventListener('message', (e) => {`
  + ` const m = (e && e.data) || {};`
  + ` const k = m.kind;`
  // The host forwards the whole batch unfiltered, so 未登録 is recomputed per
  // batch: it counts the watched names arriving now that are not plotted
  // series. A cumulative set froze at the session high-water mark.
  + ` if (k === 'live-sample' && Array.isArray(m.samples)) {`
  + `  G.unknown.clear();`
  + `  for (let i = 0; i < m.samples.length; i += 1) ingest(m.samples[i]);`
  + `  scheduleReadout();`
  + `  schedule();`
  + ` }`
  + ` else if (k === 'live-types') onTypes(m);`
  + ` else if (k === 'graph-series') onSeries(m);`
  + `});`
  + `window.addEventListener('resize', schedule);`
  // A theme switch restyles the page without a message; the canvas cannot read
  // a custom property, so the resolved colour has to be pulled again.
  + `if (typeof matchMedia === 'function') {`
  + ` try {`
  + `  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { resolveAxisText(); schedule(); });`
  + ` } catch (e) { /* older webview: the boot-time value stands */ }`
  + `}`
  + `if (typeof ResizeObserver === 'function' && wrap) { new ResizeObserver(schedule).observe(wrap); }`
  + `q('[data-testid="graph-add"]').addEventListener('click', () => pickVars());`
  + `q('[data-testid="graph-remove"]').addEventListener('click', () => remove(picker ? picker.value : ''));`
  + `q('[data-testid="graph-clear"]').addEventListener('click', removeAll);`
  + `q('[data-testid="graph-download-csv"]').addEventListener('click', downloadCsv);`
  + `if (picker) picker.addEventListener('keydown', (e) => { if (e && e.key === 'Enter') pickVars(); });`
  + `if (winSel) winSel.addEventListener('change', () => setWindow(parseInt(winSel.value, 10)));`
  + `if (Array.isArray(__SEED)) for (let i = 0; i < __SEED.length; i += 1) seriesFor(String(__SEED[i]));`
  + `resolveAxisText();`
  + `rebuild();`
  + `schedule();`;

/** Self-contained document for a webview opened in the editor area. */
export function graphPanelHtml(selected: readonly string[] = []): string {
  // The seed is interpolated into a <script> block, so every character that
  // could close the block or start a tag is escaped as a JS string escape.
  const seed = JSON.stringify(selected)
    .replace(/&/g, "\\u0026")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");
  const script = GRAPH_SCRIPT
    .replace("__GRAPH_SEED__", seed)
    .replace("__MAX_POINTS__", String(MAX_POINTS))
    .replace("__PRUNE_BATCH__", String(PRUNE_BATCH))
    .replace("__DEFAULT_WINDOW_MS__", String(DEFAULT_WINDOW_MS));
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1.0">`
    + `<title>${GRAPH_PANEL_TITLE}</title>${GRAPH_CSS}</head>`
    + `<body><h1>${GRAPH_PANEL_TITLE} <span class="ver">v${EXT_VERSION}</span></h1>`
    + `<div class="bar" role="toolbar" aria-label="グラフ操作">`
    + `<div class="grp"><span class="lbl">系列</span>`
    + `<input data-testid="graph-var-picker" type="text" placeholder="sys.loop_hz" aria-label="系列名（変数ピッカーの検索文字列）">`
    + `<button data-testid="graph-add" type="button" class="primary" title="変数ピッカーから系列を選ぶ">追加</button>`
    + `<button data-testid="graph-remove" type="button" title="入力した名前を系列から削除">削除</button>`
  + `<button data-testid="graph-clear" type="button" title="登録中の系列をすべて削除">全削除</button></div>`
    + `<div class="grp"><span class="lbl">表示範囲</span><select data-testid="graph-window" aria-label="時間幅">`
    + GRAPH_WINDOW_OPTIONS.map((ms) =>
      `<option value="${ms}"${ms === DEFAULT_WINDOW_MS ? " selected" : ""}>${ms / 1000}s</option>`).join("")
    + `</select>`
    + `<button data-testid="graph-download-csv" type="button" title="表示中の系列をCSVで保存">CSV保存</button></div>`
    + `<span data-testid="graph-y-unit" class="note"></span></div>`
    + `<p data-testid="graph-error" class="err msg" role="alert"></p>`
    + `<p data-testid="graph-note" class="note msg"></p>`
    + `<div data-testid="graph-wrap" class="wrap">`
    + `<canvas data-testid="graph-canvas"></canvas></div>`
    + `<ul data-testid="graph-selected" class="series" aria-label="系列"></ul>`
    + `<table data-testid="graph-readout" class="read"><thead><tr>`
    + `<th>NAME</th><th>MIN</th><th>MAX</th><th>LAST</th><th>UNIT</th>`
    + `</tr></thead></table>`
    + `<footer><span data-testid="graph-status" class="stat"></span></footer>`
    + `<script>${script}</` + `script>`
    + `</body></html>`;
}

export type GraphPanelMessageKind =
  | "graph-add"
  | "graph-remove"
  | "graph-download-csv"
  | "var-pick";

export interface GraphPanelMessage {
  readonly kind: GraphPanelMessageKind;
  /** Empty for graph-download-csv and var-pick, which carry no name. */
  readonly name: string;
  /** Only set for var-pick: the series input's text as the QuickPick seed. */
  readonly query?: string;
}

export function parseGraphPanelMessage(raw: unknown): GraphPanelMessage | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const r = raw as Record<string, unknown>;
  if (r["kind"] === "graph-download-csv") {
    return { kind: "graph-download-csv", name: "" };
  }
  if (r["kind"] === "var-pick" && typeof r["query"] === "string") {
    return { kind: "var-pick", name: "", query: r["query"] };
  }
  if (r["kind"] === "graph-add" && typeof r["name"] === "string" && r["name"] !== "") {
    return { kind: "graph-add", name: r["name"] };
  }
  if (r["kind"] === "graph-remove" && typeof r["name"] === "string" && r["name"] !== "") {
    return { kind: "graph-remove", name: r["name"] };
  }
  return null;
}


