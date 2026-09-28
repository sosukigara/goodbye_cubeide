// First-run environment setup: a private virtualenv inside the extension's
// own storage, so installing the VSIX is enough to get a working toolchain.
//
// WHY A VENV AND NOT `pip install --user`
// ---------------------------------------
// The obvious one-liner is `python3 -m pip install --user pyocd`, and that is
// exactly what the old `live_poll.py --ensure-pyocd` recovery path ran. It
// does not work on any current Debian/Ubuntu: /usr/lib/python3.12/
// EXTERNALLY-MANAGED makes pip refuse with PEP 668, so the command the README
// told users to run to recover from "pyocd is not installed" was guaranteed
// to fail on the machines that needed it. Passing --break-system-packages
// would make it succeed by mutating a system-owned interpreter.
//
// A venv sidesteps the whole question. pip has no externally-managed marker
// inside one, nothing outside the extension's storage directory is touched,
// and removing the extension's data removes the environment with it.
//
// WHAT THIS CANNOT DO
// -------------------
// `arm-none-eabi-gcc` is a cross toolchain measured in hundreds of megabytes
// and needs root to install; `python3` cannot be provisioned by a process that
// is itself running under python3; `ccache` has no dependable wheel. Those
// three stay manual and are reported as such. This module installs what a
// wheel can honestly provide — ninja, pyocd, pyelftools — and is explicit
// about the rest rather than pretending the toolchain is complete.
import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";
import type { SpawnResult } from "../flash/spawn";

/** A tool this extension can provide by installing a wheel, with its package. */
export interface AutoPackage {
  /** The executable the user ultimately needs, as TOOL_REQUIREMENTS names it. */
  readonly tool: string;
  /** The PyPI distribution that provides it. */
  readonly pkg: string;
}

/**
 * The wheels that stand in for a system package.
 *
 * `ninja` is here because the PyPI distribution ships the real binary, which
 * turns a root-required `apt install ninja-build` into a user-local install.
 * `pyelftools` is here because without it the type tree degrades to nm/readelf
 * symbol scraping and every value renders as "型不明"; it is a library with no
 * executable, so it is detected by import rather than by PATH.
 */
export const AUTO_PACKAGES: readonly AutoPackage[] = [
  { tool: "ninja", pkg: "ninja" },
  { tool: "pyocd", pkg: "pyocd" },
  { tool: "pyelftools", pkg: "pyelftools" },
];

/**
 * Join with the target platform's separator rules, not the host's.
 *
 * `path.join` is posix-flavoured on Linux, so a win32 path assembled there
 * comes out as `C:\v/Scripts` — mixed separators a Windows API call rejects.
 * Production only ever builds paths for the platform it runs on, so this is
 * invisible in the field; it matters because a test that builds a win32 path
 * on Linux would otherwise pin the broken shape and call it correct.
 */
function joinFor(platform: NodeJS.Platform): (a: string, b: string) => string {
  return (platform === "win32" ? win32 : posix).join;
}

/** Marker file `python3 -m venv` writes; its presence is the readiness test. */
export function venvMarker(
  venvDir: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return joinFor(platform)(venvDir, "pyvenv.cfg");
}

/** True when the venv has actually been created. */
export function venvReady(
  venvDir: string,
  exists: (p: string) => boolean = existsSync,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return exists(venvMarker(venvDir, platform));
}

/** Directory holding the venv's executables. Windows uses Scripts/, not bin/. */
export function venvBinDir(
  venvDir: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return joinFor(platform)(venvDir, platform === "win32" ? "Scripts" : "bin");
}

/** The interpreter to run the sidecars with, so they see the venv's wheels. */
export function venvPython(
  venvDir: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return joinFor(platform)(
    venvBinDir(venvDir, platform),
    platform === "win32" ? "python.exe" : "python",
  );
}

/** Path of a tool inside the venv, or undefined if the venv is not built yet. */
export function venvToolPath(
  venvDir: string,
  tool: string,
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = existsSync,
): string | undefined {
  if (!venvReady(venvDir, exists, platform)) {
    return undefined;
  }
  const j = joinFor(platform);
  const bin = venvBinDir(venvDir, platform);
  const candidates =
    platform === "win32" ? [j(bin, `${tool}.exe`), j(bin, tool)] : [j(bin, tool)];
  return candidates.find((c) => exists(c));
}

/**
 * The interpreter to spawn for a sidecar.
 *
 * Prefers the venv's own python so the sidecars import pyocd and pyelftools
 * from it, and falls back to the bare name when setup has not run — the
 * sidecars work without the venv, they just lose the wheels.
 */
export function sidecarPython(
  venvDir: string | undefined,
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = existsSync,
): string {
  if (venvDir === undefined) {
    return "python3";
  }
  const py = venvPython(venvDir, platform);
  return exists(py) ? py : "python3";
}

/** Package names needed to cover the tools that are missing. */
export function packagesFor(
  missingTools: readonly string[],
  catalogue: readonly AutoPackage[] = AUTO_PACKAGES,
): string[] {
  const missing = new Set(missingTools);
  return catalogue.filter((c) => missing.has(c.tool)).map((c) => c.pkg);
}

/** What setup would do for the current state, decided without touching disk. */
export interface SetupPlan {
  /** Packages to install; empty when nothing installable is missing. */
  readonly packages: readonly string[];
  /** Tools that stay manual because no wheel can honestly provide them. */
  readonly manual: readonly string[];
  /** True when there is nothing to do. */
  readonly ready: boolean;
}

/**
 * Decide what (if anything) to install, without touching disk.
 *
 * The caller passes the tools it could not resolve, so the catalogue lookup
 * is a plain membership test — anything absent from the catalogue is reported
 * as manual rather than silently dropped, because a tool that quietly installs
 * nothing is worse than one that says it cannot be installed.
 */
export function planSetup(
  missingTools: readonly string[],
  catalogue: readonly AutoPackage[] = AUTO_PACKAGES,
): SetupPlan {
  const missing = new Set(missingTools);
  const manual = missingTools.filter((t) => !catalogue.some((c) => c.tool === t));
  const packages = catalogue.filter((c) => missing.has(c.tool)).map((c) => c.pkg);
  return { packages, manual, ready: packages.length === 0 && manual.length === 0 };
}

/** The final non-blank line of a command's output — the part that explains it. */
function lastLine(text: string): string {
  const lines = text.trim().split("\n").filter((l) => l.trim() !== "");
  return lines[lines.length - 1]?.trim() ?? "";
}

/** Outcome of running a command, kept narrow so the caller can log it verbatim. */
export interface InstallResult {
  readonly ok: boolean;
  /** What happened, or the line that explains the failure. */
  readonly detail: string;
  readonly stdout: string;
  readonly stderr: string;
}

export type CommandRunner = (
  bin: string,
  args: string[],
  timeoutMs: number,
) => Promise<SpawnResult>;

/**
 * Create the venv if it is not there. Returns the venv's python, or undefined
 * when creation failed — the caller then keeps using the system interpreter
 * and says so, rather than blocking on an environment it cannot build.
 */
export async function ensureVenv(
  venvDir: string,
  systemPython: string,
  run: CommandRunner,
  platform: NodeJS.Platform = process.platform,
  timeoutMs = 300_000,
  exists: (p: string) => boolean = existsSync,
): Promise<{ python: string | undefined; result: InstallResult }> {
  if (venvReady(venvDir, exists, platform)) {
    return {
      python: venvPython(venvDir, platform),
      result: { ok: true, detail: `venv already present at ${venvDir}`, stdout: "", stderr: "" },
    };
  }
  const res = await run(systemPython, ["-m", "venv", venvDir], timeoutMs);
  const ok = res.exitCode === 0 && venvReady(venvDir, exists, platform);
  return {
    python: ok ? venvPython(venvDir, platform) : undefined,
    result: {
      ok,
      detail: ok
        ? `created venv at ${venvDir}`
        : `${systemPython} -m venv failed (exit=${res.exitCode}): ${lastLine(res.stderr) || lastLine(res.stdout)}`,
      stdout: res.stdout,
      stderr: res.stderr,
    },
  };
}

/** Install packages into the venv with the venv's own pip. */
export async function installPackages(
  venvPythonPath: string,
  packages: readonly string[],
  run: CommandRunner,
  timeoutMs = 900_000,
): Promise<InstallResult> {
  if (packages.length === 0) {
    return { ok: true, detail: "nothing to install", stdout: "", stderr: "" };
  }
  // --disable-pip-version-check keeps the run quiet and short: the user did not
  // ask for a self-check, and the network round trip shows up as a stall on an
  // offline machine.
  const res = await run(
    venvPythonPath,
    ["-m", "pip", "install", "--disable-pip-version-check", ...packages],
    timeoutMs,
  );
  return {
    ok: res.exitCode === 0,
    detail:
      res.exitCode === 0
        ? `installed ${packages.join(", ")}`
        : `pip install failed (exit=${res.exitCode}): ${lastLine(res.stderr) || lastLine(res.stdout)}`,
    stdout: res.stdout,
    stderr: res.stderr,
  };
}

// ---------------------------------------------------------------------------
// Wiring
//
// The path is process-wide state on purpose. It is set once during activation
// and read by spawn sites four layers away (a sidecar launched deep in a build
// flow, the tool resolver) that have no other way to learn it. Every decision
// function above stays pure and takes the directory as an argument, so this
// holder is the only mutable part and it holds one string.

let configuredVenvDir: string | undefined;

/** Called once per activation; undefined disables venv use entirely. */
export function setVenvDir(dir: string | undefined): void {
  configuredVenvDir = dir;
}

/** The venv directory this session is using, if any. */
export function activeVenvDir(): string | undefined {
  return configuredVenvDir;
}

/**
 * The interpreter to spawn for a sidecar right now.
 *
 * Falls back to the bare "python3" whenever the venv is absent or not built,
 * so a machine that declines setup keeps working — it just does without the
 * wheels, which is the pre-existing behaviour.
 */
export function sidecarPythonNow(platform: NodeJS.Platform = process.platform): string {
  return sidecarPython(configuredVenvDir, platform);
}

/** The venv's bin directory, for the tool resolver's extra search path. */
export function venvExtraDirs(platform: NodeJS.Platform = process.platform): string[] {
  return configuredVenvDir === undefined ? [] : [venvBinDir(configuredVenvDir, platform)];
}
