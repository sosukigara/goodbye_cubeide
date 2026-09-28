// todo4: CubeProgrammer CLI flash backend.
// Wraps STMicroelectronics STM32CubeProgrammer CLI (Linux binary name:
// STM32_Programmer_CLI). No custom flash algorithm — pure delegation.
// Reference: unit_omni3.launch reset_strategy=connect_under_reset; defaults
// ST-LINK / SWD / connect-under-reset come from the package.json settings
// schema (stm32ext.probe/interface/resetMode). Verify (-v) is mandatory.
// This is the fallback backend; the default is pyOCD (see ./pyocd.ts), which
// needs no ST toolchain installed.

export const DEFAULT_CLI = "STM32_Programmer_CLI";

const BUNDLE_PLUGIN_PREFIX = "com.st.stm32cube.ide.mcu.externaltools.cubeprogrammer.linux64_";

export type FlashProbe = "ST-LINK" | "J-LINK";
export type FlashInterface = "SWD" | "JTAG";
export type FlashResetMode =
  | "connect-under-reset"
  | "software-reset"
  | "hardware-reset"
  | "core-reset"
  | "none";

export interface FlashSettings {
  readonly cliPath: string;
  readonly probe: FlashProbe;
  readonly iface: FlashInterface;
  readonly resetMode: FlashResetMode;
}

export interface FlashRequest {
  readonly elfPath: string;
  /** Caller must set true — backend refuses confirmless writes. */
  readonly confirmed: boolean;
  /** verify flag is accepted but ignored: -v is always emitted. */
  readonly verify?: boolean;
  readonly dryRun?: boolean;
}

export interface FlashResult {
  readonly ok: boolean;
  readonly command: string;
  readonly stdout?: string;
  readonly message: string;
  readonly dryRun?: boolean;
  /** True when output looks like probe-not-found: caller may offer a retry. */
  readonly retryable?: boolean;
  /** Verbose diagnostic lines (resolved paths, sizes, timing) — hosts print these to the log. */
  readonly details?: readonly string[];
}

export const DEFAULT_FLASH_SETTINGS: FlashSettings = {
  cliPath: DEFAULT_CLI,
  probe: "ST-LINK",
  iface: "SWD",
  resetMode: "connect-under-reset",
};

export const CLI_INSTALL_GUIDE = [
  "STM32_Programmer_CLI was not found on PATH.",
  "Auto-search also checked: PATH, ~/STMicroelectronics/STM32Cube/STM32CubeProgrammer/bin,",
  "  and the CubeIDE bundle (/opt/st/*/plugins/com.st.stm32cube.ide.mcu.externaltools.cubeprogrammer.linux64_*/tools/bin).",
  "Install STM32CubeProgrammer from https://www.st.com/en/development-tools/stm32cubeprog.html",
  "(Linux: run the Setup .zip installer; the CLI lands under",
  "  <install>/STMicroelectronics/STM32Cube/STM32CubeProgrammer/bin/STM32_Programmer_CLI).",
  "Then either add that bin dir to PATH or set stm32ext.cliPath to the full path,",
  "install ST-LINK udev rules, reconnect the probe, and retry.",
  "Until then, dry-run mode validates the command shape without hardware.",
].join("\n");

import { existsSync, readdirSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { homedir } from "node:os";
import { PROBE_BUSY_MESSAGE, isProbeBusyOutput } from "../probe/conflict.js";

function quoteArg(arg: string): string {
  return /[\s"']/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

/** Canonical argv: -c port=<IFACE> -w <elf> -v -rst. -v is unconditional. */
export function buildFlashArgs(settings: FlashSettings, req: FlashRequest): string[] {
  return ["-c", `port=${settings.iface}`, "-w", req.elfPath, "-v", "-rst"];
}

export function buildFlashCommand(settings: FlashSettings, req: FlashRequest): string {
  const cli = settings.cliPath || DEFAULT_CLI;
  return [cli, ...buildFlashArgs(settings, req).map((a, i) => (i === 3 ? quoteArg(a) : a))].join(" ");
}

/**
 * Resolve the CLI binary: explicit absolute path first, then PATH, then
 * well-known install locations (user STM32CubeProgrammer dir, CubeIDE
 * bundle under /opt/st). Never throws; reports what was searched.
 */
export function resolveCliPath(configured: string): { cli: string; searched: string[]; found: boolean } {
  const name = configured.trim() || DEFAULT_CLI;
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
  const candidates = [
    join(homedir(), "STMicroelectronics", "STM32Cube", "STM32CubeProgrammer", "bin", name),
    ...cubeIdeBundledClis(name),
  ];
  for (const full of candidates) {
    searched.push(full);
    if (isExecutable(full)) {
      return { cli: full, searched, found: true };
    }
  }
  return { cli: name, searched, found: false };
}

function isExecutable(path: string): boolean {
  try {
    const st = statSync(path);
    return st.isFile();
  } catch {
    return false;
  }
}

/** STM32_Programmer_CLI copies bundled inside CubeIDE installs (/opt/st). */
function cubeIdeBundledClis(name: string): string[] {
  const out: string[] = [];
  let roots: string[];
  try {
    roots = readdirSync("/opt/st");
  } catch {
    return out;
  }
  for (const root of roots) {
    let plugins: string[];
    try {
      plugins = readdirSync(join("/opt/st", root, "plugins"));
    } catch {
      continue;
    }
    for (const plugin of plugins) {
      if (plugin.startsWith(BUNDLE_PLUGIN_PREFIX)) {
        out.push(join("/opt/st", root, "plugins", plugin, "tools", "bin", name));
      }
    }
  }
  return out;
}

/** One-line ELF description for logs (abs path + size), or the reason it is missing. */
export function describeElf(elfPath: string): string {
  try {
    const st = statSync(elfPath);
    if (!st.isFile()) {
      return `elf: ${elfPath} (not a file)`;
    }
    return `elf: ${elfPath} (${st.size} bytes, mtime=${st.mtime.toISOString()})`;
  } catch {
    return `elf: ${elfPath} (missing)`;
  }
}
/** Last non-empty CLI output lines for failure messages (cause display). */
export function causeExcerpt(output: string, maxLines = 4, maxChars = 600): string {
  const lines = output.split("\n").map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trim()).filter((l) => l);
  const tail = lines.slice(-maxLines).join(" / ");
  return tail.length > maxChars ? `…${tail.slice(-maxChars)}` : tail;
}

const PROBE_NOT_FOUND_RE =
  /no\s*(st-?link|probe)|probe\s*not\s*found|unable to connect|target not found|no target/i;

export function isProbeNotFound(output: string): boolean {
  return PROBE_NOT_FOUND_RE.test(output);
}

export type SpawnFn = (
  cli: string,
  args: string[],
  timeoutMs?: number,
) => Promise<{ exitCode: number; stdout: string; stderr: string; timedOut?: boolean }>;

function validateRequest(settings: FlashSettings, req: FlashRequest): string | null {
  if (!req.confirmed) {
    return "Flash refused: user confirmation required (confirmless write is forbidden).";
  }
  if (!req.elfPath || req.elfPath.trim().length === 0) {
    return "Flash refused: empty ELF path.";
  }
  if (!req.elfPath.endsWith(".elf")) {
    return `Flash refused: expected an .elf file, got "${req.elfPath}".`;
  }
  if (!settings.cliPath || settings.cliPath.trim().length === 0) {
    return "Flash refused: empty stm32ext.cliPath.";
  }
  return null;
}

/**
 * Execute (or dry-run) a flash. Never retries internally — a probe-not-found
 * failure is reported with retryable:true so the GUI can offer ONE manual
 * retry step (auto-reflash loops are forbidden).
 */
export async function runFlash(
  settings: FlashSettings,
  req: FlashRequest,
  spawn?: SpawnFn,
): Promise<FlashResult> {
  const invalid = validateRequest(settings, req);
  const resolved = resolveCliPath(settings.cliPath || DEFAULT_CLI);
  const effSettings: FlashSettings = { ...settings, cliPath: resolved.cli };
  const command = buildFlashCommand(effSettings, req);
  const headDetails = [
    describeElf(req.elfPath),
    `cli: ${resolved.cli} (${resolved.found ? "found" : "NOT FOUND"})`,
    `settings: probe=${settings.probe} iface=${settings.iface} reset=${settings.resetMode}`,
  ];
  if (invalid) {
    return { ok: false, command, message: invalid, details: headDetails };
  }
  if (req.dryRun || process.env["STM32EXT_FLASH_DRY_RUN"] === "1") {
    return {
      ok: true, command, dryRun: true, message: `dry-run: ${command}`,
      details: [...headDetails, `argv: ${buildFlashArgs(effSettings, req).join(" ")}`],
    };
  }
  if (!resolved.found) {
    return {
      ok: false, command, retryable: false,
      message:
        `${CLI_INSTALL_GUIDE.split("\n")[0]}\n`
        + `searched:\n${resolved.searched.map((s) => `  - ${s}`).join("\n")}\n`
        + `${CLI_INSTALL_GUIDE.split("\n").slice(1).join("\n")}`,
      details: headDetails,
    };
  }
  if (!spawn) {
    const { spawnCli } = await import("./spawn.js");
    spawn = spawnCli;
  }
  const started = Date.now();
  let out: { exitCode: number; stdout: string; stderr: string };
  try {
    out = await spawn(resolved.cli, buildFlashArgs(effSettings, req));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      command,
      message: `${CLI_INSTALL_GUIDE}\n(spawn failed: ${detail})`,
      retryable: false,
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
    return { ok: true, command, stdout: combined, message: "Flash + verify OK.", details: tailDetails };
  }
  if (isProbeBusyOutput(combined)) {
    return {
      ok: false, command, stdout: combined, retryable: false,
      message: PROBE_BUSY_MESSAGE,
      details: [...tailDetails, `cause: ${causeExcerpt(combined)}`],
    };
  }
  if (isProbeNotFound(combined)) {
    return {
      ok: false,
      command,
      stdout: combined,
      message:
        `プローブ未検出 — ST-LINK接続・udev・プローブ選択を確認し1回再試行してください。原因: ${causeExcerpt(combined)}`,
      retryable: true,
      details: tailDetails,
    };
  }
  return {
    ok: false, command, stdout: combined,
    message: `Flash failed (exit ${out.exitCode})。原因: ${causeExcerpt(combined)}`,
    details: tailDetails,
  };
}
