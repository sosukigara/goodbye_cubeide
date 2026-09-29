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
      get: (key: string, dflt: unknown) => {
        const defaults: Record<string, unknown> = {
          cliPath: "STM32_Programmer_CLI",
          probe: "ST-LINK",
          interface: "SWD",
          resetMode: "connect-under-reset",
          pollHz: 50,
        };
        return defaults[key] ?? dflt;
      },
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
import type { ElfResolution } from "../src/live/elfResolver.js";
import { readNewSamples } from "../src/live/manager.js";

interface FakeWebview {
  options: Record<string, unknown>;
  html: string;
  postMessage: (msg: unknown) => void;
}

function fakeView(posted: unknown[]): {
  webview: FakeWebview & { onDidReceiveMessage: () => { dispose(): void } };
} {
  return {
    webview: {
      options: {},
      html: "",
      postMessage: (msg: unknown): void => {
        posted.push(msg);
      },
      onDidReceiveMessage: () => ({ dispose(): void { /* noop */ } }),
    },
  };
}

const CHANNEL = { appendLine: (): void => { /* test sink */ } } as unknown as
  import("vscode").OutputChannel;

const MOCK_CSV =
  "timestamp,address,name,value\n" +
  "2026-09-18T00:00:00.000Z,0x200000bc,sys.loop_hz,1000\n" +
  "2026-09-18T00:00:00.100Z,0x200000ec,sys.uptime_ms,100\n";

/** Mirror of the single activate() wiring: one sink, Live tail -> Graph. */
function wireLiveToGraph(
  live: LivePanelProvider,
  graph: GraphPanelProvider,
): void {
  live.setSampleSink((samples) => { graph.pushSamples(samples); });
}

describe("live -> graph sample forwarding (todo2)", () => {
  it("forwards every Live table batch to the Graph panel exactly once", () => {
    const live = new LivePanelProvider(CHANNEL);
    const graph = new GraphPanelProvider();
    const livePosted: unknown[] = [];
    const graphPosted: unknown[] = [];
    // The product's wiring: the sidebar is the live panel's post target, and
    // the graph panel receives the batch through the sample sink only. It used
    // to be registered as a post target as well, which delivered every batch
    // twice and made this assertion certify a topology the product never had.
    live.setPostTarget(fakeView(livePosted).webview as never);
    graph.mount(fakeView(graphPosted).webview as never);
    wireLiveToGraph(live, graph);

    // Mock CSV ingest through the same tail path the poller uses.
    const { samples } = readNewSamples(MOCK_CSV, 0);
    expect(samples).toHaveLength(2);
    live.pushSamples(samples);

    const liveSamples = livePosted.filter(
      (m) => (m as { kind?: string }).kind === "live-sample",
    );
    const graphSamples = graphPosted.filter(
      (m) => (m as { kind?: string }).kind === "live-sample",
    );
    expect(liveSamples).toHaveLength(1);
    // Exactly-once delivery to the Graph panel.
    expect(graphSamples).toHaveLength(1);
    expect((graphSamples[0] as { samples?: unknown }).samples).toBe(samples);
    // Graph series grows: both ingested variable names are present.
    const names = (samples as { name: string }[]).map((s) => s.name).sort();
    expect(names).toEqual(["sys.loop_hz", "sys.uptime_ms"]);
  });

  it("re-setting the sink overwrites (no duplicate subscriptions)", () => {
    const live = new LivePanelProvider(CHANNEL);
    const graph = new GraphPanelProvider();
    const graphPosted: unknown[] = [];
    graph.mount(fakeView(graphPosted).webview as never);
    wireLiveToGraph(live, graph);
    // A second registration must NOT create a second delivery path.
    wireLiveToGraph(live, graph);

    const { samples } = readNewSamples(MOCK_CSV, 0);
    live.pushSamples(samples);
    const graphSamples = graphPosted.filter(
      (m) => (m as { kind?: string }).kind === "live-sample",
    );
    expect(graphSamples).toHaveLength(1);
  });
});

describe("graph archive replay ordering", () => {
  const kinds = (posted: unknown[]): string[] =>
    posted.map((m) => String((m as { kind?: string }).kind));

  // The archive only holds the series the graph plots (pushSamples filters on
  // `selected`), so a replay test has to select them first. addSeries is what
  // the panel's 追加 button reaches through handleMessage("graph-add").
  const select = (graph: GraphPanelProvider, name: string): void => {
    (graph as unknown as Record<string, (n: string) => void>)["addSeries"]!(name);
  };

  // sendTypesTo sends live-types only when a resolution is set, which is what
  // makes the ordering observable at all: with no types the replay would be
  // dropped by the panel for a second, unrelated reason.
  const RESOLUTION = {
    elf: "/tmp/fw/Debug/fw.elf",
    base: "0x08000000",
    tree: [],
    symbols: [
      { name: "sys.loop_hz", address: "0x200000bc", size: 4, kind: "scalar", signed: true, type: "uint32_t" },
      { name: "sys.uptime_ms", address: "0x200000ec", size: 4, kind: "scalar", signed: true, type: "uint32_t" },
    ],
  } as unknown as ElfResolution;

  it("replays only after openGraphPanel has registered the type target", () => {
    const live = new LivePanelProvider(CHANNEL);
    const graph = new GraphPanelProvider();
    const graphPosted: unknown[] = [];
    live.setResolution(RESOLUTION, "STM32F4");
    wireLiveToGraph(live, graph);
    select(graph, "sys.loop_hz");
    select(graph, "sys.uptime_ms");
    // Fill the archive while nothing is mounted, so the only possible source of
    // a live-sample message below is the replay itself.
    const { samples } = readNewSamples(MOCK_CSV, 0);
    live.pushSamples(samples);

    // The product's openGraphPanel sequence, one step at a time.
    const view = fakeView(graphPosted).webview as never;
    graph.mount(view);
    expect(kinds(graphPosted).filter((k) => k === "live-sample")).toHaveLength(0);
    live.addTypeTarget(view);
    graph.replayArchive();

    const seen = kinds(graphPosted);
    expect(seen.filter((k) => k === "live-sample")).toHaveLength(1);
    // The order is the fix. mount() used to post the archive tail itself, so
    // the batch arrived before live-types, decoded as 型不明 and was dropped by
    // the panel's ingest(): a full legend over a permanently blank canvas, with
    // no error anywhere. Asserting the messages are both present is not enough
    // — it is the sequence that decides whether the points are plottable.
    expect(seen.indexOf("live-types")).toBeGreaterThanOrEqual(0);
    expect(seen.indexOf("live-types")).toBeLessThan(seen.indexOf("live-sample"));
  });

  it("replayArchive is a no-op with an empty archive", () => {
    const graph = new GraphPanelProvider();
    const graphPosted: unknown[] = [];
    const view = fakeView(graphPosted).webview as never;
    graph.mount(view);
    graph.replayArchive();
    expect(kinds(graphPosted).filter((k) => k === "live-sample")).toHaveLength(0);
  });
});
