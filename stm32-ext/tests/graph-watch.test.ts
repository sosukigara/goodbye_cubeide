// Regression tests for the three defects that made the graph unusable:
//
//  1. A graph panel opened BEFORE the first build never received `live-types`
//     (setResolution posted them to the sidebar only), so every sample decoded
//     as non-plottable: a blank canvas with a full legend and no error.
//  2. `追加` in the graph panel called addSeries() and nothing else, so the
//     series was never added to the live watchlist and never polled.
//  3. Those per-name changes were forwarded one at a time, so a single
//     struct-prefix click (up to MAX_BULK names) raced 32 read-modify-writes
//     of the stored watchlist and 32 sidecar restarts.
//
// Each test below fails against the pre-fix wiring.
import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  window: {
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showQuickPick: vi.fn(),
    showInputBox: vi.fn(),
    createOutputChannel: vi.fn(),
  },
  workspace: {
    getConfiguration: () => ({
      get: (key: string, dflt: unknown) => dflt,
    }),
    workspaceFolders: [],
  },
  Uri: { file: (p: string) => ({ fsPath: p }) },
  Range: class {},
  Selection: class {},
  Diagnostic: class {},
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2 },
  ProgressLocation: { Notification: 15 },
  QuickPickItemKind: { Separator: -1 },
}));

import { GraphPanelProvider, LivePanelProvider } from "../src/extension.js";
import { WatchBatcher } from "../src/live/watchBatch.js";
import type { OutputChannel } from "vscode";
import type { ElfResolution } from "../src/live/elfResolver.js";

const CHANNEL = { appendLine: (): void => { /* test sink */ } } as unknown as OutputChannel;

// Fully-populated ElfResolution: every required field is real resolver output,
// not a cast. Window covers both symbols (0x200000bc + 6 = 0x200000c2) and
// each offset is address - base, so the fixture is self-consistent.
const RESOLUTION: ElfResolution = {
  elf: "/tmp/fw/Debug/fw.elf",
  base: "0x200000bc",
  size: 6,
  end: "0x200000c2",
  hasDebugInfo: true,
  backend: "pyelftools",
  symbols: [
    { name: "sys.loop_hz", address: "0x200000bc", offset: 0, size: 4, kind: "scalar", signed: true, type: "uint32_t" },
    { name: "drive.motor_timeout", address: "0x200000c0", offset: 4, size: 2, kind: "scalar", signed: false, type: "uint16_t" },
  ],
  unresolved: [],
  tree: { name: "debug", address: "0x200000bc", size: 6, type: "struct", kind: "struct", signed: false, children: [] },
};

function fakeView(posted: unknown[]) {
  return {
    webview: {
      options: {},
      html: "",
      postMessage: (m: unknown): void => { posted.push(m); },
      onDidReceiveMessage: (): { dispose(): void } => ({ dispose: (): void => { /* noop */ } }),
    },
  };
}

const kinds = (posted: readonly unknown[]): string[] =>
  posted.map((m) => (m as { kind: string }).kind);

describe("graph panel: type metadata reaches a panel opened before the build", () => {
  it("delivers live-types once setResolution arrives", () => {
    const live = new LivePanelProvider(CHANNEL);
    const graph = new GraphPanelProvider();
    const sidebarPosted: unknown[] = [];
    const graphPosted: unknown[] = [];

    live.setPostTarget(fakeView(sidebarPosted).webview as never);
    // The user opens the graph panel first: resolution is still undefined, so
    // this seeds nothing. That is the real ordering the bug lived in.
    graph.mount(fakeView(graphPosted).webview as never);
    live.addTypeTarget(fakeView(graphPosted).webview as never);
    expect(kinds(graphPosted)).not.toContain("live-types");

    live.setResolution(RESOLUTION, "STM32F4");

    // The panel must now be able to decode. Without the fix this was 0 and
    // every sample fell through as "型不明" / non-plottable.
    const types = graphPosted.filter((m) => (m as { kind: string }).kind === "live-types");
    expect(types).toHaveLength(1);
    const index = (types[0] as { index: Record<string, { size: number }> }).index;
    expect(Object.keys(index).sort()).toEqual(["drive.motor_timeout", "sys.loop_hz"]);
  });

  it("stops delivering to a panel that was disposed", () => {
    const live = new LivePanelProvider(CHANNEL);
    const posted: unknown[] = [];
    const view = fakeView(posted).webview as never;
    live.setPostTarget(fakeView([]).webview as never);

    live.addTypeTarget(view);
    posted.length = 0;
    live.removeTypeTarget(view);
    live.setResolution(RESOLUTION, "STM32F4");

    expect(kinds(posted)).not.toContain("live-types");
  });
});

describe("graph panel: adding a series registers it with the live session", () => {
  it("routes the panel's var-pick to the host picker, membership and all", () => {
    // The panel's 追加 / Enter post var-pick with the typed query instead of
    // completing in-page, so the graph behaves like the variable-monitor tab.
    const graph = new GraphPanelProvider();
    const queries: string[] = [];
    const changes: [string, boolean][] = [];
    graph.setPickHandler((query) => { queries.push(query); });
    graph.setWatchHandler((name, add) => { changes.push([name, add]); });
    let deliver: ((raw: unknown) => void) | undefined;
    graph.mount({
      options: {},
      html: "",
      postMessage: (): void => { /* noop */ },
      onDidReceiveMessage: (fn: (raw: unknown) => void) => {
        deliver = fn;
        return { dispose: (): void => { /* noop */ } };
      },
    } as never);

    (deliver as unknown as (raw: unknown) => void)({ kind: "var-pick", query: "sys." });

    expect(queries).toEqual(["sys."]);
    // The panel decides nothing by itself: the picker result comes back through
    // addSeries, which is the single place that also registers the watch.
    expect(graph.seriesNames()).toEqual([]);
    expect(changes).toEqual([]);

    graph.addSeries("sys.loop_hz");
    expect(graph.seriesNames()).toEqual(["sys.loop_hz"]);
    expect(changes).toEqual([["sys.loop_hz", true]]);
  });

  it("expands a picked struct group into the leaves a series can plot", () => {
    // A QuickPick row can be a GROUP node (`drive.controller`). The watchlist
    // expands it server-side, so the group name itself never receives a
    // sample: adding it verbatim would plot a permanently empty series.
    const live = new LivePanelProvider(CHANNEL);
    live.setResolution(RESOLUTION, "STM32F4");
    expect(live.leavesUnder("sys.loop_hz")).toEqual(["sys.loop_hz"]);
    expect(live.leavesUnder("sys")).toEqual(["sys.loop_hz"]);
    expect(live.leavesUnder("drive")).toEqual(["drive.motor_timeout"]);
    // An unknown name stays itself: the host resolves nm-only globals.
    expect(live.leavesUnder("  periph.uart_rx ")).toEqual(["periph.uart_rx"]);
    expect(live.leavesUnder("   ")).toEqual([]);
  });

  it("the panel's own 追加 reaches the watch handler", () => {
    const graph = new GraphPanelProvider();
    const changes: [string, boolean][] = [];
    let deliver: ((raw: unknown) => void) | undefined;
    graph.setWatchHandler((name, add) => { changes.push([name, add]); });
    graph.mount({
      options: {},
      html: "",
      postMessage: (): void => { /* noop */ },
      onDidReceiveMessage: (fn: (raw: unknown) => void) => {
        deliver = fn;
        return { dispose: (): void => { /* noop */ } };
      },
    } as never);

    (deliver as unknown as (raw: unknown) => void)({ kind: "graph-add", name: "sys.loop_hz" });

    // The legend grew AND the session was told to poll it. The legend-only
    // behaviour is what drew an empty canvas with no error.
    expect(graph.seriesNames()).toEqual(["sys.loop_hz"]);
    expect(changes).toEqual([["sys.loop_hz", true]]);
  });

  it("削除 stops polling it again", () => {
    const graph = new GraphPanelProvider();
    const changes: [string, boolean][] = [];
    let deliver: ((raw: unknown) => void) | undefined;
    graph.setWatchHandler((name, add) => { changes.push([name, add]); });
    graph.mount({
      options: {},
      html: "",
      postMessage: (): void => { /* noop */ },
      onDidReceiveMessage: (fn: (raw: unknown) => void) => {
        deliver = fn;
        return { dispose: (): void => { /* noop */ } };
      },
    } as never);

    const send = deliver as unknown as (raw: unknown) => void;
    send({ kind: "graph-add", name: "sys.loop_hz" });
    send({ kind: "graph-remove", name: "sys.loop_hz" });

    expect(changes).toEqual([["sys.loop_hz", true], ["sys.loop_hz", false]]);
  });

  it("re-adding an already plotted series does not touch the watchlist again", () => {
    const graph = new GraphPanelProvider();
    const changes: [string, boolean][] = [];
    let deliver: ((raw: unknown) => void) | undefined;
    graph.setWatchHandler((name, add) => { changes.push([name, add]); });
    graph.mount({
      options: {},
      html: "",
      postMessage: (): void => { /* noop */ },
      onDidReceiveMessage: (fn: (raw: unknown) => void) => {
        deliver = fn;
        return { dispose: (): void => { /* noop */ } };
      },
    } as never);

    const send = deliver as unknown as (raw: unknown) => void;
    send({ kind: "graph-add", name: "sys.loop_hz" });
    send({ kind: "graph-add", name: "sys.loop_hz" });

    // A duplicate would otherwise restart the sidecar for nothing.
    expect(changes).toHaveLength(1);
  });
});

describe("watchlist changes are coalesced, not forwarded one at a time", () => {
  it("collapses a burst into a single flush", () => {
    vi.useFakeTimers();
    try {
      const flushes: [string[], string[]][] = [];
      const batcher = new WatchBatcher({
        delayMs: 50,
        sink: (add, remove) => { flushes.push([[...add], [...remove]]); },
      });

      // One struct-prefix click: the panel expands it to 32 leaf messages.
      for (let i = 0; i < 32; i += 1) {
        batcher.push(`periph.leaf${i}`, true);
      }
      expect(flushes).toHaveLength(0);
      vi.advanceTimersByTime(50);

      // One call, all 32 names. Forwarding each on its own raced 32
      // read-modify-writes of the stored watchlist, so 31 were lost.
      expect(flushes).toHaveLength(1);
      expect(flushes[0]?.[0]).toHaveLength(32);
      expect(flushes[0]?.[1]).toEqual([]);
      expect(batcher.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps only the final intent when a name is added and removed in one burst", () => {
    vi.useFakeTimers();
    try {
      const flushes: [string[], string[]][] = [];
      const batcher = new WatchBatcher({
        delayMs: 50,
        sink: (add, remove) => { flushes.push([[...add], [...remove]]); },
      });

      batcher.push("sys.loop_hz", true);
      batcher.push("sys.loop_hz", false);
      batcher.push("drive.mode", true);
      vi.advanceTimersByTime(50);

      expect(flushes).toEqual([[["drive.mode"], ["sys.loop_hz"]]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes nothing when the burst was empty", () => {
    vi.useFakeTimers();
    try {
      const flushes: unknown[] = [];
      const batcher = new WatchBatcher({ delayMs: 50, sink: () => { flushes.push(1); } });
      batcher.flush();
      vi.advanceTimersByTime(50);
      expect(flushes).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores blank names", () => {
    vi.useFakeTimers();
    try {
      const flushes: [string[], string[]][] = [];
      const batcher = new WatchBatcher({
        delayMs: 50,
        sink: (add, remove) => { flushes.push([[...add], [...remove]]); },
      });
      batcher.push("   ", true);
      vi.advanceTimersByTime(50);
      expect(flushes).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * Host-level watchlist mutation. The webview tests pin the message SHAPE, so
 * a broken removeNames still leaves them all green — these assert the stored
 * watchlist actually changes and that a no-op does not restart the sidecar.
 */
function liveWithStore(initial: string[]): {
  live: LivePanelProvider;
  store: Map<string, unknown>;
} {
  const live = new LivePanelProvider(CHANNEL);
  const store = new Map<string, unknown>([["stm32ext.liveWatch", initial]]);
  live.configure("/tmp/scripts", {
    get: (k: string): unknown => store.get(k),
    update: (k: string, v: unknown): Promise<void> => {
      store.set(k, v);
      return Promise.resolve();
    },
  } as never);
  return { live, store };
}

const watched = (store: Map<string, unknown>): string[] =>
  store.get("stm32ext.liveWatch") as string[];

const call = (live: LivePanelProvider, fn: "addNames" | "removeNames", raw: string): Promise<void> =>
  (live as unknown as Record<string, (r: string) => Promise<void>>)[fn]!(raw);

describe("host watchlist mutation (the 削除 path, end to end)", () => {
  it("removeNames actually shrinks the stored watchlist", async () => {
    const { live, store } = liveWithStore(["a.b", "drive.motor_timeout"]);
    await call(live, "removeNames", "drive.motor_timeout");
    expect(watched(store)).toEqual(["a.b"]);
  });

  it("removeNames takes the whole subtree of a struct prefix", async () => {
    const { live, store } = liveWithStore(["drive.a", "drive.b", "sys.loop_hz"]);
    await call(live, "removeNames", "drive");
    expect(watched(store)).toEqual(["sys.loop_hz"]);
  });

  it("addNames grows the stored watchlist", async () => {
    const { live, store } = liveWithStore(["sys.loop_hz"]);
    await call(live, "addNames", "drive.mode, backup.armed");
    expect(watched(store)).toEqual(["sys.loop_hz", "drive.mode", "backup.armed"]);
  });

  it("re-adding a watched name changes nothing and does not restart", async () => {
    // The session log showed `+backup.armed (104 -> 104)` followed by SIGKILL
    // and a fresh spawn: a no-op add tore down a running session.
    const { live, store } = liveWithStore(["backup.armed", "sys.loop_hz"]);
    const restart = vi.spyOn(live as unknown as { restart: () => Promise<void> }, "restart")
      .mockResolvedValue(undefined);

    await call(live, "addNames", "backup.armed");

    expect(watched(store)).toEqual(["backup.armed", "sys.loop_hz"]);
    expect(restart).not.toHaveBeenCalled();
  });
});
