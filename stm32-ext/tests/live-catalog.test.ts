// Live catalog (host side): the python resolver gains --catalog (another
// agent's work) which adds a `roots` array to the existing JSON. The host
// requests it, keeps it, and hands it to the sidebar as a NEW live-catalog
// message, leaving live-types and the sidecar payload exactly as they are.
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

vi.mock("vscode", () => ({
  window: {
    showWarningMessage: vi.fn(async () => undefined),
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showQuickPick: vi.fn(),
    showInputBox: vi.fn(),
    showSaveDialog: vi.fn(),
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

import { LivePanelProvider, parseCatalogRoots } from "../src/extension.js";
import type { ElfResolution } from "../src/live/elfResolver.js";
import {
  buildResolutionJson,
  filterWatchedSymbols,
  resolveWatchlist,
} from "../src/live/manager.js";
import { findSymbol } from "../src/live/elfResolver.js";

const here = dirname(fileURLToPath(import.meta.url));
const extensionSource = readFileSync(join(here, "../src/extension.ts"), "utf8");

const CHANNEL = { appendLine: (): void => { /* test sink */ } } as unknown as
  import("vscode").OutputChannel;

interface FakeWebview {
  postMessage: (msg: unknown) => void;
  onDidReceiveMessage: () => { dispose(): void };
}

function fakeView(posted: unknown[]): FakeWebview {
  return {
    postMessage: (msg: unknown): void => {
      posted.push(msg);
    },
    onDidReceiveMessage: (): { dispose(): void } => ({ dispose: (): void => { /* noop */ } }),
  };
}

const ROOTS_JSON = JSON.stringify({
  elf: "build-ext/fw.elf",
  base: "0x20000000",
  size: 64,
  end: "0x20000040",
  has_debug_info: true,
  backend: "pyelftools",
  symbols: [
    { name: "tuner.kp", address: "0x20000000", offset: 0, size: 4, type: "float", kind: "float", signed: true },
    { name: "debug", address: "0x20000010", offset: 16, size: 16, type: "DebugGlobal", kind: "struct", signed: false },
  ],
  unresolved: [],
  roots: [
    {
      name: "tuner", path: "tuner", address: "0x20000000", size: 4, type: "Tuner",
      kind: "struct", display: "Tuner tuner",
      children: [
        {
          name: "kp", path: "tuner.kp", address: "0x20000000", size: 4,
          type: "float", kind: "float", display: "float Tuner::kp",
        },
      ],
    },
    {
      name: "debug", path: "debug", address: "0x20000010", size: 16,
      type: "DebugGlobal", kind: "struct", display: "DebugGlobal",
    },
  ],
});

// Resolution whose symbols already carry the flat catalog entries (the
// resolver extends symbols/index for every catalog path, root and member).
function catalogResolution(): ElfResolution {
  return {
    elf: "build-ext/fw.elf",
    base: "0x20000000",
    size: 64,
    end: "0x20000040",
    hasDebugInfo: true,
    backend: "pyelftools",
    symbols: [
      { name: "tuner.kp", address: "0x20000000", offset: 0, size: 4, type: "float", kind: "float", signed: true },
      { name: "debug", address: "0x20000010", offset: 16, size: 16, type: "DebugGlobal", kind: "struct", signed: false },
    ],
    unresolved: [],
  } as ElfResolution;
}

const kinds = (posted: readonly unknown[]): string[] =>
  posted.map((m) => String((m as { kind?: string }).kind));

describe("the host asks the python resolver for the catalog", () => {
  it("passes --catalog alongside --all-members to elf_resolve.py", () => {
    expect(extensionSource).toMatch(/\["--all-members",\s*"--catalog"\]/);
  });
});

describe("parseCatalogRoots", () => {
  it("keeps the roots array with node shape plus display", () => {
    const roots = parseCatalogRoots(ROOTS_JSON);
    expect(roots).toHaveLength(2);
    expect(roots?.[0]?.path).toBe("tuner");
    expect(roots?.[0]?.display).toBe("Tuner tuner");
    expect(roots?.[0]?.children?.[0]?.path).toBe("tuner.kp");
    expect(roots?.[0]?.children?.[0]?.display).toBe("float Tuner::kp");
    expect(roots?.[1]?.path).toBe("debug");
  });

  it("is undefined when the resolver ran without --catalog (additive flag)", () => {
    expect(parseCatalogRoots(JSON.stringify({ base: "0x1", size: 1 }))).toBeUndefined();
  });

  it("never throws on garbage (restore path is best-effort)", () => {
    expect(parseCatalogRoots("not json")).toBeUndefined();
  });
});

describe("setResolution posts the catalog without touching live-types", () => {
  it("posts live-catalog with the roots it was given", () => {
    const live = new LivePanelProvider(CHANNEL);
    const posted: unknown[] = [];
    live.setPostTarget(fakeView(posted) as never);
    const roots = parseCatalogRoots(ROOTS_JSON);
    live.setResolution(catalogResolution(), "STM32G4", roots);
    const catalog = posted.filter((m) => (m as { kind?: string }).kind === "live-catalog");
    expect(catalog).toHaveLength(1);
    expect(catalog[0]).toEqual({ kind: "live-catalog", roots });
  });

  it("keeps the live-types message shape exactly as before", () => {
    const live = new LivePanelProvider(CHANNEL);
    const posted: unknown[] = [];
    live.setPostTarget(fakeView(posted) as never);
    const roots = parseCatalogRoots(ROOTS_JSON);
    live.setResolution(catalogResolution(), "STM32G4", roots);
    const types = posted.filter((m) => (m as { kind?: string }).kind === "live-types");
    expect(types).toHaveLength(1);
    expect(types[0]).toEqual({
      kind: "live-types",
      tree: undefined,
      index: {
        "tuner.kp": { size: 4, kind: "float", signed: true, type: "float" },
        debug: { size: 16, kind: "struct", signed: false, type: "DebugGlobal" },
      },
    });
  });

  it("posts no live-catalog when the resolution carries none (honest fallback)", () => {
    const live = new LivePanelProvider(CHANNEL);
    const posted: unknown[] = [];
    live.setPostTarget(fakeView(posted) as never);
    live.setResolution(catalogResolution(), "STM32G4");
    expect(kinds(posted)).not.toContain("live-catalog");
    expect(kinds(posted)).toContain("live-types");
  });
});

describe("replayTo brings the catalog back after a reload", () => {
  it("replays live-catalog inside the resolution guard", () => {
    const live = new LivePanelProvider(CHANNEL);
    const posted: unknown[] = [];
    live.setPostTarget(fakeView(posted) as never);
    const roots = parseCatalogRoots(ROOTS_JSON);
    live.setResolution(catalogResolution(), "STM32G4", roots);
    posted.length = 0;
    live.replayTo(fakeView(posted) as never);
    const at = kinds(posted);
    expect(at).toContain("live-types");
    expect(at).toContain("live-catalog");
    expect(at.indexOf("live-catalog")).toBeGreaterThan(-1);
  });

  it("replays nothing catalog-shaped without a resolution", () => {
    const live = new LivePanelProvider(CHANNEL);
    const posted: unknown[] = [];
    live.replayTo(fakeView(posted) as never);
    expect(kinds(posted)).not.toContain("live-catalog");
    expect(kinds(posted)).not.toContain("live-types");
  });

  it("replays no live-catalog when the stored resolution has no roots", () => {
    const live = new LivePanelProvider(CHANNEL);
    live.setPostTarget(fakeView([]) as never);
    live.setResolution(catalogResolution(), "STM32G4");
    const posted: unknown[] = [];
    live.replayTo(fakeView(posted) as never);
    expect(kinds(posted)).toContain("live-types");
    expect(kinds(posted)).not.toContain("live-catalog");
  });
});

describe("a catalog path resolves through the existing watch and write pipeline", () => {
  it("filterWatchedSymbols matches a catalog member exactly", () => {
    const out = filterWatchedSymbols(catalogResolution(), ["tuner.kp"]);
    expect(out.symbols.map((s) => s.name)).toEqual(["tuner.kp"]);
    expect(out.unmatched).toEqual([]);
  });

  it("findSymbol places a catalog root for the write path", () => {
    expect(findSymbol(catalogResolution(), "debug")?.address).toBe("0x20000010");
    expect(findSymbol(catalogResolution(), "tuner.kp")?.size).toBe(4);
  });

  it("resolveWatchlist needs no extra for a catalog path (already resolved)", () => {
    const out = resolveWatchlist(["tuner.kp"], catalogResolution(), () => undefined);
    expect(out.extras).toEqual([]);
    expect(out.unresolved).toEqual([]);
  });

  it("an unknown catalog-shaped path is reported, never dropped silently", () => {
    const out = filterWatchedSymbols(catalogResolution(), ["tuner.missing"]);
    expect(out.symbols).toEqual([]);
    expect(out.unmatched).toEqual(["tuner.missing"]);
    // startSession merges filter.unmatched into live-unresolved (source pin).
    expect(extensionSource).toMatch(/\[\.\.\.unresolved, \.\.\.filter\.unmatched\]/);
  });
});

describe("the sidecar still receives only the watched subset", () => {
  it("buildResolutionJson is handed the filter output, not the whole resolution", () => {
    expect(extensionSource).toMatch(/buildResolutionJson\(res, filter\.symbols\)/);
    const res = catalogResolution();
    const watched = filterWatchedSymbols(res, ["tuner.kp"]).symbols;
    const json = JSON.parse(buildResolutionJson(res, watched)) as { symbols: { name: string }[] };
    expect(json.symbols.map((s) => s.name)).toEqual(["tuner.kp"]);
  });
});
