// Single stacked sidebar. One webview view carries every function, so the
// activity-bar icon is the only click needed to build, flash, watch and edit
// values. Sections are label-only: no guide paragraphs, no parentheticals.
// Pure string builders so vitest asserts structure without vscode.
//
// Rendering contract (spec §3.3): the host writes `webview.html` ONCE and then
// only ever posts messages. Every post lands in `SIDEBAR_SCRIPT`, which must
// therefore update the DOM in place — no `innerHTML`, no re-parse. A host that
// re-sends `live-bootstrap` still converges, because bootstrap re-applies state
// idempotently instead of re-rendering the page.

import type { GccDiagnostic } from "../build/backend.js";
import type { DiscoveredProject } from "../project/discover.js";
import { NAME_PATH_JS } from "../live/namePath.js";

export interface SidebarSection {
  readonly id: "project" | "build" | "flash" | "live" | "graph" | "log";
  readonly title: string;
}

export const SIDEBAR_SECTIONS: readonly SidebarSection[] = [
  { id: "project", title: "プロジェクト" },
  { id: "build", title: "ビルド" },
  { id: "flash", title: "書き込み" },
  { id: "live", title: "変数" },
  { id: "graph", title: "グラフ" },
  { id: "log", title: "ログ" },
];

/** Log lines retained in the webview before the oldest are dropped. */
export const SIDEBAR_LOG_MAX_LINES = 2000;

export interface SidebarState {
  readonly projects: readonly DiscoveredProject[];
  readonly selectedDir: string | undefined;
  readonly buildStatus: "idle" | "running" | "ok" | "failed";
  readonly buildPercent: number;
  readonly diagnostics: readonly GccDiagnostic[];
  readonly elfPath: string;
  readonly flashProgress: string;
  readonly flashResult: string;
  readonly liveHz: number;
  readonly liveConnected: boolean;
  readonly liveSource: string;
  readonly liveDrop: string;
  readonly unresolved: readonly string[];
  readonly graphSeries: readonly string[];
  readonly logTail: string;
}

export const SIDEBAR_PANEL_DEFAULT_STATE: SidebarState = {
  projects: [],
  selectedDir: undefined,
  buildStatus: "idle",
  buildPercent: 0,
  diagnostics: [],
  elfPath: "",
  flashProgress: "",
  flashResult: "",
  liveHz: 50,
  liveConnected: false,
  liveSource: "",
  liveDrop: "",
  unresolved: [],
  graphSeries: [],
  logTail: "",
};

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function basenameOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}

function projectSection(s: SidebarState): string {
  const empty = `<p class="empty" data-testid="project-empty"${s.projects.length === 0 ? "" : " hidden"}>.cproject なし — 対象フォルダを開いて「再検出」</p>`;
  const rows = s.projects.map((p) => {
    const sel = p.dir === s.selectedDir;
    return `<button class="row${sel ? " on" : ""}" data-testid="project-select" `
      + `data-dir="${esc(p.dir)}" title="${esc(p.dir)}">${esc(p.name)}</button>`;
  }).join("");
  return `<div class="rows" data-testid="project-rows">${rows}</div>${empty}`
    + `<button data-testid="project-refresh" title="プロジェクトを再検出">再検出</button>`;
}

function buildSection(s: SidebarState): string {
  const pill = s.buildStatus === "ok" ? "ok" : s.buildStatus === "failed" ? "bad"
    : s.buildStatus === "running" ? "run" : "idle";
  const label = s.buildStatus === "ok" ? "成功" : s.buildStatus === "failed" ? "失敗"
    : s.buildStatus === "running" ? "ビルド中" : "待機";
  const diag = s.diagnostics.filter((d) => d.kind === "error").slice(0, 50).map((d) => {
    const payload = encodeURIComponent(JSON.stringify([{ file: d.file, line: d.line, col: d.col }]));
    return `<a class="diag" href="command:stm32ext.openBuildDiag?${payload}">`
      + `${esc(d.file)}:${d.line}:${d.col}</a>`;
  }).join("");
  return `<button data-testid="build-run" title="Ninja でビルド">ビルド</button> `
    + `<button data-testid="build-flash" class="primary" title="ビルドして書込">ビルドして書込</button>`
    + `<p class="status"><span class="pill ${pill}" data-testid="build-pill">${label}</span>`
    + `<span class="pct" data-testid="build-pct">${s.buildPercent}%</span>`
    + `<span class="path" data-testid="build-elf" title="${esc(s.elfPath)}">${s.elfPath !== "" ? esc(basenameOf(s.elfPath)) : ""}</span>`
    + `</p><progress max="100" value="${s.buildPercent}" data-testid="build-bar"></progress>`
    + `<p class="why" data-testid="build-why"></p>`
    + `<div class="diags" data-testid="build-diags">${diag}</div>`;
}

function flashSection(s: SidebarState): string {
  return `<button data-testid="flash-start" class="primary" title="ELF を書込">書込</button> `
    + `<button data-testid="flash-retry" title="ビルドからやり直す" hidden>再試行</button>`
    + `<div class="io">`
    + `<p class="busy" data-testid="flash-progress">${esc(s.flashProgress)}</p>`
    + `<p class="result" data-testid="flash-result">${esc(s.flashResult)}</p>`
    + `<p class="why" data-testid="flash-why"></p></div>`;
}

function liveSection(s: SidebarState): string {
  const dot = s.liveConnected ? "ok" : "idle";
  const dotText = s.liveConnected ? "監視中" : "停止";
  return `<p class="status"><span class="pill ${dot}" data-testid="live-state">${dotText}</span>`
    + `<span class="path" data-testid="live-source" title="${esc(s.liveSource)}">${s.liveSource !== "" ? esc(basenameOf(s.liveSource)) : ""}</span>`
    + `<span class="pct" data-testid="live-hz">${s.liveHz}Hz</span>`
    + `<span class="drop" data-testid="live-drop-rate" aria-live="polite">${esc(s.liveDrop)}</span>`
    + `</p>`
    + `<div class="ctrls">`
    + `<button data-testid="live-start" class="primary" title="監視を開始">監視開始</button> `
    + `<button data-testid="live-stop" title="監視を停止">停止</button> `
    + `<button data-testid="live-pause-toggle" title="一時停止と再開を切り替える">一時停止</button> `
    + `<button data-testid="live-reconnect" title="プローブを取り直して再開">再接続</button> `
    + `<button data-testid="live-add-watch" title="QuickPick で変数を追加">変数追加</button> `
    + `<button data-testid="live-export-csv" title="監視履歴を CSV で保存">CSV</button>`
    + `</div><a class="btn primary" data-testid="variable-open" role="button" href="command:stm32ext.showVariables">変数をタブで開く</a><p class="why" data-testid="live-why"></p>`
    // The host routes every user-facing failure reason through live-status
    // (text + optional detail). The pill is for the state word only, so a
    // reason can never be overwritten by it.
    + `<p class="msg" data-testid="live-status-text" role="status" aria-live="polite"></p>`
    + `<p class="detail" data-testid="live-detail"></p>`;
}

function graphSection(s: SidebarState): string {
  const names = s.graphSeries.length > 0 ? s.graphSeries.join(", ") : "";
  const rows = s.graphSeries.map((n) =>
    `<li data-name="${esc(n)}" data-visible="1"><span class="dot"></span>`
    + `<span class="nm">${esc(n)}</span><span class="vv">—</span><span class="st">表示</span></li>`).join("");
  return `<a class="btn primary" data-testid="graph-open" role="button" href="command:stm32ext.showGraph">グラフを開く</a>`
  + `<input data-testid="graph-input" type="text" list="graph-name-list" placeholder="sys.loop_hz" aria-label="グラフに追加する変数名" value="${esc(names)}">`
    + `<datalist id="graph-name-list" data-testid="graph-names"></datalist>`
    + `<button data-testid="graph-add" title="入力した変数をグラフに追加">追加</button> `
    + `<button data-testid="graph-remove" title="入力した変数をグラフから削除">削除</button>`
    + `<p class="why" data-testid="graph-why"></p>`
    + `<ul class="series" data-testid="graph-series" role="list">`
    + (rows !== "" ? rows : `<li class="empty">系列がありません</li>`)
    + `</ul>`;
}

function logSection(s: SidebarState): string {
  return `<div class="ctrls">`
    + `<input data-testid="log-filter" type="text" placeholder="ログを絞り込み" value="">`
    + `<button data-testid="log-clear" title="ログを消去">消去</button>`
    + `<label class="chk"><input data-testid="log-autoscroll" type="checkbox" checked>自動スクロール</label>`
    + `</div>`
    + `<a class="diag" data-testid="log-open" href="command:stm32ext.showLog">出力チャネルを開く</a>`
    + `<pre data-testid="log-tail">${esc(s.logTail.slice(-4000))}</pre>`;
}

export function renderSidebar(
  state: SidebarState = SIDEBAR_PANEL_DEFAULT_STATE,
  fontPxRaw = 15,
): string {
  const body: Record<SidebarSection["id"], string> = {
    project: projectSection(state),
    build: buildSection(state),
    flash: flashSection(state),
    live: liveSection(state),
    graph: graphSection(state),
    log: logSection(state),
  };
  const sections = SIDEBAR_SECTIONS.map((s, i) =>
    `<section data-section="${s.id}"><h2><span class="step" aria-hidden="true">${i + 1}</span>${s.title}</h2>${body[s.id]}</section>`).join("");
  // fontPx is a pure presentation input: the host passes stm32ext.uiFontPx so
  // the size is user-adjustable, and every fixed column in the CSS is derived
  // from it. It is a parameter rather than a global read so the HTML stays a
  // pure function and stays testable without a vscode mock.
  // Number.isFinite FIRST: Math.max(12, Math.round(NaN)) is NaN, which would
  // emit `--stm32ext-ui-font:NaNpx` and silently invalidate every width
  // derived from it — the columns would collapse with no visible error.
  const fontPx = Number.isFinite(fontPxRaw)
    ? Math.min(16, Math.max(12, Math.round(fontPxRaw)))
    : 15;
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1.0">`
    + `<title>STM32</title><style>:root{--stm32ext-ui-font:${fontPx}px}</style>${SIDEBAR_CSS}</head>`
    + `<body>${sections}`
    + `<script>${SIDEBAR_SCRIPT}</script>`
    + `</body></html>`;
}

export const SIDEBAR_CSS = `<style>`
  // NB: keep this above renderSidebar so the <style> block is a plain
  // constant — a stray `</script>` anywhere would truncate the page.
  // --stm32ext-ui-font is the ONLY font size, deliberately. It used to be
  // max(vscode-font-size, uiFontPx) while the fixed columns were sized from
  // uiFontPx alone, so a user on a 16px editor font rendered 16px text inside
  // a 15px-sized column and the rightmost control was clipped by 5px — the
  // same failure this sizing work was meant to end, reappearing at the
  // default. One source, so the columns can never disagree with the text.
  + `body{font-family:var(--vscode-font-family,sans-serif);font-size:var(--stm32ext-ui-font,15px);color:var(--vscode-foreground,#ccc);margin:0;padding:0 8px 24px;line-height:1.5}`
  + `section{border-top:1px solid var(--vscode-panel-border,rgba(128,128,128,.3));padding:8px 0 10px}`
  + `section:first-child{border-top:none}`
  + `h2{font-size:.92em;font-weight:600;margin:0 0 6px;letter-spacing:.02em;display:flex;align-items:center;gap:6px}`
  + `.step{display:inline-flex;align-items:center;justify-content:center;min-width:1.5em;height:1.5em;padding:0 .3em;border-radius:50%;background:var(--vscode-badge-background,#4d4d4d);color:var(--vscode-badge-foreground,#fff);font-size:.85em;font-weight:700;line-height:1}`
  + `a.btn.primary{background:var(--vscode-button-background,#0e639c);color:var(--vscode-button-foreground,#fff)}`
  + `.ctrls{display:flex;flex-wrap:wrap;gap:0}`
  // Tap targets: 28px for section buttons, 24px in the dense table. The op
  // glyphs are the only way to add or remove a variable.
  + `button{font:inherit;margin:0 4px 4px 0;padding:5px 12px;min-height:28px;border-radius:2px;border:1px solid transparent;background:var(--vscode-button-secondaryBackground,#3a3d41);color:var(--vscode-button-secondaryForeground,#ccc);cursor:pointer}`
  + `button:disabled{opacity:.45;cursor:default}`
  + `button.primary{background:var(--vscode-button-background,#0e639c);color:var(--vscode-button-foreground,#fff)}`
  + `button.row{display:block;width:100%;text-align:left;background:transparent;border:none;padding:2px 0}`
  + `button.row.on{font-weight:600}`
  + `.rows{margin-bottom:4px}`
  + `p{margin:3px 0}`
  + `.empty,.warn{opacity:.7}`
  + `.why{opacity:.7;font-size:.92em;min-height:1em}`
  + `.note{opacity:.85;font-size:.94em}`
  + `.msg{margin:3px 0;font-size:.95em}`
  + `p.msg:empty, p.detail:empty{display:none}`
  + `.detail{margin:2px 0 3px;opacity:.75;font-size:.92em;white-space:pre-wrap}`
  + `.status{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;margin:4px 0}`
  + `.pill{font-weight:600}.pill.ok{color:var(--vscode-testing-iconPassed,#388a34)}.pill.bad{color:var(--vscode-testing-iconFailed,#f14c4c)}.pill.run{color:var(--vscode-testing-iconQueued,#cca700)}.pill.idle{opacity:.6;font-weight:400}`
  + `.pct,.drop,.path{font-family:var(--vscode-editor-font-family,monospace);font-variant-numeric:tabular-nums;opacity:.8;font-size:.94em}`
  + `.path{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`
  + `progress{width:100%;height:3px}`
  + `.diags{margin-top:4px;max-height:120px;overflow:auto}`
  + `.diag{display:block;font-family:var(--vscode-editor-font-family,monospace);font-size:.9em;color:var(--vscode-textLink-foreground,#3794ff);text-decoration:none}`
  + `.busy{opacity:.7}.result{white-space:pre-wrap}`
  + `label.chk{display:inline-flex;align-items:center;gap:3px;font-size:.9em;opacity:.8;margin:0 6px 4px 0}`
  + `label.chk input{width:auto;margin:0}`
  + `input{background:var(--vscode-input-background,#3c3c3c);color:var(--vscode-input-foreground,#ccc);border:1px solid var(--vscode-input-border,rgba(128,128,128,.35));border-radius:2px;padding:5px 7px;font:inherit;box-sizing:border-box;width:100%;margin:2px 0}`
  + `a.btn{display:inline-block;margin:0 4px 4px 0;padding:3px 10px;border-radius:2px;background:var(--vscode-button-secondaryBackground,#3a3d41);color:var(--vscode-button-secondaryForeground,#ccc);text-decoration:none}`
  + `ul.series{list-style:none;margin:4px 0 0;padding:0}`
  + `ul.series li{display:flex;gap:6px;align-items:baseline;font-family:var(--vscode-editor-font-family,monospace);font-size:.95em;padding:2px 0}`
  + `ul.series li[data-visible="0"]{opacity:.5}`
  + `.dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;background:var(--vscode-textLink-foreground,#3794ff)}`
  + `.nm{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`
  + `.vv{font-variant-numeric:tabular-nums}`
  + `.st{opacity:.7;font-size:.9em}`
  + `pre{background:var(--vscode-textCodeBlock-background,rgba(128,128,128,.1));padding:5px;overflow:auto;box-sizing:border-box;max-height:150px;font-family:var(--vscode-editor-font-family,monospace);font-size:.88em;margin:0}`
  + `button:focus-visible,input:focus-visible,a.btn:focus-visible{outline:1px solid var(--vscode-focusBorder,#007fd4)}`
  + `</style>`;

// The webview program. Kept as an array of lines (not one concatenated blob)
// so it stays reviewable; joined with newlines at module load.
export const SIDEBAR_SCRIPT: string = [
  "const vscode = acquireVsCodeApi();",
  "const q = (s) => document.querySelector(s);",
  "const el = (id) => q('[data-testid=\"' + id + '\"]');",
  "const qa = (s) => Array.prototype.slice.call(document.querySelectorAll(s));",
  "const setText = (node, t) => { if (node && node.textContent !== t) node.textContent = t; };",
  "const LOG_MAX = " + SIDEBAR_LOG_MAX_LINES + ";",
  // Shared hierarchy logic (src/live/namePath.js): one definition of `.`/`[`
  // boundaries for host and panels. Spread as lines — the array is joined
  // with newlines at module load, so hoisted `function` declarations land in
  // the same script scope as every caller below.
  ...NAME_PATH_JS.split("\n"),
  // Datalist depth sized off measured reality: the resolver reports ~355
  // leaves for unit_omni3 before arrays (more after), so 5000 options leave
  // headroom for 10x growth instead of silently hiding later members.
  "const MAX_OPTIONS = 5000;",
  "",
  "// ------------------------------------------------------------------ decode",
  "// spec 3.4. One place, reused by the table, the write input and the graph.",
  "const HEX = /^\\s*0x([0-9a-fA-F]+)\\s*$/;",
  "const rawHex = (s) => { const m = HEX.exec(String(s)); return m ? '0x' + m[1] : String(s); };",
  "const bigOf = (s) => { const m = HEX.exec(String(s)); if (!m) return null; try { return BigInt('0x' + m[1]); } catch (e) { return null; } };",
  "const hexSize = (s) => { const m = HEX.exec(String(s)); return m ? Math.max(1, Math.ceil(m[1].length / 2)) : 4; };",
  "const leBytes = (v, n) => { const b = new Uint8Array(n); for (let i = 0; i < n; i += 1) b[i] = Number((v >> BigInt(i * 8)) & 255n); return b; };",
  "const utf8 = (b) => { try { return new TextDecoder('utf-8').decode(b); } catch (e) { let s = ''; for (let i = 0; i < b.length; i += 1) s += String.fromCharCode(b[i]); return s; } };",
  "const decode = (raw, m) => {",
  "  const v = bigOf(raw);",
  "  if (v === null) return { text: String(raw), input: String(raw), num: null };",
  "  const size = m && m.size > 0 ? m.size : hexSize(raw);",
  "  const kind = m ? String(m.kind || 'scalar') : 'unknown';",
  "  if (kind === 'bool') { const t = v !== 0n; return { text: t ? 'true' : 'false', input: t ? 'true' : 'false', num: t ? 1 : 0 }; }",
  "  if (kind === 'float') {",
  "    const f = size <= 4",
  "      ? new DataView(leBytes(v & 0xffffffffn, 4).buffer).getFloat32(0, true)",
  "      : new DataView(leBytes(v, 8).buffer).getFloat64(0, true);",
  "    return { text: f.toPrecision(6), input: String(f), num: Number.isFinite(f) ? f : null };",
  "  }",
  "  if (kind === 'enum') {",
  "    const en = (m && m.enumerators) || [];",
  "    for (let i = 0; i < en.length; i += 1) { if (BigInt(en[i].value) === v) return { text: en[i].name, input: en[i].name, num: Number(v) }; }",
  "    return { text: v.toString(10) + ' (unknown)', input: v.toString(10), num: Number(v) };",
  "  }",
  "  if (kind === 'string') {",
  "    let n = size; if (m && m.length > 0 && m.length < n) n = m.length;",
  "    const b = leBytes(v, n); let end = b.length;",
  "    for (let i = 0; i < b.length; i += 1) { if (b[i] === 0) { end = i; break; } }",
  "    const s = utf8(b.subarray(0, end));",
  "    return { text: s === '' ? \"''\" : s, input: s, num: null };",
  "  }",
  "  if (kind === 'bitfield' && m) {",
  "    const bs = m.bitSize !== undefined ? m.bitSize : m.bit_size;",
  "    const bo = m.bitOffset !== undefined ? m.bitOffset : m.bit_offset;",
  "    if (bs > 0) {",
  "      const w = BigInt(bs);",
  "      const t = (v >> BigInt(bo || 0)) & ((1n << w) - 1n);",
  "      return { text: t.toString(10), input: t.toString(10), num: Number(t) };",
  "    }",
  "  }",
  "  if (!m || kind === 'unknown') return { text: rawHex(raw) + ' 型不明', input: rawHex(raw), num: null };",
  "  const d = m.signed ? BigInt.asIntN(Math.max(1, size * 8), v) : v;",
  "  return { text: d.toString(10), input: d.toString(10), num: Number(d) };",
  "};",
  "",
  "// ------------------------------------------------------------------- state",
  "const st = { live: 'idle', build: 'idle', buildPhase: '', flash: '', flashBusy: null, hasTree: false, rootName: '', project: '', elf: '' };",
  "const meta = new Map();    // leaf name -> LeafMeta",
  "const cache = new Map();   // leaf name -> <tr>",
  "const nodes = new Map();   // node path -> {tr, path, leaves, kids}",
  "const lastRaw = new Map();  // leaf name -> last raw hex (fmt toggle)",
  "const fmt = new Map();     // leaf name -> 'dec' | 'hex'",
  "const shown = new Map();   // name+value memo: BigInt churn at 100Hz is waste",
  "const series = new Map();   // name -> {visible, color}, mirrors the graph panel",
  "const lastValue = new Map(); // name -> last decoded text for the series list",
  "const watched = new Set(); // host is the authority (live-watchlist)",
  "let logBuf = [];",
  "let logFilter = '';",
  "let logPinned = true;",
  "let catalogQuery = '';",
  "const catalogText = new Map();",
  "",
  "const show = (s) => {",
  "  const hexed = fmt.get(s.name) === 'hex';",
  "  const k = s.name + '\\u0000' + s.value + (hexed ? '\\u00001' : '');",
  "  let t = shown.get(k);",
  "  if (t === undefined) {",
  "    t = hexed ? rawHex(s.value) : decode(s.value, meta.get(s.name)).text;",
  "    if (shown.size > 400) shown.clear();",
  "    shown.set(k, t);",
  "  }",
  "  return t;",
  "};",
  "",
  "// ------------------------------------------------------------------- gates",
  "const base = new Map();    // button -> its always-on tooltip",
  "const reasons = new Map(); // sink id -> why-this-section-is-blocked lines",
  "qa('button').forEach((b) => base.set(b, b.title || ''));",
  "const clearWhy = (sink) => { reasons.set(sink, []); };",
  "const gate = (id, on, reason, sink) => {",
  "  const b = el(id);",
  "  if (!b) return;",
  "  b.disabled = !on;",
  "  const t = on ? (base.get(b) || '') : reason;",
  "  if (b.title !== t) b.title = t;",
  "  if (!on && reason) { const a = reasons.get(sink) || []; a.push(reason); reasons.set(sink, a); }",
  "};",
  "const flushWhy = () => {",
  "  reasons.forEach((list, id) => {",
  "    const uniq = [];",
  "    for (let i = 0; i < list.length; i += 1) if (uniq.indexOf(list[i]) < 0) uniq.push(list[i]);",
  "    setText(el(id), uniq.join(' / '));",
  "  });",
  "};",
  "",
  "// -------------------------------------------------------------------- tree",
  "const rows = el('live-rows');",
  "const gi = el('graph-input');",
  "const cf = el('live-search');",
  "const lf = el('log-filter');",
  "const la = el('log-autoscroll');",
  "let lfTimer = 0;",
  "const cell = (cls) => { const td = document.createElement('td'); td.className = cls; return td; };",
  "const opButton = (op, glyph, title) => {",
  "  const b = document.createElement('button');",
  "  b.dataset.op = op; b.textContent = glyph; b.title = title;",
  "  return b;",
  "};",
  "const leafRow = (name) => {",
  "  const tr = document.createElement('tr');",
  "  tr.dataset.name = name; tr.dataset.path = name; tr.dataset.kind = 'leaf'; tr.dataset.watched = '0';",
  "  const n = cell('n');",
  "  const v = cell('v'); v.dataset.fmt = '1'; v.title = '10進/16進';",
  "  v.setAttribute('tabindex', '0'); v.setAttribute('role', 'button');",
  "  const w = cell('w');",
  "  const inp = document.createElement('input');",
  "  inp.setAttribute('type', 'text'); inp.dataset.write = '1';",
  "  inp.setAttribute('aria-label', name + ' 書込');",
  "  inp.title = '値を入力してEnterで書き込み（Escで取り消し）';",
  "  const wr = document.createElement('span');",
  "  wr.className = 'wr'; wr.hidden = true;",
  "  w.appendChild(inp); w.appendChild(wr);",
  // No literal space text nodes between the buttons: a space is ~0.45em in",
  // the UI font, so two of them plus the last button's margin made the cell",
  // content wider than --opw at EVERY size — measured 5/7/8/10px of overflow",
  // at 12/15/18/22px, pushing × outside the table at 18px and above. The gap",
  // is CSS now, so the column width is exact by construction.",
  "  const o = cell('o');",
  "  o.appendChild(opButton('add', '+', '監視に追加'));",
  "  o.appendChild(opButton('remove', '×', '監視から除外'));",
  "  tr.appendChild(n); tr.appendChild(v); tr.appendChild(w); tr.appendChild(o);",
  "  return tr;",
  "};",
  "const groupRow = (name, path, label, depth) => {",
  "  const tr = document.createElement('tr');",
  "  tr.dataset.name = name; tr.dataset.path = path; tr.dataset.kind = 'group'; tr.dataset.collapse = '1';",
  "  tr.dataset.collapsed = '0'; tr.dataset.watched = '0';",
  "  const n = cell('n');",
  "  n.textContent = label;",
  "  n.style.paddingLeft = (6 + Math.min(depth, 4) * 8) + 'px';",
  "  n.setAttribute('tabindex', '0'); n.setAttribute('role', 'button'); n.setAttribute('aria-expanded', 'true');",
  "  const v = cell('v');",
  "  const o = cell('o');",
  "  o.appendChild(opButton('add', '+', '監視に追加'));",
  "  o.appendChild(opButton('remove', '×', '監視から除外'));",
  "  tr.appendChild(n); tr.appendChild(v); tr.appendChild(o);",
  "  return tr;",
  "};",
  // npIsUnder: `.` OR `[` is a boundary, so an array group matches its
  // element leaves and `a.bx` never matches `a.b`. The dotted-only test hid
  // or deleted the wrong rows once element leaves existed.
  "const under = (name, prefix) => npIsUnder(name, prefix);",
  "",
  "const refreshEmpty = () => { const n = el('live-empty'); if (n) n.hidden = cache.size > 0; };",
  "const note = (t) => setText(el('live-add-note'), t);",
  "",
"// Name completion for the graph input, fed from the same index the tree is.",
"// Every leaf plus the struct nodes above it: `drive.controller` is a valid",
"// graph target (the host expands it to its leaves), so hiding the groups",
"// made the picker look incapable of something it does.",
"// The membership set is a Set, not a plain object: a C symbol called",
"// `constructor` or `toString` would hit Object.prototype and vanish from the",
"// candidates without a trace.",
"const fillNameList = () => {",
"  const box = el('graph-names');",
"  if (!box) return;",
"  while (box.firstChild) box.removeChild(box.firstChild);",
"  const cands = npCandidates(Array.from(meta.keys()));",
"  const seen = new Set();",
"  const out = [];",
"  const push = (v) => { if (v !== '' && !seen.has(v)) { seen.add(v); out.push(v); } };",
"  for (let i = 0; i < cands.length; i += 1) push(cands[i]);",
"  for (let i = 0; i < cands.length; i += 1) push(npLastSegment(cands[i]));",
"  const n = Math.min(out.length, MAX_OPTIONS);",
"  for (let i = 0; i < n; i += 1) {",
"    const o = document.createElement('option');",
"    o.setAttribute('value', out[i]);",
"    box.appendChild(o);",
"  }",
"};",
"const expandGraphNames = (ns) => {",
"  const keys = Array.from(meta.keys());",
"  if (keys.length === 0) return ns;",
"  const cands = npCandidates(keys);",
"  const out = [];",
"  for (let i = 0; i < ns.length; i += 1) {",
"    const raw = ns[i];",
"    if (cands.indexOf(raw) >= 0) { out.push(raw); continue; }",
"    let hit = false;",
"    for (let k = 0; k < cands.length; k += 1) {",
"      if (npLastSegment(cands[k]) === raw) { out.push(cands[k]); hit = true; }",
"    }",
"    if (!hit) out.push(raw);",
"  }",
"  return out;",
"};",
"",
  "const buildTree = (tree, index) => {",
  "  meta.clear(); cache.clear(); nodes.clear(); lastRaw.clear(); shown.clear(); catalogText.clear();",
  "  if (index && typeof index === 'object') for (const k of Object.keys(index)) meta.set(k, index[k]);",
  "  fillNameList();",
  "  if (rows) while (rows.firstChild) rows.removeChild(rows.firstChild);",
  "  st.hasTree = !!tree;",
  "  if (tree && rows) {",
  "    st.rootName = String(tree.name || '');",
  "    const walk = (nd, parentPath, depth, isRoot) => {",
  "      const nm = String(nd.name || '');",
  "      // The resolver gives every node `name` (the last segment) AND `path` (the full",
  "      // dotted path — measured on the real ELF: 327 leaf nodes, 0 with a dot in the",
  "      // name). Prefer `path`: rebuilding it by concatenation is how a half-correct",
  "      // name makes every add/remove/write target the wrong symbol while still",
  "      // reporting success.",
  "      const path = isRoot ? '' : (String(nd.path || '') || (parentPath === '' ? nm : parentPath + '.' + nm));",
  "      const kids = Array.isArray(nd.children) ? nd.children : [];",
  "      const rec = { path: path, tr: null, leaves: [], kids: [] };",
  "      // Declared before the branch: both the group label and the leaf tooltip",
  "      // need it, and a const inside the branch is invisible to the else.",
  "      const typeName = String(nd.type || '');",
  "      const named = typeName !== '' && typeName.indexOf('<anonymous>') < 0;",
  "      const disp0 = nd.display !== undefined && nd.display !== null ? String(nd.display) : '';",
  "      catalogText.set(path, (disp0 + ' ' + path + ' ' + typeName).toLowerCase());",
  "      if (kids.length > 0) {",
  "        // A nameless DWARF type is not worth showing: 'sys : struct <anonymous>'",
  "        // is noise in a narrow column. Show the C type name only when there is one.",
  "        const label = disp0 !== '' ? disp0 : (named ? nm + ' : ' + typeName : nm);",
  "        rec.tr = groupRow(path === '' ? nm : path, path, label, depth);",
  "        rows.appendChild(rec.tr);",
  "        for (let i = 0; i < kids.length; i += 1) rec.kids.push(walk(kids[i], path, depth + 1, false));",
  "        const leaves = [];",
  "        for (let i = 0; i < rec.kids.length; i += 1) for (let k = 0; k < rec.kids[i].leaves.length; k += 1) leaves.push(rec.kids[i].leaves[k]);",
  "        rec.leaves = leaves;",
  "        rec.tr.children[1].textContent = leaves.length + '件';",
  "      } else {",
  "        rec.tr = leafRow(path);",
  "        // The row is put in the cache here, so a later sample finds it and never",
  "        // reaches its own 'fresh' branch: the name has to be written HERE, or the",
  "        // 変数 column stays empty for every leaf.",
  "        // The label is the path's last segment, not `name`: the resolver gives",
  "        // the last segment, but a full path in `name` would then render as the",
  "        // whole dotted path in a 150px column. Either shape yields the same.",
  "        const leafName = npLastSegment(path) || nm;",
  "        rec.tr.children[0].textContent = disp0 !== '' ? disp0 : leafName;",
  "        rec.tr.children[0].title = path === leafName ? path : (path + ' — ' + typeName);",
  "        rec.tr.children[0].style.paddingLeft = (6 + Math.min(depth, 4) * 8) + 'px';",
  "        rows.appendChild(rec.tr);",
  "        cache.set(path, rec.tr);",
  "        // An array node resolves to no scalar symbol, so it can never show a",
  "        // value. Measured on unit_omni3.elf: 327 leaf nodes but 324 symbols —",
  "        // the 3 extra are `float[4]` / `struct [3]`. They stay in the catalogue",
  "        // (they are real variables) but are left out of the leaf count and get",
  "        // no watch buttons, which could only fail.",
  "        if (String(nd.kind || '') === 'array') {",
  "          rec.tr.dataset.pollable = '0';",
  "          rec.tr.children[0].title = path + ' — ' + typeName + ' (配列: 監視対象外)';",
  "          const wc = rec.tr.children[2];",
  "          while (wc.firstChild) wc.removeChild(wc.firstChild);",
  "          const oc = rec.tr.children[3];",
  "          while (oc.firstChild) oc.removeChild(oc.firstChild);",
  "          oc.appendChild(document.createTextNode('—'));",
  "        } else {",
  "          rec.leaves = [path];",
  "        }",
  "      }",
  "      nodes.set(path, rec);",
  "      return rec;",
  "    };",
  "    walk(tree, '', 0, true);",
  "  }",
  "  refreshEmpty();",
  "  applyCatalogFilter();",
  "  applyLive();",
  "};",
  "",
  "const buildCatalog = (roots) => {",
  "  meta.clear(); cache.clear(); nodes.clear(); lastRaw.clear(); shown.clear(); catalogText.clear();",
  "  if (rows) while (rows.firstChild) rows.removeChild(rows.firstChild);",
  "  st.hasTree = Array.isArray(roots) && roots.length > 0;",
  "  st.rootName = '';",
  "  if (Array.isArray(roots) && rows) {",
  "    const walkCat = (nd, parentPath, depth) => {",
  "      const nm = String(nd.name || '');",
  "      const path = String(nd.path || '') || (parentPath === '' ? nm : parentPath + '.' + nm);",
  "      const kids = Array.isArray(nd.children) ? nd.children : [];",
  "      const rec = { path: path, tr: null, leaves: [], kids: [] };",
  "      const typeName = String(nd.type || '');",
  "      const disp = nd.display !== undefined && nd.display !== null ? String(nd.display) : '';",
  "      catalogText.set(path, (disp + ' ' + path + ' ' + typeName).toLowerCase());",
  "      const named = typeName !== '' && typeName.indexOf('<anonymous>') < 0;",
  "      if (kids.length > 0) {",
  "        const label = disp !== '' ? disp : (named ? nm + ' : ' + typeName : nm);",
  "        rec.tr = groupRow(path, path, label, depth);",
  "        rows.appendChild(rec.tr);",
  "        for (let i = 0; i < kids.length; i += 1) rec.kids.push(walkCat(kids[i], path, depth + 1));",
  "        const leaves = [];",
  "        for (let i = 0; i < rec.kids.length; i += 1) for (let k = 0; k < rec.kids[i].leaves.length; k += 1) leaves.push(rec.kids[i].leaves[k]);",
  "        rec.leaves = leaves;",
  "        rec.tr.children[1].textContent = leaves.length + '件';",
  "      } else {",
  "        rec.tr = leafRow(path);",
  "        rec.tr.children[0].textContent = disp !== '' ? disp : (npLastSegment(path) || nm);",
  "        rec.tr.children[0].title = path + (typeName !== '' ? ' — ' + typeName : '');",
  "        rec.tr.children[0].style.paddingLeft = (6 + Math.min(depth, 4) * 8) + 'px';",
  "        rows.appendChild(rec.tr);",
  "        cache.set(path, rec.tr);",
  "        meta.set(path, { size: Number(nd.size) || 0, kind: String(nd.kind || 'scalar'), type: typeName, signed: nd.signed === true, enumerators: nd.enumerators, length: nd.length, bitSize: nd.bitSize, bitOffset: nd.bitOffset, bit_size: nd.bit_size, bit_offset: nd.bit_offset });",
  "        if (String(nd.kind || '') === 'array') {",
  "          rec.tr.dataset.pollable = '0';",
  "          rec.tr.children[0].title = path + ' — ' + typeName + ' (配列: 監視対象外)';",
  "          const wc = rec.tr.children[2];",
  "          while (wc.firstChild) wc.removeChild(wc.firstChild);",
  "          const oc = rec.tr.children[3];",
  "          while (oc.firstChild) oc.removeChild(oc.firstChild);",
  "          oc.appendChild(document.createTextNode('—'));",
  "        } else {",
  "          rec.leaves = [path];",
  "        }",
  "      }",
  "      nodes.set(path, rec);",
  "      return rec;",
  "    };",
  "    for (let i = 0; i < roots.length; i += 1) walkCat(roots[i], '', 0);",
  "  }",
  "  fillNameList();",
  "  cache.forEach((tr, name) => { tr.dataset.watched = watched.has(name) ? '1' : '0'; });",
  "  nodes.forEach((rec) => {",
  "    if (!rec.tr || rec.tr.dataset.kind !== 'group') return;",
  "    let hit = 0;",
  "    for (let i = 0; i < rec.leaves.length; i += 1) if (watched.has(rec.leaves[i])) hit += 1;",
  "    rec.tr.dataset.watched = hit > 0 ? '1' : '0';",
  "  });",
  "  refreshEmpty();",
  "  applyCatalogFilter();",
  "  applyLive();",
  "};",
  "",
  "const applyCatalogFilter = () => {",
  "  const q = catalogQuery.trim().toLowerCase();",
  "  const selfHit = (path) => (catalogText.get(path) || '').indexOf(q) >= 0;",
  "  const subHit = (rec) => {",
  "    if (selfHit(rec.path)) return true;",
  "    for (let i = 0; i < rec.kids.length; i += 1) if (subHit(rec.kids[i])) return true;",
  "    return false;",
  "  };",
  "  const hideSub = (rec) => {",
  "    if (rec.tr) rec.tr.dataset.hidden = '1';",
  "    for (let i = 0; i < rec.kids.length; i += 1) hideSub(rec.kids[i]);",
  "  };",
  "  const paint = (rec, force) => {",
  "    if (!force && q !== '' && !subHit(rec)) { hideSub(rec); return; }",
  "    if (rec.tr) rec.tr.dataset.hidden = '0';",
  "    if (rec.kids.length === 0) return;",
  "    const forceKids = force || (q !== '' && selfHit(rec.path));",
  "    for (let i = 0; i < rec.kids.length; i += 1) paint(rec.kids[i], forceKids);",
  "  };",
  "  if (q === '') {",
  "    nodes.forEach((rec) => { if (rec.tr) rec.tr.dataset.hidden = '0'; });",
  "  } else {",
  "    const done = new Set();",
  "    nodes.forEach((rec) => {",
  "      const p = rec.path;",
  "      const parent = npParentOf(p);",
  "      if (parent !== '' && nodes.has(parent)) return;",
  "      if (done.has(p)) return;",
  "      const mark = (r) => { done.add(r.path); for (let i = 0; i < r.kids.length; i += 1) mark(r.kids[i]); };",
  "      mark(rec);",
  "      paint(rec, false);",
  "    });",
  "  }",
  "  nodes.forEach((rec) => {",
  "    if (!rec.tr || rec.tr.dataset.kind !== 'group' || rec.tr.dataset.collapsed !== '1') return;",
  "    const mark = (kid) => { kid.tr.dataset.hidden = '1'; for (let i = 0; i < kid.kids.length; i += 1) mark(kid.kids[i]); };",
  "    for (let i = 0; i < rec.kids.length; i += 1) mark(rec.kids[i]);",
  "  });",
  "};",
  "",
  "const setCollapsed = (path, on) => {",
  "  const rec = nodes.get(path);",
  "  if (!rec || !rec.tr) return;",
  "  rec.tr.dataset.collapsed = on ? '1' : '0';",
  "  const mark = (kid) => { kid.tr.dataset.hidden = on ? '1' : '0'; for (let i = 0; i < kid.kids.length; i += 1) mark(kid.kids[i]); };",
  "  for (let i = 0; i < rec.kids.length; i += 1) mark(rec.kids[i]);",
  "  const head = rec.tr.children[0];",
  "  if (head) head.setAttribute('aria-expanded', on ? 'false' : 'true');",
  "};",
  "",
  // D4: a bulk add reports its count.
"const bulkAdd = (path, label) => {",
"  const rec = nodes.get(path);",
"  const all = rec ? rec.leaves : [];",
  "  if (all.length === 0) { note(label + ': 追加できる変数がありません'); return; }",
  // No cap. It used to stop at 32 leaves and say so in the note, but a
  // variable the user added and can see in the tree must also be watched: the
  // host polls the whole watchlist now, so a slice here only produced a
  // watchlist that looked complete and quietly was not.
"  vscode.postMessage({ kind: 'live-add', names: all });",
"  note(label + ': ' + all.length + ' 件追加');",
"};",
  "",
  "const dropUnder = (prefix) => {",
  "  const gone = [];",
  "  cache.forEach((tr, name) => { if (under(name, prefix)) gone.push(name); });",
  "  for (let i = 0; i < gone.length; i += 1) {",
  "    const tr = cache.get(gone[i]);",
  "    if (tr && tr.parentNode) tr.parentNode.removeChild(tr);",
  "    cache.delete(gone[i]); lastRaw.delete(gone[i]); lastValue.delete(gone[i]); watched.delete(gone[i]);",
  "  }",
  "  refreshEmpty();",
  "  return gone.length;",
  "};",
  "const bulkRemove = (path, label) => {",
  "  vscode.postMessage({ kind: 'live-remove-names', names: [path === '' ? st.rootName : path] });",
  "  note(label + ': ' + dropUnder(path) + ' 件を監視から除外');",
  "};",
  "",
  "// -------------------------------------------------------------------- rows",
  "// Only a leaf row has a write cell, and it is children[2] in 変数|値|書込|操作.",
  "// The kind check is the guard that matters: on a group row children[2] is the",
  "// operations cell, so an unguarded index would repaint the buttons and put the",
  "// result mark inside them.",
  "const writeCell = (tr) => (tr.dataset.kind === 'leaf' ? tr.children[2] || null : null);",
  "const writeInputFocused = (tr) => {",
  "  const w = writeCell(tr);",
  "  const inp = w ? w.children[0] : null;",
  "  return !!inp && document.activeElement === inp;",
  "};",
  "const clearRowResult = (tr) => {",
  "  const w = writeCell(tr);",
  "  const m = w ? w.children[1] : null;",
  "  if (!m) return;",
  "  m.hidden = true; m.textContent = ''; m.removeAttribute('title');",
  "};",
  "const setRowResult = (tr, ok, message) => {",
  "  const w = writeCell(tr);",
  "  const m = w ? w.children[1] : null;",
  "  if (!m) return;",
  "  m.textContent = ok ? '✓' : '✗';",
  "  m.dataset.ok = ok ? '1' : '0';",
  "  m.title = String(message || '');",
  "  m.hidden = false;",
  "};",
  "// Enter is the only commit. Blur and 'input' deliberately do nothing: a",
  "// repaint or a stray focus change could otherwise send a half-typed number.",
  "const commitWrite = (inp, tr) => {",
  "  const value = String(inp.value || '').trim();",
  "  if (value === '') { clearRowResult(tr); inp.value = ''; return; }",
  "  post('live-write', { name: tr.dataset.name, value: value });",
  "};",
  "const paintLeaf = (s) => {",
  "  if (!rows) { lastRaw.set(s.name, s.value); return; }",
  "  let tr = cache.get(s.name);",
  "  if (tr && lastRaw.get(s.name) === s.value) return;",
  "  let fresh = false;",
  "  if (!tr) { tr = leafRow(s.name); cache.set(s.name, tr); rows.appendChild(tr); fresh = true; }",
  "  const c = tr.children;",
  "  // Label the same way the tree does: the last segment, full path in the title.",
  "  if (fresh || c[0].textContent === '') {",
  "    const leafName = npLastSegment(String(s.name)) || s.name;",
  "    c[0].textContent = leafName; c[0].title = s.name;",
  "    refreshEmpty();",
  "  }",
  "  lastRaw.set(s.name, s.value);",
  "  const text = show(s);",
  "  const m = meta.get(s.name);",
  "  const tip = (m ? String(m.type || m.kind) + (m.size ? ' ' + m.size + 'B' : '') : '型不明') + ' / ' + rawHex(s.value);",
  "  // The title and the aria-label have to describe the same sample as the text,",
  "  // so they are derived from `text` and written before the freeze below.",
  "  if (c[1].title !== tip) { c[1].title = tip; c[1].setAttribute('aria-label', s.name + ' ' + text); }",
  "  // A focused 書込 input belongs to the user: at 200Hz the next sample would",
  "  // overwrite the text — and the value it is being typed against — several",
  "  // times a second. Only the cell text is frozen; the accessible value above",
  "  // keeps tracking the wire, so a screen reader never announces a stale number",
  "  // while a value is being typed.",
  "  if (writeInputFocused(tr)) return;",
  "  c[1].textContent = text;",
  "};",
  "",
  "const toggleFmt = (name) => {",
  "  fmt.set(name, fmt.get(name) === 'hex' ? 'dec' : 'hex');",
  "  shown.clear();",
  "  const tr = cache.get(name);",
  "  const v = lastRaw.get(name);",
  "  if (!tr || v === undefined) return;",
  "  const c = tr.children[1];",
  "  c.textContent = fmt.get(name) === 'hex' ? rawHex(v) : decode(v, meta.get(name)).text;",
  "};",
  "",
  "// ------------------------------------------------------------------ series",
  "// The plot lives in the editor-area graph panel (D1); this section is a",
  "// launcher plus a status/selection list, so there is no second renderer.",
  "const PALETTE = ['#4c9aff', '#f78166', '#c586c0', '#6ac47c', '#d7ba7d', '#9cdcfe'];",
  "const seriesRow = (name) => {",
  "  const box = el('graph-series');",
  "  if (!box) return null;",
  "  const kids = box.children;",
  "  for (let i = 0; i < kids.length; i += 1) if (kids[i].dataset.name === name) return kids[i];",
  "  return null;",
  "};",
  "const paintSeriesValue = (name) => {",
  "  const li = seriesRow(name);",
  "  if (!li || !li.children[2]) return;",
  "  const t = lastValue.get(name) || '—';",
  "  if (li.children[2].textContent !== t) li.children[2].textContent = t;",
  "};",
  "const renderSeries = () => {",
  "  const box = el('graph-series');",
  "  if (!box) return;",
  "  while (box.firstChild) box.removeChild(box.firstChild);",
  "  if (series.size === 0) {",
  "    const li = document.createElement('li');",
  "    li.className = 'empty';",
  "    li.textContent = '系列がありません';",
  "    box.appendChild(li);",
  "    return;",
  "  }",
  "  series.forEach((info, name) => {",
  "    const li = document.createElement('li');",
  "    li.dataset.name = name;",
  "    li.dataset.visible = info.visible ? '1' : '0';",
  "    const dot = document.createElement('span');",
  "    dot.className = 'dot';",
  "    dot.style.background = info.color;",
  "    const nm = document.createElement('span');",
  "    nm.className = 'nm'; nm.textContent = name;",
  "    const vv = document.createElement('span');",
  "    vv.className = 'vv'; vv.textContent = lastValue.get(name) || '—';",
  "    const stt = document.createElement('span');",
  "    stt.className = 'st'; stt.textContent = info.visible ? '表示' : '非表示';",
  "    li.appendChild(dot); li.appendChild(nm); li.appendChild(vv); li.appendChild(stt);",
  "    box.appendChild(li);",
  "  });",
  "};",
  "",
  "// --------------------------------------------------------------------- log",
  "const logNode = el('log-tail');",
  "const renderLog = () => {",
  "  if (!logNode) return;",
  "  const src = logFilter === '' ? logBuf : logBuf.filter((l) => l.indexOf(logFilter) >= 0);",
  "  setText(logNode, src.length === 0 ? '' : src.join('\\n') + '\\n');",
  "  if (logPinned) logNode.scrollTop = logNode.scrollHeight;",
  "};",
  "const appendLog = (lines) => {",
  "  let dropped = false;",
  "  for (let i = 0; i < lines.length; i += 1) {",
  "    logBuf.push(String(lines[i]));",
  "    if (logBuf.length > LOG_MAX) { logBuf.shift(); dropped = true; }",
  "  }",
  "  if (!logNode) return;",
  "  if (logFilter !== '' || dropped) { renderLog(); return; }",
  "  logNode.appendChild(document.createTextNode(lines.map(String).join('\\n') + '\\n'));",
  "  if (logPinned) logNode.scrollTop = logNode.scrollHeight;",
  "};",
  "",
  "// ------------------------------------------------------------------- gates",
  "const applyLive = () => {",
  "  clearWhy('live-why');",
  "  const s = st.live;",
  "  const on = s === 'running' || s === 'paused';",
  "  const pill = el('live-state');",
  "  if (pill) {",
  "    pill.textContent = s === 'running' ? '監視中' : s === 'paused' ? '一時停止'",
  "      : s === 'starting' ? '接続中' : s === 'error' ? 'エラー' : '停止';",
  "    pill.className = 'pill ' + (s === 'error' ? 'bad' : s === 'idle' ? 'idle' : s === 'running' ? 'ok' : 'run');",
  "  }",
  "  const pt = el('live-pause-toggle');",
  "  if (pt) pt.textContent = s === 'paused' ? '再開' : '一時停止';",
  "  gate('live-start', (s === 'idle' || s === 'error') && st.project !== '',",
  "    st.project === '' ? 'プロジェクト未選択' : '監視中です', 'live-why');",
  // An empty watchlist no longer disables 監視開始: pressing it opens the
  // variable-add flow instead, so the hint names what the press will do.
  "  if ((s === 'idle' || s === 'error') && st.project !== '' && watched.size === 0) {",
  "    const hint = reasons.get('live-why') || []; hint.push('監視する変数がありません — 監視開始で「変数追加」が開きます'); reasons.set('live-why', hint);",
  "  }",
  "  gate('live-stop', on, '監視していません', 'live-why');",
  "  gate('live-pause-toggle', on, s === 'starting' ? '接続中です' : '監視していません', 'live-why');",
  "  gate('live-reconnect', !on, '監視中です', 'live-why');",
  "  gate('live-add-watch', st.hasTree, '型ツリー未受信 (ビルドしてください)', 'live-why');",
  "  gate('live-export-csv', on, '監視していません', 'live-why');",
  "  flushWhy();",
  "};",
  "const applyBuild = () => {",
  "  clearWhy('build-why');",
  "  const running = st.build === 'running';",
  "  const pill = el('build-pill');",
  "  if (pill) {",
  "    pill.textContent = running ? (st.buildPhase || 'ビルド中') : st.build === 'ok' ? '成功' : st.build === 'failed' ? '失敗' : '待機';",
  "    pill.className = 'pill ' + (st.build === 'ok' ? 'ok' : st.build === 'failed' ? 'bad' : running ? 'run' : 'idle');",
  "  }",
  "  gate('build-run', !running && st.project !== '', st.project === '' ? 'プロジェクト未選択' : 'ビルド中です', 'build-why');",
  "  gate('build-flash', !running && st.project !== '', st.project === '' ? 'プロジェクト未選択' : 'ビルド中です', 'build-why');",
  "  flushWhy();",
  "};",
  "const applyFlash = () => {",
  "  clearWhy('flash-why');",
  "  const failed = st.flash.startsWith('書き込み失敗') || st.flash === 'failed' || st.flash === 'error';",
  // Positive test, not "not failed and not done": a terminal phase the host has
  // not seen before (設定不足, 先にビルドしてください, ...) must not wedge 書込.
  "  const busy = st.flashBusy === null ? st.flash.startsWith('書き込み中') : st.flashBusy;",
  "  const retry = el('flash-retry');",
  "  if (retry) retry.hidden = !failed;",
  "  gate('flash-start', !busy && st.elf !== '', st.elf === '' ? 'ELF がありません (先にビルド)' : '書き込み中です', 'flash-why');",
  "  gate('flash-retry', failed, '失敗した書き込みがありません', 'flash-why');",
  "  flushWhy();",
  "};",
  "const applyGraph = () => {",
  "  clearWhy('graph-why');",
  "  const v = gi.value.trim();",
  "  gate('graph-add', v !== '', '変数名を入力してください', 'graph-why');",
  "  gate('graph-remove', v !== '', '変数名を入力してください', 'graph-why');",
  "  flushWhy();",
  "};",
  "",
  "const renderProjects = (s) => {",
  "  const box = el('project-rows');",
  "  if (!box) return;",
  "  while (box.firstChild) box.removeChild(box.firstChild);",
  "  const list = Array.isArray(s.projects) ? s.projects : [];",
  "  for (let i = 0; i < list.length; i += 1) {",
  "    const p = list[i];",
  "    const b = document.createElement('button');",
  "    b.className = 'row' + (p.dir === s.selectedDir ? ' on' : '');",
  "    b.dataset.testid = 'project-select';",
  "    b.dataset.dir = p.dir;",
  "    b.title = p.dir;",
  "    b.textContent = p.name;",
  "    box.appendChild(b);",
  "  }",
  "  const empty = el('project-empty');",
  "  if (empty) empty.hidden = list.length > 0;",
  "};",
  "",
  "const renderDiags = (list) => {",
  "  const box = el('build-diags');",
  "  if (!box) return;",
  "  while (box.firstChild) box.removeChild(box.firstChild);",
  "  for (let i = 0; i < list.length && i < 50; i += 1) {",
  "    const d = list[i];",
  "    if (d.kind !== 'error') continue;",
  "    const a = document.createElement('a');",
  "    a.className = 'diag';",
  "    a.href = 'command:stm32ext.openBuildDiag?' + encodeURIComponent(JSON.stringify([{ file: d.file, line: d.line, col: d.col }]));",
  "    a.textContent = d.file + ':' + d.line + ':' + d.col;",
  "    box.appendChild(a);",
  "  }",
  "};",
  "",
  "const applySeries = (csv) => {",
  "  const names = String(csv || '').split(',').map((t) => t.trim()).filter((t) => t !== '');",
  "  series.clear();",
  "  for (let i = 0; i < names.length; i += 1) series.set(names[i], { visible: true, color: PALETTE[i % PALETTE.length] });",
  "  renderSeries();",
  "};",
  "",
  "const applyWatchlist = (names) => {",
  "  watched.clear();",
  "  for (let i = 0; i < names.length; i += 1) watched.add(String(names[i]));",
  "  cache.forEach((tr, name) => { tr.dataset.watched = watched.has(name) ? '1' : '0'; });",
  "  nodes.forEach((rec) => {",
  "    if (!rec.tr || rec.tr.dataset.kind !== 'group') return;",
  "    let hit = 0;",
  "    for (let i = 0; i < rec.leaves.length; i += 1) if (watched.has(rec.leaves[i])) hit += 1;",
  "    rec.tr.dataset.watched = hit > 0 ? '1' : '0';",
  "  });",
  // gate('live-start') reads watched.size, and this is its only writer.
  "  applyLive();",
  "};",
  "",
  "const applyState = (s) => {",
  "  if (!s) return;",
  "  st.elf = s.elfPath || '';",
  "  st.project = s.selectedDir || st.project;",
  "  renderProjects(s);",
  "  st.build = s.buildStatus || 'idle';",
  "  if (st.build !== 'running') st.buildPhase = '';",
  "  const pct = Math.max(0, Math.min(100, Number(s.buildPercent) || 0));",
  "  setText(el('build-pct'), pct + '%');",
  "  const bar = el('build-bar'); if (bar) bar.value = pct;",
  "  setText(el('build-elf'), s.elfPath ? String(s.elfPath).split('/').pop() : '');",
  "  const elf = el('build-elf'); if (elf) elf.title = s.elfPath || '';",
  "  renderDiags(Array.isArray(s.diagnostics) ? s.diagnostics : []);",
  "  setText(el('flash-progress'), s.flashProgress || '');",
  "  setText(el('flash-result'), s.flashResult || '');",
  "  setText(el('live-hz'), (Number(s.liveHz) || 0) + 'Hz');",
  "  const src = el('live-source');",
  "  if (src) { src.textContent = s.liveSource ? String(s.liveSource).split('/').pop() : ''; src.title = s.liveSource || ''; }",
  "  setText(el('live-drop-rate'), s.liveDrop || '');",
  "  setText(el('live-unresolved'), (s.unresolved && s.unresolved.length > 0) ? '未解決 ' + s.unresolved.join(', ') : '');",
  // The host pushes state on every build settle / select / flash phase, so an
  // unconditional write would delete a half-typed name.
  "  if (Array.isArray(s.graphSeries) && document.activeElement !== gi) { gi.value = s.graphSeries.join(', '); applySeries(gi.value); }",
  "  if (typeof s.logTail === 'string' && s.logTail !== '') { logBuf = s.logTail.replace(/\\n$/, '').split('\\n'); renderLog(); }",
  "  applyBuild(); applyFlash(); applyLive(); applyGraph();",
  "};",
  "",
  "// ------------------------------------------------------------------ wiring",
  "const post = (kind, extra) => {",
  "  const m = { kind: kind };",
  "  if (extra) for (const k of Object.keys(extra)) m[k] = extra[k];",
  "  vscode.postMessage(m);",
  "};",
  "const onClick = (id, fn) => { const b = el(id); if (b) b.addEventListener('click', fn); };",
  "onClick('project-refresh', () => post('project-refresh'));",
  "onClick('build-run', () => post('build-run'));",
  "onClick('build-flash', () => post('build-flash'));",
  "onClick('flash-start', () => post('flash'));",
  "onClick('flash-retry', () => post('flash-retry'));",
  "onClick('live-start', () => {",
  "  if (st.project === '') return;",
  "  post(watched.size === 0 ? 'live-add-watch' : 'live-start');",
  "});",  "onClick('live-stop', () => post('live-stop'));",
  "onClick('live-reconnect', () => post('live-reconnect'));",
  "onClick('live-export-csv', () => post('live-export-csv'));",
  "onClick('live-add-watch', () => post('live-add-watch'));",
  "onClick('live-pause-toggle', () => post(st.live === 'paused' ? 'live-resume' : 'live-pause'));",
  "onClick('log-clear', () => { logBuf = []; renderLog(); post('log-clear'); });",
  "const graphNames = () => String(gi.value || '').split(',').map((t) => t.trim()).filter((t) => t !== '');",
  // One message per name, like the graph panel: the host adds a series by
  // exact name, so posting "a, b" would create a series literally called "a, b".
  "onClick('graph-add', () => { const ns = graphNames(); for (let i = 0; i < ns.length; i += 1) post('graph-add', { name: ns[i] }); });",
  "onClick('graph-remove', () => { const ns = graphNames(); for (let i = 0; i < ns.length; i += 1) post('graph-remove', { name: ns[i] }); });",
  "",
  "const pbox = el('project-rows');",
  "if (pbox) pbox.addEventListener('click', (ev) => {",
  "  const t = ev.target && ev.target.closest ? ev.target.closest('[data-dir]') : null;",
  "  if (t) post('project-select', { dir: t.dataset.dir });",
  "});",
  "",
  "const handleOp = (op, tr) => {",
  "  const label = tr.children[0] ? tr.children[0].textContent : tr.dataset.name;",
  "  if (op.dataset.op === 'add') { bulkAdd(tr.dataset.path, label); return; }",
  "  if (tr.dataset.kind === 'group') { bulkRemove(tr.dataset.path, label); return; }",
  "  post('live-remove-names', { names: [tr.dataset.name] });",
  "  note(label + ': ' + dropUnder(tr.dataset.name) + ' 件を監視から除外');",
  "};",
  "",
  "if (rows) {",
  "  rows.addEventListener('click', (ev) => {",
  "    const t = ev.target;",
  "    if (!t || !t.closest) return;",
  "    const op = t.closest('[data-op]');",
  "    if (op) { handleOp(op, op.closest('tr')); return; }",
  "    const head = t.closest('[data-collapse]');",
  "    if (head) { const tr = head.closest('tr'); setCollapsed(tr.dataset.path, tr.dataset.collapsed !== '1'); return; }",
  "    const v = t.closest('[data-fmt]');",
  "    if (v) toggleFmt(v.closest('tr').dataset.name);",
  "  });",
  "  rows.addEventListener('keydown', (ev) => {",
  "    const t0 = ev.target;",
  "    // The 書込 input is handled first and exclusively: Enter and Esc belong to",
  "    // it, and every other key has to stay a keystroke in a text field.",
  "    if (t0 && t0.closest) {",
  "      const inp = t0.closest('[data-write]');",
  "      if (inp) {",
  "        const tr0 = inp.closest('tr');",
  "        if (ev.key === 'Enter') { commitWrite(inp, tr0); ev.preventDefault(); return; }",
  "        if (ev.key === 'Escape') { inp.value = ''; clearRowResult(tr0); ev.preventDefault(); return; }",
  "        return;",
  "      }",
  "    }",
  "    if (ev.key !== 'Enter' && ev.key !== ' ') return;",
  "    const t = t0;",
  "    if (!t || !t.closest) return;",
  "    const tr = t.closest('tr');",
  "    if (!tr) return;",
  "    if (t.closest('[data-collapse]')) { setCollapsed(tr.dataset.path, tr.dataset.collapsed !== '1'); ev.preventDefault(); return; }",
  "    if (t.closest('[data-fmt]')) { toggleFmt(tr.dataset.name); ev.preventDefault(); }",
  "  });",
  "}",
  "",
  "if (gi) {",
  "  gi.addEventListener('input', () => { applySeries(gi.value); applyGraph(); });",
  "}",
  "if (cf) cf.addEventListener('input', () => { catalogQuery = cf.value; applyCatalogFilter(); });",
  "if (la) la.addEventListener('change', () => { logPinned = !!la.checked; if (logPinned && logNode) logNode.scrollTop = logNode.scrollHeight; });",
  "if (lf) lf.addEventListener('input', () => {",
  "  logFilter = lf.value;",
  "  renderLog();",
  "  if (lfTimer !== 0) clearTimeout(lfTimer);",
  "  lfTimer = setTimeout(() => { lfTimer = 0; post('log-filter', { text: logFilter }); }, 250);",
  "});",
  "",
  "window.addEventListener('message', (ev) => {",
  "  const m = ev.data || {};",
  "  if (m.kind === 'live-bootstrap') { st.project = m.project || st.project; applyState(m.state); setText(el('live-hz'), (Number(m.hz) || 0) + 'Hz'); return; }",
  "  if (m.kind === 'live-types') { buildTree(m.tree, m.index); return; }",
  "  if (m.kind === 'live-catalog' && Array.isArray(m.roots)) { buildCatalog(m.roots); return; }",
  "  if (m.kind === 'live-sample' && Array.isArray(m.samples)) {",
  "    const arr = m.samples;",
  "    for (let i = 0; i < arr.length; i += 1) {",
  "      const s = arr[i];",
  "      if (series.has(s.name)) {",
  "        const t = show(s);",
  "        if (lastValue.get(s.name) !== t) { lastValue.set(s.name, t); paintSeriesValue(s.name); }",
  "      }",
  "      if (!rows) continue;",
  "      if (!cache.has(s.name) && st.hasTree) continue;",
  "      paintLeaf(s);",
  "    }",
  "    return;",
  "  }",
  "  if (m.kind === 'live-status') {",
  "    st.live = String(m.state || 'idle');",
  "    setText(el('live-status-text'), m.text || '');",
  "    setText(el('live-detail'), m.detail || '');",
  "    applyLive();",
  "    return;",
  "  }",
  "  if (m.kind === 'live-drop') { setText(el('live-drop-rate'), m.summary || ''); return; }",
  "  if (m.kind === 'live-unresolved') { setText(el('live-unresolved'), (m.names || []).length > 0 ? '未解決 ' + m.names.join(', ') : ''); return; }",
  "  if (m.kind === 'live-write-result') {",
  "    setText(el('live-write-result'), m.message || '');",
  "    const wtr = m.name ? cache.get(m.name) : null;",
  "    if (wtr) setRowResult(wtr, m.ok === true, m.message || '');",
  "    return;",
  "  }",
  "  if (m.kind === 'live-watchlist') { applyWatchlist(Array.isArray(m.names) ? m.names : []); return; }",
  "  if (m.kind === 'build-progress') {",
  "    st.build = 'running';",
  "    st.buildPhase = String(m.phase || 'ビルド中');",
  "    const raw0 = m.percent === null || m.percent === undefined ? 0 : Number(m.percent);",
  "    const p = Math.max(0, Math.min(100, raw0));",
  "    setText(el('build-pct'), (m.total ? m.done + '/' + m.total + ' ' : '') + p + '%');",
  "    const bar = el('build-bar'); if (bar) bar.value = p;",
  "    applyBuild();",
  "    return;",
  "  }",
  "  if (m.kind === 'flash-progress') {",
  "    st.flash = String(m.phase || '');",
  "    st.flashBusy = typeof m.busy === 'boolean' ? m.busy : null;",
  "    setText(el('flash-progress'), st.flash);",
  "    applyFlash();",
  "    return;",
  "  }",
  "  if (m.kind === 'log-append') { appendLog(Array.isArray(m.lines) ? m.lines : []); return; }",
  "  if (m.kind === 'graph-series') {",
  "    const list = Array.isArray(m.series) ? m.series : [];",
  "    series.clear();",
  "    for (let i = 0; i < list.length; i += 1) {",
  "      if (!list[i] || typeof list[i].name !== 'string' || list[i].name === '') continue;",
  "      series.set(list[i].name, { visible: list[i].visible !== false, color: list[i].color || PALETTE[i % PALETTE.length] });",
  "    }",
  "    const shownNames = [];",
  "    series.forEach((info, name) => { if (info.visible) shownNames.push(name); });",
  "    gi.value = shownNames.join(', ');",
  "    renderSeries();",
  "    applyGraph();",
  "    return;",
  "  }",
  "});",
  "",
  "applySeries(gi.value);",
  "refreshEmpty();",
  "applyLive(); applyBuild(); applyFlash(); applyGraph();",
].join("\n");

export type SidebarMessageKind =
  | "project-select" | "project-refresh"
  | "build-run" | "build-flash"
  | "flash" | "flash-retry"
  | "live-start" | "live-stop" | "live-pause" | "live-resume" | "live-reconnect"
  | "live-export-csv" | "live-add-watch" | "live-write" | "live-remove"
  | "live-add" | "live-remove-names"
  | "log-clear" | "log-filter"
  | "graph-add" | "graph-remove";

export interface SidebarMessage {
  readonly kind: SidebarMessageKind;
  readonly dir: string;
  readonly name: string;
  readonly value: string;
  /** Present only for `live-add` / `live-remove-names`. Every other kind keeps
   *  its original four-field shape so existing host switch arms stay valid. */
  readonly names?: readonly string[];
}

const SIMPLE: readonly SidebarMessageKind[] = [
  "project-refresh", "build-run", "build-flash", "flash", "flash-retry",
  "live-start", "live-stop", "live-pause", "live-resume", "live-reconnect",
  "live-export-csv", "live-add-watch", "log-clear",
];

function stringList(rawValue: unknown): string[] {
  if (!Array.isArray(rawValue)) {
    return [];
  }
  return rawValue.filter((v): v is string => typeof v === "string" && v !== "");
}

export function parseSidebarMessage(raw: unknown): SidebarMessage | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const r = raw as Record<string, unknown>;
  const kind = r["kind"];
  if (typeof kind !== "string") {
    return null;
  }
  if (SIMPLE.includes(kind as SidebarMessageKind)) {
    return { kind: kind as SidebarMessageKind, dir: "", name: "", value: "" };
  }
  if (kind === "project-select" && typeof r["dir"] === "string") {
    return { kind, dir: r["dir"], name: "", value: "" };
  }
  if (kind === "graph-add" && typeof r["name"] === "string") {
    return { kind, dir: "", name: r["name"], value: "" };
  }
  if (kind === "graph-remove" && typeof r["name"] === "string") {
    return { kind, dir: "", name: r["name"], value: "" };
  }
  if (kind === "live-remove" && typeof r["name"] === "string" && r["name"] !== "") {
    return { kind, dir: "", name: r["name"], value: "" };
  }
  if (kind === "live-write" && typeof r["name"] === "string" && typeof r["value"] === "string") {
    return { kind, dir: "", name: r["name"], value: r["value"] };
  }
  if (kind === "live-add" || kind === "live-remove-names") {
    const names = stringList(r["names"]);
    return names.length === 0 ? null : { kind, dir: "", name: "", value: "", names };
  }
  if (kind === "log-filter" && typeof r["text"] === "string") {
    return { kind, dir: "", name: r["text"], value: "" };
  }
  return null;
}

export const SIDEBAR_VIEW_ID = "stm32ext-sidebar";
export const SIDEBAR_VIEW_NAME = "STM32";
