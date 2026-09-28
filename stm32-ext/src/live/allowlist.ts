// todo5d: DebugGlobal-only allowlisted memory write.
// Rules (plan MUST NOT: arbitrary-address writes):
// - Target must be a RESOLVED symbol inside [DebugGlobal base, end).
// - Out-of-range or unresolved targets are refused (no prompt, no write).
// - Resolved in-range writes still need explicit modal confirmation
//   (host shows confirm dialog; `confirmed=false` is refused here too).
// - Names under drive/motor/current paths raise a motor-drive warning that
//   the confirm dialog must surface.
// - Every decision (allowed or refused) appends an audit log line.

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

export function decideWrite(
  req: WriteRequest,
  range: { base: number; end: number },
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
  if (!(range.base <= addr && addr < range.end)) {
    const reason = `refused: ${req.target.address} outside DebugGlobal ` +
      `[${`0x${range.base.toString(16)}`}, ${`0x${range.end.toString(16)}`}) — arbitrary-address writes are forbidden`;
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
