// CLI write-confirmation gate + audit: every branch of src/cli/policy.ts,
// driven through injected deps (no real TTY, no real ~/.local writes).
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MOTOR_DRIVE_WARNING } from "../src/live/allowlist.js";
import {
  appendAuditToFile,
  buildWriteInput,
  gateWrite,
  MAX_AUDIT_LINES,
  type PolicyDeps,
} from "../src/cli/policy.js";

const STAMP = "2026-09-30T00:00:00.000Z";

interface Capture {
  stderr: string[];
  appended: string[];
  deps: PolicyDeps;
  prompts: string[];
}

function capture(overrides?: Partial<PolicyDeps> & { promptAnswers?: string[] }): Capture {
  const stderr: string[] = [];
  const appended: string[] = [];
  const prompts: string[] = [];
  const answers = [...(overrides?.promptAnswers ?? [])];
  const { promptAnswers: _dropped, ...rest } = overrides ?? {};
  const deps: PolicyDeps = {
    isTTY: false,
    prompt: async (q: string) => {
      prompts.push(q);
      return answers.length > 0 ? (answers.shift() as string) : "";
    },
    stderr: (t: string) => { stderr.push(t); },
    appendAudit: (line: string) => { appended.push(line); },
    stamp: () => STAMP,
    ...rest,
  };
  return { stderr, appended, deps, prompts };
}

describe("buildWriteInput", () => {
  it("uses the symbol's own byte span [address, address+size) as the extent", () => {
    const { req, extent } = buildWriteInput("sys.loop_hz", "0x200000bc", 4, "1287", true);
    expect(extent).toEqual({ base: 0x200000bc, size: 4 });
    expect(req).toEqual({
      target: { name: "sys.loop_hz", address: "0x200000bc", size: 4 },
      value: "1287",
      confirmed: true,
    });
  });

  it("passes the raw value text through untouched (worker owns parsing)", () => {
    const { req } = buildWriteInput("sys.loop_hz", "0x200000bc", 4, "0xFF", true);
    expect(req.value).toBe("0xFF");
  });

  it("maps an unparseable address to base 0 and never throws", () => {
    expect(() => buildWriteInput("mystery", "unknown", 4, "1", true).extent).not.toThrow();
    expect(buildWriteInput("mystery", "unknown", 4, "1", true).extent).toEqual({ base: 0, size: 4 });
  });
});

describe("gateWrite confirmation", () => {
  it("--yes allows a fitting write without prompting", async () => {
    const c = capture({ isTTY: true });
    const v = await gateWrite("sys.loop_hz", "0x200000bc", 4, "1287", { yes: true }, c.deps);
    expect(c.prompts).toHaveLength(0);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.warning).toBeUndefined();
      expect(v.audit).toContain("[live-write]");
      expect(v.audit).toContain("ALLOWED");
    }
  });

  it("TTY prompt 'y' confirms, default-N empty answer refuses", async () => {
    const yesCap = capture({ isTTY: true, promptAnswers: ["y"] });
    expect((await gateWrite("sys.loop_hz", "0x200000bc", 4, "1", { yes: false }, yesCap.deps)).ok).toBe(true);

    const noCap = capture({ isTTY: true, promptAnswers: [""] });
    const v = await gateWrite("sys.loop_hz", "0x200000bc", 4, "1", { yes: false }, noCap.deps);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toMatch(/confirmation/);
    }
    expect(yesCap.prompts[0]).toContain("sys.loop_hz");
  });

  it("TTY prompt accepts 'yes' case-insensitively, rejects anything else", async () => {
    const upper = capture({ isTTY: true, promptAnswers: ["YES"] });
    expect((await gateWrite("sys.loop_hz", "0x200000bc", 4, "1", { yes: false }, upper.deps)).ok).toBe(true);
    const junk = capture({ isTTY: true, promptAnswers: ["later"] });
    expect((await gateWrite("sys.loop_hz", "0x200000bc", 4, "1", { yes: false }, junk.deps)).ok).toBe(false);
  });

  it("non-TTY without --yes refuses without prompting", async () => {
    const c = capture({ isTTY: false });
    const v = await gateWrite("sys.loop_hz", "0x200000bc", 4, "1", { yes: false }, c.deps);
    expect(c.prompts).toHaveLength(0);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toMatch(/confirmation/);
    }
  });

  it("a throwing prompt refuses instead of throwing", async () => {
    const c = capture({
      isTTY: true,
      prompt: async () => { throw new Error("interrupted"); },
    });
    const v = await gateWrite("sys.loop_hz", "0x200000bc", 4, "1", { yes: false }, c.deps);
    expect(v.ok).toBe(false);
  });
});

describe("gateWrite motor warning", () => {
  it("emits MOTOR_DRIVE_WARNING to stderr even with --yes", async () => {
    const c = capture({ isTTY: false });
    const v = await gateWrite("drive.drive_mode", "0x2000010c", 4, "1", { yes: true }, c.deps);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.warning).toBe(MOTOR_DRIVE_WARNING);
    }
    expect(c.stderr.some((t) => t.includes(MOTOR_DRIVE_WARNING))).toBe(true);
  });

  it("emits no warning for a non-motor path", async () => {
    const c = capture({ isTTY: false });
    await gateWrite("sys.loop_hz", "0x200000bc", 4, "1", { yes: true }, c.deps);
    expect(c.stderr.some((t) => t.includes(MOTOR_DRIVE_WARNING))).toBe(false);
  });

  it("warns even when the motor-path write is refused", async () => {
    const c = capture({ isTTY: false });
    const v = await gateWrite("drive.drive_mode", "0x2000010c", 4, "1", { yes: false }, c.deps);
    expect(v.ok).toBe(false);
    expect(c.stderr.some((t) => t.includes(MOTOR_DRIVE_WARNING))).toBe(true);
  });
});

describe("gateWrite audit", () => {
  it("writes the audit line to stderr AND the appender on allow", async () => {
    const c = capture({ isTTY: false });
    const v = await gateWrite("sys.loop_hz", "0x200000bc", 4, "1", { yes: true }, c.deps);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(c.stderr).toContain(v.audit + "\n");
      expect(c.appended).toEqual([v.audit]);
    }
  });

  it("still audits a refusal (REFUSED line)", async () => {
    const c = capture({ isTTY: false });
    const v = await gateWrite("sys.loop_hz", "0x200000bc", 4, "1", { yes: false }, c.deps);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.audit).toContain("REFUSED(");
      expect(c.appended).toEqual([v.audit]);
      expect(c.stderr).toContain(v.audit + "\n");
    }
  });

  it("an audit-append failure does not fail the command", async () => {
    const c = capture({
      isTTY: false,
      appendAudit: () => { throw new Error("disk full"); },
    });
    const v = await gateWrite("sys.loop_hz", "0x200000bc", 4, "1", { yes: true }, c.deps);
    expect(v.ok).toBe(true);
  });
});

describe("gateWrite malformed input (assert on verdict, not on stderr)", () => {
  it("unparseable address refuses with the unresolvable-address reason, never throws", async () => {
    const c = capture({ isTTY: false });
    let v;
    await expect((async () => {
      v = await gateWrite("mystery", "notahex", 4, "1", { yes: true }, c.deps);
    })()).resolves.toBeUndefined();
    expect(v?.ok).toBe(false);
    if (v !== undefined && !v.ok) {
      expect(v.reason).toMatch(/unresolvable address/);
      expect(v.audit).toContain("REFUSED(");
    }
    expect(c.appended).toHaveLength(1);
  });

  it("size 0 refuses (empty extent cannot fit)", async () => {
    const c = capture({ isTTY: false });
    const v = await gateWrite("ghost", "0x20001000", 0, "1", { yes: true }, c.deps);
    expect(v.ok).toBe(false);
  });

  it("negative size refuses", async () => {
    const c = capture({ isTTY: false });
    const v = await gateWrite("ghost", "0x20001000", -4, "1", { yes: true }, c.deps);
    expect(v.ok).toBe(false);
  });

  it("size > 8 still fits its own span (width policy lives elsewhere)", async () => {
    // Recorded, not fenced here: decideWrite is the single source of truth
    // and only checks fit, so a 16-byte symbol span allows a 16-byte write.
    const c = capture({ isTTY: false });
    const v = await gateWrite("big.blob", "0x20001000", 16, "1", { yes: true }, c.deps);
    expect(v.ok).toBe(true);
  });

  it("pins the extent to the symbol's own span, so fit-refusals only arise from size <= 0", async () => {
    // gateWrite derives the extent from the same (address, size) it sends, so
    // a write always fits its own claim by construction; the remaining
    // decideWrite refusals reachable here are unresolvable-address,
    // empty/non-positive extent, and missing confirmation.
    const c = capture({ isTTY: false });
    const v = await gateWrite("flag", "0x20001003", 4, "1", { yes: true }, c.deps);
    expect(v.ok).toBe(true);
  });
});

describe("appendAuditToFile", () => {
  it("converges to the last 5000 lines after >5000 appends", () => {
    const dir = mkdtempSync(join(tmpdir(), "stm32-cli-policy-"));
    const file = join(dir, "audit.log");
    for (let i = 0; i < MAX_AUDIT_LINES + 200; i++) {
      appendAuditToFile(`[live-write] line-${i}`, file);
    }
    const lines = readFileSync(file, "utf8").split("\n");
    lines.pop(); // trailing newline
    expect(lines).toHaveLength(MAX_AUDIT_LINES);
    expect(lines[0]).toBe("[live-write] line-200");
    expect(lines[lines.length - 1]).toBe(`[live-write] line-${MAX_AUDIT_LINES + 199}`);
  });

  it("is safe to call many times in a row on the same file", () => {
    const dir = mkdtempSync(join(tmpdir(), "stm32-cli-policy-"));
    const file = join(dir, "sub", "audit.log");
    for (let i = 0; i < 50; i++) {
      appendAuditToFile(`[live-write] ${STAMP} ALLOWED n@${i} value=1`, file);
    }
    const lines = readFileSync(file, "utf8").split("\n");
    lines.pop();
    expect(lines).toHaveLength(50);
    expect(lines[0]).toContain("[live-write]");
  });
});
