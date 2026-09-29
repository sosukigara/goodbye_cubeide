// A 監視開始 press with nothing pollable logged the same two lines on every
// press, so the log filled with an identical pair and buried everything after
// it. These pin the idempotence: identical attempts report once, a changed
// watchlist reports again, and a start that does proceed clears the memory.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    getConfiguration: () => ({ get: (key: string, dflt: unknown) => dflt }),
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

// Without this the test depends on whatever holds the ST-LINK on the machine.
vi.mock("../src/probe/conflict", () => ({
  CUBEIDE_RUNNING_MESSAGE: "CubeIDE is running",
  detectConflicts: () => [],
  findOwnPollPids: () => [],
  listProcesses: () => "",
}));

import { LivePanelProvider } from "../src/extension.js";
import type { ElfResolution } from "../src/live/elfResolver.js";
import * as vscode from "vscode";
import type { OutputChannel } from "vscode";

const RESOLUTION = {
  elf: join(mkdtempSync(join(tmpdir(), "stm32ext-nosession-")), "fw.elf"),
  base: "0x08000000",
  symbols: [
    { name: "sys.loop_hz", address: "0x200000bc", size: 4, kind: "scalar", signed: true, type: "uint32_t" },
  ],
} as unknown as ElfResolution;

function liveWith(watch: string[]): {
  live: LivePanelProvider;
  channel: { lines: string[]; appendLine(l: string): void };
  store: Map<string, unknown>;
} {
  const channel = {
    lines: [] as string[],
    appendLine(l: string): void {
      channel.lines.push(l);
    },
  };
  const live = new LivePanelProvider(channel as unknown as OutputChannel);
  const store = new Map<string, unknown>([["stm32ext.liveWatch", watch]]);
  live.configure(join(tmpdir(), "stm32ext-scripts"), {
    get: (k: string): unknown => store.get(k),
    update: (k: string, v: unknown): Promise<void> => {
      store.set(k, v);
      return Promise.resolve();
    },
  } as never);
  live.setResolution(RESOLUTION, "STM32F4");
  return { live, channel, store };
}

const start = (live: LivePanelProvider): Promise<void> =>
  (live as unknown as Record<string, () => Promise<void>>)["startSession"]!();

const pairs = (lines: string[]): string[] =>
  lines.filter((l) => l.includes("watch leaves:") || l.includes("session not started"));

describe("nothing-pollable start attempts are reported once", () => {
  it("logs the pair once for repeated identical attempts", async () => {
    const { live, channel } = liveWith([]);
    await start(live);
    await start(live);
    await start(live);
    expect(pairs(channel.lines)).toHaveLength(2);
    expect(pairs(channel.lines)[0]).toContain("watch leaves: 0 (of 0 watched names)");
    expect(pairs(channel.lines)[1]).toContain("session not started: nothing watched");
  });

  it("logs again once the watchlist changes", async () => {
    const { live, channel, store } = liveWith([]);
    await start(live);
    store.set("stm32ext.liveWatch", ["not.in.the.elf"]);
    await start(live);
    expect(pairs(channel.lines).filter((l) => l.includes("watch leaves:"))).toHaveLength(2);
  });
});

// The CSV button posts "export-csv", but handleLiveAction only knew "csv", so
// the action fell through to writeFlow("","") and every press tried to write an
// empty address instead of exporting.
describe("live-export-csv reaches exportCsv", () => {
  it("exports instead of falling through to a write", async () => {
    const { live, channel } = liveWith([]);
    vi.mocked(vscode.window.showErrorMessage).mockClear();
    await live.handleLiveAction("export-csv");
    // Asserted on the message, not just on the call: "an error was shown" is
    // also what the old fallthrough produced (writeFlow refuses an empty name),
    // so only the text tells the two paths apart.
    const shown = String(vi.mocked(vscode.window.showErrorMessage).mock.calls[0]?.[0] ?? "");
    expect(shown).toContain("CSV");
    expect(channel.lines.filter((l) => l.includes("[live-write]"))).toHaveLength(0);
  });
});
