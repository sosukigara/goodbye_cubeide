// Variable panel: the Live watchlist as an editor-area WebviewPanel tab, the
// same D1 shape as the graph panel. The sidebar keeps the status/controls
// surface (start/stop/pause/CSV); this file owns the table surface — search,
// decoded values, per-row write inputs, per-row add/remove.
//
// Host -> webview messages consumed (same shapes as the sidebar uses):
//   live-sample       { samples: LiveSample[] }                  value updates
//   live-types        { tree, index: Record<string, LeafMeta> }   type decoding
//   live-watchlist    { names: string[] }                         authoritative set
//   live-write-result { name, ok, message }                       per-row write feedback
// webview -> host messages produced (see parseVariablePanelMessage):
//   var-add / var-remove   { name }              one message per leaf
//   var-write              { name, value }       Enter in a row's write input
//
// Value decoding follows spec 3.4, same as graphPanel.ts: hex -> BigInt,
// float little-endian through a DataView, enum through the enumerator table,
// signed scalars via asIntN. Raw hex is never shown as a number.
//
// The script below is written without template literals on purpose: it is
// inlined into a <script> block, so `${` and backticks would break the host
// string builder and a stray `</script>` would truncate the page.

import type * as vscode from "vscode";
import { CSV_HEADER } from "./poller.js";
import { EXT_VERSION } from "../version.js";

/** viewType the host registers in the editor area. */
export const VARIABLE_PANEL_VIEW_TYPE = "stm32ext.variables";
export const VARIABLE_PANEL_TITLE = "STM32 Variables";

const VAR_CSS = `<style>`
  + `html,body{height:100%}`
  + `body{font-family:var(--vscode-font-family,sans-serif);font-size:var(--vscode-font-size,13px);color:var(--vscode-foreground,#ccc);margin:0;padding:8px 10px;line-height:1.4;box-sizing:border-box;overflow:auto}`
  + `h1{font-size:1em;font-weight:600;margin:0 0 8px;padding:0}`
  + `h1 .ver{font-weight:400;font-size:.85em;opacity:.55}`
  + `.bar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:4px}`
  + `.grp{display:flex;gap:6px;align-items:center;flex-wrap:wrap}`
  + `.lbl{font-size:.85em;opacity:.7;white-space:nowrap}`
  + `input,button{font:inherit;background:var(--vscode-input-background,#3c3c3c);color:var(--vscode-input-foreground,#ccc);border:1px solid var(--vscode-input-border,rgba(128,128,128,.35));border-radius:2px;padding:3px 7px}`
  + `button{cursor:pointer;background:var(--vscode-button-secondaryBackground,#3a3d41);color:var(--vscode-button-secondaryForeground,#ccc);border-color:transparent}`
  + `button.primary{background:var(--vscode-button-background,#0e639c);color:var(--vscode-button-foreground,#fff)}`
  + `button:focus-visible,input:focus-visible{outline:1px solid var(--vscode-focusBorder,#007fd4)}`
  + `.pick{width:280px;max-width:60vw}`
  + `.srch{width:220px;max-width:50vw}`
  + `table.vars{width:100%;border-collapse:collapse;margin-top:6px;font-size:.95em}`
  + `table.vars th{font-weight:600;text-align:left;opacity:.75;padding:3px 6px;border-bottom:1px solid var(--vscode-panel-border,rgba(128,128,128,.3))}`
  + `table.vars td{padding:2px 6px;border-bottom:1px solid var(--vscode-panel-border,rgba(128,128,128,.2));overflow:hidden}`
  + `td.n{font-family:var(--vscode-editor-font-family,monospace);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:38vw}`
  + `td.v{font-family:var(--vscode-editor-font-family,monospace);font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap;max-width:22vw;overflow:hidden;text-overflow:ellipsis}`
  + `td.w input{width:130px;max-width:18vw;padding:1px 4px}`
  + `td.o{white-space:nowrap;text-align:right}`
  + `td.o button{padding:0 7px;line-height:1.4}`
  + `tr[data-hidden="1"]{display:none}`
  + `.msg{min-height:1.2em;margin:2px 0;font-size:.9em}`
  + `.err{color:var(--vscode-testing-iconFailed,#f14c4c)}`
  + `.note{opacity:.75}`
  + `footer{display:flex;gap:14px;flex-wrap:wrap;align-items:baseline;font-size:.85em;opacity:.8;margin-top:4px}`
  + `</style>`;

// The whole webview program. Kept as one string so the host owns exactly one
// place where HTML and script can drift apart.
const VAR_SCRIPT = `var __SEED = __VAR_SEED__;`
  + `const vscode = acquireVsCodeApi();`
  + `const q = (s) => document.querySelector(s);`
  + `const mk = (t) => document.createElement(t);`
  + `const V = { types: new Map(), order: [], watched: Object.create(null), last: new Map(), query: '' };`
  + `const tbody = q('[data-testid="var-rows"]');`
  + `const errBox = q('[data-testid="var-error"]');`
  + `const noteBox = q('[data-testid="var-note"]');`
  + `const statusBox = q('[data-testid="var-status"]');`
  + `const namesBox = q('[data-testid="var-names"]');`
  + `const picker = q('[data-testid="var-picker"]');`
  + `const search = q('[data-testid="var-search"]');`
  + `const kindOf = (meta) => (meta && typeof meta.kind === 'string' && meta.kind !== '' ? meta.kind : 'scalar');`
  // hex string -> readable label. Same conventions as the graph decode: the
  // raw hex is shown with a type note, never as a bare number.
  + `function decode(name, raw) {`
  + ` const meta = V.types.get(name) || null;`
  + ` const kind = kindOf(meta);`
  + ` const str = String(raw === undefined || raw === null ? '' : raw).trim();`
  + ` const hex = /^0x([0-9a-fA-F]+)$/.exec(str);`
  + ` const note = !meta ? '型不明' : (kind === 'enum' ? 'enum' : (kind === 'string' ? 'string' : (kind === 'bitfield' ? 'bit' : (meta.type || kind) + ' ' + meta.size + 'B')));`
  + ` if (kind === 'string' && hex) {`
  + `  const size0 = (meta && typeof meta.size === 'number' && meta.size > 0) ? meta.size : (hex[1].length >> 1);`
  + `  let b0 = 0n;`
  + `  try { b0 = BigInt('0x' + hex[1]); } catch (e) { return { label: str, note: note }; }`
  + `  return { label: textOf(b0, size0), note: note }; }`
  + ` if (kind === 'string') return { label: str, note: note };`
  + ` if (!hex) return { label: str, note: note };`
  + ` const digits = hex[1].length;`
  + ` const size = (meta && typeof meta.size === 'number' && meta.size > 0) ? meta.size : (digits >> 1);`
  + ` let big = 0n;`
  + ` try { big = BigInt('0x' + hex[1]); } catch (e) { return { label: str, note: note }; }`
  + ` if (kind === 'bitfield' || (meta && typeof meta.bitSize === 'number' && meta.bitSize > 0)) {`
  + `  const w = BigInt(meta && typeof meta.bitSize === 'number' && meta.bitSize > 0 ? meta.bitSize : digits * 4);`
  + `  const at = BigInt(meta && typeof meta.bitOffset === 'number' ? meta.bitOffset : 0);`
  + `  const raw2 = (big >> at) & ((1n << w) - 1n);`
  + `  const sv = (meta && meta.signed) ? BigInt.asIntN(Number(w), raw2) : raw2;`
  + `  return { label: sv.toString(10), note: note }; }`
  + ` if (kind === 'bool') { const b = big !== 0n; return { label: b ? 'true' : 'false', note: note }; }`
  + ` if (kind === 'float') {`
  + `  const f = toFloat(big, size);`
  + `  if (f === null) return { label: str + ' (型不明)', note: note };`
  + `  return { label: f.toPrecision(6), note: note }; }`
  + ` if (kind === 'enum') {`
  + `  const en = (meta && Array.isArray(meta.enumerators)) ? meta.enumerators : [];`
  + `  for (let i = 0; i < en.length; i += 1) {`
  + `   if (BigInt(en[i].value) === big) return { label: String(en[i].name), note: note }; }`
  + `  return { label: big.toString(10) + ' (unknown)', note: note }; }`
  + ` if (!meta) return { label: str + ' 型不明', note: note };`
  + ` if (meta.signed) { const sv = BigInt.asIntN(size * 8, big); return { label: sv.toString(10), note: note }; }`
  + ` return { label: big.toString(10), note: note };`
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
  + `function textOf(big, size) {`
  + ` const b = bytesOf(big, size);`
  + ` let end = b.length;`
  + ` for (let i = 0; i < b.length; i += 1) { if (b[i] === 0) { end = i; break; } }`
  + ` const s = new TextDecoder('utf-8').decode(b.subarray(0, end));`
  + ` return s === '' ? '(空)' : s;`
  + `}`
  + `function fail(msg) { if (errBox) { errBox.textContent = msg; errBox.className = 'err'; } }`
  + `function note(msg) { if (noteBox) { noteBox.textContent = msg; noteBox.className = 'note'; } }`
  + `function clearErr() { if (errBox) { errBox.textContent = ''; errBox.className = 'err'; } }`
  // Membership is the host's call: live-watchlist is authoritative, so the
  // table converges to exactly what the host polls — including empty.
  // watched/keep are null-prototype maps, not {}: a C symbol called
  // `constructor` or `toString` would otherwise hit Object.prototype, look
  // already registered, and never get a row (same class the graph panel
  // fixed with a Set).
  + `function onWatchlist(m) {`
  + ` const arr = m.names;`
  + ` if (!Array.isArray(arr)) return;`
  + ` const keep = Object.create(null);`
  + ` for (let i = 0; i < arr.length; i += 1) {`
  + `  const n = String(arr[i]);`
  + `  if (n === '') continue;`
  + `  keep[n] = true;`
  + `  if (!V.watched[n]) { V.watched[n] = true; V.order.push(n); }`
  + ` }`
  + ` V.order = V.order.filter((n) => keep[n]);`
  + ` const drop = Object.keys(V.watched).filter((n) => !keep[n]);`
  + ` for (let i = 0; i < drop.length; i += 1) delete V.watched[drop[i]];`
  + ` rebuild();`
  + `}`
  + `function onTypes(m) {`
  + ` const idx = m.index;`
  + ` if (idx && typeof idx === 'object') {`
  + `  const next = new Map();`
  + `  const keys = Object.keys(idx);`
  + `  for (let i = 0; i < keys.length; i += 1) next.set(keys[i], idx[keys[i]]);`
  + `  V.types = next;`
  + ` }`
  + ` fillNames();`
  + ` paintAll();`
  + `}`
  + `function onSamples(arr) {`
  + ` for (let i = 0; i < arr.length; i += 1) {`
  + `  const s = arr[i];`
  + `  if (!s || typeof s.name !== 'string' || s.name === '') continue;`
  + `  V.last.set(s.name, String(s.value === undefined || s.value === null ? '' : s.value));`
  + ` }`
  + ` paintAll();`
  + `}`
  + `function fillNames() {`
  + ` if (!namesBox) return;`
  + ` namesBox.textContent = '';`
  + ` const keys = Array.from(V.types.keys()).sort();`
  + ` const n = Math.min(keys.length, 800);`
  + ` for (let i = 0; i < n; i += 1) { const o = mk('option'); o.setAttribute('value', keys[i]); namesBox.appendChild(o); }`
  + `}`
  + `function rowFor(name) {`
  + ` const kids = tbody ? tbody.children : [];`
  + ` for (let i = 0; i < kids.length; i += 1) if (kids[i].getAttribute('data-name') === name) return kids[i];`
  + ` return null;`
  + `}`
  + `function rebuild() {`
  + ` if (!tbody) return;`
  + ` tbody.textContent = '';`
  + ` for (let i = 0; i < V.order.length; i += 1) tbody.appendChild(mkRow(V.order[i]));`
  + ` paintAll();`
  + `}`
  + `function mkRow(name) {`
  + ` const tr = mk('tr');`
  + ` tr.setAttribute('data-name', name);`
  + ` const n = mk('td'); n.className = 'n'; n.textContent = name; n.title = name;`
  + ` const v = mk('td'); v.className = 'v'; v.textContent = '-';`
  + ` const w = mk('td'); w.className = 'w';`
  + ` const inp = mk('input');`
  + ` inp.setAttribute('type', 'text');`
  + ` inp.setAttribute('aria-label', name + ' 書込');`
  + ` inp.title = '値を入力してEnterで書き込み（Escで取り消し）';`
  + ` inp.addEventListener('keydown', (e) => {`
  + `  if (!e) return;`
  + `  if (e.key === 'Enter') commitWrite(name, inp);`
  + `  else if (e.key === 'Escape') { inp.value = ''; }`
  + ` });`
  + ` w.appendChild(inp);`
  + ` const o = mk('td'); o.className = 'o';`
  + ` const add = mk('button'); add.textContent = '+'; add.title = name + ' を監視に追加';`
  + ` add.addEventListener('click', () => addName(name));`
  + ` const del = mk('button'); del.textContent = 'x'; del.title = name + ' を監視から除外';`
  + ` del.addEventListener('click', () => removeName(name));`
  + ` o.appendChild(add); o.appendChild(document.createTextNode(' ')); o.appendChild(del);`
  + ` tr.appendChild(n); tr.appendChild(v); tr.appendChild(w); tr.appendChild(o);`
  + ` return tr;`
  + `}`
  // Enter is the only commit. Blur and 'input' deliberately do nothing: a
  // repaint or a stray focus change could otherwise send a half-typed number.
  + `function commitWrite(name, inp) {`
  + ` const value = String(inp.value === undefined || inp.value === null ? '' : inp.value).trim();`
  + ` if (value === '') return;`
  + ` vscode.postMessage({ kind: 'var-write', name: name, value: value });`
  + ` note(name + ' への書き込みを要求しました');`
  + `}`
  // A write result marks only the row that asked: success clears that row's
  // input, failure keeps the typed text so the user can correct it. The
  // host text always lands in the note line. Every lookup is guarded: a
  // missing row (watchlist moved on) must not throw the listener away.
  + `function onWriteResult(m) {`
  + ` const nm = (m && typeof m.name === 'string') ? m.name : '';`
  + ` if (nm === '') return;`
  + ` const ok = m.ok === true;`
  + ` const msg = (m && typeof m.message === 'string') ? m.message : '';`
  + ` note(msg);`
  + ` const tr = rowFor(nm);`
  + ` if (!tr) return;`
  + ` const cells = tr.children;`
  + ` if (!cells) return;`
  + ` const wcell = cells[2];`
  + ` if (wcell && wcell.children && wcell.children[0] && wcell.children[0].tagName === 'INPUT' && ok) { wcell.children[0].value = ''; }`
  + ` const ocell = cells[3];`
  + ` if (!ocell) return;`
  + ` const kids = ocell.children;`
  + ` if (kids) { for (let i = kids.length - 1; i >= 0; i -= 1) { const k = kids[i]; if (k && k.getAttribute && k.getAttribute('data-wmark') === '1') ocell.removeChild(k); } }`
  + ` const mark = mk('span');`
  + ` mark.setAttribute('data-wmark', '1');`
  + ` mark.textContent = ok ? '✓' : '✗';`
  + ` mark.title = msg;`
  + ` ocell.appendChild(mark);`
  + `}`
  + `function paintAll() {`
  + ` if (!tbody) return;`
  + ` const filt = V.query.trim().toLowerCase();`
  + ` const kids = tbody.children;`
  + ` for (let i = 0; i < kids.length; i += 1) {`
  + `  const tr = kids[i];`
  + `  const name = tr.getAttribute('data-name') || '';`
  + `  tr.setAttribute('data-hidden', (filt !== '' && name.toLowerCase().indexOf(filt) < 0) ? '1' : '0');`
  + `  const cells = tr.children;`
  + `  const raw = V.last.has(name) ? V.last.get(name) : '';`
  + `  const d = decode(name, raw);`
  + `  cells[1].textContent = raw === '' ? '-' : d.label;`
  + `  cells[1].title = name + ' [' + d.note + '] ' + String(raw);`
  + ` }`
  + ` if (statusBox) statusBox.textContent = '監視 ' + V.order.length + ' 件';`
  + `}`
  + `function addName(raw) {`
  + ` const name = String(raw === undefined || raw === null ? '' : raw).trim();`
  + ` if (name === '') { fail('変数名が空です'); return; }`
  + ` if (V.watched[name]) { note(name + ' は追加済み'); return; }`
  + ` V.watched[name] = true; V.order.push(name);`
  + ` rebuild();`
  + ` vscode.postMessage({ kind: 'var-add', name: name });`
  + ` clearErr();`
  + `}`
  + `function removeName(raw) {`
  + ` const name = String(raw === undefined || raw === null ? '' : raw).trim();`
  + ` if (name === '') { fail('変数名が空です'); return; }`
  + ` if (!V.watched[name]) { fail('未登録の変数: ' + name); return; }`
  + ` delete V.watched[name];`
  + ` V.order = V.order.filter((n) => n !== name);`
  + ` rebuild();`
  + ` vscode.postMessage({ kind: 'var-remove', name: name });`
  + ` clearErr();`
  + `}`
  + `window.addEventListener('message', (e) => {`
  + ` const m = (e && e.data) || {};`
  + ` const k = m.kind;`
  + ` if (k === 'live-sample' && Array.isArray(m.samples)) onSamples(m.samples);`
  + ` else if (k === 'live-types') onTypes(m);`
  + ` else if (k === 'live-watchlist') onWatchlist(m);`
  + ` else if (k === 'live-write-result') onWriteResult(m);`
  + `});`
  + `const addBtn = q('[data-testid="var-add"]');`
  + `if (addBtn) addBtn.addEventListener('click', () => addName(picker ? picker.value : ''));`
  + `const removeBtn = q('[data-testid="var-remove"]');`
  + `if (removeBtn) removeBtn.addEventListener('click', () => removeName(picker ? picker.value : ''));`
  + `if (picker) picker.addEventListener('keydown', (e) => { if (e && e.key === 'Enter') addName(picker.value); });`
  + `if (search) search.addEventListener('input', () => { V.query = search.value || ''; paintAll(); });`
  + `if (Array.isArray(__SEED)) for (let i = 0; i < __SEED.length; i += 1) { const n = String(__SEED[i]); if (n !== '' && !V.watched[n]) { V.watched[n] = true; V.order.push(n); } }`
  + `rebuild();`;

/** Self-contained document for a webview opened in the editor area. */
export function variablePanelHtml(watched: readonly string[] = []): string {
  // The seed is interpolated into a <script> block, so every character that
  // could close the block or start a tag is escaped as a JS string escape.
  const seed = JSON.stringify(watched)
    .replace(/&/g, "\\u0026")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");
  const script = VAR_SCRIPT.replace("__VAR_SEED__", seed);
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1.0">`
    + `<title>${VARIABLE_PANEL_TITLE}</title>${VAR_CSS}</head>`
    + `<body><h1>${VARIABLE_PANEL_TITLE} <span class="ver">v${EXT_VERSION}</span></h1>`
    + `<div class="bar" role="toolbar" aria-label="変数操作">`
    + `<div class="grp"><span class="lbl">変数</span>`
    + `<input data-testid="var-picker" class="pick" type="text" list="var-names" placeholder="sys.loop_hz" aria-label="変数名">`
    + `<datalist id="var-names" data-testid="var-names"></datalist>`
    + `<button data-testid="var-add" type="button" class="primary" title="入力した変数を監視に追加">追加</button>`
    + `<button data-testid="var-remove" type="button" title="入力した変数を監視から除外">削除</button></div>`
    + `<div class="grp"><span class="lbl">検索</span>`
    + `<input data-testid="var-search" class="srch" type="text" placeholder="変数を検索" aria-label="変数を検索"></div>`
    + `</div>`
    + `<p data-testid="var-error" class="err msg" role="alert"></p>`
    + `<p data-testid="var-note" class="note msg"></p>`
    + `<table data-testid="var-table" class="vars"><thead><tr>`
    + `<th>変数</th><th>値</th><th>書込</th><th>操作</th>`
    + `</tr></thead><tbody data-testid="var-rows"></tbody></table>`
    + `<footer><span data-testid="var-status"></span></footer>`
    + `<p data-testid="var-csv-schema" class="note">${CSV_HEADER}</p>`
    + `<script>${script}</` + `script>`
    + `</body></html>`;
}

export type VariablePanelMessageKind = "var-add" | "var-remove" | "var-write";

export interface VariablePanelMessage {
  readonly kind: VariablePanelMessageKind;
  readonly name: string;
  /** Only set for var-write: the raw text from the row's write input. */
  readonly value: string;
}

export function parseVariablePanelMessage(raw: unknown): VariablePanelMessage | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const r = raw as Record<string, unknown>;
  if (r["kind"] === "var-add" && typeof r["name"] === "string" && r["name"] !== "") {
    return { kind: "var-add", name: r["name"], value: "" };
  }
  if (r["kind"] === "var-remove" && typeof r["name"] === "string" && r["name"] !== "") {
    return { kind: "var-remove", name: r["name"], value: "" };
  }
  if (
    r["kind"] === "var-write"
    && typeof r["name"] === "string" && r["name"] !== ""
    && typeof r["value"] === "string" && r["value"] !== ""
  ) {
    return { kind: "var-write", name: r["name"], value: r["value"] };
  }
  return null;
}

/**
 * Editor-area mount state. One panel at a time: openVariablePanel reveals the
 * existing one instead of creating a second, so a single slot is enough —
 * the same shape as GraphPanelProvider.postTarget.
 */
let postTarget: vscode.Webview | undefined;

/** Assign the panel document. Called once per panel, like graphPanel.mount. */
export function mount(webview: vscode.Webview, watched: readonly string[] = []): void {
  postTarget = webview;
  webview.options = { enableScripts: true, enableCommandUris: true };
  webview.html = variablePanelHtml(watched);
}

/** Detach the panel document. */
export function unmount(webview: vscode.Webview): void {
  if (postTarget === webview) {
    postTarget = undefined;
  }
}

/** Forward one live sample batch. Wired into the Live sample sink in activate. */
export function pushVariableSamples(samples: readonly { readonly name: string }[]): void {
  if (postTarget !== undefined) {
    void postTarget.postMessage({ kind: "live-sample", samples });
  }
}
