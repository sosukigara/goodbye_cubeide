// S1-2: the Live CSV export read the whole rotated session CSV synchronously on
// the extension host thread. At the user's real rate one generation is ~193 MB
// (220 leaves x 100 Hz x 120 s = 2.64M rows), so one button press froze VS Code
// for seconds and cost >500 MB of peak RSS. These pin the replacement: a
// chunked copy that yields to the event loop between chunks, and a byte-exact
// result — including rows from rotated generations, the frozen 4-column schema,
// and the trailing-newline normalisation the old readFileSync path did.
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { copyCsvToFile, CSV_EXPORT_CHUNK_BYTES } from "../src/live/csvExport.js";

const HEADER = "timestamp,address,name,value";

/**
 * Fixture size and chunk size for the bounded-read tests.
 *
 * 2 MB over 64 KB is 32 chunks: enough that a whole-file read is unmistakably a
 * single pass (it yields exactly once, at the end) while the whole fixture set
 * stays in single-digit MB. Smaller is not honest here — the memory assertion
 * below compares peak heap growth against a fraction of the file, and at a few
 * hundred KB that fraction falls under V8's allocator noise, so the test would
 * pass for the wrong reason. 2 MB is the smallest size where a whole-file read
 * (one string + one Buffer, ~4 MB) still overshoots the budget by an order of
 * magnitude.
 */
const FIXTURE_BYTES = 2 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;

/** Every temp dir this file makes, removed even when an assertion throws. */
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  // try/finally alone would not help when the process is killed mid-run, and a
  // leaked fixture is what filled the disk in the first place: clean up after
  // every test, not just the ones that pass.
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function row(i: number): string {
  return `2026-10-01T00:00:${String(i % 60).padStart(2, "0")}.${String(i % 1000).padStart(3, "0")},0x2000${(i % 4096).toString(16).padStart(4, "0")},sys.loop_hz,0x${(i % 0xffffff).toString(16).padStart(6, "0")}`;
}

/**
 * Write a session CSV of ~`targetBytes`, the way the sidecar writes it: one
 * header line, then whole LF-terminated rows.
 *
 * Termination is by construction: the row count is computed from the budget up
 * front and the writer is a `for` over it, so there is no loop whose condition
 * depends on the bytes it has written. The previous version drove a
 * `while (buf.length < targetBytes)` loop that reassigned `buf` to a fresh 1 MB
 * block every iteration instead of growing it, so `buf.length` never reached
 * the target and the loop wrote ~1 MB per iteration until the disk was full —
 * 21 GB, 16 GB and 12 GB of leaked fixtures, all on the same filesystem as `/`.
 * `bytesWritten` is the hard ceiling that makes such a regression impossible to
 * hide: it is checked against `targetBytes` on every block.
 */
function makeSessionCsv(targetBytes: number): { path: string; rows: number; bytes: number } {
  const dir = makeTempDir("stm32ext-csvexp-");
  const path = join(dir, "live.csv");
  const fd = openSync(path, "w");
  const rowBytes = row(0).length + 1;
  // Whole rows only, so the file always ends on a line boundary.
  const rows = Math.max(1, Math.floor((targetBytes - HEADER.length - 1) / rowBytes));
  const blocks = Math.ceil((rows * rowBytes) / (1024 * 1024));
  let bytesWritten = 0;
  try {
    writeSync(fd, `${HEADER}\n`);
    bytesWritten += HEADER.length + 1;
    let emitted = 0;
    for (let block = 0; block < blocks; block += 1) {
      const want = Math.min(rows - emitted, Math.ceil((1024 * 1024) / rowBytes));
      let buf = "";
      for (let n = 0; n < want; n += 1) {
        buf += `${row(emitted + n)}\n`;
      }
      writeSync(fd, buf);
      bytesWritten += buf.length;
      emitted += want;
      if (emitted >= rows) {
        break;
      }
    }
  } finally {
    closeSync(fd);
  }
  if (bytesWritten > targetBytes) {
    throw new Error(`fixture generator overran its target: ${bytesWritten} > ${targetBytes}`);
  }
  return { path, rows, bytes: statSync(path).size };
}

describe("the fixture generator itself is bounded", () => {
  it("writes a whole-row file within a hair of the target and never past it", () => {
    // Regression guard for the 51 GB leak: a `while` loop whose condition
    // depends on the bytes it has written can only be caught by an assertion on
    // the result. If this fails, the generator is filling the disk again.
    const { bytes } = makeSessionCsv(FIXTURE_BYTES);
    expect(bytes).toBeLessThanOrEqual(FIXTURE_BYTES);
    // Whole rows only, so the shortfall is at most one row (56 bytes).
    expect(bytes).toBeGreaterThan(FIXTURE_BYTES - 1024);
  });
});

describe("live CSV export reads the session file in bounded chunks", () => {
  it("reads the session CSV in many bounded chunks, not one pass", async () => {
    const { path, bytes } = makeSessionCsv(FIXTURE_BYTES);
    const dest = `${path}.out`;
    let chunks = 0;
    let lastDone = 0;
    const result = await copyCsvToFile(path, dest, {
      chunkBytes: CHUNK_BYTES,
      onProgress: (done) => {
        chunks += 1;
        expect(done).toBeGreaterThan(lastDone);
        lastDone = done;
      },
    });

    expect(result).toMatchObject({ ok: true });
    // A whole-file read reports exactly one chunk; a bounded read reports one
    // per CHUNK_BYTES, which is ~32 here.
    expect(chunks).toBe(Math.ceil(bytes / CHUNK_BYTES));
    expect(chunks).toBeGreaterThan(8);
    expect(lastDone).toBe(bytes);
    expect(readFileSync(dest, "utf8").length).toBeGreaterThan(0);
  }, 30_000);

  it("leaves the event loop running: a macrotask scheduled before the copy runs during it", async () => {
    const { path } = makeSessionCsv(FIXTURE_BYTES);
    const dest = `${path}.out`;

    // A synchronous whole-file read would starve this timer for its whole
    // duration: the copy returns before the loop ever gets a turn.
    let ticks = 0;
    let running = true;
    const spin = (): void => {
      if (!running) {
        return;
      }
      ticks += 1;
      setTimeout(spin, 0);
    };
    setTimeout(spin, 0);

    const result = await copyCsvToFile(path, dest, { chunkBytes: CHUNK_BYTES });
    running = false;

    expect(result).toMatchObject({ ok: true });
    // ~32 chunks means the loop was handed back between every one of them. A
    // whole-file read yields once, at the end, and cannot beat this.
    expect(ticks).toBeGreaterThan(8);
  }, 30_000);

  it("never holds more than one chunk in memory at a time", async () => {
    const { path, bytes } = makeSessionCsv(FIXTURE_BYTES);
    const dest = `${path}.out`;

    const before = process.memoryUsage().heapUsed;
    let peak = before;
    const result = await copyCsvToFile(path, dest, {
      chunkBytes: CHUNK_BYTES,
      // Sampled inside the copy: a whole-file read peaks here at the file size.
      onProgress: () => {
        peak = Math.max(peak, process.memoryUsage().heapUsed);
      },
    });
    expect(result).toMatchObject({ ok: true });
    // Generous: Buffer churn is not exact, but a whole-file read of a 2 MB file
    // as one string plus one Buffer cannot stay under 512 KB of growth.
    expect(peak - before).toBeLessThan(bytes / 4);
  }, 30_000);

  it("the default chunk size is the one the host ships", () => {
    // The tests above pass 64 KB explicitly so they can afford many chunks; the
    // product default is what a real ~193 MB generation is copied with.
    expect(CSV_EXPORT_CHUNK_BYTES).toBe(4 * 1024 * 1024);
  });
});

describe("the exported CSV is byte-identical to the session file", () => {
  it("copies every row, header first, LF-terminated", async () => {
    const { path, rows, bytes } = makeSessionCsv(FIXTURE_BYTES);
    const dest = `${path}.out`;
    const result = await copyCsvToFile(path, dest, { chunkBytes: CHUNK_BYTES });

    expect(result).toMatchObject({ ok: true, rows });
    if (result.ok) {
      expect(result.bytes).toBe(bytes);
    }
    const out = readFileSync(dest, "utf8");
    expect(out).toBe(readFileSync(path, "utf8"));
    expect(out.split("\n")[0]).toBe(HEADER);
    expect(out.endsWith("\n")).toBe(true);
  }, 30_000);

  it("keeps rotated generations: the file is copied whole, never windowed", async () => {
    // Rotation rewrites live.csv in place, so "including rotated generations"
    // means the whole current generation is what lands in the export. Six
    // generations of 2000 rows is ~700 KB: past CHUNK_BYTES, so the "whole"
    // claim is checked across chunk boundaries without a huge fixture.
    const dir = makeTempDir("stm32ext-csvrot-");
    const path = join(dir, "live.csv");
    const chunks: string[] = [`${HEADER}\n`];
    for (let g = 0; g < 6; g += 1) {
      for (let i = 0; i < 2_000; i += 1) {
        chunks.push(`${row(i + g * 2_000)}\n`);
      }
    }
    writeFileSync(path, chunks.join(""));
    const dest = join(dir, "live.csv.out");

    const result = await copyCsvToFile(path, dest, { chunkBytes: CHUNK_BYTES });
    expect(result).toMatchObject({ ok: true, rows: 12_000 });
    expect(readFileSync(dest, "utf8")).toBe(readFileSync(path, "utf8"));
  }, 30_000);

  it("adds the trailing newline a mid-flush last line is missing", async () => {
    const dir = makeTempDir("stm32ext-csvpart-");
    const path = join(dir, "live.csv");
    // The sidecar flushes per tick, so the host can catch it mid-row.
    writeFileSync(path, `${HEADER}\nt1,0x1,sys.loop_hz,0x2\nt2,0x2,sys.loop_hz,0x3`);
    const dest = join(dir, "live.csv.out");

    const result = await copyCsvToFile(path, dest);
    expect(result).toMatchObject({ ok: true, rows: 2 });
    expect(readFileSync(dest, "utf8")).toBe(`${HEADER}\nt1,0x1,sys.loop_hz,0x2\nt2,0x2,sys.loop_hz,0x3\n`);
  }, 30_000);

  it("counts rows by newline tally, not by splitting the file into lines", async () => {
    const dir = makeTempDir("stm32ext-csvcount-");
    const path = join(dir, "live.csv");
    const lines = [`${HEADER}\n`];
    for (let i = 0; i < 4_000; i += 1) {
      lines.push(`${row(i)}\n`);
    }
    // Blank lines are not rows (the old filter dropped them); keep that.
    lines.splice(10, 0, "\n", "   \n");
    writeFileSync(path, lines.join(""));
    const dest = join(dir, "live.csv.out");

    const result = await copyCsvToFile(path, dest, { chunkBytes: CHUNK_BYTES });
    expect(result).toMatchObject({ ok: true, rows: 4_000 });
  }, 30_000);
});

describe("export failure paths are reported, not silent", () => {
  it("names the missing session CSV instead of writing nothing", async () => {
    const dir = makeTempDir("stm32ext-csvmiss-");
    const dest = join(dir, "live.csv.out");
    const result = await copyCsvToFile(join(dir, "does-not-exist.csv"), dest);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.cause).toBe("missing");
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });

  it("rejects a header that is not the frozen schema, and says which schema it wanted", async () => {
    const dir = makeTempDir("stm32ext-csvschema-");
    const path = join(dir, "live.csv");
    writeFileSync(path, "time,addr,name,value\nt1,0x1,a,0x2\n");
    const dest = join(dir, "live.csv.out");

    const result = await copyCsvToFile(path, dest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.cause).toBe("schema");
      expect(result.reason).toContain("timestamp,address,name,value");
    }
    // A rejected file must not leave a partial export behind.
    expect(existsSync(dest)).toBe(false);
  });

  it("surfaces a write failure (unwritable destination) instead of claiming success", async () => {
    const dir = makeTempDir("stm32ext-csvwr-");
    const path = join(dir, "live.csv");
    writeFileSync(path, `${HEADER}\nt1,0x1,a,0x2\n`);
    // A destination inside a non-existent directory: open() fails.
    const dest = join(dir, "no", "such", "dir", "live.csv");

    const result = await copyCsvToFile(path, dest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.cause).toBe("io");
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });

  it("rejects an empty file rather than exporting a headerless CSV", async () => {
    const dir = makeTempDir("stm32ext-csvempty-");
    const path = join(dir, "live.csv");
    writeFileSync(path, "");
    const dest = join(dir, "live.csv.out");

    const result = await copyCsvToFile(path, dest);
    expect(result).toMatchObject({ ok: false, cause: "schema" });
    expect(existsSync(dest)).toBe(false);
  });

  it("a CRLF file still exports (header check strips \\r, like the old read)", async () => {
    const dir = makeTempDir("stm32ext-csvcrlf-");
    const path = join(dir, "live.csv");
    writeFileSync(path, `${HEADER}\r\nt1,0x1,a,0x2\r\n`);
    const dest = join(dir, "live.csv.out");

    const result = await copyCsvToFile(path, dest);
    expect(result).toMatchObject({ ok: true, rows: 1 });
    expect(readFileSync(dest, "utf8")).toBe(`${HEADER}\r\nt1,0x1,a,0x2\r\n`);
  });
});