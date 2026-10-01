// todo4: dry-run unit tests — generated command must match
// `-c port=SWD -w <.elf> -v -rst` shape; confirm/progress/verify wired.
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { stubCliOnPath } from "./helpers/stub-cli.js";
import {
  CLI_INSTALL_GUIDE,
  DEFAULT_FLASH_SETTINGS,
  buildFlashArgs,
  buildFlashCommand,
  isProbeNotFound,
  runFlash,
} from "../src/flash/backend.js";
import { renderSidebar, SIDEBAR_PANEL_DEFAULT_STATE } from "../src/panels/sidebar.js";

const ELF = "build-ext/firmware.elf";

describe("flash command shape (dry-run)", () => {
  it("defaults produce `-c port=SWD -w <elf> -v -rst`", () => {
    const cmd = buildFlashCommand(DEFAULT_FLASH_SETTINGS, { elfPath: ELF, confirmed: true });
    expect(cmd).toMatch(/-c port=SWD -w \S+\.elf -v -rst/);
    expect(cmd).toBe(`STM32_Programmer_CLI -c port=SWD -w ${ELF} -v -rst`);
  });

  it("argv order is exactly -c/port/-w/elf/-v/-rst", () => {
    expect(buildFlashArgs(DEFAULT_FLASH_SETTINGS, { elfPath: ELF, confirmed: true })).toEqual([
      "-c",
      "port=SWD",
      "-w",
      ELF,
      "-v",
      "-rst",
    ]);
  });

  it("verify is mandatory even when verify:false requested", () => {
    const cmd = buildFlashCommand(
      DEFAULT_FLASH_SETTINGS,
      { elfPath: ELF, confirmed: true, verify: false },
    );
    expect(cmd).toContain(" -v ");
  });

  it("dry-run resolves ok without spawning", async () => {
    const res = await runFlash(
      DEFAULT_FLASH_SETTINGS,
      { elfPath: ELF, confirmed: true, dryRun: true },
      () => {
        throw new Error("must not spawn in dry-run");
      },
    );
    expect(res.ok).toBe(true);
    expect(res.dryRun).toBe(true);
    expect(res.command).toMatch(/-c port=SWD -w \S+ -v -rst/);
  });
});

describe("flash safety rails", () => {
  // runFlash resolves STM32_Programmer_CLI on PATH before the injected spawn
  // mock; the stub satisfies only the existence check, calls go to the mock.
  let restorePath: (() => void) | undefined;
  beforeEach(() => {
    restorePath = stubCliOnPath("STM32_Programmer_CLI");
  });
  afterEach(() => {
    restorePath?.();
    restorePath = undefined;
  });
  it("confirmless write is refused", async () => {
    const res = await runFlash(DEFAULT_FLASH_SETTINGS, { elfPath: ELF, confirmed: false });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/confirmation/i);
  });

  it("non-elf path is refused", async () => {
    const res = await runFlash(
      DEFAULT_FLASH_SETTINGS,
      { elfPath: "build-ext/firmware.bin", confirmed: true },
    );
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/\.elf/);
  });

  it("probe-not-found output is detected and retryable (no auto-retry)", async () => {
    expect(isProbeNotFound("Error: No ST-LINK detected!")).toBe(true);
    const res = await runFlash(
      DEFAULT_FLASH_SETTINGS,
      { elfPath: ELF, confirmed: true },
      async () => ({ exitCode: 1, stdout: "Error: No ST-LINK detected!", stderr: "" }),
    );
    expect(res.ok).toBe(false);
    expect(res.retryable).toBe(true);
    expect(res.message).toMatch(/再試行|retry/i);
  });

  it("missing CLI spawn failure points at install guidance", async () => {
    const res = await runFlash(
      DEFAULT_FLASH_SETTINGS,
      { elfPath: ELF, confirmed: true },
      async () => {
        throw new Error("spawn STM32_Programmer_CLI ENOENT");
      },
    );
    expect(res.ok).toBe(false);
    expect(res.message).toContain(CLI_INSTALL_GUIDE.split("\n")[0] as string);
  });
});

describe("flash wiring through the sidebar", () => {
  it("sidebar flash section exposes a start and a retry button", () => {
    const html = renderSidebar(SIDEBAR_PANEL_DEFAULT_STATE);
    expect(html).toContain('data-testid="flash-start"');
    expect(html).toContain('data-testid="flash-retry"');
  });

  it("flash command carries the interface setting verbatim", () => {
    const cmd = buildFlashCommand(
      // Legacy "normal" is now "software-reset": a standard post-flash reset
      // (connect-under-reset is already the default and means halting under reset).
      { ...DEFAULT_FLASH_SETTINGS, probe: "J-LINK", iface: "JTAG", resetMode: "software-reset" },
      { elfPath: ELF, confirmed: true },
    );
    expect(cmd).toContain("port=JTAG");
    expect(cmd).toMatch(/-v -rst$/);
  });
});
