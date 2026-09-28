// First-run usability: a person who has never seen this extension must be told
// what to install, in one message, before they press Build and meet
// "executable file not found".
import { describe, expect, it, vi } from "vitest";
import {
  firstRunMessage,
  describeMissingTools,
  TOOL_REQUIREMENTS,
  toolInstalledSync,
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

  it("does not let an optional tool become a notice", () => {
    // ccache is missing on plenty of machines and the build still works.
    // Notifying about it trains people to dismiss the notice. activate() acts
    // on `missing.filter(required)`, so the filtering has to happen here.
    const opt: ToolRequirement = {
      name: "ccache", needed: "キャッシュ", install: "apt install ccache", required: false,
    };
    expect(describeMissingTools([opt], () => false).summary).toContain("環境 OK");
    expect(describeMissingTools([opt], () => false).missing.filter((m) => m.required)).toHaveLength(0);
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

describe("setup: the synchronous probe must not misjudge import-only tools", () => {
  it("never counts pyelftools as missing, though it ships no executable", () => {
    // pyelftools has no console script, so resolveTool reports "missing" for
    // it on every machine. If that fed `tools.missing`, setup would start on
    // every launch and re-run pip against the network every time.
    expect(toolInstalledSync("pyelftools")).toBe(true);
  });

  it("still judges a real executable by PATH", () => {
    expect(toolInstalledSync("stm32ext-definitely-absent-xyz")).toBe(false);
  });

  it("keeps pyelftools out of the missing list even with everything else present", () => {
    const reqs = TOOL_REQUIREMENTS.map((r) => ({ ...r, name: r.name }));
    const r = describeMissingTools(reqs, toolInstalledSync);
    // Only the machine-specific real tools may be reported; pyelftools must
    // not appear, or the preflight would never settle.
    expect(r.missing.map((m) => m.name)).not.toContain("pyelftools");
  });
});

  it("does not call an optional gap a required one", () => {
    const opt = (name: string): ToolRequirement => ({
      name, needed: "用途", install: "pip install x", required: false,
    });
    // pyelftools is not required and is judged by import, but it can be the
    // only thing left after setup runs. Calling that "必須ツールが未導入"
    // would tell the user their install is blocked when it is not.
    const msg = firstRunMessage([opt("pyelftools")]);
    expect(msg).toContain("pyelftools");
    expect(msg).toContain("ツールが未導入です");
    expect(msg).not.toContain("必須ツールが未導入です");
  });

  it("still says required when every tool in the list is required", () => {
    const need = (name: string): ToolRequirement => ({
      name, needed: "用途", install: "apt install x", required: true,
    });
    expect(firstRunMessage([need("ninja"), need("python3")])).toContain("必須ツールが未導入です");
  });
