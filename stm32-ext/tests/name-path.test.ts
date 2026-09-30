// Hierarchy rules for watch names (src/live/namePath.ts).
//
// The resolver now emits one leaf per array element, so a name is no longer
// purely dot-separated: `measure.drive_target_radps[0]` names a single float
// and `measure.drive_target_radps` is a GROUP above it. Every dotted-boundary
// test of the form `name.startsWith(prefix + ".")` therefore matched none of
// the element leaves, and the whole failure mode these tests pin is a user
// selecting a group and getting nothing polled.

import { describe, expect, it } from "vitest";
import {
  NAME_PATH_JS,
  ancestorsOf,
  completionCandidates,
  descendantsOf,
  isUnder,
  lastSegment,
  parentOf,
} from "../src/live/namePath.js";

/**
 * The JS twin is what the three webviews actually run. Evaluating it here is
 * the only way to prove host and panels cannot disagree — the bug this module
 * was introduced for was a host that understood brackets and a panel that did
 * not.
 */
function loadPanelHelpers(): Record<string, (...args: unknown[]) => unknown> {
  const scope: Record<string, unknown> = {};
  const factory = new Function(
    `${NAME_PATH_JS}\nreturn { npLastSegment, npParentOf, npAncestorsOf, npIsUnder, npDescendantsOf, npCandidates, npComparePath };`,
  );
  return factory() as Record<string, (...args: unknown[]) => unknown>;
}

const panel = loadPanelHelpers();

/** C identifiers that collide with Object.prototype. */
const PROTOTYPE_NAMES = ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"];

describe("namePath hierarchy boundaries", () => {
  it("treats '.' and '[' both as a boundary", () => {
    expect(isUnder("measure.drive_target_radps[0]", "measure")).toBe(true);
    expect(isUnder("measure.drive_target_radps[0]", "measure.drive_target_radps")).toBe(true);
    expect(isUnder("measure.drive_target_radps[0]", "measure.drive_target_radps[0]")).toBe(true);
  });

  it("rejects a prefix that is not a real boundary", () => {
    // The false positive this rule exists to prevent: removing group `a.b`
    // must not take the unrelated sibling `a.bx` with it.
    expect(isUnder("measure.drive_now_radpsX", "measure.drive_now_radps")).toBe(false);
    expect(isUnder("a.bx", "a.b")).toBe(false);
    expect(isUnder("a.b0", "a.b")).toBe(false);
  });

  it("matches everything under the empty root prefix", () => {
    expect(isUnder("anything.at.all", "")).toBe(true);
  });

  it("splits display segments at the last dot only", () => {
    expect(lastSegment("measure.drive_target_radps[0]")).toBe("drive_target_radps[0]");
    expect(lastSegment("measure.drive_target_radps[0].nested")).toBe("nested");
    expect(lastSegment("solo")).toBe("solo");
    expect(lastSegment("")).toBe("");
  });

  it("takes the display parent at the last dot, so b[0] is one segment", () => {
    expect(parentOf("a.b[0].c")).toBe("a.b[0]");
    expect(parentOf("measure.drive_target_radps[0]")).toBe("measure");
    expect(parentOf("solo")).toBe("");
  });

  it("lists every node prefix, cutting at dots AND open brackets", () => {
    // `a.b` appears even though no dot precedes the `[`: it is a real pickable
    // group above the element leaf.
    expect(ancestorsOf("measure.drive_target_radps[0]")).toEqual([
      "measure",
      "measure.drive_target_radps",
    ]);
    expect(ancestorsOf("a.b[0].c")).toEqual(["a", "a.b", "a.b[0]"]);
    expect(ancestorsOf("solo")).toEqual([]);
  });

  it("collects descendants including the prefix item itself", () => {
    const items = [
      { name: "measure.a" },
      { name: "measure.drive_now_radps[0]" },
      { name: "measure.drive_now_radps[1]" },
      { name: "measureX.c" },
    ];
    const got = descendantsOf("measure", items, (i) => i.name).map((i) => i.name);
    expect(got).toEqual(["measure.a", "measure.drive_now_radps[0]", "measure.drive_now_radps[1]"]);
  });

  it("deduplicates descendants by name", () => {
    const items = [{ name: "a.x" }, { name: "a.x" }];
    expect(descendantsOf("a", items, (i) => i.name)).toHaveLength(1);
  });
});

describe("completionCandidates", () => {
  it("offers every group as well as every leaf", () => {
    const got = completionCandidates(["measure.drive_target_radps[0]"]);
    expect(got).toContain("measure");
    expect(got).toContain("measure.drive_target_radps");
    expect(got).toContain("measure.drive_target_radps[0]");
  });

  it("never loses a leaf", () => {
    const leaves = ["measure.a", "measure.drive_now_radps[0]", "measure.drive_now_radps[1]"];
    const set = new Set(completionCandidates(leaves));
    for (const leaf of leaves) {
      expect(set.has(leaf)).toBe(true);
    }
  });

  it("sorts groups before leaves so a truncation keeps whole subtrees", () => {
    const got = completionCandidates(["measure.drive_target_radps[0]", "measure.a"]);
    expect(got.indexOf("measure")).toBeLessThan(got.indexOf("measure.a"));
    expect(got.indexOf("measure.drive_target_radps")).toBeLessThan(
      got.indexOf("measure.drive_target_radps[0]"),
    );
  });

  it("orders array indices numerically, so [2] precedes [10]", () => {
    const got = completionCandidates(["m.v[10]", "m.v[2]"]);
    expect(got.indexOf("m.v[2]")).toBeLessThan(got.indexOf("m.v[10]"));
  });

  it("keeps a C global named after an Object.prototype member", () => {
    // A path segment is chosen by C code, so these are legal names. On a plain
    // `{}` membership set they read as already-present and vanish without a
    // trace — the measured symptom was npCandidates(["constructor.foo"])
    // returning only the leaf and silently dropping the `constructor` group.
    for (const name of PROTOTYPE_NAMES) {
      const got = completionCandidates([`${name}.leaf`]);
      expect(got, `${name} group must survive`).toContain(name);
      expect(got, `${name}.leaf must survive`).toContain(`${name}.leaf`);
    }
  });

  it("ignores the empty path", () => {
    expect(completionCandidates(["", "a.b"])).not.toContain("");
  });
});

describe("the webview twin agrees with the host", () => {
  it("splits and matches identically", () => {
    const cases: [string, string][] = [
      ["measure.drive_target_radps[0]", "measure.drive_target_radps"],
      ["measure.drive_target_radpsX", "measure.drive_target_radps"],
      ["measure.drive_target_radps[0]", "measure"],
      ["a.b[0].c", "a.b[0]"],
    ];
    for (const [name, prefix] of cases) {
      expect(panel["npIsUnder"]!(name, prefix), `${name} under ${prefix}`).toBe(isUnder(name, prefix));
    }
    for (const path of ["measure.drive_target_radps[0]", "a.b[0].c", "solo"]) {
      expect(panel["npLastSegment"]!(path)).toBe(lastSegment(path));
      expect(panel["npParentOf"]!(path)).toBe(parentOf(path));
      expect(panel["npAncestorsOf"]!(path)).toEqual(ancestorsOf(path));
    }
  });

  it("produces the same candidate set, prototype names included", () => {
    const paths = ["constructor.foo", "measure.drive_target_radps[0]", "measure.a"];
    expect(panel["npCandidates"]!(paths)).toEqual(completionCandidates(paths));
  });

  it("is safe to inline in a <script> block", () => {
    expect(NAME_PATH_JS).not.toContain("</script");
    expect(NAME_PATH_JS).not.toContain("`");
    expect(NAME_PATH_JS).not.toContain("${");
  });
});
