// First-run usability: a person who has never seen this extension must be told
// what to install, in one message, before they press Build and meet
// "executable file not found".
import { describe, expect, it, vi } from "vitest";
import {
  firstRunMessage,
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

  it("keeps reminding while a required tool is still missing", () => {
    // The original bug: a "seen it" flag was written to globalState but never
    // read to suppress anything, so it was ceremony — and its comment claimed
    // it stopped nagging a returning user, which it did not. Before that, the
    // flag was written unconditionally and a user who dismissed the notice
    // never heard about the tool again, not even after installing half of it.
    // Nudging while the problem persists is the correct behaviour, so there is
    // deliberately no stored state: the answer depends only on the blockers.
    const blocker: ToolRequirement = {
      name: "ninja", needed: "ビルド", install: "apt install ninja-build", required: true,
    };
    expect(firstRunDecision([blocker])).toBe(true);
    expect(firstRunDecision([])).toBe(false);
    // Same answer on the tenth launch as on the first — that is the point.
    expect(firstRunDecision([blocker])).toBe(true);
  });

  it("ignores an optional tool, which is not worth a notice", () => {
    // ccache is missing on plenty of machines and the build still works.
    // Notifying about it trains people to dismiss the notice.
    const opt: ToolRequirement = {
      name: "ccache", needed: "キャッシュ", install: "apt install ccache", required: false,
    };
    // The decision is fed BLOCKERS, so an optional-only list reads as clear.
    expect(firstRunDecision([])).toBe(false);
    // ...and describeMissingTools is what does the filtering.
    expect(describeMissingTools([opt], () => false).summary).toContain("環境 OK");
  });

  it("keeps the user-facing text one line, because a toast collapses newlines", () => {
    // VS Code renders a notification as a single row: every "\n" in the
    // message is dropped. The install block used to be embedded in both the
    // first-run warning and 診断, so "which tool, and what do I type" was
    // formatted carefully and then thrown away unreadable.
    const req = (name: string): ToolRequirement => ({
      name, needed: "用途", install: "apt install x", required: true,
    });
    // The install text is multi-line by design — that is why it must NOT be
    // the notification body.
    const install = describeMissingTools([req("ninja"), req("python3")], () => false).install;
    expect(install).toContain("\n");
    // The message the user actually sees is one line, and names the tools.
    const msg = firstRunMessage([req("ninja"), req("python3")]);
    expect(msg).not.toContain("\n");
    expect(msg).toContain("ninja");
    expect(msg).toContain("python3");
    // It must not smuggle the command block back in.
    expect(msg).not.toContain("apt install");
  });
});
