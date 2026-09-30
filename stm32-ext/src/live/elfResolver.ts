// todo5a: ELF resolution — `debug` (volatile DebugGlobal) base + member
// offsets, re-resolved per build. Thin TS wrapper over
// scripts/elf_resolve.py (pyelftools preferred, nm/readelf fallback).
// Stripped ELFs are refused with an explicit -g3 rebuild error.
//
// This module is the ONLY place where elf_resolve.py's JSON becomes host
// types, so every field the sidecar or the webview needs has to survive the
// projection: re-picking a known subset of keys silently drops type
// information (P0-15). Optional fields are only attached when the resolver
// actually emitted them, because `exactOptionalPropertyTypes` forbids an
// explicit `undefined`.

export type LeafKind =
  | "scalar" | "bool" | "enum" | "float" | "string"
  | "array" | "struct" | "bitfield" | "unknown";

export interface Enumerator {
  readonly name: string;
  readonly value: number;
}

export interface ResolvedSymbol {
  readonly name: string;
  readonly address: string;
  readonly offset: number;
  /** Leaf width in bytes (a struct/array node's size is its whole span). */
  readonly size: number;
  /** C type name from DWARF ("?" when unknown, e.g. nm fallback). */
  readonly type: string;
  readonly kind: LeafKind;
  readonly signed: boolean;
  readonly enumerators?: readonly Enumerator[];
  /** Element count (array) or byte length (string). */
  readonly length?: number;
  readonly bitSize?: number;
  readonly bitOffset?: number;
}

/** Display-only mirror of the DWARF structure (D9: nested children). */
export interface TypeNode {
  readonly name: string;
  readonly address: string;
  readonly size: number;
  readonly type: string;
  readonly kind: LeafKind;
  readonly signed: boolean;
  readonly children: readonly TypeNode[];
  readonly enumerators?: readonly Enumerator[];
  readonly length?: number;
  readonly bitSize?: number;
  readonly bitOffset?: number;
}

export interface ElfResolution {
  readonly elf: string;
  readonly base: string;
  readonly size: number;
  readonly end: string;
  readonly hasDebugInfo: boolean;
  readonly backend: string;
  readonly symbols: readonly ResolvedSymbol[];
  readonly unresolved: readonly string[];
  /** Catalog-only bodies carry an explicit null (no DebugGlobal window);
   * resolver-with-tree bodies carry a node; older bodies omit the key.
   * Widened (not normalized) so the host stays faithful to the wire shape;
   * consumers must treat null and undefined identically. */
  readonly tree?: TypeNode | null;
}

export interface ElfResolveRunner {
  (elfPath: string, extraArgs?: readonly string[]): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export const STRIP_HINT =
  "ELF has no debug info (stripped or built without -g). " +
  "Rebuild the Debug configuration with -g3 and re-resolve: ninja -C build-ext";

const KNOWN_KINDS: readonly string[] = [
  "scalar", "bool", "enum", "float", "string", "array", "struct", "bitfield", "unknown",
];

/**
 * Fallback classification for resolvers that predate the kind field (the
 * nm+readelf backend cannot know). Only used when `kind` is absent.
 */
function kindFromType(type: string): LeafKind {
  const t = type.toLowerCase();
  if (t === "bool" || t === "_bool") {
    return "bool";
  }
  if (/\b(float|double)\b/.test(t)) {
    return "float";
  }
  if (/\b(char|wchar_t)\b/.test(t)) {
    return "string";
  }
  if (/\[\d*\]$/.test(t)) {
    return "array";
  }
  return "scalar";
}

/** Fallback signedness from the C type name (int8_t…int64_t, int, short, long). */
function signedFromType(type: string): boolean {
  const t = type.trim();
  if (/^u/.test(t)) {
    return false;
  }
  return /^(?:int(?:8|16|32|64)?_t|short|long(?:\s+long)?|signed|ssize_t|ptrdiff_t)$/.test(t);
}

function asKind(v: unknown, type: string): LeafKind {
  return typeof v === "string" && KNOWN_KINDS.includes(v)
    ? v as LeafKind
    : kindFromType(type);
}

function parseEnumerators(v: unknown): readonly Enumerator[] | undefined {
  if (!Array.isArray(v)) {
    return undefined;
  }
  const out: Enumerator[] = [];
  for (const e of v) {
    if (typeof e !== "object" || e === null) {
      continue;
    }
    const o = e as Record<string, unknown>;
    if (typeof o["name"] !== "string" || typeof o["value"] !== "number") {
      continue;
    }
    out.push({ name: o["name"], value: o["value"] });
  }
  return out.length > 0 ? out : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Optional DWARF extras shared by symbols and tree nodes. */
function extras(
  o: Record<string, unknown>,
  kind: LeafKind,
  signed: boolean,
): {
  readonly enumerators?: readonly Enumerator[];
  readonly length?: number;
  readonly bitSize?: number;
  readonly bitOffset?: number;
  readonly signed: boolean;
} {
  const enumerators = kind === "enum" ? parseEnumerators(o["enumerators"]) : undefined;
  const length = num(o["length"]);
  const bitSize = num(o["bit_size"]) ?? num(o["bitSize"]);
  const bitOffset = num(o["bit_offset"]) ?? num(o["bitOffset"]);
  return {
    signed,
    ...(enumerators === undefined ? {} : { enumerators }),
    ...(length === undefined ? {} : { length }),
    ...(bitSize === undefined ? {} : { bitSize }),
    ...(bitOffset === undefined ? {} : { bitOffset }),
  };
}

function parseTypeNode(v: unknown, depth = 0): TypeNode | undefined {
  if (typeof v !== "object" || v === null || depth > 32) {
    return undefined;
  }
  const o = v as Record<string, unknown>;
  const type = typeof o["type"] === "string" ? o["type"] : "?";
  const kind = asKind(o["kind"], type);
  const signed = typeof o["signed"] === "boolean" ? o["signed"] : signedFromType(type);
  const children: TypeNode[] = [];
  if (Array.isArray(o["children"])) {
    for (const c of o["children"]) {
      const node = parseTypeNode(c, depth + 1);
      if (node !== undefined) {
        children.push(node);
      }
    }
  }
  return {
    name: typeof o["name"] === "string" ? o["name"] : "",
    address: typeof o["address"] === "string" ? o["address"] : "",
    size: num(o["size"]) ?? 0,
    type,
    kind,
    children,
    ...extras(o, kind, signed),
  };
}

function parseHex(s: string): number | undefined {
  if (!/^0x[0-9a-fA-F]+$/.test(s)) {
    return undefined;
  }
  const n = Number.parseInt(s, 16);
  return Number.isSafeInteger(n) ? n : undefined;
}

export function parseElfResolutionJson(stdout: string): ElfResolution {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout) as unknown;
  } catch {
    throw new Error(`elf_resolve: not JSON output. ${STRIP_HINT}`);
  }
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`elf_resolve: unexpected output shape. ${STRIP_HINT}`);
  }
  const r = raw as Record<string, unknown>;
  const base = typeof r["base"] === "string" ? r["base"] : "";
  const end = typeof r["end"] === "string" ? r["end"] : "";
  const size = typeof r["size"] === "number" ? r["size"] : -1;
  // An explicit zero window (base/end 0x00000000, size 0) is a deliberate
  // catalog-only body, not a missing window: only a negative/missing size
  // still fails here.
  if (parseHex(base) === undefined || parseHex(end) === undefined || !(size >= 0)) {
    throw new Error(`elf_resolve: missing base/size. ${STRIP_HINT}`);
  }
  const symbols: ResolvedSymbol[] = [];
  if (Array.isArray(r["symbols"])) {
    for (const s of r["symbols"]) {
      const o = s as Record<string, unknown>;
      if (typeof o["name"] !== "string" || typeof o["address"] !== "string"
        || typeof o["offset"] !== "number") {
        continue;
      }
      const type = typeof o["type"] === "string" ? o["type"] : "?";
      const kind = asKind(o["kind"], type);
      const signed = typeof o["signed"] === "boolean" ? o["signed"] : signedFromType(type);
      symbols.push({
        name: o["name"],
        address: o["address"],
        offset: o["offset"],
        size: num(o["size"]) ?? 0,
        type,
        kind,
        ...extras(o, kind, signed),
      });
    }
  }
  const unresolved: string[] = Array.isArray(r["unresolved"])
    ? (r["unresolved"] as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  const tree = parseTypeNode(r["tree"]);
  return {
    elf: typeof r["elf"] === "string" ? r["elf"] : "",
    base,
    size,
    end,
    hasDebugInfo: r["has_debug_info"] === true,
    backend: typeof r["backend"] === "string" ? r["backend"] : "unknown",
    symbols,
    unresolved,
    ...(tree === undefined ? {} : { tree }),
  };
}

export function isStripError(stderr: string, exitCode: number): boolean {
  return exitCode === 2 && /no debug info|stripped|without -g/.test(stderr);
}

export async function resolveElf(
  elfPath: string,
  run: ElfResolveRunner,
  extraArgs: readonly string[] = [],
): Promise<ElfResolution> {
  const result = await run(elfPath, extraArgs);
  if (result.exitCode !== 0) {
    if (isStripError(result.stderr, result.exitCode)) {
      throw new Error(`elf_resolve: ${STRIP_HINT}`);
    }
    const tail = result.stderr.trim().split("\n").slice(-3).join(" ");
    throw new Error(`elf_resolve failed for ${elfPath}: ${tail || `exit=${result.exitCode}`}`);
  }
  return parseElfResolutionJson(result.stdout);
}

/** Look up one dotted member (e.g. "sys.loop_hz") in a resolution. */
export function findSymbol(
  res: ElfResolution,
  name: string,
): ResolvedSymbol | undefined {
  return res.symbols.find((s) => s.name === name);
}

