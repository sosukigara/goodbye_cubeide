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

const CHANNEL = { appendLine: (): void => { /* test sink */ } } as unknown as OutputChannel;

const RESOLUTION = {
  elf: "/tmp/fw/Debug/fw.elf",
  base: "0x08000000",
  symbols: [
    { name: "sys.loop_hz", address: "0x200000bc", size: 4, kind: "scalar", signed: true, type: "uint32_t" },
    { name: "drive.motor_timeout", address: "0x200000c0", size: 2, kind: "scalar", signed: false, type: "uint16_t" },
  ],
  tree: { name: "debug", path: "", kind: "struct", children: [] },
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
