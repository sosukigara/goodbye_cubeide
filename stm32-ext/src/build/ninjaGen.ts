// Fast-build backend: .cproject -> build.ninja generator (todo3).
//
// Consumes the todo2 parser read-only: `parseCproject(xmlText)` returns
// ProjectConfig; everything below copies its text verbatim (G2).
//
// Verbatim contract (mirrors unit_omni3/Debug/*/subdir.mk + Debug/makefile,
// GNU Tools for STM32 14.3.rel1):
//   MCU:  -mcpu=cortex-m4 -mthumb -mfloat-abi=hard -mfpu=fpv4-sp-d16
//   C:    arm-none-eabi-gcc -std=gnu11 -g3 -D... -O0 -ffunction-sections
//         -fdata-sections -Wall -fstack-usage -fcyclomatic-complexity
//         --specs=nano.specs
//   C++:  arm-none-eabi-g++ -std=gnu++20 (from .cproject languagestandard
//         suffix) + C flags + -fno-rtti -fno-use-cxa-atexit
//   ASM:  arm-none-eabi-gcc -g3 -DDEBUG -x assembler-with-cpp --specs=nano.specs
//   LINK: arm-none-eabi-g++ @objs -T <ld> --specs=nosys.specs -Wl,-Map
//         -Wl,--gc-sections -static <otherLinkerFlags verbatim>
//         --specs=nano.specs -Wl,--start-group -lc -lm -lstdc++ -lsupc++
//         -Wl,--end-group
//
// Optimization note: the plan text says "Debug -g3 + -Og", but the real
// Debug artifacts (Debug/Core/Src/subdir.mk) use -O0 — the .cproject Debug
// configuration carries NO optimization.level value, and CubeIDE's default
// for an empty level is -O0. SCOPE OUT forbids changing opt levels and Done
// requires parity PASS (+-1%) against the existing Debug/*.elf, so -O0 is
// mirrored verbatim. If a future .cproject carries an explicit level, its
// suffix is mapped (-Os/-O0/-Og/-O1/-O2/-O3) and recorded in the header.

import { readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ProjectConfig } from "../parser/index.js";

export type SourceKind = "c" | "cxx" | "asm";

export interface DiscoveredSource {
  /** Absolute path (read-only reference into the firmware tree). */
  readonly absPath: string;
  /** Posix-style path relative to projectRoot, e.g. "Core/Src/main.c". */
  readonly relPath: string;
  readonly kind: SourceKind;
}

export interface DiscoverResult {
  readonly sources: readonly DiscoveredSource[];
  readonly warnings: readonly string[];
}

const CXX_EXTS = new Set([".cpp", ".cxx", ".cc", ".C", ".c++"]);
const ASM_EXTS = new Set([".s", ".S"]);

function extOf(fileName: string): string {
  const i = fileName.lastIndexOf(".");
  return i < 0 ? "" : fileName.slice(i);
}

export function classifySource(fileName: string): SourceKind | undefined {
  const ext = extOf(fileName);
  if (ext === ".c") {
    return "c";
  }
  if (CXX_EXTS.has(ext)) {
    return "cxx";
  }
  if (ASM_EXTS.has(ext)) {
    return "asm";
  }
  return undefined;
}

/** Walk sourceEntries (e.g. ["Core", "Drivers"]) under projectRoot. Pure read. */
export function discoverSources(projectRoot: string, sourceEntries: readonly string[]): DiscoverResult {
  const sources: DiscoveredSource[] = [];
  const warnings: string[] = [];
  const visit = (dirAbs: string): void => {
    let names: string[];
    try {
      names = readdirSync(dirAbs).sort();
    } catch {
      warnings.push(`discoverSources: cannot read directory "${dirAbs}"; skipped`);
      return;
    }
    for (const name of names) {
      const abs = join(dirAbs, name);
      let isDir = false;
      try {
        isDir = statSync(abs).isDirectory();
      } catch {
        warnings.push(`discoverSources: cannot stat "${abs}"; skipped`);
        continue;
      }
      if (isDir) {
        visit(abs);
        continue;
      }
      const kind = classifySource(name);
      if (kind !== undefined) {
        sources.push({ absPath: abs, relPath: relative(projectRoot, abs).split(sep).join("/"), kind });
      }
    }
  };
  if (sourceEntries.length === 0) {
    warnings.push("discoverSources: empty sourceEntries; no sources indexed");
  }
  for (const entry of sourceEntries) {
    const abs = resolve(projectRoot, entry);
    let isDir = false;
    try {
      isDir = statSync(abs).isDirectory();
    } catch {
      warnings.push(`discoverSources: source entry "${entry}" not found under "${projectRoot}"; skipped`);
      continue;
    }
    if (!isDir) {
      warnings.push(`discoverSources: source entry "${entry}" is not a directory; skipped`);
      continue;
    }
    visit(abs);
  }
  return { sources, warnings };
}

export interface RenderArgs {
  readonly cfg: ProjectConfig;
  /** Absolute firmware project root (include dirs resolve against Debug build dir). */
  readonly projectRoot: string;
  /** Absolute build output dir (build-ext/). Never inside Debug/. */
  readonly outDirAbs: string;
  readonly artifactName: string;
  readonly sources: readonly DiscoveredSource[];
  readonly useCcache: boolean;
  /** Absolute linker script path (already resolved). */
  readonly linkerAbs: string;
  /** Absolute include dirs (already resolved). */
  readonly includesAbs: readonly string[];
  /** Absolute path of the Debug build dir used for relative -I resolution note. */
  readonly debugBuildDirAbs: string;
}

// CubeIDE-only analysis flags: -fcyclomatic-complexity exists solely in
// STMicroelectronics' patched "GNU Tools for STM32" GCC fork and only emits
// .cyclo side reports (zero codegen effect). Stock arm-none-eabi-gcc rejects
// it, so it is dropped here and the drop is recorded in the ninja header.
// -fstack-usage is kept verbatim (supported upstream, .su side files only).
const ANALYSIS_FLAGS = "-fstack-usage";
const DROPPED_ANALYSIS_FLAGS = "-fcyclomatic-complexity";

function shellQuote(p: string): string {
  return /[^A-Za-z0-9_@%+=:,./-]/.test(p) ? `"${p.replace(/"/g, "\\\"")}"` : p;
}

/** Map a .cproject optimization suffix to a GCC flag. Empty = CubeIDE Debug default -O0. */
export function optimizationFlag(suffix: string | undefined): { flag: string; note: string } {
  switch (suffix) {
    case "os":
      return { flag: "-Os", note: "verbatim .cproject optimization.level=os" };
    case "o0":
      return { flag: "-O0", note: "verbatim .cproject optimization.level=o0" };
    case "og":
      return { flag: "-Og", note: "verbatim .cproject optimization.level=og" };
    case "o1":
      return { flag: "-O1", note: "verbatim .cproject optimization.level=o1" };
    case "o2":
      return { flag: "-O2", note: "verbatim .cproject optimization.level=o2" };
    case "o3":
      return { flag: "-O3", note: "verbatim .cproject optimization.level=o3" };
    case undefined:
    case "":
      return { flag: "-O0", note: "empty .cproject optimization.level in Debug = CubeIDE default -O0 (verbatim Debug/subdir.mk)" };
    default:
      return { flag: "-O0", note: `unknown optimization suffix "${suffix}"; keeping CubeIDE Debug default -O0` };
  }
}

/** Render the .cproject languagestandard suffix the way CubeIDE does: gnupp20 -> -std=gnu++20. */
export function cxxStdFlag(cppStandard: string): string {
  const m = /^gnupp(\d+)$/.exec(cppStandard);
  if (m !== null) {
    return `-std=gnu++${m[1] as string}`;
  }
  if (cppStandard.startsWith("-std=")) {
    return cppStandard;
  }
  if (cppStandard !== "") {
    return `-std=${cppStandard}`;
  }
  return "-std=gnu++20";
}

function debugConfigOf(cfg: ProjectConfig): { debugLevel: string; cppStandard: string; optimizationRaw: string | undefined } {
  const lower = cfg.configurations.find((c) => c.name.toLowerCase() === "debug") ?? cfg.configurations[0];
  return {
    debugLevel: lower?.debugLevel ?? "g3",
    cppStandard: lower?.cppStandard ?? "gnupp20",
    optimizationRaw: lower?.optimizationRaw,
  };
}

function objOf(relPath: string): string {
  return `obj/${relPath.replace(/\.[^.]+$/, ".o")}`;
}

/** Pure renderer: RenderArgs -> build.ninja text. No fs access. */
export function renderNinja(args: RenderArgs): string {
  const { cfg, outDirAbs, artifactName, sources, useCcache, linkerAbs, includesAbs, debugBuildDirAbs } = args;
  const prefix = cfg.toolchainPrefix !== "" ? cfg.toolchainPrefix : "arm-none-eabi-";
  const cc = `${prefix}gcc`;
  const cxx = `${prefix}g++`;
  const dbg = debugConfigOf(cfg);
  const opt = optimizationFlag(dbg.optimizationRaw);
  // Parser yields the verbatim suffix ("g3"); the GCC flag is "-"+suffix.
  const debugFlag = dbg.debugLevel !== "" ? `-${dbg.debugLevel}` : "-g3";
  const mcuFlags = [...cfg.mcuFlags.argv].join(" ");
  const defines = cfg.defines.map((d) => `-D${d}`).join(" ");
  // CubeIDE assembler template only injects the assembler tool's own defines
  // (verbatim: just -DDEBUG). Never invent extra -D for .s files.
  const asmDefines = cfg.defines.includes("DEBUG") ? "-DDEBUG" : defines;
  const incFlags = includesAbs.map((i) => `-I${shellQuote(i)}`).join(" ");
  const otherLd = [...cfg.otherLinkerFlags].join(" ");
  const elf = `${outDirAbs}/${artifactName}.elf`;
  const map = `${outDirAbs}/${artifactName}.map`;

  const cFlags =
    `-std=gnu11 ${debugFlag} ${defines} -c ${incFlags} ${opt.flag} ` +
    `-ffunction-sections -fdata-sections -Wall ${ANALYSIS_FLAGS} --specs=nano.specs ${mcuFlags}`;
  const cxxFlags =
    `${cxxStdFlag(dbg.cppStandard)} ${debugFlag} ${defines} -c ${incFlags} ${opt.flag} ` +
    `-ffunction-sections -fdata-sections -fno-rtti -fno-use-cxa-atexit -Wall ${ANALYSIS_FLAGS} --specs=nano.specs ${mcuFlags}`;
  const asmFlags = `${debugFlag} ${asmDefines} -c -x assembler-with-cpp --specs=nano.specs ${mcuFlags}`;
  const ldFlags =
    `${mcuFlags} -T${shellQuote(linkerAbs)} --specs=nosys.specs -Wl,-Map=${shellQuote(map)} ` +
    `-Wl,--gc-sections -static ${otherLd} --specs=nano.specs -Wl,--start-group -lc -lm -lstdc++ -lsupc++ -Wl,--end-group`;

  const ccCmd = useCcache ? `ccache ${cc}` : cc;
  const cxxCmd = useCcache ? `ccache ${cxx}` : cxx;

  const lines: string[] = [];
  lines.push("# AUTO-GENERATED by stm32-ext todo3 (ninjaGen). Do not edit.");
  lines.push(`# project=${cfg.projectName} mcu=${cfg.mcu} toolchain=${prefix} artifact=${artifactName}`);
  lines.push(`# mcuFlags verbatim: ${mcuFlags}`);
  lines.push(`# debugLevel verbatim: ${dbg.debugLevel} -> ${debugFlag}; cppStandard verbatim: ${dbg.cppStandard}`);
  lines.push(`# optimization: ${opt.note} -> ${opt.flag}`);
  lines.push(`# includes resolved against Debug build dir: ${debugBuildDirAbs}`);
  lines.push(`# linker script: ${linkerAbs}`);
  lines.push(`# dropped CubeIDE-only analysis flags (no codegen effect, stock GCC rejects): ${DROPPED_ANALYSIS_FLAGS}`);
  lines.push(`# outputs: ${outDirAbs} (independent dir; existing Debug/ untouched)`);
  lines.push("ninja_required_version = 1.10");
  lines.push("");
  lines.push("rule cc");
  lines.push(`  command = ${ccCmd} $in ${cFlags} -MMD -MP -MF $depfile -MT $out -o $out`);
  lines.push("  description = CC $in");
  lines.push("  depfile = $out.d");
  lines.push("  deps = gcc");
  lines.push("");
  lines.push("rule cxx");
  lines.push(`  command = ${cxxCmd} $in ${cxxFlags} -MMD -MP -MF $depfile -MT $out -o $out`);
  lines.push("  description = CXX $in");
  lines.push("  depfile = $out.d");
  lines.push("  deps = gcc");
  lines.push("");
  lines.push("rule asm");
  lines.push(`  command = ${ccCmd} ${asmFlags} -MMD -MP -MF $depfile -MT $out -o $out $in`);
  lines.push("  description = ASM $in");
  lines.push("  depfile = $out.d");
  lines.push("  deps = gcc");
  lines.push("");
  lines.push("rule link");
  lines.push(`  command = ${cxxCmd} -o $out $in ${ldFlags}`);
  lines.push("  description = LINK $out");
  lines.push("");
  lines.push("rule size");
  lines.push(`  command = ${prefix}size -B $in`);
  lines.push("  description = SIZE $in");
  lines.push("");

  const objs: string[] = [];
  const sorted = [...sources].sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  for (const s of sorted) {
    const rule = s.kind === "c" ? "cc" : s.kind === "cxx" ? "cxx" : "asm";
    const obj = `${outDirAbs}/${objOf(s.relPath)}`;
    objs.push(obj);
    lines.push(`build ${obj}: ${rule} ${shellQuote(s.absPath)}`);
  }
  lines.push("");
  lines.push(`build ${elf}: link ${objs.map(shellQuote).join(" ")} | ${shellQuote(linkerAbs)}`);
  lines.push(`build size: size ${elf}`);
  lines.push(`default ${elf}`);
  lines.push("");
  return lines.join("\n");
}

/** Resolve verbatim relative -I entries against the Debug build dir (CubeIDE semantics). */
export function resolveIncludes(includes: readonly string[], debugBuildDirAbs: string): string[] {
  return includes.map((inc) => (isAbsolute(inc) || inc.includes("${") ? inc : resolve(debugBuildDirAbs, inc)));
}

/** Absolute path of the Debug build dir: prefer the parsed buildPathResolved when absolute. */
export function debugBuildDirOf(cfg: ProjectConfig, projectRoot: string): string {
  const dbg = cfg.configurations.find((c) => c.name.toLowerCase() === "debug") ?? cfg.configurations[0];
  const resolved = dbg?.buildPathResolved ?? "";
  if (resolved !== "" && isAbsolute(resolved) && !resolved.includes("${")) {
    return resolved;
  }
  return join(projectRoot, "Debug");
}

/** Absolute linker script: prefer parsed linkerScriptResolved when absolute. */
export function linkerAbsOf(cfg: ProjectConfig, projectRoot: string): string {
  const resolved = cfg.linkerScriptResolved;
  if (resolved !== "" && isAbsolute(resolved) && !resolved.includes("${")) {
    return resolved;
  }
  // Manual fallback for ${workspace_loc:/${ProjName}/X} when no workspaceRoots given.
  const m = /([^/]+\.ld)$/.exec(cfg.linkerScriptRaw);
  const leaf = m?.[1] ?? "STM32G474RETX_FLASH.ld";
  return join(projectRoot, leaf);
}

/** Artifact name: strip ${ProjName}-style placeholders, fall back to projectName. */
export function artifactOf(cfg: ProjectConfig): string {
  const raw = cfg.configurations.find((c) => c.name.toLowerCase() === "debug")?.artifactName
    ?? cfg.configurations[0]?.artifactName
    ?? "";
  if (raw === "" || raw.includes("${")) {
    return cfg.projectName !== "" ? cfg.projectName : "firmware";
  }
  return raw;
}
