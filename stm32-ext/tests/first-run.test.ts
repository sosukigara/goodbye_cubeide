// First-run usability: a person who has never seen this extension must be told
// what to install, in one message, before they press Build and meet
// "executable file not found".
import { describe, expect, it, vi } from "vitest";
import {
  describeMissingTools,
  firstRunDecision,
  TOOL_REQUIREMENTS,
  type ToolRequirement,
} from "../src/extension.js";

// extension.ts is the only place the preflight lives, and it imports vscode
// at module load. The mock only has to satisfy that import — nothing in these
// tests touches the host surface.
vi.mock("vscode", () => ({
  window: {
    showWarningMessage: vi.fn(async () => undefined),
    showErrorMessage: vi.fn(async () => undefined),
    showInformationMessage: vi.fn(async () => undefined),
    createOutputChannel: vi.fn(() => ({ appendLine: vi.fn(), append: vi.fn(), show: vi.fn() })),
  },
  workspace: {
    getConfiguration: () => ({ get: (_k: string, d: unknown) => d }),
    workspaceFolders: [],
  },
  commands: { executeCommand: vi.fn(), registerCommand: vi.fn() },
  Uri: { file: (p: string) => ({ fsPath: p }), parse: (p: string) => ({ toString: () => p }) },
  Range: class {},
  Selection: class {},
  Diagnostic: class {},
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2 },
  ProgressLocation: { Notification: 15 },
  QuickPickItemKind: { Separator: -1 },
}));
// The wording is the product here, so it is asserted directly rather than
// snapshotted: an unhelpful summary is exactly the failure this guards.

describe("first-run toolchain preflight", () => {
  it("says nothing is missing when everything is installed", () => {
    const r = describeMissingTools(TOOL_REQUIREMENTS, () => true);
    expect(r.missing).toHaveLength(0);
    expect(r.summary).toContain("環境 OK");
    expect(r.install).toBe("");
  });

  it("names every missing REQUIRED tool, and gives an install line for each", () => {
    // The failure this replaces: a user with no toolchain pressed Build and got
    // one opaque error at a time.
    const r = describeMissingTools(TOOL_REQUIREMENTS, () => false);
    expect(r.summary).toContain("arm-none-eabi-gcc");
    expect(r.summary).toContain("ninja");
    expect(r.summary).toContain("python3");
    // Every blocker carries a copy-pasteable command, not just a noun.
    for (const line of ["arm-none-eabi-gcc", "ninja", "python3"]) {
      expect(r.install).toContain(line);
    }
  });

  it("does not call pyocd a blocker — the build and type tree work without it", () => {
    // pyOCD only gates flash and live monitor. Calling it required made the
    // extension cry "必須ツールが未導入" on a machine that can build, and
    // contradicted the README.
    const r = describeMissingTools(TOOL_REQUIREMENTS, (n) => n !== "pyocd");
    expect(r.summary).toContain("環境 OK");
    expect(r.install).toBe("");
    // The wording must say what is lost, so "optional" does not read as
    // "you lose nothing".
    const pyocd = TOOL_REQUIREMENTS.find((t) => t.name === "pyocd");
    expect(pyocd?.required).toBe(false);
    expect(pyocd?.needed).toContain("使えません");
  });

  it("offers an install path for every platform, not just apt/brew", () => {
    // An apt-only line on Windows is both a false "not found" (the exe is
    // ninja.exe) and a command the user cannot run.
    for (const r of TOOL_REQUIREMENTS) {
      expect(r.install).toMatch(/Linux|macOS|Windows|pip install|choco/);
    }
    // Anything that is a native tool needs a Windows answer.
    for (const native of TOOL_REQUIREMENTS.filter((r) => r.install.startsWith("apt"))) {
      expect(native.install).toContain("Windows");
    }
  });

  it("does not block on an optional tool, but still names it", () => {
    // ccache is missing on plenty of machines and the build still works, just
    // slower. Reporting it as a blocker trains people to ignore the notice.
    const r = describeMissingTools(TOOL_REQUIREMENTS, (n) => n !== "ccache");
    expect(r.summary).toContain("環境 OK");
    // Named, but explicitly as optional — not folded into the blocker count.
    expect(r.summary).toContain("ccache");
    expect(r.install).toBe("");
  });

  it("keeps the optional tool out of the blocker count when everything else is present", () => {
    const r = describeMissingTools(TOOL_REQUIREMENTS, (n) => n !== "ccache");
    expect(r.summary).not.toContain("必須ツールが未導入");
    expect(r.install).toBe("");
  });

  it("every requirement states what it is for and how to install it", () => {
    // A requirement without an install command is just a complaint.
    for (const r of TOOL_REQUIREMENTS) {
      expect(r.name.length).toBeGreaterThan(0);
      expect(r.needed.length).toBeGreaterThan(0);
      expect(r.install.trim().length).toBeGreaterThan(0);
    }
  });

  it("shows the notice again until the environment is actually complete", () => {
    // The bug: the "seen it" flag was written unconditionally, so a user who
    // dismissed the notice never saw it again — not even after installing half
    // of what was missing. That is exactly backwards: nagging is correct while
    // the problem is still there.
    const blocker: ToolRequirement = {
      name: "ninja", needed: "ビルド", install: "apt install ninja-build", required: true,
    };
    // Never shown before, something missing -> show, and do NOT mark done.
    expect(firstRunDecision(undefined, [blocker])).toEqual({ show: true, markDone: false });
    // Still missing on a later launch -> show again.
    expect(firstRunDecision(true, [blocker])).toEqual({ show: true, markDone: false });
    // Nothing missing -> silent, and this is the one case that marks done.
    expect(firstRunDecision(undefined, [])).toEqual({ show: false, markDone: true });
    // Already done and still fine -> never speak again.
    expect(firstRunDecision(true, [])).toEqual({ show: false, markDone: false });
  });

  it("only marks done when nothing required is missing", () => {
    // An optional tool alone must not suppress the check, nor clear the flag
    // while a required one is still absent.
    const opt: ToolRequirement = {
      name: "ccache", needed: "キャッシュ", install: "apt install ccache", required: false,
    };
    const req: ToolRequirement = {
      name: "ninja", needed: "ビルド", install: "apt install ninja-build", required: true,
    };
    expect(firstRunDecision(undefined, [req]).markDone).toBe(false);
    expect(firstRunDecision(undefined, [opt, req]).markDone).toBe(false);
    // The decision takes BLOCKERS, so an optional-only list means all clear.
    expect(firstRunDecision(undefined, []).markDone).toBe(true);
  });
});
