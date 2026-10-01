// Audit round 1 (host): regression tests for the 6 confirmed host defects.
// Extension-side defects pin the fixed source shape (the established
// source-text harness style); poller/manager defects are behavioral.
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Hoisted so the write-gate tests below can drive the dialog per case: a
// dismissal resolves undefined, a confirmation echoes back the confirm item.
const vs = vi.hoisted(() => ({
  showWarning: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined),
}));

vi.mock("vscode", () => ({
  window: {
    showWarningMessage: vs.showWarning,
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showQuickPick: vi.fn(),
    showInputBox: vi.fn(),
    showSaveDialog: vi.fn(),
    createOutputChannel: vi.fn(),
  },
  workspace: {
    getConfiguration: () => ({ get: (key: string, dflt: unknown) => dflt }),
    workspaceFolders: [],
  },
  Uri: { file: (p: string) => ({ fsPath: p }) },
  Range: class {},
  Selection: class {},
  Diagnostic: class {},
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2 },
  ProgressLocation: { Notification: 15 },
  QuickPickItemKind: { Separator: -1 },
}));

import { LivePanelProvider } from "../src/extension.js";
import { MOTOR_DRIVE_WARNING } from "../src/live/allowlist.js";
import type { ElfResolution } from "../src/live/elfResolver.js";
import { resolveWatchlist } from "../src/live/manager.js";
import { decodeValue, type LeafMeta } from "../src/live/poller.js";
import { WRITE_RESULT_PREFIX } from "../src/live/writeChannel.js";

const here = dirname(fileURLToPath(import.meta.url));
const extensionSource = readFileSync(join(here, "../src/extension.ts"), "utf8");

function methodBody(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  expect(start, `missing ${startMarker}`).toBeGreaterThan(-1);
  const end = source.indexOf(endMarker, start);
  expect(end, `missing ${endMarker} after ${startMarker}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

const CHANNEL = { appendLine: (): void => { /* test sink */ } } as unknown as
  import("vscode").OutputChannel;

function fakeWebview(posted: unknown[]): import("vscode").Webview {
  return {
    postMessage: (msg: unknown): void => {
      posted.push(msg);
    },
  } as unknown as import("vscode").Webview;
}

describe("audit1 defect 1: pause does not survive stop/restart", () => {
  it("startSession clears a stale display pause at the session boundary", () => {
    // pause → stop → start left the table frozen (!this.paused in the tail
    // path) while status said "running": neither stop() nor startSession()
    // reset the flag.
    const body = methodBody(
      extensionSource, "private async startSession(origin", "private async spawnPoll(");
    expect(body).toContain("this.paused = false");
  });
});

describe("audit1 defect 2: sidebar webviews do not leak into post targets", () => {
  it("resolveWebviewView unregisters every post target on dispose", () => {
    // Every re-resolve handed a NEW webview to the build panel's target Set
    // (and the live/graph single slots) with no removal: dead views kept
    // receiving every build-progress post.
    const body = methodBody(
      extensionSource,
      "resolveWebviewView(view: vscode.WebviewView)",
      "private post(msg: unknown)",
    );
    expect(body).toContain("view.onDidDispose");
    expect(body).toContain("buildPanel.removePostTarget(view.webview)");
    expect(body).toContain("livePanel.removePostTarget(view.webview)");
    expect(body).toContain("graphPanel.removeSidebarTarget(view.webview)");
  });
});

describe("audit1 defect 3: startSession race with stop()", () => {
  it("stop() bumps a generation that an in-flight startSession() honors", () => {
    // startSession() is fired as `void` and awaits across probe/nm/claim;
    // a stop() in that window was overwritten when the start continued and
    // spawned the child anyway (probe lock held by a stopped session).
    const stopBody = methodBody(
      extensionSource, "async stop(): Promise<void> {", "private waitForExit(");
    expect(stopBody).toContain("this.sessionGen += 1");
    const startBody = methodBody(
      extensionSource, "private async startSession(origin", "private async spawnPoll(");
    expect(startBody).toContain("const gen = this.sessionGen");
    expect(startBody).toContain("gen !== this.sessionGen");
  });
});

describe("audit1 defect 4: a leaf named __proto__ survives the type index", () => {
  it("every live-types index map is null-prototype, never a {} literal", () => {
    // index["__proto__"] = meta on a {} literal mutates the prototype: no own
    // key, so JSON.stringify silently drops the leaf for the webview.
    expect(extensionSource).not.toContain("Record<string, LeafMeta> = {}");
    expect(extensionSource).toContain("Record<string, LeafMeta> = Object.create(null)");
  });

  it("sendTypesTo delivers a leaf literally named __proto__", () => {
    const panel = new LivePanelProvider(CHANNEL);
    const res: ElfResolution = {
      elf: "build-ext/fw.elf",
      base: "0x20000000",
      size: 16,
      end: "0x20000010",
      hasDebugInfo: true,
      backend: "pyelftools",
      symbols: [
        { name: "__proto__", address: "0x20000000", offset: 0, size: 4, type: "uint32_t", kind: "scalar", signed: false },
        { name: "sys.ok", address: "0x20000004", offset: 4, size: 4, type: "uint32_t", kind: "scalar", signed: false },
      ],
      unresolved: [],
    };
    panel.setResolution(res, "STM32G474RETx");
    const posted: unknown[] = [];
    panel.sendTypesTo(fakeWebview(posted));
    const types = posted.find(
      (m) => (m as { kind?: string }).kind === "live-types",
    ) as { index: Record<string, LeafMeta> } | undefined;
    expect(types).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(types?.index, "__proto__")).toBe(true);
    expect(JSON.stringify(types?.index)).toContain("__proto__");
    expect(Object.prototype.hasOwnProperty.call(types?.index, "sys.ok")).toBe(true);
  });
});

describe("audit1 defect 5: decodeValue never throws on a non-4/8-byte float", () => {
  it("a 2-byte float falls back to raw hex with a type-unknown note", () => {
    const half: LeafMeta = { size: 2, kind: "float", signed: true, type: "float" };
    expect(() => decodeValue("0x3c00", half)).not.toThrow();
    expect(decodeValue("0x3c00", half)).toBe("0x3c00 (型不明)");
  });

  it("an over-wide float is not decoded from its first 4 bytes", () => {
    const wide: LeafMeta = { size: 16, kind: "float", signed: true, type: "float" };
    expect(decodeValue("0x00000000000000000000000000000000", wide))
      .toBe("0x00000000000000000000000000000000 (型不明)");
  });

  it("4/8-byte floats and strings still decode (no behavior change)", () => {
    const f4: LeafMeta = { size: 4, kind: "float", signed: true, type: "float" };
    expect(decodeValue("0x3f800000", f4)).toBe("1.00000");
    const f8: LeafMeta = { size: 8, kind: "float", signed: true, type: "double" };
    expect(decodeValue("0x3ff0000000000000", f8)).toBe("1.00000");
    const s: LeafMeta = { size: 2, kind: "string", signed: false, type: "char[2]", length: 2 };
    expect(decodeValue("0x4241", s)).toBe("AB");
  });
});

describe("audit1 defect 6: a watched GROUP name is not reported as unresolved", () => {
  const GROUP_RES: ElfResolution = {
    elf: "build-ext/fw.elf",
    base: "0x20000000",
    size: 64,
    end: "0x20000040",
    hasDebugInfo: true,
    backend: "pyelftools",
    symbols: [
      { name: "measure.a", address: "0x20000000", offset: 0, size: 4, type: "float", kind: "float", signed: true },
      { name: "measure.b", address: "0x20000004", offset: 4, size: 4, type: "float", kind: "float", signed: true },
      { name: "measure.arr[0]", address: "0x20000008", offset: 8, size: 4, type: "float", kind: "float", signed: true },
      { name: "measure.arr[1]", address: "0x2000000c", offset: 12, size: 4, type: "float", kind: "float", signed: true },
      { name: "sys.hz", address: "0x20000010", offset: 16, size: 4, type: "uint32_t", kind: "scalar", signed: false },
    ],
    unresolved: [],
  };

  it("a group name is neither a bogus --extra nor unresolved, even when nm knows it", () => {
    // Exact-match resolution missed the struct name; nm then produced a wrong
    // 4-byte poll of a whole struct (or the name landed in unresolved).
    const r = resolveWatchlist(["measure"], GROUP_RES, () => "0x20000100");
    expect(r.extras).toEqual([]);
    expect(r.unresolved).toEqual([]);
  });

  it("array groups, exact leaves and true unknowns keep their meanings", () => {
    const r = resolveWatchlist(["measure.arr", "sys.hz", "ghost"], GROUP_RES, () => undefined);
    expect(r.extras).toEqual([]);
    expect(r.unresolved).toEqual(["ghost"]);
  });
});

// The highest-severity audit finding: the live-write path had no confirmation
// gate at all. writeFlow passed `confirmed: true` to decideWrite and reached
// sendWrite with no dialog, so pressing Enter in the Variables tab wrote the
// MCU immediately and a motor-drive variable never warned — while
// README.md:149 / README.md:207 / allowlist.ts:15 all promise a modal gate
// showing the current and the new value.
const WRITE_RES: ElfResolution = {
  elf: "build-ext/wf.elf",
  base: "0x20000100",
  size: 8,
  end: "0x20000108",
  hasDebugInfo: true,
  backend: "pyelftools",
  symbols: [
    { name: "sys.gain", address: "0x20000100", offset: 0, size: 4, type: "float", kind: "float", signed: true },
    { name: "drive.drive_mode", address: "0x20000104", offset: 4, size: 4, type: "uint32_t", kind: "scalar", signed: false },
  ],
  unresolved: [],
};

interface WriteHarness {
  readonly lines: string[];
  readonly posted: unknown[];
  /** Every request line that reached the sidecar's stdin. */
  readonly requests: string[];
  write(name: string, value: string): Promise<void>;
  /** The text the confirm dialog was shown with, or "" if it never appeared. */
  dialog(): string;
  dialogOptions(): unknown;
  results(): { name: string; ok: boolean; message: string }[];
}

async function writeHarness(): Promise<WriteHarness> {
  const lines: string[] = [];
  const posted: unknown[] = [];
  const requests: string[] = [];
  const live = new LivePanelProvider({
    appendLine: (l: string): void => {
      lines.push(l);
    },
  } as unknown as import("vscode").OutputChannel);
  live.setPostTarget(fakeWebview(posted));
  live.setResolution(WRITE_RES, "STM32F4");
  // setResolution fires `void startSession()`; with no scriptsDir configured it
  // returns before spawning, but it must finish before the fake child lands or
  // its stop() would clear the child and abandon the pending write.
  await new Promise((r) => setTimeout(r, 0));
  const internals = live as unknown as {
    child: { stdin: { write(line: string, cb: (err: Error | null) => void): void }; destroyed: boolean };
    pendingWrites: { settle(line: string): boolean };
    writeFlow(name: string, value: string): Promise<void>;
  };
  internals.child = {
    destroyed: false,
    stdin: {
      write: (line: string, cb: (err: Error | null) => void): void => {
        requests.push(line);
        // Answer exactly the way spawnPoll's stdout handler does, so the awaited
        // sendWrite resolves instead of hanging on its 3s timeout.
        const { id } = JSON.parse(line) as { id: string };
        internals.pendingWrites.settle(`${WRITE_RESULT_PREFIX}${JSON.stringify({
          id, ok: true, address: "0x20000100", value: "0x40200000", readback: "0x40200000",
        })}`);
        cb(null);
      },
    },
  };
  live.pushSamples([
    { timestamp: "t0", address: "0x20000100", name: "sys.gain", value: "0x3f800000" },
    { timestamp: "t0", address: "0x20000104", name: "drive.drive_mode", value: "0x00000000" },
  ]);
  const calls = (): unknown[][] => vs.showWarning.mock.calls as unknown[][];
  return {
    lines,
    posted,
    requests,
    write: (name, value) => internals.writeFlow(name, value),
    dialog: () => String(calls()[0]?.[0] ?? ""),
    dialogOptions: () => calls()[0]?.[1],
    results: () => posted
      .filter((m) => (m as { kind?: string }).kind === "live-write-result")
      .map((m) => m as { name: string; ok: boolean; message: string }),
  };
}

describe("audit defect: the live-write path committed with no modal gate", () => {
  it("dismissing the modal refuses the write, dispatches nothing and audits it", async () => {
    const h = await writeHarness();
    vs.showWarning.mockClear();
    vs.showWarning.mockResolvedValueOnce(undefined);
    await h.write("sys.gain", "2.5");
    expect(h.requests).toEqual([]);
    const refused = h.lines.filter((l) => l.includes("[live-write]") && l.includes("REFUSED"));
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatch(/confirmation/);
    expect(h.results()).toEqual([
      expect.objectContaining({ name: "sys.gain", ok: false }),
    ]);
  });

  it("confirming the modal dispatches exactly one write", async () => {
    const h = await writeHarness();
    vs.showWarning.mockClear();
    vs.showWarning.mockImplementationOnce(async (...args: unknown[]): Promise<unknown> => {
      const items = args.slice(2).filter((a): a is string => typeof a === "string");
      return items[items.length - 1];
    });
    await h.write("sys.gain", "2.5");
    expect(vs.showWarning).toHaveBeenCalledTimes(1);
    // Modal, not a toast: a non-modal warning is dismissible by clicking away
    // and would not be a gate at all.
    expect(h.dialogOptions()).toMatchObject({ modal: true });
    expect(h.requests).toHaveLength(1);
    expect(JSON.parse(h.requests[0] ?? "")).toMatchObject({
      op: "write", address: "0x20000100", size: 4, value: "1075838976",
    });
    expect(h.results()).toEqual([expect.objectContaining({ name: "sys.gain", ok: true })]);
  });

  it("the dialog shows the name, the decoded current value and the decoded new value", async () => {
    const h = await writeHarness();
    vs.showWarning.mockClear();
    vs.showWarning.mockResolvedValueOnce(undefined);
    await h.write("sys.gain", "2.5");
    const message = h.dialog();
    expect(message).toContain("sys.gain");
    expect(message).toContain("1.00000"); // current value, decoded by the table's decoder
    expect(message).toContain("2.5"); // new value, as the user typed it
    expect(message).toContain("0x40200000"); // and the hex the sidecar will move
  });

  it("a motor path leads the dialog with the motor-drive warning", async () => {
    const h = await writeHarness();
    vs.showWarning.mockClear();
    vs.showWarning.mockResolvedValueOnce(undefined);
    await h.write("drive.drive_mode", "1");
    expect(h.dialog().startsWith(MOTOR_DRIVE_WARNING)).toBe(true);
    expect(h.dialog()).toContain("drive.drive_mode");
    expect(h.requests).toEqual([]);
  });

  it("a name outside the motor heuristic gets no motor warning", async () => {
    const h = await writeHarness();
    vs.showWarning.mockClear();
    vs.showWarning.mockResolvedValueOnce(undefined);
    await h.write("sys.gain", "2.5");
    expect(h.dialog()).not.toContain(MOTOR_DRIVE_WARNING);
  });
});
