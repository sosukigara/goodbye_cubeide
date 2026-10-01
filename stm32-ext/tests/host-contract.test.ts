// S3 host contract: the fixes that could only be observed by unit-testing the
// host side, not by looking at the (unregistered) dead renderers.
//
// Covered here:
//  - P0-1  the watchlist filter is the only thing between 355 resolved leaves
//          and the sidecar, so it gets a real 355-leaf fixture
//  - P0-15 kind / signed / tree survive elf_resolve.py -> host -> sidecar file
//  - P0-3  no product path re-assigns webview.html after the one initial call
//  - P0-11 a rotated CSV re-consumes its header instead of parsing it as data
//  - P0-12 a clean sidecar exit does not end a session the user did not stop
//  - P0-4  leaf width reaches the write request; values decode by type
//  - D-3   buildResolutionJson takes the watched set, not the whole resolution
//  - D-4   assertCsvHeader / dropStats are live product code
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

import {
  buildResolutionJson,
  filterWatchedSymbols,
  usbErrorSummary,
} from "../src/live/manager.js";
import { parseElfResolutionJson, type ElfResolution, type ResolvedSymbol } from "../src/live/elfResolver.js";
import { assertCsvHeader, decodeValue, dropStats, formatDropSummary } from "../src/live/poller.js";
import {
  DEFAULT_EXTRA_SIZE,
  extraArgs,
  exitCodeReason,
  resolveWatchlist,
} from "../src/live/manager.js";

describe("the sidecar argv carries a width for every watch", () => {
  it("--extra is name=addr:SIZE; a size-less extra is silently not polled", () => {
    expect(extraArgs([{ name: "tuner_params", address: "0x20000008", size: 4 }]))
      .toEqual(["--extra=tuner_params=0x20000008:4"]);
  });

  it("a user-picked global gets the firmware-global default width", () => {
    const res = bigResolution();
    const out = resolveWatchlist(["periph.m1", "tuner_params"], res,
      (n) => (n === "tuner_params" ? "0x20000008" : undefined));
    expect(out.extras).toEqual([{ name: "tuner_params", address: "0x20000008", size: DEFAULT_EXTRA_SIZE }]);
  });

  it("the sidecar's new exit codes are explained, not swallowed", () => {
    expect(exitCodeReason(6)).toContain("監視できる変数がありません");
    expect(exitCodeReason(5)).toContain("ST-LINK");
    expect(exitCodeReason(3)).toContain("ST-LINK");
    expect(exitCodeReason(4)).toContain("データ落ち");
    expect(exitCodeReason(0)).toBeUndefined();
    expect(extensionSource).toContain("exitCodeReason(code)");
  });
});

const here = dirname(fileURLToPath(import.meta.url));
const extensionSource = readFileSync(join(here, "../src/extension.ts"), "utf8");

/**
 * The reference firmware's DebugGlobal: 355 leaves with one dominant
 * `periph` subtree (300 of them) and the real 1/2/4/8-byte mix, i.e. the
 * exact shape that flooded the sidecar at 100Hz.
 */
function bigResolution(): ElfResolution {
  const widths = [4, 4, 1, 2, 8, 4, 1] as const;
  const kinds = ["scalar", "scalar", "bool", "scalar", "scalar", "float", "enum"] as const;
  const symbols: ResolvedSymbol[] = [];
  const add = (name: string, i: number): void => {
    const k = kinds[i % kinds.length] as ResolvedSymbol["kind"];
    symbols.push({
      name,
      address: `0x${(0x200000b4 + i * 4).toString(16)}`,
      offset: i * 4,
      size: widths[i % widths.length] as number,
      type: k === "bool" ? "bool" : k === "float" ? "float" : k === "enum" ? "mode_t" : "uint32_t",
      kind: k,
      signed: false,
      ...(k === "enum" ? { enumerators: [{ name: "MODE_IDLE", value: 0 }] } : {}),
    });
  };
  for (let i = 0; i < 300; i++) {
    add(`periph.m${i}`, i);
  }
  for (let i = 0; i < 55; i++) {
    add(`drive.m${i}`, i);
  }
  return {
    elf: "build-ext/unit_omni3.elf",
    base: "0x200000b4",
    size: 976,
    end: "0x20000484",
    hasDebugInfo: true,
    backend: "pyelftools",
    symbols,
    unresolved: [],
  };
}

describe("D11: the watchlist filter is what the sidecar is given", () => {
  it("keeps 355 resolved leaves down to only the watched ones", () => {
    const res = bigResolution();
    expect(res.symbols).toHaveLength(355);
    const out = filterWatchedSymbols(res, ["periph.m7", "drive.m3", "periph.m0"]);
    expect(out.symbols.map((s) => s.name)).toEqual(["periph.m7", "drive.m3", "periph.m0"]);
    expect(out.unmatched).toEqual([]);
  });

  it("writes only the watched leaves into the sidecar's resolution file", () => {
    const res = bigResolution();
    const watched = filterWatchedSymbols(res, ["periph.m1", "drive.m4"]).symbols;
    const json = JSON.parse(buildResolutionJson(res, watched)) as { symbols: { name: string }[] };
    expect(json.symbols.map((s) => s.name)).toEqual(["periph.m1", "drive.m4"]);
  });

  it("expands a watched struct node to ALL of its leaves, with no cap", () => {
    // There used to be a 64-leaf ceiling here, and the overflow was reported
    // as `監視上限 ... 個は未追加` in a log channel. Anything past it was never
    // polled, so a plotted series sat in the legend over a blank canvas: the
    // graph and the watchlist disagreed and only a log line said so.
    const res = bigResolution();
    const periph = res.symbols.filter((s) => s.name.startsWith("periph."));
    expect(periph.length).toBeGreaterThan(64);
    const out = filterWatchedSymbols(res, ["periph"]);
    expect(out.symbols).toHaveLength(periph.length);
    expect(out.symbols.map((s) => s.name)).toEqual(periph.map((s) => s.name));
    // The interface no longer has an overflow field at all.
    expect("overflow" in out).toBe(false);
  });

  it("reports watched names that match nothing (typo / renamed member)", () => {
    const res = bigResolution();
    const out = filterWatchedSymbols(res, ["periph.m3", "nope.gone", "periph.m3"]);
    expect(out.symbols.map((s) => s.name)).toEqual(["periph.m3"]);
    expect(out.unmatched).toEqual(["nope.gone"]);
  });
});

describe("P0-15 + D3: the type tree survives the host", () => {
  const resolverJson = JSON.stringify({
    elf: "build-ext/unit_omni3.elf",
    base: "0x200000b4",
    size: 976,
    end: "0x20000484",
    has_debug_info: true,
    backend: "pyelftools",
    symbols: [
      { name: "sys.loop_hz", address: "0x200000b4", offset: 0, size: 4, type: "uint32_t", kind: "scalar", signed: false },
      { name: "drive.up", address: "0x20000100", offset: 76, size: 1, type: "bool", kind: "bool", signed: false },
      { name: "drive.mode", address: "0x20000104", offset: 80, size: 4, type: "int", kind: "enum", signed: true,
        enumerators: [{ name: "MODE_FOLLOW", value: 2 }] },
      { name: "nav.yaw_f", address: "0x20000108", offset: 84, size: 4, type: "float", kind: "float", signed: true },
      { name: "sys.stamp_ns", address: "0x2000010c", offset: 88, size: 8, type: "uint64_t", kind: "scalar", signed: false },
    ],
    unresolved: [],
    tree: {
      name: "debug", address: "0x200000b4", size: 976, type: "DebugGlobal", kind: "struct",
      children: [
        {
          name: "drive", address: "0x20000100", size: 8, type: "Drive", kind: "struct",
          children: [
            { name: "drive.up", address: "0x20000100", size: 1, type: "bool", kind: "bool", signed: false, children: [] },
            { name: "drive.mode", address: "0x20000104", size: 4, type: "int", kind: "enum", signed: true, children: [],
              enumerators: [{ name: "MODE_FOLLOW", value: 2 }] },
          ],
        },
      ],
    },
  });

  it("parseElfResolutionJson keeps kind, signed, enumerators and the tree", () => {
    const res = parseElfResolutionJson(resolverJson);
    expect(res.symbols.map((s) => s.kind)).toEqual(["scalar", "bool", "enum", "float", "scalar"]);
    expect(res.symbols[1]?.signed).toBe(false);
    expect(res.symbols[2]?.signed).toBe(true);
    expect(res.symbols[2]?.enumerators).toEqual([{ name: "MODE_FOLLOW", value: 2 }]);
    expect(res.tree?.kind).toBe("struct");
    expect(res.tree?.children[0]?.name).toBe("drive");
    expect(res.tree?.children[0]?.children).toHaveLength(2);
  });

  it("the resolution file handed to the sidecar carries kind, signed and tree", () => {
    const res = parseElfResolutionJson(resolverJson);
    const json = JSON.parse(buildResolutionJson(res, res.symbols)) as {
      base: string;
      size: number;
      symbols: { name: string; kind: string; signed: boolean; size: number; enumerators?: unknown[] }[];
      tree?: { kind: string; children: unknown[] };
    };
    expect(json.base).toBe("0x200000b4");
    expect(json.size).toBe(976);
    expect(json.symbols[0]?.kind).toBe("scalar");
    expect(json.symbols[1]?.kind).toBe("bool");
    expect(json.symbols[1]?.size).toBe(1);
    expect(json.symbols[2]?.signed).toBe(true);
    expect(json.symbols[2]?.enumerators).toEqual([{ name: "MODE_FOLLOW", value: 2 }]);
    expect(json.tree?.kind).toBe("struct");
    expect(json.tree?.children).toHaveLength(1);
  });

  it("elf_resolve.py can be told to resolve every member (--all-members)", () => {
    // The resolution is useless for struct selection without the whole tree,
    // and the runner has to forward the flag instead of hardcoding argv.
    expect(extensionSource).toMatch(/\[\s*"--all-members"[^\]]*\]/);
    expect(extensionSource).toMatch(/extra: readonly string\[\]/);
  });

  it("falls back to the C type when an older resolver omits kind/signed", () => {
    const res = parseElfResolutionJson(JSON.stringify({
      base: "0x200000b4", size: 4, end: "0x200000b8",
      symbols: [
        { name: "a", address: "0x200000b4", offset: 0, size: 1, type: "bool" },
        { name: "b", address: "0x200000b5", offset: 1, size: 4, type: "int32_t" },
        { name: "c", address: "0x200000b9", offset: 5, size: 4, type: "uint32_t" },
      ],
    }));
    expect(res.symbols.map((s) => [s.kind, s.signed])).toEqual([
      ["bool", false], ["scalar", true], ["scalar", false],
    ]);
  });
});

describe("P0-3: the webview is written once and then only messaged", () => {
  it("every webview.html assignment is a one-time mount, never a refresh", () => {
    // Two webviews exist: the sidebar (registered view) and the editor-area
    // graph panel (created on demand). Each is written exactly once, at the
    // point it is created. Nothing re-writes a document that is already live.
    const sites = [...extensionSource.matchAll(/webview\.html\s*=\s*([^\n;]+);/g)]
      .map((m) => ({ at: m.index ?? 0, line: m[1] ?? "" }));
    expect(sites).toHaveLength(2);
    for (const s of sites) {
      // The sidebar's own document, and the graph's, seeded from the host's
      // series list. Nothing else is ever assigned.
      expect(s.line).toMatch(/renderSidebar\(|graphPanelHtml\(/);
    }
    // The sidebar assignment lives in its resolveWebviewView, not in a path
    // that runs per sample / per log line / per state push.
    const sidebar = extensionSource.indexOf("class SidebarProvider");
    const resolve = extensionSource.indexOf("resolveWebviewView(view: vscode.WebviewView)", sidebar);
    const assign = extensionSource.indexOf("webview.html =", sidebar);
    expect(assign).toBeGreaterThan(resolve);
    expect(assign).toBeLessThan(extensionSource.indexOf("private post(msg: unknown)", sidebar));
  });

  it("no provider re-renders on a log line, a sample or a status change", () => {
    // appendLog used to call refresh(), which is the whole 100Hz DOM rebuild.
    const at = extensionSource.indexOf("appendLog(line: string): void {");
    const appendLog = extensionSource.slice(at, at + 320);
    expect(appendLog).toContain("log-append");
    expect(appendLog).not.toContain("webview.html");
    for (const hot of ["pushSamples(samples: readonly LiveSample[]): void",
      "private publishSeries(): void",
      "setFlashPhase(phase: string, percent: number | null): void",
      "private pushState(): void"]) {
      const i = extensionSource.indexOf(hot);
      expect(i).toBeGreaterThan(-1);
      expect(extensionSource.slice(i, i + 600)).not.toContain("webview.html =");
    }
  });

  it("sends live-bootstrap as the single initial state transfer", () => {
    expect(extensionSource).toContain("kind: \"live-bootstrap\"");
    // The render wiring itself is asserted by the test above (every
    // webview.html assignment is renderSidebar/graphPanelHtml). Pinning the
    // exact argument list here only re-asserted that with a string that
    // breaks whenever the call legitimately gains an argument — the sidebar
    // now takes the configured font size.
  });
});

describe("P0-11: a rotated CSV is re-read from its header", () => {
  it("resets headerSkipped together with the byte offset", () => {
    const at = extensionSource.indexOf("if (size < this.tailByte ||");
    expect(at).toBeGreaterThan(-1);
    const rotation = extensionSource.slice(at, at + 700);
    expect(rotation).toContain("this.headerSkipped = false");
    expect(rotation).toContain("this.tailByte = 0");
    expect(rotation).toContain("this.csvOffset = 0");
  });

  it("a header row arriving mid-stream is never delivered as a sample", () => {
    // The rotated file starts with the header again; the tail must strip it
    // instead of showing a row named "name" with value "value".
    expect(extensionSource).toContain("assertCsvHeader(header)");
    // readNewSamples only accepts exactly 4 columns, so a header would slip
    // through as data unless the headerSkipped flag was reset.
    expect(extensionSource).toMatch(/this\.headerSkipped = true;[\s\S]{0,600}readNewSamples\(/);
  });
});

describe("D-4: header and drop accounting are live product code", () => {
  it("the tail loop verifies the schema and reports ingest loss", () => {
    expect(extensionSource).toContain("assertCsvHeader");
    expect(extensionSource).toContain("dropStats(");
    expect(extensionSource).toContain("formatDropSummary(stats)");
  });

  it("the dead poll helpers are gone from the product surface", () => {
    const poller = readFileSync(join(here, "../src/live/poller.ts"), "utf8");
    expect(poller).not.toContain("TearGuard");
    expect(poller).not.toContain("pollConfigOf");
    expect(extensionSource).not.toContain("TearGuard");
    expect(extensionSource).not.toContain("pollConfigOf");
  });

  it("assertCsvHeader rejects anything but the frozen 4-column header", () => {
    expect(() => assertCsvHeader("timestamp,address,name,value")).not.toThrow();
    expect(() => assertCsvHeader("timestamp,address,name,value,type"))
      .toThrow(/schema mismatch/);
  });

  it("dropStats measures what the tail could not use", () => {
    const stats = dropStats(1000, 999);
    expect(stats.dropped).toBe(1);
    expect(stats.dropRate).toBeCloseTo(0.001, 5);
    expect(formatDropSummary(dropStats(1000, 900))).toContain("drop_rate=10.0000%");
  });
});

describe("P0-12: a session outlives its sidecar's clean exit", () => {
  it("does not pass a one-hour cap to live_poll.py", () => {
    expect(extensionSource).not.toMatch(/--seconds",\s*"3600"/);
    expect(extensionSource).toContain('"--seconds", "2147483647"');
  });

  it("a clean exit the user did not ask for resumes the session", () => {
    const close = extensionSource.slice(
      extensionSource.indexOf('child.on("close"'),
      extensionSource.indexOf('child.on("close"') + 3000,
    );
    // The old code returned on `code === 0` and posted "session ended", which
    // left the values frozen for the rest of the VSCode session.
    expect(close).not.toMatch(/if \(code === 0\)/);
    expect(close).toContain("MAX_AUTO_RESTARTS");
    expect(close).toContain("void this.spawnPoll(args)");
    // An intentional stop still means stop.
    expect(close).toContain("no auto-restart");
  });

  it("still never restarts after a probe-busy failure", () => {
    const close = extensionSource.slice(
      extensionSource.indexOf('child.on("close"'),
      extensionSource.indexOf('child.on("close"') + 3000,
    );
    const busy = close.indexOf("isProbeBusyOutput");
    const restart = close.indexOf("void this.spawnPoll(args)");
    expect(busy).toBeGreaterThan(-1);
    expect(restart).toBeGreaterThan(busy);
  });

  it("a sidecar USB failure is reported with the raw error text", () => {
    const summary = usbErrorSummary("Traceback...\nusb.core.USBError: [Errno 110] Operation timed out\n");
    expect(summary).toContain("Errno 110");
    expect(summary).toContain("ST-LINK");
    expect(usbErrorSummary("all good")).toBeUndefined();
  });
});

describe("the CSV value encoding is the member's integer, MSB first", () => {
  // Integrator ruling that closed the §3.2/§3.4 contradiction: `value` is
  // the unsigned integer in `size*2` lowercase hex digits, so decoding is
  // BigInt(hex) for scalars and a little-endian reinterpretation of those
  // digits for float/string. Worked example from the sidecar author: memory
  // bytes 2C 0D F0 A4 B6 E2 05 01 (low address first) are logged
  // 0x0105e2b6a4f00d2c.
  it("decodes a 4-byte float from the integer form", () => {
    expect(decodeValue("0x3f800000", { size: 4, kind: "float", signed: true, type: "float" }))
      .toBe("1.00000");
    expect(decodeValue("0xc0490fdb", { size: 4, kind: "float", signed: true, type: "float" }))
      .toBe("-3.14159");
  });

  it("the byte-sequence form would decode to garbage, so the two cannot be confused", () => {
    // 0x0000803f is the same four bytes in memory order. Reading it as the
    // integer the ruling says it is must not produce 1.0.
    expect(decodeValue("0x0000803f", { size: 4, kind: "float", signed: true, type: "float" }))
      .not.toBe("1.00000");
  });

  it("zero-pads to exactly size*2 digits and honours signedness", () => {
    expect(decodeValue("0x01", { size: 1, kind: "bool", signed: false, type: "bool" })).toBe("true");
    expect(decodeValue("0x00", { size: 1, kind: "bool", signed: false, type: "bool" })).toBe("false");
    expect(decodeValue("0xffffffff", { size: 4, kind: "scalar", signed: true, type: "int" })).toBe("-1");
  });
});

describe("P0-1: a user-added variable is resolved, not stubbed away", () => {
  it("the session resolves watchlist names through nm instead of returning undefined", () => {
    // The regression: `const nmLookup = (name) => undefined` made every
    // user-added variable permanently unresolved.
    expect(extensionSource).not.toMatch(/nmLookup\s*=\s*\(\s*name(?::\s*string)?\s*\)\s*=>\s*undefined/);
    expect(extensionSource).toContain("await this.nmResolveAll(names, res.elf)");
    expect(extensionSource).toMatch(/resolveWatchlist\(names, res, \(n\) => nmAddrs\.get\(n\)\)/);
  });
});

describe("P0-4 / D12: the write path carries the leaf width", () => {
  it("refuses a width the sidecar cannot move instead of failing opaquely", () => {
    expect(extensionSource).toContain("WRITE_WIDTHS.includes(sym.size)");
    // The value sent to the sidecar is the ENCODED bits, not the text the user
    // typed: the table decodes by type, and the sidecar's protocol is
    // integer-only.
    expect(extensionSource).toMatch(/sendWrite\(sym\.address, sym\.size, bits\)/);
    expect(extensionSource).toContain("encodeWriteValue(value");
  });

  it("decodes by type, so the value the user reads is the value written", () => {
    expect(decodeValue("0x00000508", { size: 4, kind: "scalar", signed: false, type: "uint32_t" })).toBe("1288");
    expect(decodeValue("0xffffffff", { size: 4, kind: "scalar", signed: true, type: "int" })).toBe("-1");
    expect(decodeValue("0x01", { size: 1, kind: "bool", signed: false, type: "bool" })).toBe("true");
    expect(decodeValue("0x3f800000", { size: 4, kind: "float", signed: true, type: "float" })).toBe("1.00000");
    expect(decodeValue("0x00000002", {
      size: 4, kind: "enum", signed: true, type: "int",
      enumerators: [{ name: "MODE_FOLLOW", value: 2 }],
    })).toBe("MODE_FOLLOW");
    expect(decodeValue("0x00000009", {
      size: 4, kind: "enum", signed: true, type: "int",
      enumerators: [{ name: "MODE_FOLLOW", value: 2 }],
    })).toBe("9 (unknown)");
    // "RUN\0" in little-endian memory is the integer 0x004e5552.
    expect(decodeValue("0x004e5552", { size: 4, kind: "string", signed: false, type: "char[4]", length: 4 }))
      .toBe("RUN");
  });

  it("8-byte members stay exact (BigInt, not 32-bit bitwise)", () => {
    expect(decodeValue("0x0102030405060708", { size: 8, kind: "scalar", signed: false, type: "uint64_t" }))
      .toBe("72623859790382856");
    expect(decodeValue("0xffffffffffffffff", { size: 8, kind: "scalar", signed: true, type: "int64_t" }))
      .toBe("-1");
  });
});

describe("graph CSV export has a host handler", () => {
  it("graph-download-csv is answered by the host, which owns the filesystem", () => {
    expect(extensionSource).toContain("setDownloadHandler");
    expect(extensionSource).toContain("writeGraphCsv");
    // The archived rows are the selected series only, and they keep the
    // frozen 4-column schema.
    expect(extensionSource).toMatch(/this\.selected\.includes\(s\.name\)|wanted\.has\(s\.name\)/);
    expect(extensionSource).toContain("formatCsv(rows)");
  });
});
