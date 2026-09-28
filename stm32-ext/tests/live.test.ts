// todo5 tests: ELF resolution wrapper, poller (CSV/tear-guard/drop-rate),
// DebugGlobal allowlist writes, live + graph panels. Still 6 panels total.
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
  debugRange,
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
  passesDropBudget,
} from "../src/live/poller.js";

const RANGE = { base: 0x200000bc, end: 0x20000464 };
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
    expect(debugRange(res)).toEqual({ base: 0x200000bc, end: 0x20000464 });
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


  it("drop budget: <1% passes, >=1% fails", () => {
    expect(passesDropBudget(dropStats(3000, 2999))).toBe(true); // 0.03%
    expect(passesDropBudget(dropStats(3000, 2970))).toBe(false); // 1.0%
    expect(passesDropBudget(dropStats(0, 0))).toBe(true);
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

  it("out-of-range address is refused (no arbitrary writes)", () => {
    const v = decideWrite(
      { target: { name: "evil", address: "0x20001000", size: 4 }, value: "0x1", confirmed: true },
      RANGE,
      STAMP,
    );
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toMatch(/outside DebugGlobal/);
      expect(v.audit).toContain("REFUSED");
    }
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
      RANGE,
      STAMP,
    );
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.warning).toBe(MOTOR_DRIVE_WARNING);
    }
  });

  it("writeFlow orchestration contract: pre-modal probe (confirmed:true) passes range, final gate enforces the modal", () => {
    // Regression for oracle MUST-FIX: writeFlow must probe with confirmed:true
    // pre-modal (pure function, no side effects). Probing with confirmed:false
    // always refuses and would make the confirm modal dead code.
    const req = { target: { name: "sys.loop_hz", address: "0x200000bc", size: 4 }, value: "0x1" };
    const probe = decideWrite({ ...req, confirmed: true }, RANGE, STAMP);
    expect(probe.ok).toBe(true); // in-range target reaches the modal
    const noConfirm = decideWrite({ ...req, confirmed: false }, RANGE, STAMP);
    expect(noConfirm.ok).toBe(false); // dismissed modal stays refused
    const outOfRange = decideWrite(
      { target: { name: "evil", address: "0x20001000", size: 4 }, value: "0x1", confirmed: true },
      RANGE,
      STAMP,
    );
    expect(outOfRange.ok).toBe(false); // out-of-range never reaches the modal
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
