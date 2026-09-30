import { describe, expect, it } from "vitest";
import { resolveDapLaunch } from "../src/debug/dapLaunch.js";

const PERSISTED = { elfPath: "/fw/build-ext/unit_omni3.elf", mcu: "STM32G474RETx" };

describe("resolveDapLaunch (launch.json stays minimal)", () => {
  it("resolves elf and target from the last build when launch.json is empty", () => {
    expect(resolveDapLaunch({}, PERSISTED)).toEqual({
      ok: true,
      elf: "/fw/build-ext/unit_omni3.elf",
      target: "stm32g474retx",
    });
  });

  it("explicit launch.json values win over persisted ones", () => {
    expect(resolveDapLaunch(
      { elf: "/tmp/other.elf", target: "stm32f407vg" },
      PERSISTED,
    )).toEqual({ ok: true, elf: "/tmp/other.elf", target: "stm32f407vg" });
  });

  it("refuses without an ELF (nothing built yet)", () => {
    const r = resolveDapLaunch({}, undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("ビルド");
    }
  });

  it("refuses without a target (MCU unknown)", () => {
    const r = resolveDapLaunch(
      {},
      { elfPath: "/fw/fw.elf", mcu: "" },
    );
    expect(r.ok).toBe(false);
  });
});
