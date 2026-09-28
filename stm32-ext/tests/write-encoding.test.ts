// The write prompt is seeded with the DECODED value (the same decoder draws the
// table), while the sidecar's protocol is integer-only. These tests pin the
// encoder that bridges the two, because the failure it prevents is silent:
// before it existed, every bool leaf was refused with `bad value: 'true'`, and
// a whole-number float such as 1.0 was accepted and stored as the integer 1,
// which reads back as 1.4e-45.
import { describe, expect, it } from "vitest";
import { decodeValue, encodeWriteValue, type LeafMeta } from "../src/live/poller.js";

const u32: LeafMeta = { size: 4, kind: "scalar", signed: false, type: "uint32_t" };
const i32: LeafMeta = { size: 4, kind: "scalar", signed: true, type: "int" };
const f32: LeafMeta = { size: 4, kind: "float", signed: true, type: "float" };
const f64: LeafMeta = { size: 8, kind: "float", signed: true, type: "double" };
const bool1: LeafMeta = { size: 1, kind: "bool", signed: false, type: "bool" };
const str4: LeafMeta = { size: 4, kind: "string", signed: false, type: "char[4]", length: 4 };
const en: LeafMeta = {
  size: 4, kind: "enum", signed: true, type: "mode_t",
  enumerators: [{ name: "MODE_IDLE", value: 0 }, { name: "MODE_FOLLOW", value: 2 }],
};
const bits1: LeafMeta = {
  size: 4, kind: "bitfield", signed: false, type: "flags_t", bitSize: 3, bitOffset: 0,
};

/** The user edits what the table shows; that text must encode to the same bits. */
function roundTrip(hex: string, meta: LeafMeta): string {
  const shown = decodeValue(hex, meta);
  const out = encodeWriteValue(shown, meta, meta.size);
  if (!out.ok) {
    throw new Error(`refused: ${out.reason}`);
  }
  return out.bits;
}

describe("decode -> edit -> encode round trip", () => {
  it("an unsigned 4-byte value survives unchanged", () => {
    expect(roundTrip("0x00000508", u32)).toBe("1288");
  });

  it("a signed negative value round-trips through two's complement", () => {
    // 0xffffffff decodes to -1 and must be written back as 4294967295.
    expect(decodeValue("0xffffffff", i32)).toBe("-1");
    expect(roundTrip("0xffffffff", i32)).toBe("4294967295");
  });

  it("a whole-number float is NOT written as an integer bit pattern", () => {
    // 1.0f is 0x3f800000. Pre-filling the prompt with "1" and writing that
    // verbatim stored 0x00000001, which reads back as 1.4e-45.
    expect(decodeValue("0x3f800000", f32)).toBe("1.00000");
    expect(roundTrip("0x3f800000", f32)).toBe("1065353216");
  });

  it("a negative and a fractional float encode exactly", () => {
    // -1.5f is 0xBFC00000.
    expect(encodeWriteValue("-1.5", f32, 4)).toEqual({ ok: true, bits: "3217031168", note: expect.stringContaining("float") });
    expect(encodeWriteValue("0.5", f32, 4)).toMatchObject({ ok: true, bits: "1056964608" });
  });

  it("an 8-byte double encodes to 64 bits", () => {
    const out = encodeWriteValue("1", f64, 8);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(BigInt(out.bits)).toBe(4607182418800017408n); // 1.0 as IEEE-754 double
    }
  });

  it("a 1-byte bool accepts the words a user would type", () => {
    for (const text of ["true", "True", "1", "yes", "on"]) {
      expect(encodeWriteValue(text, bool1, 1)).toMatchObject({ ok: true, bits: "1" });
    }
    for (const text of ["false", "FALSE", "0", "no", "off"]) {
      expect(encodeWriteValue(text, bool1, 1)).toMatchObject({ ok: true, bits: "0" });
    }
    // The exact string the table shows for a true bool must be accepted:
    // this is the case that was always refused before.
    expect(encodeWriteValue(decodeValue("0x01", bool1), bool1, 1)).toMatchObject({ ok: true, bits: "1" });
  });

  it("a char array encodes its text, NUL padded", () => {
    // "RUN" is 52 55 4e in memory, so the little-endian integer is 0x4e5552.
    expect(encodeWriteValue("RUN", str4, 4)).toMatchObject({ ok: true, bits: "5133650" });
  });

  it("an enum accepts its enumerator name or its integer", () => {
    expect(encodeWriteValue("MODE_FOLLOW", en, 4)).toMatchObject({ ok: true, bits: "2" });
    expect(encodeWriteValue("2", en, 4)).toMatchObject({ ok: true, bits: "2" });
  });
});

describe("the encoder refuses rather than guessing", () => {
  it("refuses text that does not fit the member width", () => {
    const out = encodeWriteValue("256", bool1, 1);
    expect(out.ok).toBe(false);
  });

  it("refuses a negative value for an unsigned member", () => {
    expect(encodeWriteValue("-1", u32, 4).ok).toBe(false);
  });

  it("refuses a non-finite or unparsable float", () => {
    expect(encodeWriteValue("true", f32, 4).ok).toBe(false);
    expect(encodeWriteValue("nan", f32, 4).ok).toBe(false);
    expect(encodeWriteValue("", f32, 4).ok).toBe(false);
  });

  it("refuses a string longer than the array", () => {
    expect(encodeWriteValue("TOOLONG", str4, 4).ok).toBe(false);
  });

  it("refuses an unknown enum name, listing the valid ones", () => {
    const out = encodeWriteValue("NOPE", en, 4);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toContain("MODE_FOLLOW");
    }
  });

  it("refuses a bitfield, because writing it would clobber its neighbours", () => {
    const out = encodeWriteValue("1", bits1, 4);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toContain("bitfield");
    }
  });

  it("refuses non-numeric text when there is no type metadata", () => {
    const out = encodeWriteValue("abc", undefined, 4);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toContain("整数");
    }
  });

  it("accepts a plain integer when there is no type metadata", () => {
    // An nm-resolved symbol has no type; the pre-existing product behaviour
    // (the integer goes straight through) must not regress.
    expect(encodeWriteValue("255", undefined, 4)).toMatchObject({ ok: true, bits: "255" });
  });
});

describe("every encoded result fits the member width", () => {
  const cases: [LeafMeta, string][] = [
    [u32, "0xffffffff"], [i32, "0x80000000"], [f32, "0x7f800000"],
    [f64, "0x7ff0000000000000"], [bool1, "0xff"], [str4, "0xffffffff"],
  ];
  for (const [meta, hex] of cases) {
    it(`${meta.type} @ ${hex} encodes within ${meta.size} bytes`, () => {
      const out = encodeWriteValue(decodeValue(hex, meta), meta, meta.size);
      if (out.ok) {
        const v = BigInt(out.bits);
        expect(v >= 0n).toBe(true);
        expect(v < (1n << BigInt(meta.size * 8))).toBe(true);
      } else {
        // A refusal is acceptable; a wrong number is not.
        expect(out.reason.length).toBeGreaterThan(0);
      }
    });
  }
});
