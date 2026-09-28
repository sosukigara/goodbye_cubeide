// Shared parser types (todo2 owns this dir).
// Contract for sibling workers: `parseCproject(xmlText)` returns ProjectConfig.
// Verbatim rule (G2): never reinterpret/round flags — copy XML text as-is.

export interface McuFlags {
  /** e.g. "cortex-m4" (from MCU table, verbatim). Empty when MCU unknown. */
  readonly mcpu: string;
  /** Always true for Cortex-M (verbatim "-mthumb"). */
  readonly mthumb: boolean;
  /** e.g. "hard" (verbatim from .cproject floatabi suffix). */
  readonly mfloatAbi: string;
  /** e.g. "fpv4-sp-d16" (verbatim from .cproject fpu suffix). Empty when none. */
  readonly mfpu: string;
  /** Canonical argv, verbatim-joined (no rounding): [-mcpu=.., -mthumb, ...]. */
  readonly argv: readonly string[];
}

export interface BuildConfiguration {
  readonly name: string;
  readonly artifactName: string;
  readonly buildPathRaw: string;
  readonly buildPathResolved: string;
  readonly debugLevel: string;
  readonly optimizationRaw: string | undefined;
  readonly cppStandard: string | undefined;
  /** Verbatim "false"->false, "true"->true, absent->undefined. */
  readonly noExceptions: boolean | undefined;
}

export interface ProjectConfig {
  readonly projectName: string;
  /** Verbatim MCU string, e.g. "STM32G474RETx". */
  readonly mcu: string;
  readonly fpu: string;
  readonly floatAbi: string;
  readonly toolchainPrefix: string;
  readonly cpuClockMHz: number | undefined;
  readonly includes: readonly string[];
  readonly defines: readonly string[];
  readonly linkerScriptRaw: string;
  readonly linkerScriptResolved: string;
  readonly sourceEntries: readonly string[];
  readonly otherLinkerFlags: readonly string[];
  readonly configurations: readonly BuildConfiguration[];
  readonly mcuFlags: McuFlags;
  /** Non-fatal notes: unknown MCU, empty sourceEntries, divergence, unresolvable paths. */
  readonly warnings: readonly string[];
}

export interface IocConfig {
  readonly mcuCpn: string | undefined;
  readonly mcuName: string | undefined;
  readonly mcuFamily: string | undefined;
  readonly mcuPackage: string | undefined;
  readonly raw: Readonly<Record<string, string>>;
}

export interface ParseOptions {
  readonly projectNameHint?: string;
  /** Multi-root resolution (G3): project name -> absolute workspace root. */
  readonly workspaceRoots?: Readonly<Record<string, string>>;
  /** Workspace root used when ${workspace_loc} has no explicit project segment. */
  readonly defaultRoot?: string;
}

export interface MergeResult {
  readonly config: ProjectConfig;
  /** Divergence warnings (G1: .cproject always wins). */
  readonly warnings: readonly string[];
}
