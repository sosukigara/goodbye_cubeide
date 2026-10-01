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
  liveHz: 100,
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
  const rows = s.graphSeries.map((n) =>
    `<li data-name="${esc(n)}" data-visible="1"><span class="dot"></span>`
    + `<span class="nm">${esc(n)}</span><span class="vv">—</span><span class="st">表示</span></li>`).join("");
  return `<a class="btn primary" data-testid="graph-open" role="button" href="command:stm32ext.showGraph">グラフを開く</a>`
  // An entry field, not a mirror of the list below: it is never seeded with the
  // plotted names, so a caret edit cannot splice a half-typed name onto one of
  // them and post the concatenation as a new series.
  + `<input data-testid="graph-input" type="text" list="graph-name-list" placeholder="系列名を入力" aria-label="系列の変数名（入力して追加・削除）" title="系列名を入力して「追加」で変数ピッカー、「削除」で系列から外す">`
    + `<datalist id="graph-name-list" data-testid="graph-names"></datalist>`
    + `<button data-testid="graph-add" title="変数ピッカーから系列を選ぶ">追加</button> `
    + `<button data-testid="graph-remove" title="入力した系列名をグラフから削除">削除</button>`
    + `<p class="why" data-testid="graph-why"></p>`
    // The action answer, same role the live section gives live-status-text:
    // graph-why is the gate's own line and flushWhy() owns it. `msg` is what
    // collapses the line while it is empty (p.msg:empty), so the section does
    // not carry a permanent gap.
    + `<p class="note msg" data-testid="graph-note" role="status" aria-live="polite"></p>`
    + `<ul class="series" data-testid="graph-series" role="list" aria-label="登録中の系列">`
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
    + `<body><nav class="launch" aria-label="パネル">`
    + `<a class="btn primary" data-testid="launch-build" role="button" href="command:stm32ext.showBuild">ビルドタブ</a>`
    + `<a class="btn" data-testid="launch-variables" role="button" href="command:stm32ext.showVariables">変数タブ</a>`
    + `<a class="btn" data-testid="launch-graph" role="button" href="command:stm32ext.showGraph">グラフタブ</a>`
    + `<a class="btn" data-testid="launch-flash" role="button" href="command:stm32ext.flash">書込</a>`
    + `</nav>${sections}`
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
  + `body{font-family:var(--vscode-font-family,sans-serif);font-size:var(--stm32ext-ui-font,15px);color:var(--vscode-foreground,#ccc);margin:0;padding:10px 10px 28px;line-height:1.5}`
  + `.launch{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:2px 0 12px}`
  + `.launch a.btn{margin:0;text-align:center;padding:9px 4px;border-radius:8px;border:1px solid rgba(127,127,127,.28);background:rgba(127,127,127,.1);font-weight:700;letter-spacing:.06em;transition:background .12s ease,border-color .12s ease}`
  + `.launch a.btn:hover{background:rgba(127,127,127,.18);border-color:var(--vscode-textLink-foreground,#3794ff)}`
  + `.launch a.btn.primary{background:var(--vscode-button-background,#0e639c);border-color:transparent}`
  + `.launch a.btn.primary:hover{filter:brightness(1.12)}`
  + `section{background:rgba(127,127,127,.07);border:1px solid rgba(127,127,127,.22);border-radius:10px;padding:10px 12px 12px;margin:0 0 10px}`
  + `h2{font-size:.82em;font-weight:700;margin:0 0 8px;letter-spacing:.1em;opacity:.92;display:flex;align-items:center;gap:8px}`
  + `h2::after{content:"";flex:1 1 auto;height:1px;background:rgba(127,127,127,.25)}`
  + `.step{display:inline-flex;align-items:center;justify-content:center;min-width:1.4em;height:1.4em;padding:0 .35em;border-radius:999px;background:var(--vscode-textLink-foreground,#3794ff);color:#fff;font-size:.85em;font-weight:700;line-height:1}`
  + `a.btn.primary{background:var(--vscode-button-background,#0e639c);color:var(--vscode-button-foreground,#fff)}`
  + `.ctrls{display:flex;flex-wrap:wrap;gap:0}`
  // Tap target: 28px, so every section control clears the platform minimum.
  + `button{font:inherit;margin:0 4px 4px 0;padding:5px 12px;min-height:28px;border-radius:6px;border:1px solid transparent;background:var(--vscode-button-secondaryBackground,#3a3d41);color:var(--vscode-button-secondaryForeground,#ccc);cursor:pointer;transition:filter .12s ease}`
  + `button:hover:not(:disabled){filter:brightness(1.15)}`
  + `button:disabled{opacity:.45;cursor:default}`
  + `button.primary{background:var(--vscode-button-background,#0e639c);color:var(--vscode-button-foreground,#fff)}`
  + `button.row{display:block;width:100%;text-align:left;background:transparent;border:none;padding:3px 6px;border-radius:6px}`
  + `button.row:hover{background:rgba(127,127,127,.14)}`
  + `button.row.on{font-weight:700;background:rgba(127,127,127,.14);box-shadow:inset 2px 0 0 var(--vscode-textLink-foreground,#3794ff)}`
  + `.rows{margin-bottom:4px}`
  + `p{margin:3px 0}`
  + `.empty,.warn{opacity:.7}`
  + `.why{opacity:.7;font-size:.92em;min-height:1em}`
  + `.note{opacity:.85;font-size:.94em}`
  + `.msg{margin:3px 0;font-size:.95em}`
  + `p.msg:empty, p.detail:empty{display:none}`
  + `.detail{margin:2px 0 3px;opacity:.75;font-size:.92em;white-space:pre-wrap}`
  + `.status{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:6px 0}`
  + `.pill{font-weight:700;font-size:.86em;padding:2px 10px;border-radius:999px;background:rgba(127,127,127,.16)}`
  + `.pill.ok{color:var(--vscode-testing-iconPassed,#4fc34f);background:rgba(56,138,52,.18)}`
  + `.pill.bad{color:var(--vscode-testing-iconFailed,#f14c4c);background:rgba(241,76,76,.16)}`
  + `.pill.run{color:var(--vscode-testing-iconQueued,#e2c000);background:rgba(204,167,0,.16)}`
  + `.pill.idle{opacity:.65;font-weight:400}`
  + `.pct,.drop,.path{font-family:var(--vscode-editor-font-family,monospace);font-variant-numeric:tabular-nums;opacity:.8;font-size:.94em}`
  + `.path{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`
  + `progress{width:100%;height:5px;border-radius:999px;overflow:hidden}`
  + `progress::-webkit-progress-bar{background:rgba(127,127,127,.18);border-radius:999px}`
  + `progress::-webkit-progress-value{background:var(--vscode-textLink-foreground,#3794ff);border-radius:999px}`
  + `progress::-moz-progress-bar{background:var(--vscode-textLink-foreground,#3794ff);border-radius:999px}`
  + `.diags{margin-top:4px;max-height:120px;overflow:auto}`
  + `.diag{display:block;font-family:var(--vscode-editor-font-family,monospace);font-size:.9em;color:var(--vscode-textLink-foreground,#3794ff);text-decoration:none}`
  + `.busy{opacity:.7}.result{white-space:pre-wrap}`
  + `label.chk{display:inline-flex;align-items:center;gap:3px;font-size:.9em;opacity:.8;margin:0 6px 4px 0}`
  + `label.chk input{width:auto;margin:0}`
  + `input{background:var(--vscode-input-background,#3c3c3c);color:var(--vscode-input-foreground,#ccc);border:1px solid var(--vscode-input-border,rgba(128,128,128,.35));border-radius:6px;padding:5px 7px;font:inherit;box-sizing:border-box;width:100%;margin:2px 0}`
  + `input:focus{border-color:var(--vscode-focusBorder,#007fd4);outline:none}`
  + `a.btn{display:inline-block;margin:0 4px 4px 0;padding:4px 12px;border-radius:6px;background:var(--vscode-button-secondaryBackground,#3a3d41);color:var(--vscode-button-secondaryForeground,#ccc);text-decoration:none;transition:filter .12s ease}`
  + `a.btn:hover{filter:brightness(1.15)}`
  + `ul.series{list-style:none;margin:6px 0 0;padding:0;display:flex;flex-direction:column;gap:4px}`
  + `ul.series li{display:flex;gap:8px;align-items:center;font-family:var(--vscode-editor-font-family,monospace);font-size:.95em;padding:4px 8px;background:rgba(127,127,127,.08);border:1px solid rgba(127,127,127,.18);border-radius:6px}`
  + `ul.series li[data-visible="0"]{opacity:.5}`
  + `.dot{width:9px;height:9px;border-radius:3px;flex:0 0 auto;background:var(--vscode-textLink-foreground,#3794ff)}`
  + `.nm{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`
  + `.vv{font-variant-numeric:tabular-nums;font-weight:600}`
  + `.st{opacity:.7;font-size:.86em;padding:1px 8px;border-radius:999px;background:rgba(127,127,127,.16)}`
  + `pre{background:rgba(127,127,127,.08);border:1px solid rgba(127,127,127,.18);border-radius:8px;padding:8px;overflow:auto;box-sizing:border-box;max-height:150px;font-family:var(--vscode-editor-font-family,monospace);font-size:.88em;margin:0}`
  + `button:focus-visible,input:focus-visible,a.btn:focus-visible{outline:1px solid var(--vscode-focusBorder,#007fd4)}`
  + `::-webkit-scrollbar{width:10px;height:10px}`
  + `::-webkit-scrollbar-thumb{background:rgba(127,127,127,.35);border-radius:999px;border:2px solid transparent;background-clip:content-box}`
  + `::-webkit-scrollbar-track{background:transparent}`
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
  "// spec 3.4. One place, reused by the graph section's value column.",
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
  "const st = { live: 'idle', build: 'idle', buildPhase: '', flash: '', flashBusy: null, project: '', elf: '' };",
  // Survives without a table because two reachable consumers read it: the
  // graph section's decoded 最新値 column and the graph input's completion list.
  "const meta = new Map();",   // leaf name -> LeafMeta
  "const shown = new Map();   // name+value memo: BigInt churn at 100Hz is waste",
  "const series = new Map();   // name -> {visible, color}, mirrors the graph panel",
  "const lastValue = new Map(); // name -> last decoded text for the series list",
  "const watched = new Set(); // host is the authority (live-watchlist)",
  "let logBuf = [];",
  "let logFilter = '';",
  "let logPinned = true;",
  "",
  "const show = (s) => {",
  "  const k = s.name + '\\u0000' + s.value;",
  "  let t = shown.get(k);",
  "  if (t === undefined) {",
  "    t = decode(s.value, meta.get(s.name)).text;",
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
  "const gi = el('graph-input');",
  "const lf = el('log-filter');",
  "const la = el('log-autoscroll');",
  "let lfTimer = 0;",
  "",
"// Name completion for the graph input, fed from the live-types index.",
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
  "",
  // The sidebar keeps no table, so live-types only has to leave `meta` behind:
  // it is what the graph section decodes a series value with, and what the
  // graph input offers as completion. The rows themselves are the editor-area
  // variable tab's job (variablePanel.ts), which renders the same index.
  "const applyTypes = (index) => {",
  "  meta.clear(); shown.clear();",
  "  if (index && typeof index === 'object') for (const k of Object.keys(index)) meta.set(k, index[k]);",
  "  fillNameList();",
  "};",
  "",
  "// ------------------------------------------------------------------ series",
  "// Batches arrive at display rate but a slow tick must never backlog: only",
  "// the newest sample per name is kept, and painting runs at most 10/s.",
  "// Without a timer (tests) the flush is synchronous, so assertions observe",
  "// the same end state as the live panel.",
  "const staged = new Map();",
  "let sampleFlushAt = 0;",
  "let sampleTimer = 0;",
  "const SAMPLE_FLUSH_MS = 100;",
  "const flushStaged = () => {",
  "  sampleTimer = 0;",
  "  sampleFlushAt = Date.now();",
  "  staged.forEach((s) => {",
  "    if (series.has(s.name)) {",
  "      const t = show(s);",
  "      if (lastValue.get(s.name) !== t) { lastValue.set(s.name, t); paintSeriesValue(s.name); }",
  "    }",
  "  });",
  "  staged.clear();",
  "};",
  "const stageSamples = (arr) => {",
  "  for (let i = 0; i < arr.length; i += 1) {",
  "    const s = arr[i];",
  "    if (s && typeof s.name === 'string' && s.name !== '') staged.set(s.name, s);",
  "  }",
  "  if (sampleTimer !== 0) return;",
  "  if (typeof setTimeout !== 'function') { flushStaged(); return; }",
  "  const wait = SAMPLE_FLUSH_MS - (Date.now() - sampleFlushAt);",
  "  if (wait <= 0) { flushStaged(); return; }",
  "  sampleTimer = setTimeout(flushStaged, wait);",
  "};",
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
  // Membership comes from the rendered rows, not from the input. 追加/削除
  // compare against `series`, and the rows are the only thing that was ever
  // right on the first frame — before the host's first graph-series lands.
  "const seedSeries = () => {",
  "  const box = el('graph-series');",
  "  if (!box) return;",
  "  const kids = box.children;",
  "  for (let i = 0; i < kids.length; i += 1) {",
  "    const name = kids[i].dataset.name;",
  "    if (name) series.set(name, { visible: kids[i].dataset.visible !== '0', color: PALETTE[i % PALETTE.length] });",
  "  }",
  "};",
  "const graphNote = (t) => setText(el('graph-note'), t);",
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
  "  gate('live-add-watch', true, '', 'live-why');",
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
  "  const v = gi ? gi.value.trim() : '';",
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
  // The graph input is an entry field and is never seeded: the host pushes
  // state on every build settle / select / flash phase, so a write here would
  // both delete a half-typed name and re-mirror the list into the box.
  "  if (Array.isArray(s.graphSeries)) applySeries(s.graphSeries.join(','));",
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
  "const graphName = () => String((gi ? gi.value : '') || '').trim();",
  // Series selection is the host's QuickPick (`var-pick`), the same route the
  // graph panel and the variable tab use: the host expands a picked group
  // through leavesUnder() and calls addSeries, so a name that resolves to
  // nothing can never become a plotted-but-permanently-blank series. Re-adding
  // is answered here instead of being posted, because addSeries() dedups and
  // the press would otherwise look broken.
  "onClick('graph-add', () => {",
  "  const n = graphName();",
  "  if (n === '') { graphNote('系列名を入力してください'); return; }",
  "  if (series.has(n)) { graphNote(n + ' は既にグラフに追加済みです'); return; }",
  "  graphNote('');",
  "  post('var-pick', { query: n });",
  "});",
  "onClick('graph-remove', () => {",
  "  const n = graphName();",
  "  if (n === '') { graphNote('系列名を入力してください'); return; }",
  "  if (!series.has(n)) { graphNote(n + ' はグラフにありません'); return; }",
  "  graphNote('');",
  "  post('graph-remove', { name: n });",
  "});",
  "",
  "const pbox = el('project-rows');",
  "if (pbox) pbox.addEventListener('click', (ev) => {",
  "  const t = ev.target && ev.target.closest ? ev.target.closest('[data-dir]') : null;",
  "  if (t) post('project-select', { dir: t.dataset.dir });",
  "});",
  "",
  "if (gi) {",
  // Only the gate follows the keystrokes. The list used to be re-rendered from
  // this box on every input event, which is what made the entry field and the
  // series list read as one control.
  "  gi.addEventListener('input', () => { applyGraph(); });",
  "}",
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
  "  if (m.kind === 'live-types') { applyTypes(m.index); return; }",
  "  if (m.kind === 'live-sample' && Array.isArray(m.samples)) {",
  "    stageSamples(m.samples);",
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
  // live-unresolved / live-write-result get no arm on purpose: their surface is
  // the editor-area variable tab (variablePanel). Falling through unhandled is
  // the drop; do not add an element here to "handle" them.
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
  "    renderSeries();",
  "    applyGraph();",
  "    return;",
  "  }",
  "});",
  "",
  "seedSeries();",
  "applyLive(); applyBuild(); applyFlash(); applyGraph();",
].join("\n");

export type SidebarMessageKind =
  | "project-select" | "project-refresh"
  | "build-run" | "build-flash"
  | "flash" | "flash-retry"
  | "live-start" | "live-stop" | "live-pause" | "live-resume" | "live-reconnect"
  | "live-export-csv" | "live-add-watch"
  | "log-clear" | "log-filter"
  | "var-pick"
  // `graph-add` has no sender: the 追加 button asks the host picker (var-pick)
  // and the host comes back through addSeries. The graph panel's own
  // `graph-add` goes to parseGraphPanelMessage, not here.
  | "graph-remove";

export interface SidebarMessage {
  readonly kind: SidebarMessageKind;
  readonly dir: string;
  readonly name: string;
  readonly value: string;
  /** Only set for `var-pick`: the graph input's text as the QuickPick seed. */
  readonly query?: string;
}

const SIMPLE: readonly SidebarMessageKind[] = [
  "project-refresh", "build-run", "build-flash", "flash", "flash-retry",
  "live-start", "live-stop", "live-pause", "live-resume", "live-reconnect",
  "live-export-csv", "live-add-watch", "log-clear",
];

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
  if (kind === "var-pick" && typeof r["query"] === "string") {
    return { kind, dir: "", name: "", value: "", query: r["query"] };
  }
  if (kind === "graph-remove" && typeof r["name"] === "string") {
    return { kind, dir: "", name: r["name"], value: "" };
  }
  if (kind === "log-filter" && typeof r["text"] === "string") {
    return { kind, dir: "", name: r["text"], value: "" };
  }
  return null;
}

export const SIDEBAR_VIEW_ID = "stm32ext-sidebar";
export const SIDEBAR_VIEW_NAME = "STM32";
