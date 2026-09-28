// todo2 parser tests: 3 real-project fixtures must match expected JSON verbatim,
// plus synthetic divergence / multi-root / unknown-MCU cases.
// Firmware tree is read-only: fixtures are byte-identical copies under tests/fixtures.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { mergeWithIoc, parseCproject, parseIoc } from "../src/parser/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = (name: string): string => readFileSync(join(HERE, "fixtures", name), "utf8");

// Canonical MCU argv (build_check/CMakeLists.txt:25-28, verbatim — no reinterpretation).
const G474_ARGV = ["-mcpu=cortex-m4", "-mthumb", "-mfloat-abi=hard", "-mfpu=fpv4-sp-d16"];
const G474_INCLUDES = [
  "../Core/Inc",
  "../../shared",
  "../../tr",
  "../Drivers/STM32G4xx_HAL_Driver/Inc",
  "../Drivers/STM32G4xx_HAL_Driver/Inc/Legacy",
  "../Drivers/CMSIS/Device/ST/STM32G4xx/Include",
  "../Drivers/CMSIS/Include",
];
const G474_DEFINES = ["DEBUG", "USE_HAL_DRIVER", "STM32G474xx", "TR_HAL_ENABLED"];

describe("real-project fixtures match expected JSON", () => {
  it("unit_omni3: full Debug extraction", () => {
    const cfg = parseCproject(FIX("unit_omni3.cproject"), { projectNameHint: "unit_omni3" });
    expect(cfg.projectName).toBe("unit_omni3");
    expect(cfg.mcu).toBe("STM32G474RETx");
    expect(cfg.fpu).toBe("fpv4-sp-d16");
    expect(cfg.floatAbi).toBe("hard");
    expect(cfg.toolchainPrefix).toBe("arm-none-eabi-");
    expect(cfg.cpuClockMHz).toBe(160);
    expect([...cfg.includes]).toEqual(G474_INCLUDES);
    expect([...cfg.defines]).toEqual(G474_DEFINES);
    expect(cfg.linkerScriptRaw).toBe("${workspace_loc:/${ProjName}/STM32G474RETX_FLASH.ld}");
    expect([...cfg.mcuFlags.argv]).toEqual(G474_ARGV);
    expect(cfg.sourceEntries).toContain("Core");
    expect(cfg.sourceEntries).toContain("Drivers");
    // omni-only trap: --allow-multiple-definition present (Debug :88-89 and Release).
    expect(cfg.otherLinkerFlags).toContain("-Wl,--allow-multiple-definition");
    const debug = cfg.configurations.find((c) => c.name === "Debug");
    expect(debug?.debugLevel).toBe("g3");
    expect(debug?.cppStandard).toBe("gnupp20");
    expect(debug?.noExceptions).toBe(false);
    expect(cfg.configurations.map((c) => c.name).sort()).toEqual(["Debug", "Release"]);
  });

  it("unit_pc-stm: same G4 core, no allow-multiple-definition", () => {
    const cfg = parseCproject(FIX("unit_pc-stm.cproject"), { projectNameHint: "unit_pc-stm" });
    expect(cfg.projectName).toBe("unit_pc-stm");
    expect(cfg.mcu).toBe("STM32G474RETx");
    expect(cfg.fpu).toBe("fpv4-sp-d16");
    expect(cfg.floatAbi).toBe("hard");
    expect([...cfg.includes]).toEqual(G474_INCLUDES);
    expect([...cfg.defines]).toEqual(G474_DEFINES);
    expect(cfg.linkerScriptRaw).toBe("${workspace_loc:/${ProjName}/STM32G474RETX_FLASH.ld}");
    expect([...cfg.mcuFlags.argv]).toEqual(G474_ARGV);
    expect(cfg.otherLinkerFlags).not.toContain("-Wl,--allow-multiple-definition");
    const debug = cfg.configurations.find((c) => c.name === "Debug");
    expect(debug?.debugLevel).toBe("g3");
    expect(debug?.noExceptions).toBe(false);
  });

  it("pid_tuner_stm_bridge: empty sourceEntries trap (:104)", () => {
    const cfg = parseCproject(FIX("pid_tuner_stm_bridge.cproject"), {
      projectNameHint: "pid_tuner_stm_bridge",
    });
    expect(cfg.projectName).toBe("pid_tuner_stm_bridge");
    expect(cfg.mcu).toBe("STM32G474RETx");
    expect([...cfg.mcuFlags.argv]).toEqual(G474_ARGV);
    expect([...cfg.includes]).toEqual(G474_INCLUDES);
    expect([...cfg.defines]).toEqual(G474_DEFINES);
    // Empty name="" entries are dropped, parsing continues with a warning.
    expect(cfg.sourceEntries).toEqual([]);
    expect(cfg.warnings.some((w) => w.includes("empty sourceEntries"))).toBe(true);
    expect(cfg.otherLinkerFlags).not.toContain("-Wl,--allow-multiple-definition");
  });

  it("real .ioc files agree with .cproject (no divergence warning)", () => {
    const pairs: Array<[string, string]> = [
      ["unit_omni3.cproject", "unit_omni3.ioc"],
      ["unit_pc-stm.cproject", "unit_pc-stm.ioc"],
      ["pid_tuner_stm_bridge.cproject", "pid_tuner_stm_bridge.ioc"],
    ];
    for (const [cproject, ioc] of pairs) {
      const cfg = parseCproject(FIX(cproject));
      const parsed = parseIoc(FIX(ioc));
      // CPN STM32G474RET3 matches cproject STM32G474RETx (same device family).
      expect(parsed.mcuCpn).toBe("STM32G474RET3");
      const merged = mergeWithIoc(cfg, parsed);
      expect(merged.warnings.filter((w) => w.includes("divergence"))).toEqual([]);
      expect(merged.config.mcu).toBe("STM32G474RETx");
    }
  });
});

describe("synthetic cases", () => {
  it("divergence: .cproject wins over .ioc with warning", () => {
    const cfg = parseCproject(FIX("unit_omni3.cproject"));
    const ioc = parseIoc("Mcu.CPN=STM32F407VGTx\nMcu.Family=STM32F4\nMcu.Name=STM32F407VGTx\n");
    const merged = mergeWithIoc(cfg, ioc);
    expect(merged.config.mcu).toBe("STM32G474RETx"); // .cproject kept
    expect([...merged.config.mcuFlags.argv]).toEqual(G474_ARGV); // flags NOT reinterpreted
    expect(merged.warnings.some((w) => w.includes("divergence") && w.includes(".cproject"))).toBe(true);
  });

  it("multi-root: ${workspace_loc} resolves per project root", () => {
    const cfg = parseCproject(FIX("unit_omni3.cproject"), {
      projectNameHint: "unit_omni3",
      workspaceRoots: {
        unit_omni3: "/ws/main/unit_omni3",
        "unit_pc-stm": "/ws/other/unit_pc-stm",
      },
    });
    // ${workspace_loc:/${ProjName}/STM32G474RETX_FLASH.ld} with ProjName=unit_omni3.
    expect(cfg.linkerScriptResolved).toBe("/ws/main/unit_omni3/STM32G474RETX_FLASH.ld");
    const debug = cfg.configurations.find((c) => c.name === "Debug");
    expect(debug?.buildPathResolved).toBe("/ws/main/unit_omni3/Debug");
    // A second project resolves to its own root (no cross-contamination).
    const other = parseCproject(FIX("unit_pc-stm.cproject"), {
      projectNameHint: "unit_pc-stm",
      workspaceRoots: {
        unit_omni3: "/ws/main/unit_omni3",
        "unit_pc-stm": "/ws/other/unit_pc-stm",
      },
    });
    expect(other.linkerScriptResolved).toBe("/ws/other/unit_pc-stm/STM32G474RETX_FLASH.ld");
  });

  it("unknown MCU: warn-and-continue, never throw", () => {
    const xml = FIX("unit_omni3.cproject").replaceAll("STM32G474RETx", "STM32ZZ999xx");
    const cfg = parseCproject(xml, { projectNameHint: "unit_omni3" });
    expect(cfg.mcu).toBe("STM32ZZ999xx");
    // Verbatim FPU/ABI survive; parsing continues.
    expect(cfg.fpu).toBe("fpv4-sp-d16");
    expect(cfg.floatAbi).toBe("hard");
    expect([...cfg.defines]).toEqual(G474_DEFINES);
    expect(cfg.warnings.some((w) => w.includes("unknown MCU"))).toBe(true);
  });

  it("garbage input throws a clear error", () => {
    expect(() => parseCproject("<not-a-cproject/>")).toThrow(/no <configuration> blocks/);
  });
});
