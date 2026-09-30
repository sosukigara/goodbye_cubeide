// QuickPick item construction for the variable-add flow (pure, vscode-free).
//
// Extracted from addWatchFlowInner so the pickable set is testable: the old
// inline version built items from resolved leaves only and bucketed by
// `name.slice(0, name.indexOf("."))`, which both omitted every group (a user
// could never register `measure` and get all 15 members) and mis-bucketed
// `measure.drive_target_radps[0]`-style element leaves. Items now cover the
// type tree AND the catalog roots AND the resolved leaves, so a struct or
// array group always appears as its own item; selecting the GROUP NAME
// registers it, and the host's filterWatchedSymbols expands it to every leaf
// at poll time.

import type { ResolvedSymbol } from "./elfResolver.js";
import { completionCandidates, isUnder } from "./namePath.js";

/** Structural subset of a type-tree or catalog node used for item building. */
export interface PickTreeNode {
  readonly name: string;
  readonly path?: string;
  readonly type?: string;
  readonly kind?: string;
  readonly size?: number;
  readonly children?: readonly PickTreeNode[];
}

/** One QuickPick row. `separator` rows are bucket headers, never pickable. */
export interface WatchPickItem {
  readonly label: string;
  readonly description: string;
  readonly picked: boolean;
  readonly separator: boolean;
}

/** Source-scanned globals the ELF resolution does not list (via nm later). */
export interface ScannedPick {
  readonly name: string;
  readonly detail: string;
}

/**
 * Bucket key: the first segment, bracket-aware (`a.b[0]` -> `a`).
 *
 * A bare top-level GROUP needs its own bucket, not `(global)`: `measure` and
 * its children must appear under one header, and the old rule put the group in
 * `(global)` while its members went under `measure`, so the two halves of one
 * struct were listed in different sections and the group row was effectively
 * lost. A bare top-level LEAF still shares `(global)`, which is what keeps a
 * firmware with dozens of plain globals from growing a separator per symbol.
 */
export function bucketOf(name: string, isGroup = false): string {
  let cut = -1;
  for (let i = 0; i < name.length; i += 1) {
    if (name[i] === "." || name[i] === "[") {
      cut = i;
      break;
    }
  }
  if (cut >= 0) {
    return name.slice(0, cut);
  }
  return isGroup ? name : "(global)";
}

function walkNodes(
  nodes: readonly PickTreeNode[],
  parentPath: string,
  out: Map<string, { readonly type: string; readonly kids: boolean }>,
): void {
  for (const nd of nodes) {
    const nm = nd.name;
    if (nm === "") {
      continue;
    }
    const explicit = nd.path !== undefined && nd.path !== "" ? nd.path : undefined;
    let path: string;
    if (explicit !== undefined) {
      path = explicit;
    } else if (nm.startsWith("[")) {
      // Element children carry bracket-only names (`[0]`); re-adding a dot
      // would invent `grp.[0]`, a name nothing else knows.
      path = parentPath + nm;
    } else {
      path = parentPath === "" ? nm : parentPath + "." + nm;
    }
    if (path === "") {
      continue;
    }
    const kids = nd.children !== undefined && nd.children.length > 0;
    const prev = out.get(path);
    if (prev === undefined || (!prev.kids && kids)) {
      out.set(path, { type: nd.type ?? "", kids });
    }
    if (kids && nd.children !== undefined) {
      walkNodes(nd.children, path, out);
    }
  }
}

/**
 * Build the variable-add QuickPick rows from the tree, the catalog roots and
 * the resolved leaves. Every group (struct or array) yields its own item
 * labelled with the GROUP NAME, every leaf yields its own item, buckets are
 * first-segment separators, and descriptions carry the C type plus the byte
 * offset/size so `measure.drive_now_radps` is tellable from
 * `measure.drive_target_radps` at a glance. Already-watched names are marked.
 */
export function buildWatchPickItems(args: {
  readonly symbols: readonly ResolvedSymbol[];
  readonly tree?: PickTreeNode | null;
  readonly catalogRoots?: readonly PickTreeNode[];
  readonly watched: ReadonlySet<string>;
  readonly scanned?: readonly ScannedPick[];
}): WatchPickItem[] {
  const byName = new Map<string, ResolvedSymbol>();
  for (const s of args.symbols) {
    if (!byName.has(s.name)) {
      byName.set(s.name, s);
    }
  }
  const infos = new Map<string, { readonly type: string; readonly kids: boolean }>();
  if (args.tree !== undefined && args.tree !== null) {
    // The tree root itself (e.g. `debug`) is not part of leaf paths — the
    // sidebar treats it as path "" — so only its children are walked.
    walkNodes(args.tree.children ?? [], "", infos);
  }
  if (args.catalogRoots !== undefined) {
    walkNodes(args.catalogRoots, "", infos);
  }
  const candidates = completionCandidates([...byName.keys(), ...infos.keys()]);
  const underCount = new Map<string, number>();
  for (const c of candidates) {
    let n = 0;
    for (const name of byName.keys()) {
      if (isUnder(name, c)) {
        n += 1;
      }
    }
    underCount.set(c, n);
  }
  const buckets = new Map<string, WatchPickItem[]>();
  const order: string[] = [];
  for (const c of candidates) {
    const sym = byName.get(c);
    const info = infos.get(c);
    const leafCount = underCount.get(c) ?? 0;
    const isGroup = (info?.kids ?? false) || leafCount > (sym === undefined ? 0 : 1) || (sym === undefined && leafCount > 0);
    const bucket = bucketOf(c, isGroup);
    let list = buckets.get(bucket);
    if (list === undefined) {
      list = [];
      buckets.set(bucket, list);
      order.push(bucket);
    }
    let description: string;
    if (sym !== undefined && !isGroup) {
      description = `${sym.type} ${sym.size}B off ${sym.offset}`;
    } else if (info !== undefined && info.type !== "") {
      description = `${info.type} ${leafCount} leaves`;
    } else {
      description = `${leafCount} leaves`;
    }
    if (args.watched.has(c)) {
      description += " ●監視中";
    }
    list.push({ label: c, description, picked: args.watched.has(c), separator: false });
  }
  order.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const out: WatchPickItem[] = [];
  for (const bucket of order) {
    out.push({ label: bucket, description: "", picked: false, separator: true });
    const list = buckets.get(bucket) ?? [];
    for (const item of list) {
      out.push(item);
    }
  }
  const scanned = args.scanned ?? [];
  if (scanned.length > 0) {
    out.push({ label: "ソース内変数 (自動分析)", description: "", picked: false, separator: true });
    for (const s of scanned.slice(0, 60)) {
      const mark = args.watched.has(s.name) ? " ●監視中" : "";
      out.push({ label: s.name, description: `${s.detail}${mark}`, picked: args.watched.has(s.name), separator: false });
    }
  }
  return out;
}
