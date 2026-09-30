// todo5b: SWD polling model — CSV schema, drop-rate accounting and the
// single value decoder the host and the webview must agree on. Transport
// lives in scripts/live_poll.py (pyOCD primary, --mock for CI); this module
// holds the host-side contracts both sides assert.

export const CSV_HEADER = "timestamp,address,name,value";

export const DEFAULT_POLL_HZ = 50;

export interface LiveSample {
  readonly timestamp: string;
  readonly address: string;
  readonly name: string;
  readonly value: string;
}

export function formatCsvRow(s: LiveSample): string {
  return `${s.timestamp},${s.address},${s.name},${s.value}`;
}

export function formatCsv(rows: readonly LiveSample[]): string {
  return [CSV_HEADER, ...rows.map(formatCsvRow)].join("\n") + "\n";
}

/**
 * Collapse one tail batch to the latest sample per name, preserving the
 * order of last occurrence.
 *
 * The sidecar logs one CSV row per leaf per tick (N leaves x Hz rows/s),
 * but a display only needs the newest value per name. Forwarding every row
 * to 3 webviews at 100Hz x 155 leaves meant ~40 postMessage/s x ~387 rows
 * and a DOM write per row — the "使っていると重い" report. The CSV file on
 * disk keeps the full rate; only the in-memory display path is coalesced.
 */
export function coalesceSamples(samples: readonly LiveSample[]): LiveSample[] {
  const seen = new Set<string>();
  let dup = false;
  for (const s of samples) {
    if (seen.has(s.name)) {
      dup = true;
      break;
    }
    seen.add(s.name);
  }
  if (!dup) {
    return samples as LiveSample[];
  }
  const latest = new Map<string, LiveSample>();
  for (const s of samples) {
    latest.delete(s.name);
    latest.set(s.name, s);
  }
  return [...latest.values()];
}

/**
 * The CSV header is a frozen acceptance contract, so a mismatch is reported
 * instead of being parsed as data (a rotated-in header row used to show up
 * as a bogus `name`/`value` sample).
 */
export function assertCsvHeader(firstLine: string): void {
  if (firstLine !== CSV_HEADER) {
    throw new Error(`CSV schema mismatch: want exactly "${CSV_HEADER}", got "${firstLine}"`);
  }
}

export interface DropStats {
  readonly expected: number;
  readonly collected: number;
  readonly dropped: number;
  readonly dropRate: number;
}

export function dropStats(expected: number, collected: number): DropStats {
  const dropped = Math.max(0, expected - collected);
  return {
    expected,
    collected,
    dropped,
    dropRate: expected > 0 ? dropped / expected : 0,
  };
}

/** G12 acceptance: 50Hz x 5min with <1% drops. */
export function passesDropBudget(stats: DropStats): boolean {
  return stats.dropRate < 0.01;
}

export function formatDropSummary(stats: DropStats): string {
  return `ticks=${stats.expected} collected=${stats.collected} ` +
    `dropped=${stats.dropped} drop_rate=${(stats.dropRate * 100).toFixed(4)}% ` +
    `(budget: <1% required)`;
}

/**
 * Per-leaf type metadata (spec §3.3 `live-types.index`). `size` is the leaf
 * width in bytes and is what the write path must send to the sidecar.
 */
export interface LeafMeta {
  readonly size: number;
  readonly kind: string;
  readonly signed: boolean;
  readonly type: string;
  readonly enumerators?: readonly { readonly name: string; readonly value: number }[];
  readonly length?: number;
  readonly bitSize?: number;
  readonly bitOffset?: number;
}

/**
 * hex value string -> the exact text a user should read (spec §3.4).
 *
 * The CSV carries the member's integer value zero-padded to its width
 * (`0x` + `size*2` hex digits, most significant first), so scalars, bools
 * and enums are `BigInt(hex)` — no byte shuffling, and BigInt throughout so
 * 8-byte members do not fall apart on JS's 32-bit bitwise operators.
 *
 * float and string are the two kinds that are *interpreted* rather than
 * numbered: the integer is turned back into the little-endian bytes it came
 * from — the last hex digit pair is the least significant byte — and read as
 * IEEE-754 (or up to the first NUL). Worked example: an 8-byte member whose
 * memory bytes are 2C 0D F0 A4 B6 E2 05 01 is logged `0x0105e2b6a4f00d2c`
 * and must decode back to exactly those bytes. `0x3f800000` is 1.0f, not
 * four bytes 3f 80 00 00.
 *
 * Undecodable input falls back to the raw hex with a "type unknown" note —
 * never a wrong number.
 */
export function decodeValue(hex: string, meta: LeafMeta | undefined): string {
  const digits = hex.trim().replace(/^0x/i, "").toLowerCase();
  if (digits.length === 0 || digits.length % 2 !== 0 || !/^[0-9a-f]+$/.test(digits)) {
    return String(hex);
  }
  if (meta === undefined) {
    return `0x${digits}`;
  }
  const v = BigInt(`0x${digits}`);
  switch (meta.kind) {
    case "bool":
      return v !== 0n ? "true" : "false";
    case "float":
    case "string": {
      // The hex is an integer, so the byte order has to be put back.
      const memory = new Uint8Array(digits.length / 2);
      for (let i = 0; i < memory.length; i++) {
        memory[i] = Number.parseInt(
          digits.slice(digits.length - (i + 1) * 2, digits.length - i * 2), 16);
      }
      if (meta.kind === "string") {
        const nul = memory.indexOf(0);
        return new TextDecoder("utf-8").decode(nul < 0 ? memory : memory.subarray(0, nul));
      }
      const buf = new ArrayBuffer(memory.length);
      new Uint8Array(buf).set(memory);
      const view = new DataView(buf);
      // Only 4/8-byte widths are IEEE-754 decodable here: a shorter buffer
      // makes getFloat32 throw (RangeError escapes into the sample path),
      // and a longer one would decode a wrong number from its first 4 bytes.
      if (memory.length !== 4 && memory.length !== 8) {
        return `0x${digits} (型不明)`;
      }
      const n = memory.length === 8 ? view.getFloat64(0, true) : view.getFloat32(0, true);
      return Number.isFinite(n) ? n.toPrecision(6) : String(hex);
    }
    case "enum": {
      const hit = (meta.enumerators ?? []).find((e) => BigInt(e.value) === v);
      return hit === undefined ? `${v} (unknown)` : hit.name;
    }
    case "bitfield": {
      const width = BigInt(meta.bitSize ?? digits.length * 4);
      const at = BigInt(meta.bitOffset ?? 0);
      return ((v >> at) & ((1n << width) - 1n)).toString(10);
    }
    case "scalar":
      return (meta.signed ? BigInt.asIntN(digits.length * 4, v) : v).toString(10);
    default:
      return `0x${digits} (型不明)`;
  }
}
/**
 * The exact inverse of `decodeValue` for the write path: the text a user types
 * in the write prompt -> the member's integer value, as a decimal string ready
 * for the sidecar's integer-only write protocol.
 *
 * This exists because the prompt is seeded with the DECODED text (the same
 * decoder draws the table), while `scripts/live_write.py` accepts integers
 * only. Without the encoder every `bool` leaf was refused with
 * `bad value: 'true'`, and a whole-number `float` such as 1.0 was accepted
 * and stored as the integer 1 — the member then read back as 1.4e-45.
 *
 * Refuses rather than guessing whenever the text cannot be represented
 * exactly in the member's width: an out-of-range integer, a non-finite float,
 * a bitfield (whose neighbours would have to be rewritten), or text longer
 * than a char array.
 */
export type WriteEncoding =
  | { readonly ok: true; readonly bits: string; readonly note?: string }
  | { readonly ok: false; readonly reason: string };

export function encodeWriteValue(
  text: string,
  meta: LeafMeta | undefined,
  size: number,
): WriteEncoding {
  const raw = text.trim();
  const width = meta?.size ?? size;
  const limit = 1n << BigInt(width * 8);
  const asUnsigned = (v: bigint, what: string): WriteEncoding => {
    if (v < 0n || v >= limit) {
      return { ok: false, reason: `${what} は ${width} バイトに収まりません (0..${limit - 1n})` };
    }
    return { ok: true, bits: v.toString(10) };
  };

  // No type metadata (an nm-resolved symbol, or an older resolver): the value
  // is the integer, exactly as the product behaved before typed display.
  if (meta === undefined) {
    if (!/^[+-]?\d+$/.test(raw)) {
      return { ok: false, reason: `整数を入力してください (型情報が無いため): ${raw}` };
    }
    return asUnsigned(BigInt(raw), "値");
  }

  switch (meta.kind) {
    case "bool": {
      const t = raw.toLowerCase();
      if (["true", "1", "yes", "on"].includes(t)) {
        return { ok: true, bits: "1" };
      }
      if (["false", "0", "no", "off"].includes(t)) {
        return { ok: true, bits: "0" };
      }
      return { ok: false, reason: `bool には true / false (または 1 / 0) を入力してください: ${raw}` };
    }
    case "float": {
      const f = Number(raw);
      if (raw === "" || !Number.isFinite(f)) {
        return { ok: false, reason: `有限の実数を入力してください: ${raw}` };
      }
      const buf = new ArrayBuffer(8);
      const view = new DataView(buf);
      if (width === 8) {
        view.setFloat64(0, f, true);
      } else {
        if (width !== 4) {
          return { ok: false, reason: `float の幅 ${width} は書き込み未対応 (4 / 8 のみ)` };
        }
        view.setFloat32(0, f, true);
      }
      // Little-endian bytes -> the integer the CSV/log convention uses.
      let bits = 0n;
      for (let i = width - 1; i >= 0; i--) {
        bits = (bits << 8n) | BigInt(new Uint8Array(buf)[i] as number);
      }
      return { ok: true, bits: bits.toString(10), note: `float ${f} → 0x${bits.toString(16)}` };
    }
    case "enum": {
      const hit = (meta.enumerators ?? []).find((e) => e.name === raw);
      if (hit !== undefined) {
        return asUnsigned(BigInt(hit.value), `列挙子 ${raw}`);
      }
      if (!/^[+-]?\d+$/.test(raw)) {
        const names = (meta.enumerators ?? []).map((e) => e.name).join(", ");
        return {
          ok: false,
          reason: `enum には名前か整数を入力してください (${names === "" ? "列挙子なし" : names}): ${raw}`,
        };
      }
      return asUnsigned(BigInt(raw), "値");
    }
    case "string": {
      const bytes = new TextEncoder().encode(raw);
      if (bytes.length > width) {
        return { ok: false, reason: `文字列は ${width} バイトに収まりません (${bytes.length} バイト)` };
      }
      let bits = 0n;
      for (let i = bytes.length - 1; i >= 0; i--) {
        bits = (bits << 8n) | BigInt(bytes[i] as number);
      }
      return { ok: true, bits: bits.toString(10), note: `"${raw}" → ${bytes.length} バイト` };
    }
    case "bitfield": {
      // Writing a bitfield would have to rewrite the neighbouring bits of the
      // same word; the sidecar only writes whole bytes. Refuse instead.
      if (!/^\d+$/.test(raw)) {
        return { ok: false, reason: `bitfield には 0 以上の整数を入力してください: ${raw}` };
      }
      const v = BigInt(raw);
      const span = 1n << BigInt(meta.bitSize ?? 0);
      if (v >= span) {
        return { ok: false, reason: `bitfield は ${meta.bitSize} ビットなので 0..${span - 1n} を入力してください` };
      }
      return { ok: false, reason: `bitfield への直接書き込みは未対応 (隣接ビットの保存が必要なため): ${meta.type}` };
    }
    default: {
      if (!/^[+-]?\d+$/.test(raw)) {
        return { ok: false, reason: `整数を入力してください (${meta.type}): ${raw}` };
      }
      let v = BigInt(raw);
      if (v < 0n) {
        if (!meta.signed) {
          return { ok: false, reason: `${meta.type} は符号なしです: ${raw}` };
        }
        v += limit; // two's complement
      }
      return asUnsigned(v, "値");
    }
  }
}
