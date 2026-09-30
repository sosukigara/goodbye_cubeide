// CLI probe preflight: refuse safely instead of stealing the ST-LINK.
//
// Reuses the existing authorities only — `readSessionLock` (lock shape +
// corrupt-text-is-no-lock) and `detectConflicts`/`listProcesses` (CubeIDE
// scan) — and never reimplements them. Pure and vscode-free: every side
// effect (lock read, liveness probe, process list, stderr) is injected so
// unit tests simulate alive/dead pids without touching real processes.
//
// What this module NEVER does, by construction (no --force path exists):
// it never writes/deletes the lock file and never signals any pid. The
// liveness probe is `process.kill(pid, 0)` — signal 0 performs no delivery,
// it only asks the kernel whether the pid exists (ESRCH = dead).

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { readSessionLock } from "../live/manager.js";
import {
  CUBEIDE_RUNNING_MESSAGE,
  PROBE_BUSY_MESSAGE,
  detectConflicts,
  listProcesses,
} from "../probe/conflict.js";

/** Cross-window live-session lock the CLI reads but never writes. */
export const LIVE_LOCK_PATH = "/tmp/stm32ext-live.lock";

/** CLI exit code for a preflight refusal (usage/resolved/refused class). */
export const PREFLIGHT_EXIT_CODE = 2;

/** Wire stage for every refusal from this module. */
export const PREFLIGHT_STAGE = "preflight" as const;

export type PreflightVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly stage: typeof PREFLIGHT_STAGE; readonly error: string };

export interface PreflightDeps {
  /** Lock file text, or undefined when absent/unreadable. Defaults to reading LIVE_LOCK_PATH. */
  readonly readLockText?: (() => string | undefined) | undefined;
  /** True when the holder pid is alive. Defaults to a signal-0 existence probe. */
  readonly isAlive?: ((pid: number) => boolean) | undefined;
  /** `ps` output for the CubeIDE scan. Defaults to the real process list. */
  readonly listPs?: (() => Promise<string>) | undefined;
  /** Stderr sink. Defaults to `process.stderr.write`. */
  readonly warn?: ((text: string) => void) | undefined;
}

/** A lock pid is only checkable when it is a positive safe integer. */
function isCheckablePid(pid: unknown): pid is number {
  return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0;
}

function defaultReadLockText(): string | undefined {
  try {
    return readFileSync(LIVE_LOCK_PATH, "utf8");
  } catch {
    return undefined; // no lock file = no holder
  }
}

/**
 * Signal-0 existence probe: success or EPERM means alive, ESRCH means dead.
 * Signal 0 is delivered to NOBODY — it only reports whether the pid exists.
 */
function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as { code?: unknown } | undefined)?.code;
    if (code === "ESRCH") {
      return false;
    }
    return true; // EPERM and friends: the pid exists, we just cannot signal it
  }
}

function defaultRun(bin: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, [...args], { timeout: 5000 }, (err, stdout) => {
      if (err !== null) {
        reject(err);
        return;
      }
      resolve(stdout);
    });
  });
}

async function defaultListPs(): Promise<string> {
  return listProcesses(defaultRun);
}

/**
 * Run the probe preflight. Order: live-session lock first, then CubeIDE.
 *
 * - Alive holder pid -> refusal `{ok:false, stage:"preflight"}` + PROBE_BUSY text.
 * - Dead pid (ESRCH) -> stale: stderr warning, CONTINUE (exit-code-equivalent 0 path).
 * - Corrupt/unparseable lock text -> "no lock", continue silently.
 * - CubeIDE running -> refusal before any probe use, same stage, exit-code-equivalent 2.
 *
 * WHY no PID-reuse guard: a recycled pid can only produce a clear "probe
 * busy" refusal on the real probe open, never a silent takeover — and this
 * module never signals a pid, so continuing past a stale entry can never
 * seize a session. Engineering the race away would need signalling, which
 * is exactly what is forbidden here.
 */
export async function checkPreflight(deps?: PreflightDeps | undefined): Promise<PreflightVerdict> {
  const readLockText = deps?.readLockText ?? defaultReadLockText;
  const isAlive = deps?.isAlive ?? defaultIsAlive;
  const listPs = deps?.listPs ?? defaultListPs;
  const warn = deps?.warn ?? ((text: string) => { process.stderr.write(text); });

  let lockText: string | undefined;
  try {
    lockText = readLockText();
  } catch {
    lockText = undefined; // unreadable lock = no lock
  }
  if (lockText !== undefined) {
    const lock = readSessionLock(lockText); // corrupt text already yields undefined
    if (lock !== undefined && isCheckablePid(lock.pid)) {
      let alive = false;
      try {
        alive = isAlive(lock.pid);
      } catch {
        alive = false; // a checker that throws proves nothing; stale path continues
      }
      if (alive) {
        return { ok: false, stage: PREFLIGHT_STAGE, error: PROBE_BUSY_MESSAGE };
      }
      warn(`stale lock: holder pid ${lock.pid} is gone; continuing\n`);
    }
  }

  let ps = "";
  try {
    ps = await listPs();
  } catch {
    ps = ""; // unlistable processes = no provable conflict
  }
  if (detectConflicts(ps).cubeIde) {
    return { ok: false, stage: PREFLIGHT_STAGE, error: CUBEIDE_RUNNING_MESSAGE };
  }
  return { ok: true };
}

export { CUBEIDE_RUNNING_MESSAGE, PROBE_BUSY_MESSAGE };
