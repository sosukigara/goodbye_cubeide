// todo5 tests: ELF resolution wrapper, poller (CSV/tear-guard/drop-rate),
// allowlisted writes, live + graph panels. Still 6 panels total.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "../src/extension.ts"), "utf8");
import {
  decideWrite,
  isMotorDrivePath,
  MOTOR_DRIVE_WARNING,
} from "../src/live/allowlist.js";
import {
  findSymbol,
  isStripError,
  parseElfResolutionJson,
  resolveElf,
  STRIP_HINT,
} from "../src/live/elfResolver.js";
import { SIDEBAR_SECTIONS } from "../src/panels/sidebar.js";
import {
  assertCsvHeader,
  CSV_HEADER,
  dropStats,
  formatCsv,
} from "../src/live/poller.js";

// The extent a resolved symbol occupies. There is no DebugGlobal window any
// more: the write is checked against the target's own bytes.
const RANGE = { base: 0x200000bc, size: 4 };
const STAMP = "2026-09-18T00:00:00.000Z";

function fakeResolution() {
  return {
    elf: "build-ext/unit_omni3.elf",
    base: "0x200000bc",
    size: 936,
    end: "0x20000464",
    hasDebugInfo: true,
    backend: "nm+readelf",
    symbols: [
      { name: "sys.loop_hz", address: "0x200000bc", offset: 0, size: 4 },
      { name: "drive.drive_mode", address: "0x2000010c", offset: 80, size: 4 },
    ],
    unresolved: [] as string[],
  };
}

describe("elfResolver", () => {
  it("parses real elf_resolve.py JSON shape", () => {
    const res = parseElfResolutionJson(JSON.stringify({
      elf: "build-ext/unit_omni3.elf",
      base: "0x200000bc",
      size: 936,
      end: "0x20000464",
      has_debug_info: true,
      backend: "nm+readelf",
      symbols: [{ name: "sys.loop_hz", address: "0x200000bc", offset: 0, size: 4, type: "uint32_t" }],
      unresolved: ["nav.robot_yaw_deg"],
    }));
    expect(res.base).toBe("0x200000bc");
    expect(res.symbols).toHaveLength(1);
    expect(res.unresolved).toEqual(["nav.robot_yaw_deg"]);
    expect(findSymbol(res, "sys.loop_hz")?.address).toBe("0x200000bc");
    expect(findSymbol(res, "sys.loop_hz")?.type).toBe("uint32_t");
    expect(findSymbol(res, "nope")).toBeUndefined();
  });

  it("strip failure maps to the explicit -g3 error", async () => {
    expect(isStripError("elf_resolve: ELF has no debug info (stripped or built without -g)", 2)).toBe(true);
    await expect(resolveElf("x.elf", async () => ({
      stdout: "",
      stderr: "ELF has no debug info (stripped",
      exitCode: 2,
    }))).rejects.toThrow(STRIP_HINT);
  });

  it("non-strip failure keeps the tool tail", async () => {
    await expect(resolveElf("x.elf", async () => ({
      stdout: "",
      stderr: "boom",
      exitCode: 1,
    }))).rejects.toThrow(/elf_resolve failed for x\.elf: boom/);
  });
});

describe("poller contracts", () => {
  it("CSV header is exactly timestamp,address,name,value", () => {
    expect(CSV_HEADER).toBe("timestamp,address,name,value");
    expect(() => assertCsvHeader("timestamp,address,name,value")).not.toThrow();
    expect(() => assertCsvHeader("timestamp,address,name,value\r")).toThrow(/schema mismatch/);
  });

  it("formatCsv emits header + rows with LF endings", () => {
    const csv = formatCsv([
      { timestamp: "t", address: "0x200000bc", name: "sys.loop_hz", value: "0x0000000a" },
    ]);
    expect(csv).toBe("timestamp,address,name,value\nt,0x200000bc,sys.loop_hz,0x0000000a\n");
  });


  it("drop rate: <1% is inside the sidecar's budget, >=1% is not", () => {
    expect(dropStats(3000, 2999).dropRate).toBeLessThan(0.01); // 0.03%
    expect(dropStats(3000, 2970).dropRate).toBeGreaterThanOrEqual(0.01); // 1.0%
    expect(dropStats(0, 0).dropRate).toBe(0);
  });
});

describe("allowlist writes", () => {
  it("resolved in-range + confirmed write is allowed with audit line", () => {
    const v = decideWrite(
      { target: { name: "sys.loop_hz", address: "0x200000bc", size: 4 }, value: "0x1", confirmed: true },
      RANGE,
      STAMP,
    );
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.warning).toBeUndefined();
      expect(v.audit).toContain("[live-write]");
      expect(v.audit).toContain("ALLOWED");
    }
  });

  it("a write that does not fit the resolved symbol is refused", () => {
    // This replaced the DebugGlobal fence. The address itself is now free —
    // any symbol the host could resolve is writable — but the write still has
    // to stay inside the object the host said it was writing, so a width or an
    // address that overruns the extent is refused.
    const v = decideWrite(
      { target: { name: "runaway", address: "0x20001000", size: 4 }, value: "0x1", confirmed: true },
      RANGE,
      STAMP,
    );
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toMatch(/does not fit/);
      expect(v.audit).toContain("REFUSED");
    }
  });

  it("an address OUTSIDE DebugGlobal is allowed once it fits its own symbol", () => {
    // The whole point of the change: a tuner global or a plain counter lives
    // outside DebugGlobal and was previously unreachable for editing.
    const v = decideWrite(
      { target: { name: "tuner_params", address: "0x20001000", size: 4 }, value: "0x1", confirmed: true },
      { base: 0x20001000, size: 4 },
      STAMP,
    );
    expect(v.ok).toBe(true);
  });

  it("a write that runs off the END of its own symbol is still refused", () => {
    const v = decideWrite(
      { target: { name: "flag", address: "0x20001003", size: 4 }, value: "0x1", confirmed: true },
      { base: 0x20001000, size: 4 },
      STAMP,
    );
    expect(v.ok).toBe(false);
  });

  it("a zero-width symbol is refused rather than treated as unbounded", () => {
    const v = decideWrite(
      { target: { name: "ghost", address: "0x20001000", size: 4 }, value: "0x1", confirmed: true },
      { base: 0x20001000, size: 0 },
      STAMP,
    );
    expect(v.ok).toBe(false);
  });

  it("unresolved (non-hex) address is refused", () => {
    const v = decideWrite(
      { target: { name: "mystery", address: "unknown", size: 4 }, value: "0x1", confirmed: true },
      RANGE,
      STAMP,
    );
    expect(v.ok).toBe(false);
  });

  it("unconfirmed write is refused even when in range", () => {
    const v = decideWrite(
      { target: { name: "sys.loop_hz", address: "0x200000bc", size: 4 }, value: "0x1", confirmed: false },
      RANGE,
      STAMP,
    );
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toMatch(/confirmation/);
    }
  });

  it("motor/drive paths raise the motor-drive warning", () => {
    expect(isMotorDrivePath("drive.drive_mode")).toBe(true);
    expect(isMotorDrivePath("periph.dji_current")).toBe(true);
    expect(isMotorDrivePath("sys.loop_hz")).toBe(false);
    const v = decideWrite(
      { target: { name: "drive.drive_mode", address: "0x2000010c", size: 4 }, value: "0x1", confirmed: true },
      { base: 0x2000010c, size: 4 },
      STAMP,
    );
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.warning).toBe(MOTOR_DRIVE_WARNING);
    }
  });

  it("writeFlow gates every dispatch behind a modal and hands decideWrite the user's answer", () => {
    // A memory write from the Variables tab used to commit on Enter: no
    // showWarningMessage between validation and sendWrite, and a hardcoded
    // `confirmed: true` handed to decideWrite. decideWrite stays pure (verdict
    // + audit string only), so the policy is only as good as the answer the
    // caller feeds it — the host now has to ask, and has to pass what it got.
    const req = { target: { name: "sys.loop_hz", address: "0x200000bc", size: 4 }, value: "0x1" };
    const refused = decideWrite({ ...req, confirmed: false }, RANGE, STAMP);
    expect(refused.ok).toBe(false); // a dismissed dialog refuses
    if (!refused.ok) {
      expect(refused.reason).toMatch(/confirmation/);
    }
    expect(decideWrite({ ...req, confirmed: true }, RANGE, STAMP).ok).toBe(true);
    const overruns = decideWrite(
      { target: { name: "evil", address: "0x20001000", size: 4 }, value: "0x1", confirmed: true },
      RANGE,
      STAMP,
    );
    expect(overruns.ok).toBe(false); // a write that does not fit never reaches the sidecar
    // Pin the host shape: one modal inside writeFlow, no hardcoded confirmation,
    // still dispatching through sendWrite and still logging the WRITE audit
    // line (decoded text + hex) the dialog now sits in front of.
    const start = source.indexOf("private async writeFlow");
    const end = source.indexOf("/** One write over the running sidecar's stdin", start);
    const writeFlow = source.slice(start, end === -1 ? undefined : end);
    expect(start).not.toBe(-1);
    expect(writeFlow).toMatch(/showWarningMessage\([\s\S]*?\{ modal: true \}/);
    expect(writeFlow).not.toContain("confirmed: true");
    expect(writeFlow).toContain("sendWrite");
    expect(writeFlow).toContain("[live-write]");
    expect(writeFlow).toMatch(/WRITE \$\{name\}@\$\{sym\.address\}/);
  });

  it("the modals unrelated to the write gate are untouched", () => {
    // Probe-conflict, force-stop, force-reclaim and both flash confirmations are
    // separate gates; the write dialog must not have replaced or renamed them.
    expect(source).toContain("プローブ競合の可能性");
    expect(source).toContain("強制終了しますか?");
    expect(source).toContain("強制的に取り直しますか?");
    expect(source).toContain("Flash ${elfPath}? This overwrites target firmware.");
    expect(source).toContain("Build OK. Flash ${elfPath}? This overwrites target firmware.");
    expect(source).toContain("{ modal: true }");
  });
});

describe("panel inventory", () => {
  it("still exactly 6 panels (no 7th)", () => {
    // The 6-panel inventory is now the sidebar's section list; the standalone
    // per-panel renderers that used to duplicate it were never registered.
    expect(SIDEBAR_SECTIONS.map((s) => s.id))
      .toEqual(["project", "build", "flash", "live", "graph", "log"]);
  });
});

describe("usb release before restart", () => {
  it("waits for the old poll process to actually exit before spawning a new one", () => {
    // Regression: stop() sent SIGKILL and returned immediately, so the new
    // live_poll claimed the ST-LINK while the dying one still held the USB
    // interface -> "usb.core.USBError: [Errno 16] Resource busy".
    expect(source).toMatch(/await\s+this\.(?:stopAndWait|waitForExit)/);
  });

  it("waits for a killed child to reach the exited state", () => {
    expect(source).toMatch(/once\([^\)]*["']exit["']|"exit"|'exit'/);
  });

  it("never restarts automatically after a probe-busy failure", () => {
    expect(source).toMatch(/no auto-restart/);
  });
});
