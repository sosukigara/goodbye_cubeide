// The variable-add QuickPick (src/live/pickItems.ts) against the poll filter
// (src/live/manager.ts). These two are the ends of one requirement: a struct or
// array GROUP must be selectable, and selecting it must actually cause every
// leaf underneath it to be polled. Asserting either half alone would pass while
// the feature stayed broken — the original bug was exactly that shape, a group
// the picker never offered and a filter that never matched its members.

import { describe, expect, it } from "vitest";
import type { ElfResolution, ResolvedSymbol } from "../src/live/elfResolver.js";
import { filterWatchedSymbols } from "../src/live/manager.js";
import { bucketOf, buildWatchPickItems } from "../src/live/pickItems.js";
import type { PickTreeNode, WatchPickItem } from "../src/live/pickItems.js";

const BASE = 0x2000005c;

function leaf(name: string, offset: number): ResolvedSymbol {
  return {
    name,
    address: `0x${(BASE + offset).toString(16).padStart(8, "0")}`,
    offset,
    size: 4,
    type: "float",
    kind: "float",
    signed: true,
  };
}

/** `struct Measure { float drive_target_radps[3]; }` as the resolver emits it. */
const MEASURE_LEAVES: ResolvedSymbol[] = [
  leaf("measure.drive_target_radps[0]", 144),
  leaf("measure.drive_target_radps[1]", 148),
  leaf("measure.drive_target_radps[2]", 152),
];

const MEASURE_TREE: PickTreeNode = {
  name: "debug",
  children: [
    {
      name: "measure",
      type: "Measure",
      kind: "struct",
      children: [
        {
          name: "drive_target_radps",
          type: "float[3]",
          kind: "array",
          children: [
            { name: "[0]", type: "float", kind: "float" },
            { name: "[1]", type: "float", kind: "float" },
            { name: "[2]", type: "float", kind: "float" },
          ],
        },
      ],
    },
  ],
};

function resolution(symbols: readonly ResolvedSymbol[]): ElfResolution {
  return {
    elf: "/tmp/fw.elf",
    base: `0x${BASE.toString(16)}`,
    size: 204,
    end: `0x${(BASE + 204).toString(16)}`,
    hasDebugInfo: true,
    backend: "pyelftools",
    symbols,
    unresolved: [],
    tree: MEASURE_TREE as ElfResolution["tree"],
  };
}

function items(over: Partial<Parameters<typeof buildWatchPickItems>[0]> = {}) {
  return buildWatchPickItems({
    symbols: MEASURE_LEAVES,
    tree: MEASURE_TREE,
    watched: new Set<string>(),
    ...over,
  });
}

function labels(over: Partial<Parameters<typeof buildWatchPickItems>[0]> = {}): string[] {
  return items(over).filter((i) => !i.separator).map((i) => i.label);
}

function pickableByLabel(
  over: Partial<Parameters<typeof buildWatchPickItems>[0]> = {},
): Map<string, WatchPickItem> {
  return new Map(items(over).filter((i) => !i.separator).map((i) => [i.label, i]));
}

describe("bucketOf", () => {
  it("buckets by the first segment and stays bracket-aware", () => {
    expect(bucketOf("measure.drive_target_radps[0]")).toBe("measure");
    expect(bucketOf("measure", true)).toBe("measure");
    expect(bucketOf("measure", false)).toBe("(global)");
    expect(bucketOf("solo")).toBe("(global)");
  });
});

describe("buildWatchPickItems offers groups, not just leaves", () => {
  it("offers the struct group and the array group as their own rows", () => {
    const got = labels();
    expect(got).toContain("measure");
    expect(got).toContain("measure.drive_target_radps");
  });

  it("still offers every element leaf", () => {
    const got = labels();
    for (let i = 0; i < 3; i += 1) {
      expect(got).toContain(`measure.drive_target_radps[${i}]`);
    }
  });

  it("never drops a name the resolver produced", () => {
    const got = new Set(labels());
    for (const s of MEASURE_LEAVES) {
      expect(got.has(s.name), `${s.name} must be selectable`).toBe(true);
    }
  });

  it("shows how many leaves a group carries and the C type", () => {
    const byLabel = pickableByLabel();
    expect(byLabel.get("measure")?.description).toContain("3 leaves");
    expect(byLabel.get("measure")?.description).toContain("Measure");
    expect(byLabel.get("measure.drive_target_radps")?.description).toContain("float[3]");
  });

  it("marks an already-watched row", () => {
    const byLabel = pickableByLabel({ watched: new Set(["measure"]) });
    expect(byLabel.get("measure")?.picked).toBe(true);
    expect(byLabel.get("measure")?.description).toContain("●監視中");
  });

  it("emits a separator per bucket and never a pickable separator", () => {
    const all = items();
    expect(all.some((i) => i.separator)).toBe(true);
    for (const i of all) {
      if (i.separator) {
        expect(i.picked).toBe(false);
      }
    }
  });

  it("survives a resolution with no tree (catalog-only firmware)", () => {
    const got = labels({ tree: null });
    expect(got).toContain("measure.drive_target_radps[0]");
  });
});

describe("selecting a group really does poll every leaf under it", () => {
  it("expands the struct group to all of its element leaves", () => {
    const res = resolution(MEASURE_LEAVES);
    const picked = labels().filter((l) => l === "measure");
    expect(picked).toHaveLength(1);
    const { symbols, unmatched } = filterWatchedSymbols(res, picked);
    expect(unmatched).toEqual([]);
    expect(symbols.map((s) => s.name).sort()).toEqual([
      "measure.drive_target_radps[0]",
      "measure.drive_target_radps[1]",
      "measure.drive_target_radps[2]",
    ]);
  });

  it("expands the array group to exactly its own elements", () => {
    const res = resolution(MEASURE_LEAVES);
    const { symbols } = filterWatchedSymbols(res, ["measure.drive_target_radps"]);
    expect(symbols).toHaveLength(3);
  });

  it("still expands an individual element leaf to itself", () => {
    const res = resolution(MEASURE_LEAVES);
    const { symbols } = filterWatchedSymbols(res, ["measure.drive_target_radps[1]"]);
    expect(symbols.map((s) => s.name)).toEqual(["measure.drive_target_radps[1]"]);
  });

  it("does not let a group claim a same-prefixed sibling", () => {
    const symbols = [...MEASURE_LEAVES, leaf("measure.drive_target_radpsX", 160)];
    const res = resolution(symbols);
    const { symbols: got } = filterWatchedSymbols(res, ["measure.drive_target_radps"]);
    expect(got.map((s) => s.name)).not.toContain("measure.drive_target_radpsX");
  });

  it("every polled symbol carries an address and a width the sidecar can read", () => {
    const res = resolution(MEASURE_LEAVES);
    const { symbols } = filterWatchedSymbols(res, ["measure"]);
    for (const s of symbols) {
      expect(s.address).toMatch(/^0x[0-9a-f]{8}$/);
      expect(s.size).toBeGreaterThan(0);
    }
  });
});
