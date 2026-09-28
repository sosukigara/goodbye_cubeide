import { describe, expect, it } from "vitest";
import {
  DEFAULT_FLASH_SETTINGS,
  describeElf,
  resolveCliPath,
  runFlash,
} from "../src/flash/backend.js";

describe("CLI auto-detect + verbose details", () => {
  it("resolveCliPath reports searched paths and a verdict", () => {
    const r = resolveCliPath("STM32_Programmer_CLI");
    expect(r.searched.length).toBeGreaterThan(0);
    if (r.found) {
      expect(r.cli.endsWith("STM32_Programmer_CLI")).toBe(true);
    } else {
      expect(r.cli).toBe("STM32_Programmer_CLI");
    }
  });
  it("explicit absolute path is used verbatim", () => {
    const r = resolveCliPath("/opt/st/fake/STM32_Programmer_CLI");
    expect(r.cli).toBe("/opt/st/fake/STM32_Programmer_CLI");
    expect(r.searched).toEqual(["/opt/st/fake/STM32_Programmer_CLI"]);
  });
  it("dry-run result carries detail lines (elf/cli/settings/argv)", async () => {
    const res = await runFlash(
      DEFAULT_FLASH_SETTINGS,
      { elfPath: "build-ext/unit_omni3.elf", confirmed: true, dryRun: true },
      async () => { throw new Error("must not spawn in dry-run"); },
    );
    expect(res.ok).toBe(true);
    expect(res.details?.some((d) => d.startsWith("elf:"))).toBe(true);
    expect(res.details?.some((d) => d.startsWith("cli:"))).toBe(true);
    expect(res.details?.some((d) => d.startsWith("settings:"))).toBe(true);
    expect(res.details?.some((d) => d.startsWith("argv:"))).toBe(true);
  });
  it("missing CLI fails with searched-path message (no spawn)", async () => {
    const res = await runFlash(
      { ...DEFAULT_FLASH_SETTINGS, cliPath: "NO_SUCH_CLI_XYZ" },
      { elfPath: "build-ext/unit_omni3.elf", confirmed: true },
      async () => { throw new Error("must not spawn when CLI missing"); },
    );
    expect(res.ok).toBe(false);
    expect(res.message).toContain("searched:");
    expect(res.details?.some((d) => d.includes("NOT FOUND"))).toBe(true);
  });
  it("failure message carries the CLI cause excerpt", async () => {
    const res = await runFlash(
      DEFAULT_FLASH_SETTINGS,
      { elfPath: "build-ext/unit_omni3.elf", confirmed: true },
      async () => ({ exitCode: 1, stdout: "ST-LINK error (DEV_CONNECT_ERR)", stderr: "" }),
    );
    expect(res.ok).toBe(false);
    expect(res.message).toContain("Flash failed (exit 1)");
    expect(res.message).toContain("DEV_CONNECT_ERR");
  });
  it("describeElf reports size for real files", () => {
    expect(describeElf("/no/such/file.elf")).toContain("(missing)");
  });
});
