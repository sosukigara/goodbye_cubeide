// Host side of the DebugGlobal write channel: request framing, result parsing
// and request/response correlation against the live sidecar.
import { describe, expect, it } from "vitest";
import {
  PendingWrites,
  WRITE_RESULT_PREFIX,
  buildWriteRequest,
  parseWriteResult,
} from "../src/live/writeChannel.js";

describe("write request framing", () => {
  it("carries id, address, size and the value verbatim", () => {
    const line = buildWriteRequest("w1", "0x200000bc", 4, "1287", "0x200000bc", 4);
    expect(JSON.parse(line)).toEqual({
      id: "w1", op: "write", address: "0x200000bc", size: 4, value: "1287",
      base: "0x200000bc", symbolSize: 4,
    });
  });
  it("sends a hex value through untouched for the sidecar to parse", () => {
    const parsed = JSON.parse(buildWriteRequest("w1", "0x200000bc", 4, "0xFF", "0x200000bc", 4));
    expect(parsed.value).toBe("0xFF");
    expect(parsed.base).toBe("0x200000bc");
    expect(parsed.symbolSize).toBe(4);
  });
  it("is exactly one line (the sidecar reads stdin line by line)", () => {
    expect(buildWriteRequest("w1", "0x200000bc", 4, "1", "0x200000bc", 4)).not.toContain("\n");
  });
});

describe("write result parsing", () => {
  it("reads a successful result with its readback", () => {
    const line = WRITE_RESULT_PREFIX + JSON.stringify({
      id: "w1", ok: true, address: "0x200000bc",
      value: "0x00000507", readback: "0x00000507",
    });
    expect(parseWriteResult(line)).toEqual({
      id: "w1", ok: true, address: "0x200000bc",
      value: "0x00000507", readback: "0x00000507",
      error: undefined, note: undefined,
    });
  });
  it("keeps the note when the firmware already rewrote the word", () => {
    const line = WRITE_RESULT_PREFIX + JSON.stringify({
      id: "w1", ok: true, value: "0x30000000", readback: "0x000002dd",
      note: "readback differs (firmware is rewriting this word)",
    });
    const r = parseWriteResult(line);
    expect(r?.ok).toBe(true);
    expect(r?.note).toMatch(/firmware is rewriting/);
  });
  it("reads a refusal reason", () => {
    const line = WRITE_RESULT_PREFIX + JSON.stringify({
      id: "w1", ok: false, error: "address 0x30000000+4 does not fit the declared symbol",
    });
    expect(parseWriteResult(line)).toMatchObject({ ok: false });
    expect(parseWriteResult(line)?.error).toMatch(/does not fit the declared symbol/);
  });
  it("ignores ordinary poll output", () => {
    expect(parseWriteResult("live_poll: 50 symbols @ 10Hz, no-halt")).toBeNull();
    expect(parseWriteResult("")).toBeNull();
  });
  it("ignores malformed or unidentifiable result lines", () => {
    expect(parseWriteResult(`${WRITE_RESULT_PREFIX}not json`)).toBeNull();
    expect(parseWriteResult(`${WRITE_RESULT_PREFIX}[]`)).toBeNull();
    expect(parseWriteResult(`${WRITE_RESULT_PREFIX}{"ok":true}`)).toBeNull();
    expect(parseWriteResult(`${WRITE_RESULT_PREFIX}{"id":"w1","ok":"yes"}`)).toBeNull();
  });
});

describe("request/response correlation", () => {
  it("delivers a result to the request that asked for it", async () => {
    const p = new PendingWrites(1000);
    const a = p.expect();
    const b = p.expect();
    expect(a.id).not.toBe(b.id);
    p.settle(`${WRITE_RESULT_PREFIX}{"id":"${b.id}","ok":true}`);
    expect((await b.done).ok).toBe(true);
    // the other request is still outstanding, not falsely completed
    let settled = false;
    void a.done.then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);
  });

  it("ignores a result whose id is not in flight", () => {
    const p = new PendingWrites(1000);
    p.expect();
    expect(p.settle(`${WRITE_RESULT_PREFIX}{"id":"w99","ok":true}`)).toBe(false);
  });

  it("gives up when the sidecar never answers", async () => {
    const p = new PendingWrites(20);
    const r = await p.expect().done;
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/did not answer/);
  });

  it("fails everything in flight when the session goes away", async () => {
    const p = new PendingWrites(10_000);
    const a = p.expect();
    const b = p.expect();
    p.abandon("session stopped");
    expect((await a.done).error).toBe("session stopped");
    expect((await b.done).error).toBe("session stopped");
  });
});
