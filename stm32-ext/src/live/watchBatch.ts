// Coalesces watchlist changes into one host call per burst.
//
// Both surfaces post ONE MESSAGE PER NAME: the graph panel expands a struct
// prefix into up to MAX_BULK (32) `graph-add` messages for a single click
// (graphPanel.ts add()), and the sidebar loops the same way over a
// comma-separated input. Each one reached `addNames` -> `restart()` ->
// `startSession()` -> stop + spawn, so one user action could restart the
// sidecar 32 times. Consecutive stop/spawn against the same probe is what
// makes the USB claim race and fail with `Errno 16 Resource busy`.
//
// The batch therefore keeps only the FINAL intent per name (add-then-remove
// is a remove) and flushes one `add-names` and one `remove-names` call. The
// delay only has to outlast the IPC gap between two webview messages, not a
// user gesture.

export interface WatchBatcherOptions {
  /** Window in ms within which changes collapse into one flush. */
  readonly delayMs?: number;
  /** Receives the coalesced change: names to watch, names to drop. */
  readonly sink: (add: readonly string[], remove: readonly string[]) => void;
}

const DEFAULT_DELAY_MS = 50;

export class WatchBatcher {
  private readonly pending = new Map<string, boolean>();
  private timer: NodeJS.Timeout | undefined;
  private readonly delayMs: number;
  private readonly sink: (add: readonly string[], remove: readonly string[]) => void;

  constructor(options: WatchBatcherOptions) {
    this.sink = options.sink;
    this.delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  }

  /** Record one name's final intent and (re)arm the flush. */
  push(name: string, add: boolean): void {
    const n = name.trim();
    if (n === "") {
      return;
    }
    this.pending.set(n, add);
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => { this.flush(); }, this.delayMs);
  }

  /** Emit the coalesced change now. Safe to call with nothing pending. */
  flush(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.pending.size === 0) {
      return;
    }
    const add: string[] = [];
    const remove: string[] = [];
    for (const [name, keep] of this.pending) {
      (keep ? add : remove).push(name);
    }
    this.pending.clear();
    this.sink(add, remove);
  }

  /** Drop pending work without emitting it (panel teardown). */
  dispose(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.pending.clear();
  }

  /** Names waiting to be flushed, for assertions and diagnostics. */
  get size(): number {
    return this.pending.size;
  }
}
