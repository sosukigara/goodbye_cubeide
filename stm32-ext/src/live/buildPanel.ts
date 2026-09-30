import type * as vscode from "vscode";
import type { BuildPanelState } from "../build/backend.js";
import { EXT_VERSION } from "../version.js";

export const BUILD_PANEL_VIEW_TYPE = "stm32ext.build";
export const BUILD_PANEL_TITLE = "STM32 Build";

const BUILD_CSS = `<style>`
  + `html,body{height:100%}`
  + `body{font-family:var(--vscode-font-family,sans-serif);font-size:var(--vscode-font-size,13px);color:var(--vscode-foreground,#ccc);margin:0;padding:14px 18px;box-sizing:border-box;overflow:auto;background:transparent}`
  + `h1{font-size:1.05em;font-weight:700;margin:0 0 2px;padding:0;letter-spacing:.04em}`
  + `h1 .ver{font-weight:400;font-size:.8em;opacity:.5}`
  + `.sub{opacity:.65;font-size:.9em;margin:0 0 12px}`
  + `.bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px}`
  + `button{font:inherit;padding:5px 14px;border-radius:4px;border:1px solid transparent;cursor:pointer;background:var(--vscode-button-secondaryBackground,#3a3d41);color:var(--vscode-button-secondaryForeground,#ccc)}`
  + `button.primary{background:var(--vscode-button-background,#0e639c);color:var(--vscode-button-foreground,#fff)}`
  + `button:disabled{opacity:.45;cursor:default}`
  + `button:focus-visible{outline:1px solid var(--vscode-focusBorder,#007fd4)}`
  + `.status{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;margin:0 0 6px}`
  + `.pill{font-weight:700;font-size:1em}`
  + `.pill.ok{color:var(--vscode-testing-iconPassed,#388a34)}.pill.bad{color:var(--vscode-testing-iconFailed,#f14c4c)}.pill.run{color:var(--vscode-testing-iconQueued,#cca700)}.pill.idle{opacity:.6;font-weight:400}`
  + `.pct,.path,.elapsed{font-family:var(--vscode-editor-font-family,monospace);font-variant-numeric:tabular-nums;opacity:.8}`
  + `.path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}`
  + `progress{width:100%;height:5px;margin:0 0 12px}`
  + `.diags{margin:0;padding:0;list-style:none;max-width:900px}`
  + `.diags li{margin:2px 0}`
  + `.diag{display:block;font-family:var(--vscode-editor-font-family,monospace);color:var(--vscode-textLink-foreground,#3794ff);text-decoration:none;padding:2px 0}`
  + `.diag.warn{color:var(--vscode-editorWarning-foreground,#cca700)}`
  + `.empty{opacity:.6}`
  + `.cause{white-space:pre-wrap;opacity:.85;margin:8px 0 0;max-width:900px}`
  + `</style>`;

const BUILD_SCRIPT = `var __SEED = __BUILD_SEED__;`
  + `const vscode = acquireVsCodeApi();`
  + `const q = (s) => document.querySelector(s);`
  + `const pill = q('[data-testid="build-pill"]');`
  + `const pct = q('[data-testid="build-pct"]');`
  + `const bar = q('[data-testid="build-bar"]');`
  + `const elf = q('[data-testid="build-elf"]');`
  + `const elapsed = q('[data-testid="build-elapsed"]');`
  + `const diags = q('[data-testid="build-diags"]');`
  + `const cause = q('[data-testid="build-cause"]');`
  + `const runBtn = q('[data-testid="build-run"]');`
  + `const flashBtn = q('[data-testid="build-flash"]');`
  + `function paint(state, progress) {`
  + ` const st = (state && state.status) || 'idle';`
  + ` const label = st === 'ok' ? '成功' : st === 'failed' ? '失敗' : st === 'running' ? 'ビルド中' : '待機';`
  + ` if (pill) { pill.textContent = label; pill.className = 'pill ' + (st === 'ok' ? 'ok' : st === 'failed' ? 'bad' : st === 'running' ? 'run' : 'idle'); }`
  + ` let p = 0;`
  + ` if (progress && progress.percent !== null && progress.percent !== undefined) p = progress.percent;`
  + ` else if (state && state.buildPercent !== undefined) p = state.buildPercent;`
  + ` else if (st === 'ok') p = 100;`
  + ` if (pct) pct.textContent = p + '%';`
  + ` if (bar) bar.value = p;`
  + ` const ep = (state && state.elfPath) || '';`
  + ` if (elf) { elf.textContent = ep; elf.title = ep; }`
  + ` if (elapsed) elapsed.textContent = (state && state.elapsedMs !== undefined && state.elapsedMs !== null) ? (state.elapsedMs / 1000).toFixed(1) + 's' : '';`
  + ` const list = (state && Array.isArray(state.diagnostics)) ? state.diagnostics : [];`
  + ` if (diags) {`
  + `  diags.textContent = '';`
  + `  if (list.length === 0) {`
  + `   const li = document.createElement('li'); li.className = 'empty'; li.textContent = st === 'failed' ? '診断なし' : 'エラーはありません'; diags.appendChild(li);`
  + `  }`
  + `  for (let i = 0; i < list.length && i < 100; i += 1) {`
  + `   const d = list[i];`
  + `   const li = document.createElement('li');`
  + `   const a = document.createElement('a');`
  + `   a.className = d.kind === 'warning' ? 'diag warn' : 'diag';`
  + `   a.href = 'command:stm32ext.openBuildDiag?' + encodeURIComponent(JSON.stringify([{ file: d.file, line: d.line, col: d.col }]));`
  + `   a.textContent = d.file + ':' + d.line + ':' + d.col + ' ' + d.message;`
  + `   li.appendChild(a); diags.appendChild(li);`
  + `  }`
  + ` }`
  + ` if (cause) cause.textContent = (state && state.failureCause) || '';`
  + ` const busy = st === 'running';`
  + ` if (runBtn) runBtn.disabled = busy;`
  + ` if (flashBtn) flashBtn.disabled = busy;`
  + `}`
  + `if (runBtn) runBtn.addEventListener('click', () => vscode.postMessage({ kind: 'build-run' }));`
  + `if (flashBtn) flashBtn.addEventListener('click', () => vscode.postMessage({ kind: 'build-flash' }));`
  + `window.addEventListener('message', (e) => {`
  + ` const m = (e && e.data) || {};`
  + ` if (m.kind === 'build-state' && m.state) paint(m.state, null);`
  + ` else if (m.kind === 'build-progress') paint(null, m);`
  + `});`
  + `if (__SEED && __SEED.state) paint(__SEED.state, null);`;

export interface BuildPanelSeed {
  readonly state: BuildPanelSnapshot;
}

export interface BuildPanelSnapshot {
  readonly status: string;
  readonly buildPercent: number;
  readonly elfPath: string;
  readonly elapsedMs?: number;
  readonly diagnostics: readonly {
    readonly kind: string; readonly file: string;
    readonly line: number; readonly col: number; readonly message: string;
  }[];
  readonly failureCause?: string;
}

export function buildPanelHtml(seed: BuildPanelSeed): string {
  const encoded = JSON.stringify(seed)
    .replace(/&/g, "\\u0026")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");
  const script = BUILD_SCRIPT.replace("__BUILD_SEED__", encoded);
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1.0">`
    + `<title>${BUILD_PANEL_TITLE}</title>${BUILD_CSS}</head>`
    + `<body><h1>${BUILD_PANEL_TITLE} <span class="ver">v${EXT_VERSION}</span></h1>`
    + `<p class="sub">Ninja + ccache ビルド。エラーはクリックでジャンプします。</p>`
    + `<div class="bar" role="toolbar" aria-label="ビルド操作">`
    + `<button data-testid="build-run" type="button" title="Ninja でビルド">ビルド</button>`
    + `<button data-testid="build-flash" type="button" class="primary" title="ビルドして書込">ビルドして書込</button>`
    + `</div>`
    + `<p class="status"><span class="pill idle" data-testid="build-pill">待機</span>`
    + `<span class="pct" data-testid="build-pct">0%</span>`
    + `<span class="path" data-testid="build-elf"></span>`
    + `<span class="elapsed" data-testid="build-elapsed"></span></p>`
    + `<progress max="100" value="0" data-testid="build-bar"></progress>`
    + `<ul class="diags" data-testid="build-diags"></ul>`
    + `<p class="cause" data-testid="build-cause"></p>`
    + `<script>${script}</` + `script>`
    + `</body></html>`;
}

export type BuildTabMessageKind = "build-run" | "build-flash";

export function parseBuildPanelMessage(raw: unknown): BuildTabMessageKind | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const kind = (raw as Record<string, unknown>)["kind"];
  return kind === "build-run" || kind === "build-flash" ? kind : null;
}

let postTarget: vscode.Webview | undefined;

export function mountBuildPanel(webview: vscode.Webview, seed: BuildPanelSeed): void {
  postTarget = webview;
  webview.options = { enableScripts: true, enableCommandUris: true };
  webview.html = buildPanelHtml(seed);
}

export function unmountBuildPanel(webview: vscode.Webview): void {
  if (postTarget === webview) {
    postTarget = undefined;
  }
}

export function pushBuildPanelMessage(msg: unknown): void {
  if (postTarget !== undefined) {
    void postTarget.postMessage(msg);
  }
}
