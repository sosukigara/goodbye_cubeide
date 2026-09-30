// CLI explicit setup: install pyocd + pyelftools into a CLI-owned venv.
//
// WHY A CLI-OWNED VENV (measured, not assumed): this machine has no pyocd in
// the system python3, `pip install --user` is refused by PEP 668 on current
// Debian/Ubuntu, and the extension's venv lives inside VSCode's
// globalStorageUri, which a standalone CLI cannot and must not read. So the
// CLI keeps its own venv under the user's data dir and nothing else.
//
// What this module NEVER does, by construction:
// - it never touches the system site-packages (installs go through the venv's
//   own pip via `installPackages`, which is what makes this work on PEP 668);
// - it never reads VSCode state (no `vscode` import, no globalStorage path);
// - it never auto-provisions: only the `setup` command calls `runSetup`, and
//   no other CLI path imports this module for side effects.
// Reuses the existing authorities only — `sidecarPython`, `venvReady`,
// `venvPython`, `planSetup`, `packagesFor`, `ensureVenv`, `installPackages`,
// `spawnCli` — and never reimplements them. Pure and vscode-free: the command
// runner, the filesystem probe, and the venv dir are all injected, so unit
// tests never create a real venv and never run a real pip install.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ensureVenv,
  installPackages,
  packagesFor,
  planSetup,
  sidecarPython,
  venvPython,
  venvReady,
  type CommandRunner,
} from "../env/venv.js";
import { spawnCli } from "../flash/spawn.js";

/**
 * The CLI-owned venv directory: `~/.local/share/stm32-cli/venv`, or
 * `$XDG_DATA_HOME/stm32-cli/venv` when XDG_DATA_HOME is set and non-blank.
 * Nothing outside this tree is ever created. Same `join(homedir(), ...)`
 * resolution style as the other CLI path defaults (cf. policy.ts,
 * resolve.ts); the XDG branch only redirects the base.
 */
export function resolveCliVenvDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const xdg = env["XDG_DATA_HOME"];
  if (xdg !== undefined && xdg.trim() !== "") {
    return join(xdg, "stm32-cli", "venv");
  }
  return join(home, ".local", "share", "stm32-cli", "venv");
}

/** The CLI-owned venv directory for this process. */
export const CLI_VENV_DIR: string = resolveCliVenvDir();

/** Tools the setup command manages, with the module each is probed by. */
const SETUP_TOOLS = [
  { tool: "pyocd", module: "pyocd" },
  // ponytail: pyelftools ships no executable, so PATH can never see it; the
  // importable module is `elftools`, and that is what the extension probes
  // too (extension.ts runSetup). Probing `import pyelftools` would fail
  // forever, even right after a successful install.
  { tool: "pyelftools", module: "elftools" },
] as const;

export interface SetupDeps {
  /** Defaults to CLI_VENV_DIR. Never a VSCode storage path. */
  readonly venvDir?: string | undefined;
  /** Defaults to the real spawn (via spawnCli). Tests stub this. */
  readonly run?: CommandRunner | undefined;
  /** Defaults to process.platform. */
  readonly platform?: NodeJS.Platform | undefined;
  /** Existence probe for the venv. Defaults to node:fs existsSync. */
  readonly exists?: ((p: string) => boolean) | undefined;
  /** Interpreter used only to CREATE the venv. Defaults to "python3". */
  readonly systemPython?: string | undefined;
}

/**
 * JSON-serializable report so an agent can branch on it. `ok` is the only
 * field the caller needs to check; the rest explains what happened.
 */
export interface SetupResult {
  readonly ok: boolean;
  readonly venvDir: string;
  /** The venv's own python (target path, whether or not setup succeeded). */
  readonly python: string;
  /** True when this run created the venv (false on a no-op re-run). */
  readonly created: boolean;
  /** Tools found missing by the venv-only import probes. */
  readonly missing: readonly string[];
  /** Packages installed by this run; empty on a no-op or a failure. */
  readonly installed: readonly string[];
  /** Packages already present, so not installed. */
  readonly skipped: readonly string[];
  readonly detail: string;
}

/**
 * True when the interpreter can import the module. Exit-code-driven: stdout
 * is deliberately ignored, so garbage on stdout with exit 0 still counts as
 * present and a non-zero exit with empty output still counts as missing. A
 * runner that throws (unspawnable interpreter) counts as missing, which is
 * the answer that leads to installing, not to silence.
 */
async function importProbe(
  run: CommandRunner,
  python: string,
  module: string,
): Promise<boolean> {
  try {
    const r = await run(python, ["-c", `import ${module}`], 30_000);
    return r.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Explicit, opt-in setup into the CLI-owned venv. Order mirrors the
 * extension's runSetup: check what is missing, create the venv, install only
 * what is missing, report honestly.
 *
 * - The missing check consults the VENV's packages only: when the venv is
 *   not built yet both tools count as missing without spawning anything, so
 *   the system interpreter is never consulted.
 * - On venv-creation failure returns `ok:false` and says the system
 *   interpreter will continue to be used, instead of blocking.
 */
export async function runSetup(deps?: SetupDeps | undefined): Promise<SetupResult> {
  const venvDir = deps?.venvDir ?? CLI_VENV_DIR;
  const run = deps?.run ?? spawnCli;
  const platform = deps?.platform ?? process.platform;
  const exists = deps?.exists ?? existsSync;
  const systemPython = deps?.systemPython ?? "python3";
  const python = venvPython(venvDir, platform);

  const wasBuilt = venvReady(venvDir, exists, platform);
  // sidecarPython is the interpreter authority: the venv's python when built,
  // the bare system name otherwise. The fallback is never spawned for probes
  // (that would consult the system environment this setup exists to avoid);
  // an unbuilt venv simply means everything is missing.
  const probePython = sidecarPython(venvDir, platform, exists);
  const missing: string[] = [];
  if (probePython !== "python3") {
    for (const t of SETUP_TOOLS) {
      if (!(await importProbe(run, probePython, t.module))) {
        missing.push(t.tool);
      }
    }
  } else {
    for (const t of SETUP_TOOLS) {
      missing.push(t.tool);
    }
  }

  const plan = planSetup(missing);
  const present = SETUP_TOOLS.map((t) => t.tool).filter((t) => !missing.includes(t));
  const skipped = packagesFor(present);
  if (plan.packages.length === 0) {
    return {
      ok: true,
      venvDir,
      python,
      created: false,
      missing,
      installed: [],
      skipped,
      detail: `nothing to install: ${skipped.join(", ") || "nothing missing"} already importable from ${venvDir}`,
    };
  }

  const ensured = await ensureVenv(venvDir, systemPython, run, platform, 300_000, exists);
  if (ensured.python === undefined) {
    return {
      ok: false,
      venvDir,
      python,
      created: false,
      missing,
      installed: [],
      skipped,
      detail: `${ensured.result.detail}; the system interpreter (${systemPython}) will continue to be used`,
    };
  }
  const installed = await installPackages(ensured.python, plan.packages, run);
  if (!installed.ok) {
    return {
      ok: false,
      venvDir,
      python,
      created: !wasBuilt,
      missing,
      installed: [],
      skipped,
      detail: installed.detail,
    };
  }
  return {
    ok: true,
    venvDir,
    python,
    created: !wasBuilt,
    missing,
    installed: [...plan.packages],
    skipped,
    detail: `${wasBuilt ? "reused" : "created"} venv at ${venvDir}; ${installed.detail}`,
  };
}
