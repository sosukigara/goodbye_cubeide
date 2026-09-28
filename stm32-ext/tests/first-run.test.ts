// First-run usability: a person who has never seen this extension must be told
// what to install, in one message, before they press Build and meet
// "executable file not found".
import { describe, expect, it, vi } from "vitest";

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
import { describeMissingTools, TOOL_REQUIREMENTS } from "../src/extension.js";

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
    expect(r.summary).toContain("pyocd");
    expect(r.summary).toContain("python3");
    // Every blocker carries a copy-pasteable command, not just a noun.
    for (const line of ["arm-none-eabi-gcc", "ninja", "pyocd", "python3"]) {
      expect(r.install).toContain(line);
    }
    expect(r.install).toContain("apt install");
    expect(r.install).toContain("pip install");
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
});
