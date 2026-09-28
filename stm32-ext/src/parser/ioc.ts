// Minimal .ioc key=value parser + G1 merge (.cproject always wins).
// .ioc is change-detection only: divergence yields warnings, never overrides.

import type { IocConfig, MergeResult, ProjectConfig } from "./types.js";

export function parseIoc(iocText: string): IocConfig {
  const raw: Record<string, string> = {};
  for (const line of iocText.split(/\r?\n/)) {
    const t = line.trim();
    if (t === "" || t.startsWith("#")) {
      continue;
    }
    const eq = t.indexOf("=");
    if (eq < 0) {
      continue;
    }
    const key = t.slice(0, eq).trim();
    const value = t.slice(eq + 1).trim();
    if (key !== "") {
      raw[key] = value;
    }
  }
  const cfg: IocConfig = {
    mcuCpn: raw["Mcu.CPN"],
    mcuName: raw["Mcu.Name"],
    mcuFamily: raw["Mcu.Family"],
    mcuPackage: raw["Mcu.Package"],
    raw,
  };
  return cfg;
}

/** Normalize CubeMX part names for family comparison: STM32G474RET3 vs STM32G474RETx. */
function sameMcuFamily(a: string | undefined, b: string): boolean {
  if (a === undefined || a === "") {
    return true; // nothing to compare against
  }
  const norm = (s: string): string => s.toUpperCase().replace(/\(B-C-E\)/g, "").replace(/\(.*\)/g, "").replace(/X+$/g, "");
  const na = norm(a);
  const nb = norm(b);
  if (na === "" || nb === "") {
    return true;
  }
  // CPN "STM32G474RET3" vs cproject "STM32G474RETx": shared 10-char prefix => same device.
  return na.startsWith(nb.slice(0, 8)) || nb.startsWith(na.slice(0, 8));
}

export function mergeWithIoc(config: ProjectConfig, ioc: IocConfig): MergeResult {
  const warnings: string[] = [...config.warnings];
  if (!sameMcuFamily(ioc.mcuCpn, config.mcu) || !sameMcuFamily(ioc.mcuName, config.mcu)) {
    const detail = ioc.mcuCpn ?? ioc.mcuName ?? "(unknown)";
    warnings.push(
      `divergence: .ioc suggests MCU "${detail}" but .cproject says "${config.mcu}"; ` +
        `keeping .cproject (possible CubeMX regeneration pending)`,
    );
  }
  return { config: { ...config, warnings }, warnings };
}
