// Name-path hierarchy (pure, vscode-free): one definition of what a
// hierarchical boundary is, shared by the host and all three webviews.
//
// The fixed resolver emits per-element leaves for array members, so a leaf
// name is no longer purely dot-separated: `measure.drive_target_radps[0]`
// names one float, and the array member itself is a GROUP node with three
// element children. Every dotted-boundary test of the form
// `name.startsWith(prefix + ".")` silently drops those element leaves —
// selecting the array group then expands to nothing and the user gets a
// registered group whose members are never polled. A boundary is therefore
// `.` OR `[` everywhere below.
//
// Display segments vs node prefixes (the one non-obvious choice): for
// display, `b[0]` is ONE segment — lastSegment("a.b[0]") is "b[0]" and
// parentOf("a.b[0]") is "a", because the row label shows the whole element
// name. But ancestorsOf("a.b[0]") still lists "a.b" (the array GROUP node),
// because the group is a real pickable node above the leaf. parentOf is the
// display parent (cut at the last dot); ancestorsOf is every node prefix
// (cut at every dot or open bracket).

/** Display segment: text after the last dot (`a.b[0].c` -> `c`). */
export function lastSegment(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? path : path.slice(dot + 1);
}

/**
 * Display parent: everything before the last dot (`a.b[0]` -> `a`, because
 * `b[0]` is one segment). Used to find subtree roots, where skipping the
 * mid-segment array group is harmless: both the group and its elements are
 * non-roots under the same top node.
 */
export function parentOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? "" : path.slice(0, dot);
}

/**
 * Every strict prefix that is itself a node, outermost first, excluding the
 * path itself (`a.b[0].c` -> `["a", "a.b", "a.b[0]"]`). Cuts at dots AND
 * open brackets, so array groups appear even though no dot precedes `[`.
 */
export function ancestorsOf(path: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 1; i < path.length; i += 1) {
    const c = path[i];
    if (c === "." || c === "[") {
      const prefix = path.slice(0, i);
      if (prefix !== "" && prefix !== path && !seen.has(prefix)) {
        seen.add(prefix);
        out.push(prefix);
      }
    }
  }
  return out;
}

/**
 * Compiler, C++ mangled and libc internals never belong in a human-facing
 * variable list (`_ZN...`, `__sf`, `..._M_elems...`). Explicitly added names
 * bypass this; only the auto-generated catalog rows are filtered.
 */
export function isNoiseVariable(name: string): boolean {
  if (name === "") {
    return true;
  }
  if (name.charAt(0) === "_") {
    return true;
  }
  return name.indexOf("._M_") >= 0;
}

/**
 * True when `name` is `prefix` itself or hierarchically below it. An empty
 * prefix matches everything: several call sites treat "" as the root.
 * The `[` arm is the array-group fix; without it a group never matches its
 * element leaves. The boundary is load-bearing the other way too:
 * `a.bx` must NOT match `a.b`, or removing a group deletes a sibling.
 */
export function isUnder(name: string, prefix: string): boolean {
  if (prefix === "") {
    return true;
  }
  return name === prefix || name.startsWith(prefix + ".") || name.startsWith(prefix + "[");
}

/**
 * Every item under `prefix`, INCLUDING the prefix item itself when present,
 * in input order, deduplicated by name.
 */
export function descendantsOf<T>(
  prefix: string,
  items: readonly T[],
  nameOf: (item: T) => string,
): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const name = nameOf(item);
    if (!isUnder(name, prefix) || seen.has(name)) {
      continue;
    }
    seen.add(name);
    out.push(item);
  }
  return out;
}

/** Numeric-aware segment order: `[2]` before `[10]`, prefix before child. */
function comparePath(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  const ta = a.split(/(\d+)/);
  const tb = b.split(/(\d+)/);
  const n = Math.min(ta.length, tb.length);
  for (let i = 0; i < n; i += 1) {
    const x = ta[i] ?? "";
    const y = tb[i] ?? "";
    if (x === y) {
      continue;
    }
    const nx = /^\d+$/.test(x) ? Number.parseInt(x, 10) : Number.NaN;
    const ny = /^\d+$/.test(y) ? Number.parseInt(y, 10) : Number.NaN;
    if (Number.isSafeInteger(nx) && Number.isSafeInteger(ny)) {
      return nx < ny ? -1 : 1;
    }
    return x < y ? -1 : 1;
  }
  if (ta.length === tb.length) {
    return a < b ? -1 : 1;
  }
  return ta.length < tb.length ? -1 : 1;
}

/**
 * The full pickable set: every input path plus every ancestor of each,
 * deduplicated. Groups sort before leaves so the entries that survive a
 * datalist truncation are the ones carrying a whole subtree; within each
 * half the order is hierarchical (`measure` < `measure.drive_now_radps` <
 * `measure.drive_now_radps[0]`), numeric-aware so `[2]` precedes `[10]`.
 * A group is therefore always offerable, not only its leaves.
 */
export function completionCandidates(paths: Iterable<string>): string[] {
  const all = new Set<string>();
  for (const p of paths) {
    if (p === "") {
      continue;
    }
    all.add(p);
    for (const a of ancestorsOf(p)) {
      all.add(a);
    }
  }
  const list = [...all];
  const groupOf = new Set<string>();
  for (const g of list) {
    for (const c of list) {
      if (c !== g && isUnder(c, g)) {
        groupOf.add(g);
        break;
      }
    }
  }
  list.sort((x, y) => {
    const gx = groupOf.has(x) ? 0 : 1;
    const gy = groupOf.has(y) ? 0 : 1;
    if (gx !== gy) {
      return gx - gy;
    }
    return comparePath(x, y);
  });
  return list;
}

/**
 * The SAME algorithms as a JavaScript source snippet, concatenated straight
 * into each webview `<script>` block so host and panels cannot disagree on
 * what a boundary is. Constraints (not style): no template literals or
 * backticks (`${`/backticks break the host string builder), no `</script>`
 * substring (it would truncate the page), top-level `function` declarations
 * with collision-proof `np` names, and pure (no DOM access).
 *
 * Written as joined double-quoted lines: a TS template literal here could
 * not hold `${`-free JS without escaping, and backticks are banned outright.
 *
 * The membership sets are `Object.create(null)`, not `{}`: a firmware global
 * is named by C code, so `constructor`, `toString` and `__proto__` are legal
 * path segments. On a plain object literal those read as already-present and
 * are dropped without a trace -- `npCandidates(["constructor.foo"])` returned
 * only the leaf and silently lost the group. The TypeScript twin uses `Set`
 * and was never affected, so a plain `{}` here also made host and panels
 * disagree on the same input.
 */
export const NAME_PATH_JS: string = [
  "function npLastSegment(path) {",
  "  var dot = String(path).lastIndexOf('.');",
  "  return dot < 0 ? String(path) : String(path).slice(dot + 1);",
  "}",
  "function npParentOf(path) {",
  "  var s = String(path);",
  "  var dot = s.lastIndexOf('.');",
  "  return dot < 0 ? '' : s.slice(0, dot);",
  "}",
  "function npAncestorsOf(path) {",
  "  var s = String(path);",
  "  var out = [];",
  "  var seen = Object.create(null);",
  "  for (var i = 1; i < s.length; i += 1) {",
  "    var c = s.charAt(i);",
  "    if (c === '.' || c === '[') {",
  "      var prefix = s.slice(0, i);",
  "      if (prefix !== '' && prefix !== s && !seen[prefix]) { seen[prefix] = true; out.push(prefix); }",
  "    }",
  "  }",
  "  return out;",
  "}",
  "function npIsNoise(name) {",
  "  var s = String(name === undefined || name === null ? '' : name);",
  "  if (s === '') return true;",
  "  if (s.charAt(0) === '_') return true;",
  "  return s.indexOf('._M_') >= 0;",
  "}",
  "function npIsUnder(name, prefix) {",
  "  var n = String(name);",
  "  var p = String(prefix);",
  "  if (p === '') return true;",
  "  return n === p || n.indexOf(p + '.') === 0 || n.indexOf(p + '[') === 0;",
  "}",
  "function npDescendantsOf(prefix, names) {",
  "  var out = [];",
  "  var seen = Object.create(null);",
  "  for (var i = 0; i < names.length; i += 1) {",
  "    var n = String(names[i]);",
  "    if (!npIsUnder(n, String(prefix)) || seen[n]) continue;",
  "    seen[n] = true;",
  "    out.push(names[i]);",
  "  }",
  "  return out;",
  "}",
  "function npComparePath(a, b) {",
  "  var sa = String(a), sb = String(b);",
  "  if (sa === sb) return 0;",
  "  var ta = sa.split(/(\\d+)/);",
  "  var tb = sb.split(/(\\d+)/);",
  "  var n = ta.length < tb.length ? ta.length : tb.length;",
  "  for (var i = 0; i < n; i += 1) {",
  "    var x = ta[i] || '';",
  "    var y = tb[i] || '';",
  "    if (x === y) continue;",
  "    var nx = /^[0-9]+$/.test(x) ? parseInt(x, 10) : NaN;",
  "    var ny = /^[0-9]+$/.test(y) ? parseInt(y, 10) : NaN;",
  "    if (isFinite(nx) && isFinite(ny)) return nx < ny ? -1 : 1;",
  "    return x < y ? -1 : 1;",
  "  }",
  "  if (ta.length === tb.length) return sa < sb ? -1 : 1;",
  "  return ta.length < tb.length ? -1 : 1;",
  "}",
  "function npCandidates(paths) {",
  "  var all = Object.create(null);",
  "  var order = [];",
  "  var add = function (p) { if (p !== '' && !all[p]) { all[p] = true; order.push(p); } };",
  "  for (var i = 0; i < paths.length; i += 1) {",
  "    var p = String(paths[i]);",
  "    add(p);",
  "    var ancs = npAncestorsOf(p);",
  "    for (var k = 0; k < ancs.length; k += 1) add(ancs[k]);",
  "  }",
  "  var isGroup = function (g) {",
  "    for (var j = 0; j < order.length; j += 1) {",
  "      var c = order[j];",
  "      if (c !== g && npIsUnder(c, g)) return true;",
  "    }",
  "    return false;",
  "  };",
  "  order.sort(function (x, y) {",
  "    var gx = isGroup(x) ? 0 : 1;",
  "    var gy = isGroup(y) ? 0 : 1;",
  "    if (gx !== gy) return gx - gy;",
  "    return npComparePath(x, y);",
  "  });",
  "  return order;",
  "}",
].join("\n");
