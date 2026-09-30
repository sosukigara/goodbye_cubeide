// CLI ELF/target resolution: decide which ELF and which pyOCD target to use,
// then map the Python worker's `resolve` reply to a verdict.
//
// Reuses the existing authorities only — `sidecarPython` (interpreter shape),
// `isStripError`/`STRIP_HINT` (strip wording), the `resolveDapLaunch` rule
// (explicit wins, missing target refuses before any spawn) — and never
// reimplements them. Pure and vscode-free: the worker spawn, the filesystem
// probes, and the venv dir are all injected, so unit tests never launch
// python and never touch the real ~/.local tree.
//
// What this module NEVER does, by construction: it never reads VSCode state
// (globalState/storage.json/workspaceState), never parses DWARF in
// TypeScript (that is elf_resolve.py's job via the worker), and never infers
// the MCU/target from .cproject.

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { SpawnResult } from "../flash/spawn.js";
import { sidecarPython } from "../env/venv.js";
import {
  STRIP_HINT,
  isStripError,
  type ResolvedSymbol,
} from "../live/elfResolver.js";

/** Exit-code-equivalent for every refusal from this module (usage/resolve class). */
export const RESOLVE_EXIT_CODE = 2;

/** Wire stage for every refusal from this module. */
export const RESOLVE_STAGE = "resolve" as const;

/** CLI-owned venv; `setup` (not this module) is the only writer. */
export function defaultCliVenvDir(): string {
  return join(homedir(), ".local", "share", "stm32-cli", "venv");
}

/** `resolve` op waits at most 60s (interactive CLI budget, not the DAP 300s). */
export const RESOLVE_TIMEOUT_MS = 60_000;

/** Worker `resolve` reply, projected to the six fields the wire contract names. */
export type WorkerSymbol = Pick<
  ResolvedSymbol,
  "name" | "address" | "size" | "type" | "kind" | "signed"
>;

export type CliPathsResult =
  | { readonly ok: true; readonly elf: string; readonly target: string; readonly resolution?: string | undefined }
  | { readonly ok: false; readonly stage: typeof RESOLVE_STAGE; readonly error: string; readonly exitCode: typeof RESOLVE_EXIT_CODE };

export type ResolveSymbolResult =
  | { readonly ok: true; readonly symbol: WorkerSymbol; readonly exitCode: 0 }
  | { readonly ok: false; readonly stage: typeof RESOLVE_STAGE; readonly error: string; readonly exitCode: typeof RESOLVE_EXIT_CODE };

/** Same flag-reading shape as src/build/cli.ts. */
export function argValue(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  const v = i >= 0 ? argv[i + 1] : undefined;
  return v;
}

/** Blank (missing, empty, or whitespace-only) means "not provided". */
function nonBlank(v: string | undefined): string | undefined {
  return v !== undefined && v.trim() !== "" ? v : undefined;
}

export interface PathCheckDeps {
  /** Defaults to node:fs existsSync. */
  readonly exists?: ((p: string) => boolean) | undefined;
  /** Defaults to node:fs statSync().isDirectory(). */
  readonly isDirectory?: ((p: string) => boolean) | undefined;
}

function defaultIsDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false; // unreadable is reported as missing, not as a directory
  }
}

/**
 * Resolve which ELF and which pyOCD target the CLI will use.
 *
 * `--elf` > STM32_ELF, `--target` > STM32_TARGET. Missing target refuses
 * BEFORE anything spawns (pyOCD needs an explicit target id — the same rule
 * as `resolveDapLaunch`; no MCU inference from .cproject here).
 *
 * A `resolution` path (pre-built resolution JSON) lets air-gap/fixture runs
 * skip elf_resolve, so it also skips the ELF existence check — the worker
 * loads that JSON directly instead of reading the ELF.
 */
export function resolveCliPaths(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  deps?: PathCheckDeps | undefined,
): CliPathsResult {
  const exists = deps?.exists ?? existsSync;
  const isDirectory = deps?.isDirectory ?? defaultIsDirectory;

  const resolution = nonBlank(argValue(argv, "--resolution"));

  const elf = nonBlank(argValue(argv, "--elf")) ?? nonBlank(env["STM32_ELF"]) ?? "";
  if (elf === "" && resolution === undefined) {
    return {
      ok: false,
      stage: RESOLVE_STAGE,
      error: "missing ELF: pass --elf <path> or set STM32_ELF to the built firmware ELF (build first: ninja -C build-ext)",
      exitCode: RESOLVE_EXIT_CODE,
    };
  }
  if (elf !== "" && resolution === undefined) {
    let present = false;
    try {
      present = exists(elf);
    } catch {
      present = false;
    }
    if (!present) {
      return {
        ok: false,
        stage: RESOLVE_STAGE,
        error: `ELF not found: ${elf} (STM32_ELF must point at the built firmware ELF; build first: ninja -C build-ext)`,
        exitCode: RESOLVE_EXIT_CODE,
      };
    }
    let dir = false;
    try {
      dir = isDirectory(elf);
    } catch {
      dir = false;
    }
    if (dir) {
      return {
        ok: false,
        stage: RESOLVE_STAGE,
        error: `ELF path is a directory, not a file: ${elf} (STM32_ELF must point at the built .elf file; build first: ninja -C build-ext)`,
        exitCode: RESOLVE_EXIT_CODE,
      };
    }
  }

  const target = nonBlank(argValue(argv, "--target")) ?? nonBlank(env["STM32_TARGET"]) ?? "";
  if (target === "") {
    return {
      ok: false,
      stage: RESOLVE_STAGE,
      error: "missing pyOCD target: pass --target <id> or set STM32_TARGET (pyOCD requires an explicit target id)",
      exitCode: RESOLVE_EXIT_CODE,
    };
  }
  return {
    ok: true,
    elf,
    target,
    ...(resolution === undefined ? {} : { resolution }),
  };
}

export type WorkerSpawn = (
  python: string,
  script: string,
  requestJson: string,
  timeoutMs: number,
) => Promise<SpawnResult>;

/** Locate scripts/probe_op.py by walking up from `fromDir` (default: cwd). */
export function defaultProbeOpScript(
  fromDir: string = process.cwd(),
  exists: (p: string) => boolean = existsSync,
): string {
  let dir = fromDir;
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "scripts", "probe_op.py");
    try {
      if (exists(candidate)) {
        return candidate;
      }
    } catch {
      // a throwing probe proves nothing; keep climbing
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return join(fromDir, "scripts", "probe_op.py");
}

function defaultSpawnWorker(
  python: string,
  script: string,
  requestJson: string,
  timeoutMs: number,
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script], { shell: false });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    if (typeof timer.unref === "function") {
      timer.unref();
    }
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.stdin.on("error", () => {
      // spawn failure surfaces via "error" below; a broken pipe needs no extra report
    });
    child.on("error", (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
        ...(timedOut ? { timedOut: true } : {}),
      });
    });
    child.stdin.write(requestJson);
    child.stdin.end();
  });
}

export interface ResolveSymbolDeps {
  /** Defaults to spawning the real worker with stdin JSON. Tests stub this. */
  readonly spawnWorker?: WorkerSpawn | undefined;
  /** Defaults to the CLI-owned venv (undefined = system python3). */
  readonly venvDir?: string | undefined;
  /** Defaults to the discovered scripts/probe_op.py. */
  readonly probeOpScript?: string | undefined;
  /** Defaults to RESOLVE_TIMEOUT_MS. */
  readonly timeoutMs?: number | undefined;
  /** Existence probe for the venv python. Defaults to node:fs existsSync. */
  readonly pythonExists?: ((p: string) => boolean) | undefined;
}

/** Last non-blank line of worker output — the part that explains the failure. */
function lastLine(text: string): string {
  const lines = text.trim().split("\n").filter((l) => l.trim() !== "");
  return lines[lines.length - 1]?.trim() ?? "";
}

function fail(error: string): ResolveSymbolResult {
  return { ok: false, stage: RESOLVE_STAGE, error, exitCode: RESOLVE_EXIT_CODE };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Worker `symbol` -> verdict meta, or undefined when fields are missing. */
function asWorkerSymbol(v: unknown): WorkerSymbol | undefined {
  if (!isRecord(v)) {
    return undefined;
  }
  const name = v["name"];
  const address = v["address"];
  const size = v["size"];
  const type = v["type"];
  const kind = v["kind"];
  const signed = v["signed"];
  if (typeof name !== "string" || name === "") {
    return undefined;
  }
  if (typeof address !== "string" || !/^0x[0-9a-fA-F]+$/.test(address)) {
    return undefined;
  }
  if (typeof size !== "number" || !Number.isFinite(size)) {
    return undefined;
  }
  if (typeof type !== "string" || typeof kind !== "string" || typeof signed !== "boolean") {
    return undefined;
  }
  return { name, address, size, type, kind: kind as WorkerSymbol["kind"], signed };
}

/**
 * Call the worker's `resolve` op for one symbol name and map the reply.
 *
 * Symbol meta passes through verbatim; every failure shape — unresolved
 * name, unknown width, stripped ELF, non-JSON reply, spawn failure — maps to
 * `{ok:false, stage:"resolve"}` with exit-code-equivalent 2.
 */
export async function resolveSymbol(
  name: string,
  paths: CliPathsResult,
  deps?: ResolveSymbolDeps | undefined,
): Promise<ResolveSymbolResult> {
  if (!isRecord(paths) || paths.ok !== true) {
    return fail(
      isRecord(paths) && typeof paths.error === "string"
        ? paths.error
        : "missing ELF/target resolution (build first: ninja -C build-ext)",
    );
  }
  if (typeof name !== "string" || name.trim() === "") {
    return fail("missing symbol name: pass the dotted variable name to resolve");
  }
  const spawnWorker = deps?.spawnWorker ?? defaultSpawnWorker;
  const venvDir = deps?.venvDir ?? defaultCliVenvDir();
  const script = deps?.probeOpScript ?? defaultProbeOpScript();
  const timeoutMs = deps?.timeoutMs ?? RESOLVE_TIMEOUT_MS;
  const python = sidecarPython(venvDir, process.platform, deps?.pythonExists ?? existsSync);

  const request: Record<string, unknown> = {
    op: "resolve",
    name,
    elf: paths.elf,
    target: paths.target,
  };
  if (paths.resolution !== undefined) {
    request["resolution"] = paths.resolution;
  }

  let result: SpawnResult;
  try {
    result = await spawnWorker(python, script, JSON.stringify(request), timeoutMs);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return fail(`cannot run probe worker (${script}): ${detail}`);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(result.stdout) as unknown;
  } catch {
    if (isStripError(result.stderr, result.exitCode)) {
      return fail(`elf_resolve: ${STRIP_HINT}`);
    }
    const tail = lastLine(result.stderr) || lastLine(result.stdout) || `exit=${result.exitCode}`;
    return fail(`worker resolve returned non-JSON output: ${tail}`);
  }
  if (!isRecord(payload)) {
    return fail("worker resolve returned a non-object reply (stage: resolve)");
  }
  if (payload["ok"] === true) {
    const symbol = asWorkerSymbol(payload["symbol"]);
    if (symbol === undefined) {
      return fail("worker resolve returned a symbol with missing fields (stage: resolve)");
    }
    return { ok: true, symbol, exitCode: 0 };
  }
  const error = typeof payload["error"] === "string" && payload["error"] !== ""
    ? payload["error"]
    : `worker resolve failed (exit=${result.exitCode})`;
  return fail(error);
}
