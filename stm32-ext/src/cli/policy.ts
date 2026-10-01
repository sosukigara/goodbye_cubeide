// CLI write-confirmation gate and audit trail for `stm32 set`.
//
// The policy itself lives in ../live/allowlist.js: `decideWrite` is the ONLY
// write-policy authority and this module never reimplements it. The CLI's job
// is narrower — supply `confirmed` honestly (TTY prompt or --yes), surface
// the motor-drive warning, and record the audit line.
//
// Pure and vscode-free: every side effect (prompt, stderr, file append) is
// injected, so unit tests drive every branch without a TTY or filesystem.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import {
  auditLine,
  decideWrite,
  isMotorDrivePath,
  MOTOR_DRIVE_WARNING,
  type WriteRequest,
  type WriteVerdict,
} from "../live/allowlist.js";

/** Keep the last N audit lines; the log must not grow without bound. */
export const MAX_AUDIT_LINES = 5000;

/** Directory the CLI may write to. Nothing outside it is ever touched. */
export function defaultAuditDir(): string {
  return join(homedir(), ".local", "state", "stm32-cli");
}

export function defaultAuditFile(): string {
  return join(defaultAuditDir(), "audit.log");
}

/** Parse a `0x...` address for the extent base; undefined when unparseable. */
function parseAddressBase(addressHex: string): number | undefined {
  if (!/^0x[0-9a-fA-F]+$/.test(addressHex)) {
    return undefined;
  }
  const n = Number.parseInt(addressHex, 16);
  return Number.isSafeInteger(n) ? n : undefined;
}

/**
 * Build the `decideWrite` input for one write. The extent is the symbol's OWN
 * byte span `[address, address+size)` — the host declares what it resolved
 * and the check refuses anything that does not fit its own claim.
 *
 * The raw value TEXT is passed through for audit purposes only; it is never
 * parsed, range-checked, or pre-validated here (parse authority is
 * worker-only). An unparseable address maps to base 0 — `decideWrite` refuses
 * it with the unresolvable-address reason before the extent is ever consulted,
 * so this never throws.
 */
export function buildWriteInput(
  name: string,
  addressHex: string,
  size: number,
  rawValueText: string,
  confirmed: boolean,
): { req: WriteRequest; extent: { base: number; size: number } } {
  return {
    req: { target: { name, address: addressHex, size }, value: rawValueText, confirmed },
    extent: { base: parseAddressBase(addressHex) ?? 0, size },
  };
}

/**
 * Append one audit line to `file`, trimming to the last MAX_AUDIT_LINES.
 * Exported so tests can point it at a temp dir instead of the real log.
 */
export function appendAuditToFile(line: string, file: string): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, line + "\n", "utf8");
  const raw = readFileSync(file, "utf8");
  const lines = raw.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  if (lines.length > MAX_AUDIT_LINES) {
    writeFileSync(file, lines.slice(-MAX_AUDIT_LINES).join("\n") + "\n", "utf8");
  }
}

/** Default TTY prompt: `y/N`, default N. Writes to stderr: stdout is
 * reserved for the single-JSON-object contract, so a prompt on stdout would
 * corrupt the machine-readable reply. Only used on a real TTY. */
function defaultPrompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

export interface PolicyDeps {
  /** True when stdin is a TTY. Defaults to `process.stdin.isTTY`. */
  readonly isTTY?: boolean | undefined;
  /** Ask the user; resolves with the raw answer. Defaults to node:readline. */
  readonly prompt?: ((question: string) => Promise<string>) | undefined;
  /** Stderr sink. Defaults to `process.stderr.write`. */
  readonly stderr?: ((text: string) => void) | undefined;
  /** Audit-file appender. Defaults to the real `~/.local/state/stm32-cli/audit.log`. */
  readonly appendAudit?: ((line: string) => void) | undefined;
  /** Stamp factory. Defaults to `new Date().toISOString()`. */
  readonly stamp?: (() => string) | undefined;
}

export interface GateOptions {
  /** `--yes`: skip the prompt. Never defaults to true. */
  readonly yes: boolean;
}

function answerIsYes(answer: string): boolean {
  const t = answer.trim().toLowerCase();
  return t === "y" || t === "yes";
}

/**
 * Run the confirmation gate for one write and return `decideWrite`'s verdict.
 *
 * - `--yes` supplies `confirmed: true` without prompting.
 * - On a TTY without `--yes`, prompt `y/N` (default N).
 * - On a non-TTY without `--yes` (piped stdin), refuse — never prompt.
 * - A motor/drive/current name emits MOTOR_DRIVE_WARNING to stderr even when
 *   `--yes` was passed.
 * - The audit line goes to stderr AND the audit log; an append failure never
 *   fails the command.
 */
export async function gateWrite(
  name: string,
  addressHex: string,
  size: number,
  rawValueText: string,
  options: GateOptions,
  deps?: PolicyDeps | undefined,
): Promise<WriteVerdict> {
  const isTTY = deps?.isTTY ?? (process.stdin.isTTY === true);
  const prompt = deps?.prompt ?? defaultPrompt;
  const toStderr = deps?.stderr ?? ((text: string) => { process.stderr.write(text); });
  const appendAudit = deps?.appendAudit ?? ((line: string) => appendAuditToFile(line, defaultAuditFile()));
  const stamp = (deps?.stamp ?? (() => new Date().toISOString()))();

  let confirmed = options.yes;
  if (!options.yes && isTTY) {
    let answer = "";
    try {
      answer = await prompt(`Write ${name}@${addressHex} value=${rawValueText}? [y/N] `);
    } catch {
      answer = "";
    }
    confirmed = answerIsYes(answer);
  }

  const { req, extent } = buildWriteInput(name, addressHex, size, rawValueText, confirmed);
  const verdict = decideWrite(req, extent, stamp);

  // Motor warning even on the --yes path: a flag must not silence physics.
  if (isMotorDrivePath(name)) {
    toStderr(MOTOR_DRIVE_WARNING + "\n");
  }
  toStderr(verdict.audit + "\n");
  try {
    appendAudit(verdict.audit);
  } catch {
    // ponytail: audit is a record, not a gate; a full disk must not fail the write.
  }
  return verdict;
}
