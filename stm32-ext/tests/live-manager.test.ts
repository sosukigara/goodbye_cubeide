import { describe, expect, it } from "vitest";
import {
  PROBE_BUSY_MESSAGE,
  buildResolutionJson,
  expandWatchNames,
  extraArgs,
  filterWatchedSymbols,
  hasWindow,
  isProbeBusyOutput,
  parseNmSymbol,
  parseNmSymbolSize,
  partitionOutOfWindowSymbols,
  readNewSamples,
  readSessionLock,
  resolveWatchlist,
  targetOfMcu,
  writeSessionLock,
} from "../src/live/manager.js";
import type { ElfResolution } from "../src/live/elfResolver.js";

const RES: ElfResolution = {
  elf: "/fw/unit_omni3.elf",
  base: "0x200000bc",
  size: 936,
  end: "0x20000464",
  hasDebugInfo: true,
  backend: "pyelftools",
  symbols: [
    { name: "sys.loop_hz", address: "0x200000bc", offset: 0, size: 4, type: "uint32_t" },
    { name: "sys.uptime_ms", address: "0x200000ec", offset: 48, size: 4, type: "uint32_t" },
  ],
  unresolved: [],
};

describe("live session manager contracts", () => {
  it("targetOfMcu lowercases part numbers", () => {
    expect(targetOfMcu("STM32G474RETx")).toBe("stm32g474retx");
    expect(targetOfMcu("STM32F407VGx")).toBe("stm32f407vgx");
  });
  it("extraArgs renders --extra entries with the member width", () => {
    expect(extraArgs([{ name: "tuner_params", address: "0x20000008", size: 4 }]))
      .toEqual(["--extra=tuner_params=0x20000008:4"]);
    expect(extraArgs([])).toEqual([]);
  });
  it("buildResolutionJson carries only the watched leaves, with all fields", () => {
    const j = JSON.parse(buildResolutionJson(RES, [RES.symbols[0]!])) as {
      elf: string; symbols: { name: string; type: string; size: number }[];
    };
    expect(j.elf).toBe("/fw/unit_omni3.elf");
    expect(j.symbols).toHaveLength(1);
    expect(j.symbols[0]?.name).toBe(RES.symbols[0]?.name);
    expect(j.symbols[0]?.type).toBe(RES.symbols[0]?.type);
    expect(j.symbols[0]?.size).toBe(RES.symbols[0]?.size);
  });
  it("readNewSamples tails CSV rows incrementally", () => {
    const csv = "timestamp,address,name,value\nt1,0x1,a,0x2\nt2,0x3,b\n\nt3,0x4,c,0x5\n";
    const r1 = readNewSamples(csv, 0);
    expect(r1.samples.map((s) => s.name)).toEqual(["a", "c"]);
    expect(r1.nextLine).toBe(5);
    const r2 = readNewSamples(`${csv}t4,0x6,d,0x7\n`, r1.nextLine);
    expect(r2.samples.map((s) => s.name)).toEqual(["d"]);
    expect(r2.nextLine).toBe(6);
  });
  it("readNewSamples holds back a partial trailing line", () => {
    const r = readNewSamples("timestamp,address,name,value\nt1,0x1,a,0x2\nt2,0x3", 0);
    expect(r.samples.map((s) => s.name)).toEqual(["a"]);
    expect(r.nextLine).toBe(2);
    const r2 = readNewSamples("timestamp,address,name,value\nt1,0x1,a,0x2\nt2,0x3,b,0x4\n", r.nextLine);
    expect(r2.samples.map((s) => s.name)).toEqual(["b"]);
  });
  it("parseNmSymbol finds defined globals in REAL nm -S output", () => {
    // Captured from `arm-none-eabi-nm -S --defined-only` on a cortex-m4
    // object. `-S` puts a size on every defined symbol, so the four-field
    // form is the only one a real tool emits — and a parser written against
    // the three-field shape matched nothing, returning undefined for every
    // real ELF while this test stayed green on a fixture no tool produces.
    const nm = [
      "00000000 00000001 B bss_byte",
      "00000008 00000004 B bss_dword",
      "0000000c 00000010 B sized_arr",
      "00000000 00000014 T main",
      "         U puts",
    ].join("\n");
    expect(parseNmSymbol(nm, "bss_dword")).toBe("0x00000008");
    expect(parseNmSymbol(nm, "sized_arr")).toBe("0x0000000c");
    expect(parseNmSymbol(nm, "main")).toBe("0x00000000");
    // Undefined symbols are excluded by --defined-only, but a stray one in
    // the stream must still not be picked up.
    expect(parseNmSymbol(nm, "puts")).toBeUndefined();
    expect(parseNmSymbol(nm, "nope")).toBeUndefined();
  });

  it("parseNmSymbolSize also yields the width, for the write path", () => {
    const nm = "00000008 00000004 B bss_dword\n0000000c 00000010 B sized_arr\n";
    expect(parseNmSymbolSize(nm, "bss_dword")).toEqual({ address: "0x00000008", size: 4 });
    expect(parseNmSymbolSize(nm, "sized_arr")).toEqual({ address: "0x0000000c", size: 16 });
  });

  it("refuses a symbol whose width it cannot read, rather than guessing", () => {
    // Guessing a write width from the type letter would mean writing 1 byte
    // into a 4-byte variable, or 4 bytes over a 16-bit one. No width, no write.
    const nm = "20000008 D tuner_params\n";
    expect(parseNmSymbolSize(nm, "tuner_params")).toBeUndefined();
    // The address is still usable for watching, which needs no width.
    expect(parseNmSymbol(nm, "tuner_params")).toBe("0x20000008");
  });
  it("resolveWatchlist splits resolved/nm/unresolved", () => {    const r = resolveWatchlist(
      ["sys.loop_hz", "tuner_params", "ghost", "sys.loop_hz"],
      RES,
      (n) => (n === "tuner_params" ? "0x20000008" : undefined),
    );
    expect(r.extras).toEqual([{ name: "tuner_params", address: "0x20000008", size: 4 }]);
    expect(r.unresolved).toEqual(["ghost"]);
  });
  it("session lock round-trips, corrupt text yields undefined", () => {
    const s = writeSessionLock({ pid: 1234, project: "unit_omni3", started: "t" });
    expect(readSessionLock(s)).toEqual({ pid: 1234, project: "unit_omni3", started: "t" });
    expect(readSessionLock("garbage{")).toBeUndefined();
    expect(readSessionLock('{"pid":"x"}')).toBeUndefined();
  });
  it("probe-busy output detected (Resource busy)", () => {
    expect(isProbeBusyOutput("usb.core.USBError: [Errno 16] Resource busy")).toBe(true);
    expect(isProbeBusyOutput("all green")).toBe(false);
    expect(PROBE_BUSY_MESSAGE).toContain("⏹ 停止");
  });
});

const CATALOG_RES: ElfResolution = {
  elf: "/fw/naked.elf",
  base: "0x00000000",
  size: 0,
  end: "0x00000000",
  hasDebugInfo: true,
  backend: "pyelftools",
  symbols: [
    { name: "counter", address: "0x20000000", offset: 0, size: 4, type: "uint32_t", kind: "scalar", signed: false },
    { name: "flag", address: "0x20000010", offset: 0, size: 1, type: "bool", kind: "bool", signed: false },
  ],
  unresolved: [],
  tree: null,
};

describe("zero-window (catalog-only) resolution", () => {
  it("routes every watched symbol to extras with its real DWARF width", () => {
    expect(hasWindow(CATALOG_RES.base, CATALOG_RES.size)).toBe(false);
    const split = partitionOutOfWindowSymbols(CATALOG_RES.symbols, CATALOG_RES.base, CATALOG_RES.size);
    expect(split.inWindow).toEqual([]);
    expect(split.outOfWindowAsExtras).toEqual([
      { name: "counter", address: "0x20000000", size: 4 },
      { name: "flag", address: "0x20000010", size: 1 },
    ]);
    expect(extraArgs(split.outOfWindowAsExtras)).toEqual([
      "--extra=counter=0x20000000:4",
      "--extra=flag=0x20000010:1",
    ]);
  });
  it("writes a valid zero-window resolution JSON body", () => {
    const j = JSON.parse(buildResolutionJson(CATALOG_RES, [])) as Record<string, unknown>;
    expect(j["base"]).toBe("0x00000000");
    expect(j["size"]).toBe(0);
    expect(j["end"]).toBe("0x00000000");
    expect(j["symbols"]).toEqual([]);
    expect("tree" in j).toBe(false);
  });
  it("matches flat catalog names without a tree (no struct prefixes, no false empty)", () => {
    const filter = filterWatchedSymbols(CATALOG_RES, ["counter", "ghost"]);
    expect(filter.symbols.map((s) => s.name)).toEqual(["counter"]);
    expect(filter.unmatched).toEqual(["ghost"]);
  });
});

describe("expandWatchNames (struct add registers its leaves)", () => {
  const TREE_RES: ElfResolution = {
    ...RES,
    symbols: [
      { name: "debug.target_transform.vx", address: "0x200000bc", offset: 0, size: 4, type: "float" },
      { name: "debug.target_transform.vy", address: "0x200000c0", offset: 4, size: 4, type: "float" },
      { name: "sys.loop_hz", address: "0x200000ec", offset: 48, size: 4, type: "uint32_t" },
    ],
  };
  it("expands a struct group to its leaves", () => {
    expect(expandWatchNames(TREE_RES, ["debug.target_transform"]))
      .toEqual(["debug.target_transform.vx", "debug.target_transform.vy"]);
  });
  it("keeps exact leaves and unknown names untouched", () => {
    expect(expandWatchNames(TREE_RES, ["sys.loop_hz", "tuner_params"]))
      .toEqual(["sys.loop_hz", "tuner_params"]);
  });
  it("dedups overlapping group and leaf selections", () => {
    expect(expandWatchNames(TREE_RES, ["debug.target_transform", "debug.target_transform.vx"]))
      .toEqual(["debug.target_transform.vx", "debug.target_transform.vy"]);
  });
});

describe("normal-window resolution keeps the in-window/extras split", () => {
  it("partitions leaves against the DebugGlobal window", () => {
    expect(hasWindow(RES.base, RES.size)).toBe(true);
    const outOfWindow = {
      name: "robot.x", address: "0x20001000", offset: 0, size: 2, type: "int16_t", kind: "scalar", signed: true,
    } as const;
    const split = partitionOutOfWindowSymbols([...RES.symbols, outOfWindow], RES.base, RES.size);
    expect(split.inWindow.map((s) => s.name)).toEqual(["sys.loop_hz", "sys.uptime_ms"]);
    expect(split.outOfWindowAsExtras).toEqual([
      { name: "robot.x", address: "0x20001000", size: 2 },
    ]);
    const j = JSON.parse(buildResolutionJson(RES, split.inWindow)) as {
      base: string; size: number; end: string; symbols: { name: string }[];
    };
    expect(j.base).toBe(RES.base);
    expect(j.size).toBe(RES.size);
    expect(j.end).toBe(RES.end);
    expect(j.symbols.map((s) => s.name)).toEqual(["sys.loop_hz", "sys.uptime_ms"]);
  });
});
