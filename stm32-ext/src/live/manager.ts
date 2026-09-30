// Live session manager contracts (pure, vscode-free): pyOCD target naming,
// resolution JSON assembly (resolved + user-picked extras), CSV tailing into
// LiveSample rows, and nm-based address lookup for arbitrary variables.

import type { ElfResolution, ResolvedSymbol } from "./elfResolver";
import { isUnder } from "./namePath.js";
import type { LiveSample } from "./poller";

export const WATCHLIST_KEY = "stm32ext.liveWatch";

/** Last successfully built ELF + MCU, so a window reload can re-resolve. */
export const LIVE_ELF_KEY = "stm32ext.liveElf";

/** Cross-window live-session lock so two VSCode windows don't fight over one probe. */
export interface SessionLock {
  readonly pid: number;
  readonly project: string;
  readonly started: string;
}

export function readSessionLock(text: string): SessionLock | undefined {
  try {
    const o = JSON.parse(text) as Record<string, unknown>;
    if (typeof o["pid"] === "number" && typeof o["project"] === "string") {
      return {
        pid: o["pid"],
        project: o["project"],
        started: typeof o["started"] === "string" ? o["started"] : "",
      };
    }
  } catch {
    /* corrupt lock = no lock */
  }
  return undefined;
}

export function writeSessionLock(lock: SessionLock): string {
  return JSON.stringify(lock);
}

export { PROBE_BUSY_MESSAGE, isProbeBusyOutput } from "../probe/conflict.js";

/** MCU part -> pyOCD target: lowercase alphanumeric (STM32G474RETx -> stm32g474retx). */
export function targetOfMcu(mcu: string): string {
  return mcu.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export interface ExtraWatch {
  readonly name: string;
  readonly address: string;
  /**
   * Byte width the sidecar reads. live_poll.py requires it explicitly: an
   * extra without one is skipped with a stderr note, i.e. silently not
   * polled. Extras are symbols the DWARF tree does not describe, so there is
   * no resolver width to take and the firmware-global default applies.
   */
  readonly size: number;
}

/** Width assumed for a user-picked global outside the resolved type tree. */
export const DEFAULT_EXTRA_SIZE = 4;

/** live_poll.py exit codes the host has to explain (S2 sidecar contract). */
export const EXIT_NO_PROBE = 3;
export const EXIT_BUDGET = 4;
export const EXIT_USB = 5;
export const EXIT_NO_SYMBOLS = 6;

/** One symbol exactly as elf_resolve.py described it (no key is dropped). */
function symbolJson(s: ResolvedSymbol): Record<string, unknown> {
  return {
    name: s.name,
    address: s.address,
    offset: s.offset,
    size: s.size,
    type: s.type,
    kind: s.kind,
    signed: s.signed,
    ...(s.enumerators === undefined ? {} : { enumerators: s.enumerators }),
    ...(s.length === undefined ? {} : { length: s.length }),
    ...(s.bitSize === undefined ? {} : { bit_size: s.bitSize }),
    ...(s.bitOffset === undefined ? {} : { bit_offset: s.bitOffset }),
  };
}

/**
 * Resolution JSON file content for the sidecar: the header fields, the type
 * tree (display only, never polled) and exactly the leaves the user watches.
 *
 * `watched` is mandatory on purpose: handing in the whole resolution is what
 * made the sidecar poll 355 leaves at 100Hz (D11).
 *
 * A catalog-only resolution (zero window: no DebugGlobal) yields a canonical
 * zero-window body — base/end "0x00000000", size 0, empty symbols — because
 * the sidecar's load_watchlist range fence ([base, base+size)) would drop
 * every symbols[] entry of such a body. Catalog leaves travel as --extra
 * instead (see partitionOutOfWindowSymbols), so the empty symbols list loses
 * nothing. A null tree is omitted exactly like an absent one.
 */
export function buildResolutionJson(res: ElfResolution, watched: readonly ResolvedSymbol[]): string {
  if (!hasWindow(res.base, res.size)) {
    return JSON.stringify({
      elf: res.elf,
      base: "0x00000000",
      size: 0,
      end: "0x00000000",
      has_debug_info: res.hasDebugInfo,
      backend: res.backend,
      symbols: [],
    });
  }
  return JSON.stringify({
    elf: res.elf,
    base: res.base,
    size: res.size,
    end: res.end,
    has_debug_info: res.hasDebugInfo,
    backend: res.backend,
    symbols: watched.map(symbolJson),
    ...(res.tree === undefined || res.tree === null ? {} : { tree: res.tree }),
  });
}

export interface WatchFilter {
  /** Leaves to hand to the sidecar, in watchlist order. */
  readonly symbols: readonly ResolvedSymbol[];
  /** Watched names that matched no leaf (typo, renamed member). */
  readonly unmatched: readonly string[];
}

/**
 * D11 watchlist filter: resolution leaves -> the ones actually watched.
 *
 * A watched name matches itself and, when it names a struct or array node in
 * the type tree, every leaf underneath it (`periph` -> all 185 leaves).
 * The boundary is isUnder (`.` OR `[`): the resolver now emits per-element
 * leaves (`measure.drive_target_radps[0]`), and a dotted-only prefix test
 * matched none of them, so an array group expanded to nothing polled.
 *
 * There is deliberately NO upper bound here. It used to stop at 64 leaves and
 * report the rest as `overflow`, which meant a variable the user had selected
 * — and plotted — was silently never polled. The graph then showed a full
 * legend over an empty canvas, and the only trace was a `監視上限` line in a
 * log channel nobody was watching. Polling exactly what was asked for is the
 * only behaviour that keeps those two surfaces consistent.
 */
export function filterWatchedSymbols(
  res: ElfResolution,
  names: readonly string[],
): WatchFilter {
  const picked: ResolvedSymbol[] = [];
  const seen = new Set<string>();
  const pickedNames = new Set<string>();
  const unmatched: string[] = [];
  for (const name of names) {
    const want = name.trim();
    if (want === "" || seen.has(want)) {
      continue;
    }
    seen.add(want);
    const hits = res.symbols.filter((s) => isUnder(s.name, want));
    if (hits.length === 0) {
      unmatched.push(want);
      continue;
    }
    for (const h of hits) {
      if (pickedNames.has(h.name)) {
        continue;
      }
      pickedNames.add(h.name);
      picked.push(h);
    }
  }
  return { symbols: picked, unmatched };
}

/**
 * Expand watch names to pollable leaves: a struct/array group name becomes
 * every leaf underneath it, an exact leaf stays itself, and an unknown name
 * is preserved for the nm fallback. Order-preserving and deduplicated.
 */
export function expandWatchNames(res: ElfResolution, names: readonly string[]): string[] {
  const filter = filterWatchedSymbols(res, names);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of filter.symbols) {
    if (!seen.has(s.name)) {
      seen.add(s.name);
      out.push(s.name);
    }
  }
  for (const u of filter.unmatched) {
    if (!seen.has(u)) {
      seen.add(u);
      out.push(u);
    }
  }
  return out;
}

/**
 * Japanese, actionable summary of a sidecar USB failure. The raw line is
 * kept verbatim in the text: the underlying cause of Errno 110 is still
 * unknown, so hiding the original string would only make it harder to chase.
 */
export function usbErrorSummary(stderr: string): string | undefined {
  const hit = stderr.split("\n").find((l) =>
    /USBError|Errno 110|Operation timed out|Could not find CMSIS-DAP|No device connected/i.test(l));
  if (hit === undefined) {
    return undefined;
  }
  const raw = hit.trim().slice(0, 200);
  return `ST-LINK 通信エラー: ${raw} — ケーブルの接触と USB 負荷を確認して「再接続」を押してください`;
}

/** ExtraWatch list -> live_poll.py --extra argv entries (name=0xaddr:SIZE). */
export function extraArgs(extras: readonly ExtraWatch[]): string[] {
  return extras.map((e) => `--extra=${e.name}=${e.address}:${e.size}`);
}

/** Human cause for a sidecar exit code, or undefined when stderr speaks. */
export function exitCodeReason(code: number): string | undefined {
  if (code === EXIT_NO_PROBE) {
    return "ST-LINK が見つかりません — USB ケーブルの接続と電源を確認して「再接続」を押してください";
  }
  if (code === EXIT_BUDGET) {
    return "データ落ちが上限を超えました — Hz を下げるか変数を減らして「再接続」を押してください";
  }
  if (code === EXIT_NO_SYMBOLS) {
    return "監視できる変数がありません — 「変数追加」から選ぶか、ビルドし直してください";
  }
  if (code === EXIT_USB) {
    return "ST-LINK に接続できませんでした (USB) — ケーブルの接触と USB 負荷を確認して「再接続」を押してください";
  }
  return undefined;
}

/**
 * Parse new CSV rows since fromLine (0-based data-line index; line 0 is the
 * header). Two tailing hazards handled: (a) a trailing newline leaves a
 * phantom "" element that would shift indices on append — exactly one
 * trailing phantom is dropped so offsets stay append-stable; (b) a partial
 * last line (writer mid-flush) is held back and re-read next call.
 * Malformed rows are skipped, never thrown. Returns samples + next offset.
 */
export function readNewSamples(csv: string, fromLine: number): { samples: LiveSample[]; nextLine: number } {
  const endsNewline = csv.endsWith("\n");
  const lines = csv.split("\n");
  if (endsNewline && lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  const samples: LiveSample[] = [];
  let nextLine = fromLine;
  for (let i = Math.max(1, fromLine); i < lines.length; i++) {
    const line = (lines[i] ?? "").replace(/\r$/, "");
    if (i === lines.length - 1 && !endsNewline) {
      break; // partial final line: re-read it next call
    }
    nextLine = i + 1;
    if (line.trim() === "") {
      continue;
    }
    const parts = line.split(",");
    if (parts.length !== 4) {
      continue;
    }
    const [timestamp, address, name, value] = parts as [string, string, string, string];
    if (!timestamp || !address || !name || value === undefined) {
      continue;
    }
    samples.push({ timestamp, address, name, value });
  }
  return { samples, nextLine };
}

/**
 * Parse `nm -S --defined-only` output for a global symbol address (0x...).
 *
 * The address alone is what the watch path needs — an extra of unknown width
 * is polled at the firmware-global default — so this accepts a line with or
 * without the `-S` size column. Only the write path insists on a width.
 */
export function parseNmSymbol(nmStdout: string, name: string): string | undefined {
  return matchNmSymbol(nmStdout, name)?.address;
}

/**
 * Parse `nm -S --defined-only` for a symbol's address AND width.
 *
 * `-S` puts a size on EVERY defined symbol, so the four-field form is what
 * real tools emit. Measured on a cortex-m4 object, every line had four
 * fields:
 *
 *     00000000 00000001 B bss_byte
 *     00000000 00000014 T main
 *
 * A parser written against the three-field shape matched none of that and
 * returned undefined for every real ELF. A line still lacking a width now
 * yields undefined rather than a guess: guessing here would be guessing a
 * WRITE WIDTH, and a symbol reported "B" but actually 4 bytes wide would be
 * written as one byte while a 16-bit symbol guessed as 4 would clobber its
 * neighbour. No width means no write, which is the safe direction.
 */
export function parseNmSymbolSize(
  nmStdout: string,
  name: string,
): { address: string; size: number } | undefined {
  const m = matchNmSymbol(nmStdout, name);
  return m?.size === undefined ? undefined : { address: m.address, size: m.size };
}

/** One matching nm line: its address, and its width when `-S` reported one. */
function matchNmSymbol(
  nmStdout: string,
  name: string,
): { address: string; size: number | undefined } | undefined {
  for (const raw of nmStdout.split("\n")) {
    const m = /^([0-9a-fA-F]+)\s+(?:([0-9a-fA-F]+)\s+)?([A-Za-z])\s+(\S+)$/.exec(raw.trim());
    if (m === null || m[4] !== name) {
      continue;
    }
    const parsed = m[2] === undefined ? Number.NaN : Number.parseInt(m[2], 16);
    return {
      address: `0x${(m[1] ?? "").toLowerCase().padStart(8, "0")}`,
      size: Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined,
    };
  }
  return undefined;
}

/** Split of watched leaves against the DebugGlobal window. */
export interface WindowPartition {
  /** Leaves inside [base, base+size): safe for the resolution JSON. */
  readonly inWindow: readonly ResolvedSymbol[];
  /**
   * Leaves outside the window (catalog globals such as robot.*): the
   * sidecar's load_watchlist range filter would reject them from symbols[],
   * so they travel as --extra (which bypasses the filter) with their real
   * DWARF widths.
   */
  readonly outOfWindowAsExtras: readonly ExtraWatch[];
}

/**
 * True when [baseHex, baseHex+size) is a genuine DebugGlobal window. A
 * catalog-only resolution carries an explicit zero window (base
 * "0x00000000", size 0), which is deliberate — not a missing window — and
 * every caller below treats it as "route everything through --extra".
 */
export function hasWindow(baseHex: string, size: number): boolean {
  const base = Number.parseInt(baseHex, 16);
  return Number.isSafeInteger(base) && Number.isSafeInteger(size) && size > 0;
}

/**
 * Partition watched leaves into in-window (resolution JSON) vs
 * out-of-window (sidecar --extra).
 *
 * The sidecar only polls symbols[] entries inside [base, base+size) and
 * skips the rest as "outside the resolved DebugGlobal window", while
 * --extra entries bypass that range filter. Catalog leaves (robot.*,
 * monitor_odom.*) carry real addresses outside the DebugGlobal window, so
 * writing them into the JSON means they are never polled. Splitting them
 * host-side keeps every watched name polled with its DWARF size.
 *
 * With no window at all (catalog-only resolution: size 0 or an unparseable
 * base) there is no range the sidecar could accept, so every symbol travels
 * as --extra with its real DWARF width. Putting them into the JSON instead
 * would poll nothing: the zero-window fence drops each one.
 */
export function partitionOutOfWindowSymbols(
  symbols: readonly ResolvedSymbol[],
  baseHex: string,
  size: number,
): WindowPartition {
  if (!hasWindow(baseHex, size)) {
    return {
      inWindow: [],
      outOfWindowAsExtras: symbols.map((s) => ({
        name: s.name,
        address: s.address,
        size: Number.isSafeInteger(s.size) && (s.size as number) > 0
          ? s.size
          : DEFAULT_EXTRA_SIZE,
      })),
    };
  }
  const base = Number.parseInt(baseHex, 16);
  const inWindow: ResolvedSymbol[] = [];
  const outOfWindowAsExtras: ExtraWatch[] = [];
  for (const s of symbols) {
    const addr = Number.parseInt(s.address, 16);
    if (!Number.isSafeInteger(addr)) {
      // Unparseable address: leave it where the old path put it (JSON)
      // rather than silently rerouting it.
      inWindow.push(s);
      continue;
    }
    if (addr >= base && addr < base + size) {
      inWindow.push(s);
    } else {
      const width = Number.isSafeInteger(s.size) && (s.size as number) > 0
        ? s.size
        : DEFAULT_EXTRA_SIZE;
      outOfWindowAsExtras.push({ name: s.name, address: s.address, size: width });
    }
  }
  return { inWindow, outOfWindowAsExtras };
}
/** Merge stored watchlist names against a resolution: known extras with addresses. */
export function resolveWatchlist(
  names: readonly string[],
  res: ElfResolution,
  nmLookup: (name: string) => string | undefined,
): { extras: ExtraWatch[]; unresolved: string[] } {
  const byName = new Map(res.symbols.map((s) => [s.name, s.address] as const));
  const extras: ExtraWatch[] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    const hit = byName.get(name);
    if (hit !== undefined) {
      continue; // already in the resolved set; no --extra needed
    }
    const addr = nmLookup(name);
    if (addr !== undefined) {
      extras.push({ name, address: addr, size: DEFAULT_EXTRA_SIZE });
    } else {
      unresolved.push(name);
    }
  }
  return { extras, unresolved };
}
