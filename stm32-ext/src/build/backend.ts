// Build orchestration backend (todo3): run ninja, parse GCC diagnostics.
// VSCode-free so vitest can exercise it; extension.ts wires it to GUI.

import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, extname, join, resolve } from "node:path";

import { venvExtraDirs } from "../env/venv";

export type DiagnosticKind = "error" | "warning" | "note";

export interface GccDiagnostic {
  readonly file: string;
  readonly line: number;
  readonly col: number;
  readonly kind: DiagnosticKind;
  readonly message: string;
  readonly raw: string;
}

// GCC/Clang diagnostic line: path:line:col: kind: message
// e.g. /abs/Core/Src/code.cpp:123:5: error: 'x' was not declared
//      /abs/Core/Src/code.cpp:123:5: note: suggested alternative
// Continuation lines (e.g. " | ...", "In file included from...") are skipped.
const DIAG_RE = /^(.*?):(\d+):(\d+):\s+(error|warning|note):\s+(.*)$/;

/** Parse GCC-format diagnostics from combined ninja output. Pure. */
export function parseGccDiagnostics(output: string): GccDiagnostic[] {
  const out: GccDiagnostic[] = [];
  for (const raw of output.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const m = DIAG_RE.exec(line);
    if (m === null) {
      continue;
    }
    const kind = m[4] as DiagnosticKind;
    out.push({
      file: m[1] ?? "",
      line: Number(m[2] ?? "1"),
      col: Number(m[3] ?? "1"),
      kind,
      message: m[5] ?? "",
      raw: line,
    });
  }
  return out;
}

export interface NinjaProgress {
  readonly done: number;
  readonly total: number;
}

/** Parse ninja's "[12/318] ..." progress markers. Returns the last one seen. Pure. */
export function parseNinjaProgress(output: string): NinjaProgress | undefined {
  let last: NinjaProgress | undefined;
  const re = /\[(\d+)\/(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) {
    last = { done: Number(m[1]), total: Number(m[2]) };
  }
  return last;
}

export interface NinjaRunOptions {
  readonly buildDir: string;
  readonly ninjaBin?: string;
  readonly targets?: readonly string[];
  readonly extraArgs?: readonly string[];
  readonly timeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
  /** Streamed progress callback (each new [done/total] marker). */
  readonly onProgress?: (progress: NinjaProgress, action: string) => void;
}

export interface NinjaRunResult {
  readonly ok: boolean;
  readonly exitCode: number;
  readonly elapsedMs: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly diagnostics: readonly GccDiagnostic[];
  readonly progress: NinjaProgress | undefined;
}

/** Last "[done/total] action…" line on a text chunk (for live % display). Pure. */
export function parseNinjaAction(chunk: string): { progress: NinjaProgress; action: string } | undefined {
  const progress = parseNinjaProgress(chunk);
  if (progress === undefined) {
    return undefined;
  }
  const lines = chunk.split("\n").filter((l) => l.trim().length > 0);
  const last = lines[lines.length - 1] ?? "";
  return { progress, action: last.replace(/\r$/, "").slice(0, 160) };
}

function runExec(
  bin: string,
  args: readonly string[],
  opts: { cwd: string; timeoutMs: number; env: NodeJS.ProcessEnv; onProgress?: ((progress: NinjaProgress, action: string) => void) | undefined },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, [...args], { cwd: opts.cwd, env: opts.env });
    let stdout = "";
    let stderr = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    if (timer.unref) {
      timer.unref();
    }
    child.stdout.on("data", (d: Buffer) => {
      const text = d.toString();
      stdout += text;
      if (stdout.length > 64 * 1024 * 1024) {
        stdout = stdout.slice(-32 * 1024 * 1024);
      }
      const parsed = parseNinjaAction(text);
      if (parsed !== undefined) {
        opts.onProgress?.(parsed.progress, parsed.action);
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      const text = d.toString();
      stderr += text;
      if (stderr.length > 64 * 1024 * 1024) {
        stderr = stderr.slice(-32 * 1024 * 1024);
      }
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ exitCode: 127, stdout, stderr: `${stderr}\nspawn ${bin} failed (not installed?)` });
    });
    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      resolve({ exitCode: killed ? 124 : (code ?? 1), stdout, stderr });
    });
  });
}

/** Run `ninja [-C buildDir] [targets...]`, capturing diagnostics and progress. */
export async function runNinja(opts: NinjaRunOptions): Promise<NinjaRunResult> {
  const requested = opts.ninjaBin ?? "ninja";
  // Resolve once: handing the same relative buildDir to both -C and cwd made
  // ninja chdir into it twice, which always failed with "No such file or
  // directory" and produced zero compiler diagnostics.
  const buildDir = resolve(opts.buildDir);
  const args = ["-C", buildDir, ...(opts.targets ?? []), ...(opts.extraArgs ?? [])];
  const started = Date.now();
  const tool = resolveTool(requested, opts.env ?? process.env);
  const bin = tool.path;
  const res = await runExec(bin, args, {
    cwd: buildDir,
    timeoutMs: opts.timeoutMs ?? 20 * 60 * 1000,
    env: opts.env ?? process.env,
    onProgress: opts.onProgress,
  });
  const combined = `${res.stdout}\n${res.stderr}`;
  return {
    ok: res.exitCode === 0,
    exitCode: res.exitCode,
    elapsedMs: Date.now() - started,
    stdout: res.stdout,
    stderr: res.stderr,
    diagnostics: parseGccDiagnostics(combined),
    progress: parseNinjaProgress(combined),
  };
}

/** Lines worth showing as the cause: ninja/linker failures that carry no
 *  file:line:col, so parseGccDiagnostics cannot see them. */
const CAUSE_RE = /(ninja: (?:fatal|error|warning):|^\s*(?:arm-none-eabi-)?ld: |overflowed by|undefined reference|cannot find |No such file or directory|not installed)/m;

/**
 * Explain a failed build in the user's terms.
 *
 * A build can fail with zero GCC diagnostics — ninja itself refused, the
 * linker ran out of flash, or the tool was never on PATH. Reporting only an
 * error count there tells the user nothing actionable, so pull the first
 * meaningful line out of the output. Returns "" for a successful build.
 */
export function describeBuildFailure(result: {
  readonly ok: boolean;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}): string {
  if (result.ok) {
    return "";
  }
  const lines = `${result.stderr}\n${result.stdout}`.split("\n");
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "").trim();
    if (line !== "" && CAUSE_RE.test(line)) {
      if (/not installed\?/.test(line)) {
        return `${line}\nPATH に見つかりません。VS Code をターミナル以外から起動した場合は ~/.local/bin が PATH に含まれません。code /usr/bin/code で起動し直してください。`;
      }
      return line;
    }
  }
  const stderrTail = lines.map((l) => l.trim()).filter((l) => l !== "").slice(-1)[0] ?? "";
  return stderrTail !== ""
    ? `exit ${result.exitCode}: ${stderrTail}`
    : `ビルドが exit ${result.exitCode} で失敗しましたが。原因行が出力にありません。`;
}

/** Directories a desktop session commonly omits from PATH. */
const EXTRA_TOOL_DIRS = [join(homedir(), ".local", "bin")] as const;

// The setup venv's bin directory is searched too, so a `ninja` installed by
// first-run setup is found by the same resolveTool call the build uses. It is
// read per call rather than captured at module load, because setup finishes
// after this module has already been evaluated.
const venvToolDirs = (): readonly string[] => venvExtraDirs();

export interface ToolResolution {
  readonly path: string;
  readonly found: boolean;
  readonly searched: readonly string[];
}

/**
 * Locate an executable, looking past a PATH that a GUI session may have
 * truncated. `ninja` and `pyocd` both land in ~/.local/bin, which is absent
 * from /etc/environment, so a desktop-launched VS Code cannot spawn them.
 *
 * On Windows the binary is `ninja.exe`, `arm-none-eabi-gcc.exe`, `python.exe`.
 * Stat'ing the bare name therefore never matches, which made the first-run
 * preflight report a tool as missing on a machine that has it installed —
 * and, because the flag is only cleared once the environment is complete,
 * the notice would reappear on every single launch with no way out. The
 * `.exe` form is tried as well, behind the same injection point the tests
 * already use, so POSIX behaviour is provably unchanged.
 */
export function resolveTool(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  // Injected so a test can prove the extra directory is searched without
  // depending on what this machine happens to have in ~/.local/bin. Asserting
  // "ninja is found" only passes on a machine that has ninja — which is how a
  // green suite hid the regression it was written to catch.
  extraDirs: readonly string[] = EXTRA_TOOL_DIRS,
): ToolResolution {
  const searched: string[] = [];
  if (name.includes("/")) {
    searched.push(name);
    return { path: name, searched, found: isExecutableFile(name) };
  }
  const dirs = [
    ...(env["PATH"] ?? "").split(delimiter),
    ...extraDirs,
    // Only when the caller did not pass its own list, so a test that injects
    // directories still sees exactly the directories it asked for.
    ...(extraDirs === EXTRA_TOOL_DIRS ? venvToolDirs() : []),
  ];
  // A name that already carries an extension is not given another one.
  const candidates = extname(name) === ""
    ? (platform === "win32" ? [name, `${name}.exe`] : [name])
    : [name];
  for (const dir of dirs) {
    if (dir === "") {
      continue;
    }
    for (const candidate of candidates) {
      const full = join(dir, candidate);
      searched.push(full);
      if (isExecutableFile(full)) {
        return { path: full, searched, found: true };
      }
    }
  }
  return { path: name, searched, found: false };
}

function isExecutableFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
// Build panel state. These lived in build/panel.ts, which rendered a
// standalone build view that was never registered with VSCode, so the whole
// renderer was dead code. The state type is live (the one registered webview
// renders it), so it moved here next to the build domain it describes.
export interface BuildPanelProgress {
  readonly done: number;
  readonly total: number;
}

export interface BuildPanelState {
  /** "idle" | "running" | "ok" | "failed" */
  readonly status: "idle" | "running" | "ok" | "failed";
  readonly progress?: BuildPanelProgress;
  readonly diagnostics: readonly GccDiagnostic[];
  readonly elfPath?: string;
  readonly elapsedMs?: number;
  readonly parityLine?: string;
  readonly logTail?: string;
  /** Why the build failed, when the cause is not a compiler diagnostic. */
  readonly failureCause?: string;
  /** Latest "[done/total] action" line while running (live % display). */
  readonly currentAction?: string;
}

/** file:line:col jump link via the stm32ext.openBuildDiag command URI. */
export function diagJumpHref(d: GccDiagnostic): string {
  const payload = encodeURIComponent(JSON.stringify([{ file: d.file, line: d.line, col: d.col }]));
  return `command:stm32ext.openBuildDiag?${payload}`;
}
