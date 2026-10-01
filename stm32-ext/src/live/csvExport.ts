// Live CSV export: the session CSV -> the workspace copy. Kept vscode-free so
// the chunking contract (bounded reads, event-loop yields, byte-exact copy) is
// testable without a VSCode host. src/extension.ts owns the UI around it.

import { closeSync, fstatSync, openSync, readSync, unlinkSync, writeSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { assertCsvHeader } from "./poller.js";

/** Read/write granularity of the copy. One chunk is one event-loop stall. */
export const CSV_EXPORT_CHUNK_BYTES = 4 * 1024 * 1024;

export interface CsvCopyOptions {
  /** Chunk size; defaults to CSV_EXPORT_CHUNK_BYTES. */
  readonly chunkBytes?: number;
  /** Called after every chunk with (bytes copied, total bytes). */
  readonly onProgress?: (bytesDone: number, bytesTotal: number) => void;
}

export type CsvCopyFailure =
  /** The session CSV is not there (no session, or the sidecar never wrote it). */
  | "missing"
  /** First line is not the frozen schema, so the file is not exportable. */
  | "schema"
  /** The copy itself failed (source vanished mid-read, destination unwritable). */
  | "io";

export type CsvCopyResult =
  | { readonly ok: true; readonly rows: number; readonly bytes: number }
  | { readonly ok: false; readonly cause: CsvCopyFailure; readonly reason: string };

/** Non-blank lines in a newline-terminated block. Blank lines are not rows. */
function countRows(block: string): number {
  let n = 0;
  for (const line of block.split("\n")) {
    if (line.trim() !== "") {
      n += 1;
    }
  }
  return n;
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Hand the loop back so timers, IPC and rendering run between chunks. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * Copy the session CSV to `dest` in bounded chunks, yielding to the event loop
 * between them, and report how many data rows landed.
 *
 * The destination is the whole current generation of `src`: rotation rewrites
 * live.csv in place, so copying it whole is what "including rotated
 * generations" means. Bytes are copied verbatim (CRLF included); the only
 * normalisation is the single trailing "\n" the old readFileSync path added, so
 * a file caught mid-flush still ends on a line boundary.
 *
 * The first chunk's header is validated before any byte reaches `dest`, so a
 * file that is not the frozen schema never leaves a partial export behind.
 */
export async function copyCsvToFile(
  src: string,
  dest: string,
  opts: CsvCopyOptions = {},
): Promise<CsvCopyResult> {
  const chunkBytes = opts.chunkBytes ?? CSV_EXPORT_CHUNK_BYTES;
  let srcFd: number;
  let total: number;
  try {
    srcFd = openSync(src, "r");
    total = fstatSync(srcFd).size;
  } catch (err) {
    return { ok: false, cause: "missing", reason: reason(err) };
  }

  const decoder = new StringDecoder("utf8");
  const chunk = Buffer.allocUnsafe(chunkBytes);
  /** Opened only once the header is known good: -1 means "never opened". */
  let destFd = -1;
  let readPos = 0;
  let wroteAnything = false;
  let finished = false;
  let rows = 0;
  let headerChecked = false;
  /** Text after the last newline: the head of a line the next chunk completes. */
  let carry = "";

  try {
    while (readPos < total) {
      const want = Math.min(chunkBytes, total - readPos);
      const got = readSync(srcFd, chunk, 0, want, readPos);
      if (got <= 0) {
        break;
      }
      const view = chunk.subarray(0, got);
      readPos += got;

      const text = carry + decoder.write(view);
      const nl = text.lastIndexOf("\n");
      const complete = nl < 0 ? "" : text.slice(0, nl + 1);
      carry = nl < 0 ? text : text.slice(nl + 1);

      if (!headerChecked) {
        // A first line with no newline yet is still in `carry`, not `complete`.
        const firstNl = complete.indexOf("\n");
        const header = (firstNl < 0 ? carry : complete.slice(0, firstNl)).replace(/\r$/, "");
        try {
          assertCsvHeader(header);
        } catch (err) {
          return { ok: false, cause: "schema", reason: reason(err) };
        }
        headerChecked = true;
        rows += firstNl < 0 ? 0 : countRows(complete.slice(firstNl + 1));
      } else {
        rows += countRows(complete);
      }

      if (destFd < 0) {
        destFd = openSync(dest, "w");
      }
      let off = 0;
      while (off < got) {
        off += writeSync(destFd, view, off, got - off);
      }
      wroteAnything = true;
      opts.onProgress?.(readPos, total);
      await yieldToEventLoop();
    }

    if (!headerChecked) {
      // Empty, or a first line that never got its newline: not the schema.
      try {
        assertCsvHeader("");
      } catch (err) {
        return { ok: false, cause: "schema", reason: reason(err) };
      }
    }
    finished = true;

    // The sidecar flushes per tick, so the host can catch it mid-row: that
    // trailing fragment is a row, and it is the one that needs the "\n".
    const tail = carry + decoder.end();
    let bytes = fstatSync(destFd).size;
    if (tail.trim() !== "") {
      rows += 1;
      writeSync(destFd, "\n");
      bytes += 1;
    }
    return { ok: true, rows, bytes };
  } catch (err) {
    return { ok: false, cause: "io", reason: reason(err) };
  } finally {
    if (destFd >= 0) {
      closeSync(destFd);
    }
    closeSync(srcFd);
    if (destFd >= 0 && wroteAnything && !finished) {
      // Half a copy is worse than none: drop the truncated export.
      try {
        unlinkSync(dest);
      } catch {
        // Nothing to clean up.
      }
    }
  }
}
