// pyOCD flash transport: argv shape, the same safety rails as the
// CubeProgrammer path (confirmless refused, verify+reset implicit, one retry).
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_FLASH_SETTINGS, type FlashSettings } from "../src/flash/backend.js";
import {
  buildPyocdArgs,
  buildPyocdCommand,
  connectModeOf,
  isElf,
  resolvePyocdPath,
  runPyocdFlash,
} from "../src/flash/pyocd.js";

const ELF = "build-ext/firmware.elf";
const MCU = "STM32G474RETx";

describe("pyocd flash command shape", () => {
  it("loads the ELF for the resolved target under reset, verify implicit", () => {
    const args = buildPyocdArgs(MCU, DEFAULT_FLASH_SETTINGS, { elfPath: ELF, confirmed: true });
    expect(args).toEqual([
      "load", "--target", "stm32g474retx", "--format", "elf",
      "--connect", "under-reset", ELF,
    ]);
  });
  it("normalises the MCU to a pyocd target id", () => {
    expect(buildPyocdArgs("STM32F407VGx", DEFAULT_FLASH_SETTINGS, { elfPath: ELF, confirmed: true })[2])
      .toBe("stm32f407vgx");
  });
  it("verify is always on: no --no-verify escape hatch is emitted", () => {
    const args = buildPyocdArgs(MCU, DEFAULT_FLASH_SETTINGS,
      { elfPath: ELF, confirmed: true, verify: false });
    expect(args.join(" ")).not.toContain("--no-verify");
  });
  it("reset runs after programming unless the user asked for none", () => {
    const kept = buildPyocdArgs(MCU, DEFAULT_FLASH_SETTINGS, { elfPath: ELF, confirmed: true });
    expect(kept).not.toContain("--no-reset");
    const none: FlashSettings = { ...DEFAULT_FLASH_SETTINGS, resetMode: "none" };
    expect(buildPyocdArgs(MCU, none, { elfPath: ELF, confirmed: true }))
      .toContain("--no-reset");
  });
  it("maps reset modes onto pyocd connect modes", () => {
    expect(connectModeOf("connect-under-reset")).toBe("under-reset");
    expect(connectModeOf("core-reset")).toBe("halt");
    expect(connectModeOf("software-reset")).toBe("halt");
  });
  it("renders a one-line command for the log", () => {
    expect(buildPyocdCommand(MCU, DEFAULT_FLASH_SETTINGS, { elfPath: ELF, confirmed: true }))
      .toBe(`pyocd load --target stm32g474retx --format elf --connect under-reset ${ELF}`);
  });
});

describe("pyocd flash safety rails", () => {
  it("refuses a confirmless flash", async () => {
    const res = await runPyocdFlash(MCU, DEFAULT_FLASH_SETTINGS, { elfPath: ELF, confirmed: false });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/confirmation/i);
  });
  it("refuses a non-elf image", async () => {
    const res = await runPyocdFlash(MCU, DEFAULT_FLASH_SETTINGS,
      { elfPath: "firmware.bin", confirmed: true });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/\.elf/);
  });
  it("dry-run never spawns", async () => {
    const res = await runPyocdFlash(MCU, DEFAULT_FLASH_SETTINGS,
      { elfPath: ELF, confirmed: true, dryRun: true },
      () => { throw new Error("must not spawn in dry-run"); });
    expect(res.ok).toBe(true);
    expect(res.dryRun).toBe(true);
  });
  it("asks for the probe list first, because `pyocd load` waits forever without one", async () => {
    const seen: string[][] = [];
    await runPyocdFlash(MCU, DEFAULT_FLASH_SETTINGS, { elfPath: ELF, confirmed: true },
      async (_cli, args) => {
        seen.push(args);
        return args[0] === "list"
          ? { exitCode: 0, stdout: "  #  Probe   Unique ID   Target\n  0  STLink  37FF…  n/a", stderr: "" }
          : { exitCode: 0, stdout: "Programmed OK", stderr: "" };
      });
    expect(seen.map((a) => a[0])).toEqual(["list", "load"]);
    expect(seen[0]?.slice(0, 2)).toEqual(["list", "-q"]);
  });
  it("refuses without programming when the listing shows no probe", async () => {
    const seen: string[][] = [];
    const res = await runPyocdFlash(MCU, DEFAULT_FLASH_SETTINGS,
      { elfPath: ELF, confirmed: true },
      async (_cli, args) => {
        seen.push(args);
        return { exitCode: 0, stdout: "No available debug probes are connected", stderr: "" };
      });
    expect(res.ok).toBe(false);
    expect(res.retryable).toBe(true);
    expect(res.message).toMatch(/ST-LINK が見つかりません/);
    // `load` was never reached, so nothing was erased or programmed.
    expect(seen.map((a) => a[0])).toEqual(["list"]);
  });
  it("probe-not-found is retryable and never auto-retried", async () => {
    const res = await runPyocdFlash(MCU, DEFAULT_FLASH_SETTINGS,
      { elfPath: ELF, confirmed: true },
      async (_cli, args) => (args[0] === "list"
        ? { exitCode: 0, stdout: "  0  STLink  37FF…  n/a", stderr: "" }
        : { exitCode: 1, stdout: "No ST-LINK found", stderr: "" }));
    expect(res.retryable).toBe(true);
    expect(res.message).toMatch(/再試行/);
  });
  it("reports the CLI cause on a generic failure", async () => {
    const res = await runPyocdFlash(MCU, DEFAULT_FLASH_SETTINGS,
      { elfPath: ELF, confirmed: true },
      async (_cli, args) => (args[0] === "list"
        ? { exitCode: 0, stdout: "  0  STLink  37FF…  n/a", stderr: "" }
        : { exitCode: 1, stdout: "", stderr: "Erase failed: sector 3" }));
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/Erase failed/);
  });
  it("treats a hung listing as retryable rather than waiting on it", async () => {
    const res = await runPyocdFlash(MCU, DEFAULT_FLASH_SETTINGS,
      { elfPath: ELF, confirmed: true },
      async () => ({ exitCode: 1, stdout: "", stderr: "", timedOut: true }));
    expect(res.ok).toBe(false);
    expect(res.retryable).toBe(true);
    expect(res.message).toMatch(/応答しませんでした/);
  });
});

describe("flash helpers", () => {
  // This probes the real PATH, so it can only be true on a machine that has
  // pyocd. A contributor without one got a red suite saying nothing about
  // this code — the same trap as the build-ext/ ELF case. Skipped rather than
  // deleted: where pyocd IS installed it still guards the lookup, which is
  // what broke a desktop-launched VS Code with a truncated PATH.
  it.skipIf(!resolvePyocdPath("").found)("finds pyocd when it is installed", () => {
    expect(resolvePyocdPath("").cli).toMatch(/pyocd/);
    expect(resolvePyocdPath("").found).toBe(true);
  });
  it("only accepts a real .elf path", () => {
    // Built in a temp dir rather than against build-ext/: this asserts the
    // extension AND the file-exists half of the check, and a checkout that has
    // never been built has no build-ext/ to find. Failing on a missing local
    // artifact told the reader nothing about the code under test.
    const dir = mkdtempSync(join(tmpdir(), "stm32ext-elf-"));
    const elf = join(dir, "unit_omni3.elf");
    writeFileSync(elf, "");
    expect(isElf(elf)).toBe(true);
    expect(isElf(join(dir, "firmware.bin"))).toBe(false);
    // Right extension, no such file: still refused, so a stale path is never
    // handed to `pyocd load`.
    expect(isElf(join(dir, "absent.elf"))).toBe(false);
  });
});
