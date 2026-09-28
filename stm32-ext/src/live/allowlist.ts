// Memory write policy for a variable the user picked in the UI.
//
// The target is ANY variable the host could resolve from the ELF, not only the
// leaves of DebugGlobal. A DebugGlobal-only fence is gone: it made a tuner
// global or a plain counter unreachable for editing while those were exactly
// the values a person tuning a robot wants to poke at.
//
// What is still enforced, and is the part that matters once the fence is
// gone:
// - The target must have been RESOLVED. Resolution is the only thing standing
//   between a typed name and a bus write, so an unresolved one is refused
//   before any prompt appears.
// - Width must be one the sidecar can actually move (checked by the caller,
//   which knows the resolved symbol's size).
// - Every write needs explicit modal confirmation; `confirmed=false` refuses.
// - Names under drive/motor/current paths raise a motor-drive warning that
//   the confirm dialog must surface.
// - Every decision, allowed or refused, appends an audit log line.
//
// The write is confined to the symbol's own bytes by construction: the host
// sends the sidecar the extent it resolved, and the sidecar refuses anything
// that does not fit inside it. What is NOT fenced any more is the surrounding
// address space — see the note on the sidecar's read-modify-write.

export interface WriteTarget {
  readonly name: string;
  readonly address: string;
  readonly size: number;
}

export interface WriteRequest {
  readonly target: WriteTarget;
  readonly value: string;
  readonly confirmed: boolean;
}

export type WriteVerdict =
  | { readonly ok: true; readonly warning: string | undefined; readonly audit: string }
  | { readonly ok: false; readonly reason: string; readonly audit: string };

export const MOTOR_DRIVE_WARNING =
  "WARNING: this variable affects motor drive output. " +
  "Writing while the robot is energized can cause sudden motion. " +
  "Secure the wheels / E-STOP before confirming.";

const MOTOR_PATH = /(^|\.)(drive|motor|dji_current|target_current|stop_snap|stop_frame)(\.|$)|current/i;

export function isMotorDrivePath(name: string): boolean {
  return MOTOR_PATH.test(name);
}

function parseHex(s: string): number | undefined {
  if (!/^0x[0-9a-fA-F]+$/.test(s)) {
    return undefined;
  }
  const n = Number.parseInt(s, 16);
  return Number.isSafeInteger(n) ? n : undefined;
}

export function auditLine(entry: {
  readonly stamp: string;
  readonly name: string;
  readonly address: string;
  readonly value: string;
  readonly decision: string;
}): string {
  return `[live-write] ${entry.stamp} ${entry.decision} ` +
    `${entry.name}@${entry.address} value=${entry.value}`;
}

/**
 * Decide one write.
 *
 * `extent` is the byte span the host resolved for the target symbol, and the
 * write must fit inside it. Taking it as an argument rather than recomputing
 * it here is what keeps this a check: the host declares what it believes the
 * symbol is, and this refuses a request that does not fit its own claim.
 *
 * There is no DebugGlobal fence any more, so the question this used to ask
 * ("is this address inside the one allowed window?") is replaced by "is this
 * address parseable, does the write fit the declared symbol, and did the user
 * confirm?". The remaining guards are the ones that do not depend on a fixed
 * window: resolution, explicit confirmation, the motor-drive warning, and the
 * audit line.
 */
export function decideWrite(
  req: WriteRequest,
  extent: { base: number; size: number },
  stamp: string,
): WriteVerdict {
  const addr = parseHex(req.target.address);
  if (addr === undefined) {
    const reason = `refused: unresolvable address for ${req.target.name} (not in ELF resolution)`;
    return {
      ok: false,
      reason,
      audit: auditLine({ stamp, name: req.target.name, address: req.target.address, value: req.value, decision: `REFUSED(${reason})` }),
    };
  }
  // Confined to the target's own bytes, so a name that resolved to a
  // different object than the host believes cannot be written past.
  if (extent.size <= 0 || addr < extent.base || addr + req.target.size > extent.base + extent.size) {
    const reason = `refused: ${req.target.address}+${req.target.size} does not fit ` +
      `${req.target.name} [${`0x${extent.base.toString(16)}`}, +${extent.size})`;
    return {
      ok: false,
      reason,
      audit: auditLine({ stamp, name: req.target.name, address: req.target.address, value: req.value, decision: `REFUSED(${reason})` }),
    };
  }
  if (!req.confirmed) {
    const reason = "refused: modal confirmation not given";
    return {
      ok: false,
      reason,
      audit: auditLine({ stamp, name: req.target.name, address: req.target.address, value: req.value, decision: `REFUSED(${reason})` }),
    };
  }
  const warning = isMotorDrivePath(req.target.name) ? MOTOR_DRIVE_WARNING : undefined;
  return {
    ok: true,
    warning,
    audit: auditLine({ stamp, name: req.target.name, address: req.target.address, value: req.value, decision: "ALLOWED" }),
  };
}
