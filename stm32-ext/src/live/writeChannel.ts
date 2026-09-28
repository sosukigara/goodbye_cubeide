// Host side of the DebugGlobal write channel. The sidecar owns the single
// pyOCD session, so requests go to it over stdin and results come back on
// stdout as `WRITE-RESULT {json}`. Pure string/JSON handling — no vscode —
// so the round trip is unit-testable.

export const WRITE_RESULT_PREFIX = "WRITE-RESULT ";

export interface WriteResult {
  readonly id: string;
  readonly ok: boolean;
  readonly address?: string | undefined;
  readonly value?: string | undefined;
  readonly readback?: string | undefined;
  readonly error?: string | undefined;
  /** Write landed, but the word already reads back differently. */
  readonly note?: string | undefined;
}

/** One stdin line. The sidecar re-validates the range before the write. */
export function buildWriteRequest(
  id: string,
  address: string,
  size: number,
  value: string,
): string {
  return JSON.stringify({ id, op: "write", address, size, value });
}

/** Parse a sidecar stdout line; null for anything that is not a result. */
export function parseWriteResult(line: string): WriteResult | null {
  if (!line.startsWith(WRITE_RESULT_PREFIX)) {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(line.slice(WRITE_RESULT_PREFIX.length));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const r = raw as Record<string, unknown>;
  if (typeof r["id"] !== "string" || typeof r["ok"] !== "boolean") {
    return null;
  }
  const str = (k: string): string | undefined =>
    typeof r[k] === "string" ? r[k] : undefined;
  return {
    id: r["id"],
    ok: r["ok"],
    address: str("address"),
    value: str("value"),
    readback: str("readback"),
    error: str("error"),
    note: str("note"),
  };
}

/**
 * Correlates in-flight writes with sidecar results. A write that never
 * answers (session died mid-flight) must not hang the UI forever, so each
 * request carries its own timeout.
 */
export class PendingWrites {
  private readonly waiters = new Map<string, (r: WriteResult) => void>();
  private seq = 0;

  constructor(private readonly timeoutMs: number) {}

  /** Register a new request; resolves with the sidecar's answer. */
  expect(): { id: string; done: Promise<WriteResult> } {
    this.seq += 1;
    const id = `w${this.seq}`;
    const done = new Promise<WriteResult>((resolve) => {
      const timer = setTimeout(() => {
        if (this.waiters.delete(id)) {
          resolve({ id, ok: false, error: "sidecar did not answer (session may have stopped)" });
        }
      }, this.timeoutMs);
      // Node keeps the process alive for pending timers; a write must not do that.
      if (typeof timer.unref === "function") {
        timer.unref();
      }
      this.waiters.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
    });
    return { id, done };
  }

  /** Feed a stdout line; true if it settled a pending request. */
  settle(line: string): boolean {
    const result = parseWriteResult(line);
    if (result === null) {
      return false;
    }
    const waiter = this.waiters.get(result.id);
    if (waiter === undefined) {
      return false;
    }
    this.waiters.delete(result.id);
    waiter(result);
    return true;
  }

  /** Fail everything in flight (session stopped / child exited). */
  abandon(reason: string): void {
    for (const [id, waiter] of this.waiters) {
      this.waiters.delete(id);
      waiter({ id, ok: false, error: reason });
    }
  }
}
