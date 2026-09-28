// Flash via pyOCD — the same library the live monitor already requires, so
// flashing needs no second vendor toolchain installed. pyOCD always verifies
// after programming and resets the target by default, which is the same
// guarantee the CubeProgrammer path gets from its mandatory `-v -rst`.
//
// Probe selection is automatic (pyOCD picks the single attached ST-LINK);
// the SWD/JTAG choice is a DAP-layer property pyOCD derives from the probe,
// so `stm32ext.interface` does not appear in the command line here.

import { existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import {
  describeElf,
  isProbeNotFound,
  type FlashRequest,
  type FlashResult,
  type FlashSettings,
  type SpawnFn,
} from "./backend.js";
import { PROBE_BUSY_MESSAGE, isProbeBusyOutput } from "../probe/conflict.js";

export const DEFAULT_PYOCD = "pyocd";

/** connect mode per resetMode; `none` keeps pyOCD's default halt-connect. */
export function connectModeOf(resetMode: FlashSettings["resetMode"]): string {
  return resetMode === "connect-under-reset" ? "under-reset" : "halt";
}

/** `pyocd load` argv. Verify is implicit; reset is implicit (no --no-reset). */
export function buildPyocdArgs(
  mcu: string,
  settings: FlashSettings,
  req: FlashRequest,
): string[] {
  const args = [
    "load",
    "--target", mcu.toLowerCase().replace(/[^a-z0-9]/g, ""),
    "--format", "elf",
    "--connect", connectModeOf(settings.resetMode),
  ];
  // STM32_Programmer_CLI's `-rst` = run after programming; pyOCD does this
  // by default, so only an explicit "none" suppresses it.
  if (settings.resetMode === "none") {
    args.push("--no-reset");
  }
  args.push(req.elfPath);
  return args;
}

export function buildPyocdCommand(
  mcu: string,
  settings: FlashSettings,
  req: FlashRequest,
): string {
  return [DEFAULT_PYOCD, ...buildPyocdArgs(mcu, settings, req)].join(" ");
}

export function resolvePyocdPath(configured: string): { cli: string; searched: string[]; found: boolean } {
  const name = configured.trim() || DEFAULT_PYOCD;
  const searched: string[] = [];
  if (name.includes("/")) {
    searched.push(name);
    return { cli: name, searched, found: isExecutable(name) };
  }
  for (const dir of (process.env["PATH"] ?? "").split(delimiter)) {
    if (!dir) {
      continue;
    }
    const full = join(dir, name);
    searched.push(full);
    if (isExecutable(full)) {
      return { cli: full, searched, found: true };
    }
  }
  return { cli: name, searched, found: false };
}

function isExecutable(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function isElf(path: string): boolean {
  return path.endsWith(".elf") && existsSync(path);
}

/**
 * `pyocd list -q` exits in about a second and prints
 * "No available debug probes are connected" when nothing is attached, which is
 * the answer `pyocd load` will never give: it waits instead.
 */
const PROBE_LIST_ARGS = ["list", "-q"];
const PROBE_LIST_TIMEOUT_MS = 10_000;
/** A programming run past this is a hung probe, not a slow flash. */
const FLASH_TIMEOUT_MS = 5 * 60_000;

export const NO_PROBE_MESSAGE =
  "ST-LINK が見つかりません。USB ケーブルの接続と拡張ボードの電源を確認してください";

function noProbeInListing(output: string): boolean {
  return /No available debug probes are connected/i.test(output);
}

export async function runPyocdFlash(
  mcu: string,
  settings: FlashSettings,
  req: FlashRequest,
  spawn?: SpawnFn,
): Promise<FlashResult> {
  const command = buildPyocdCommand(mcu, settings, req);
  const resolved = resolvePyocdPath(DEFAULT_PYOCD);
  const headDetails = [
    describeElf(req.elfPath),
    `cli: ${resolved.cli} (${resolved.found ? "found" : "NOT FOUND"})`,
    `target: ${mcu} reset=${settings.resetMode} -> ${connectModeOf(settings.resetMode)}`,
  ];
  if (!req.confirmed) {
    return {
      ok: false, command,
      message: "Flash refused: user confirmation required (confirmless write is forbidden).",
      details: headDetails,
    };
  }
  if (!req.elfPath || !req.elfPath.endsWith(".elf")) {
    return {
      ok: false, command,
      message: `Flash refused: expected an .elf file, got "${req.elfPath}".`,
      details: headDetails,
    };
  }
  if (req.dryRun || process.env["STM32EXT_FLASH_DRY_RUN"] === "1") {
    return {
      ok: true, command, dryRun: true, message: `dry-run: ${command}`,
      details: [...headDetails, `argv: ${buildPyocdArgs(mcu, settings, req).join(" ")}`],
    };
  }
  if (!resolved.found) {
    return {
      ok: false, command, retryable: false,
      message:
        "pyocd was not found on PATH.\n"
        + `searched:\n${resolved.searched.map((s) => `  - ${s}`).join("\n")}\n`
        + "Install it with `pip install --user pyocd` (the live monitor needs it too).",
      details: headDetails,
    };
  }
  if (!spawn) {
    const { spawnCli } = await import("./spawn.js");
    spawn = spawnCli;
  }
  // Pre-flight: `pyocd load` blocks forever when no probe is attached, so ask
  // the CLI to list probes first. It answers in about a second and exits.
  const listStarted = Date.now();
  let listing: { exitCode: number; stdout: string; stderr: string; timedOut?: boolean };
  try {
    listing = await spawn(resolved.cli, PROBE_LIST_ARGS, PROBE_LIST_TIMEOUT_MS);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false, command, retryable: true,
      message: `pyocd probe 確認に失敗しました: ${detail}`,
      details: [...headDetails, `pyocd list spawn error: ${detail}`],
    };
  }
  const listed = `${listing.stdout}\n${listing.stderr}`;
  if (listing.timedOut === true) {
    return {
      ok: false, command, retryable: true,
      message: `pyocd が probe リストに ${PROBE_LIST_TIMEOUT_MS}ms 以内に応答しませんでした。`
        + "ST-LINK が他のセッションに掴まれている可能性があります。",
      details: [...headDetails, `pyocd list timed out after ${PROBE_LIST_TIMEOUT_MS}ms`],
    };
  }
  if (noProbeInListing(listed)) {
    return {
      ok: false, command, retryable: true,
      message: NO_PROBE_MESSAGE,
 details: [...headDetails,
        `pyocd list (${Date.now() - listStarted}ms): ${lastLines(listed)}`],
    };
  }
  const started = Date.now();
  let out: { exitCode: number; stdout: string; stderr: string; timedOut?: boolean };
  try {
    out = await spawn(resolved.cli, buildPyocdArgs(mcu, settings, req), FLASH_TIMEOUT_MS);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false, command, retryable: false,
      message: `pyocd spawn failed: ${detail}`,
      details: [...headDetails, `spawn error after ${Date.now() - started}ms: ${detail}`],
    };
  }
  const elapsedMs = Date.now() - started;
  const combined = `${out.stdout}\n${out.stderr}`;
  const tailDetails = [
    ...headDetails,
    `exit=${out.exitCode} elapsed=${elapsedMs}ms outBytes=${combined.length}`,
  ];
  if (out.exitCode === 0) {
    return { ok: true, command, stdout: combined, message: "書き込み + 検証 OK", details: tailDetails };
  }
  if (isProbeBusyOutput(combined)) {
    return {
      ok: false, command, stdout: combined, retryable: false,
      message: PROBE_BUSY_MESSAGE,
      details: [...tailDetails, `cause: ${lastLines(combined)}`],
    };
  }
  if (isProbeNotFound(combined)) {
    return {
      ok: false, command, stdout: combined, retryable: true,
      message: `プローブ未検出 — ST-LINK接続・udevを確認し1回再試行してください。原因: ${lastLines(combined)}`,
      details: tailDetails,
    };
  }
  return {
    ok: false, command, stdout: combined,
    message: `書き込み失敗 (exit ${out.exitCode})。原因: ${lastLines(combined)}`,
    details: tailDetails,
  };
}

function lastLines(output: string, maxLines = 4): string {
  const lines = output.split("\n").map((l) => l.trim()).filter((l) => l);
  return lines.slice(-maxLines).join(" / ");
}
