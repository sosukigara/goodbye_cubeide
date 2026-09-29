// Generic .cproject XML parser (todo2). Zero runtime dependencies.
// Rules: .cproject wins on divergence (G1); verbatim flags, no reinterpretation (G2);
// ${workspace_loc} multi-root (G3); MCU table best-effort + unknown-MCU warn-and-continue (G11).

import { lookupMcu, unknownMcuWarning } from "./mcuTable.js";
import { resolveWorkspaceLoc } from "./workspaceLoc.js";
import type { BuildConfiguration, McuFlags, ParseOptions, ProjectConfig } from "./types.js";

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`${name}="([^"]*)"`).exec(tag);
  return m?.[1] === undefined ? undefined : decodeEntities(m[1]);
}

/** Split XML into <configuration ...>...</configuration> blocks with their open tags. */
function configurationBlocks(xml: string): Array<{ openTag: string; body: string }> {
  const out: Array<{ openTag: string; body: string }> = [];
  const re = new RegExp("<configuration\\b([^>]*)>([\\s\\S]*?)</configuration>", "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const openTag = m[1] ?? "";
    // Skip <configuration configurationName="..."> (refreshScope): only real
    // build configurations carry a plain name="..." attribute.
    if (/(?:^|\s)name="/.test(openTag)) {
      out.push({ openTag, body: m[2] ?? "" });
    }
  }
  return out;
}

function configName(openTag: string): string {
  return attr(openTag, "name") ?? "";
}

/** All <option> elements whose superClass contains `needle` (full bodies, children included). */
function optionsBySuperClass(block: string, needle: string): string[] {
  const out: string[] = [];
  const open = new RegExp("<option\\b[^>]*>", "g");
  let m: RegExpExecArray | null;
  while ((m = open.exec(block)) !== null) {
    const openTag = m[0] ?? "";
    const start = (m.index ?? 0) + openTag.length;
    let full: string;
    if (/\/>$/.test(openTag)) {
      full = openTag; // self-closed, no children
    } else {
      const close = block.indexOf("</option>", start);
      full = close < 0 ? openTag : (openTag + block.slice(start, close + "</option>".length));
      open.lastIndex = close < 0 ? start : close + "</option>".length;
    }
    const sc = attr(openTag, "superClass") ?? "";
    if (sc.includes(needle)) {
      out.push(full);
    }
  }
  return out;
}

function listValues(optionTag: string): string[] {
  const out: string[] = [];
  const re = /<listOptionValue\b[^>]*value="([^"]*)"[^>]*\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(optionTag)) !== null) {
    const v = m[1];
    if (v !== undefined) {
      out.push(decodeEntities(v));
    }
  }
  return out;
}

/** Verbatim enum suffix: "com.st...value.fpv4-sp-d16" -> "fpv4-sp-d16". No mapping. */
function enumSuffix(value: string | undefined): string {
  if (value === undefined || value === "") {
    return "";
  }
  const i = value.lastIndexOf(".");
  return i < 0 ? value : (value.slice(i + 1) as string);
}

function firstOptionValue(block: string, needle: string): string | undefined {
  const found = optionsBySuperClass(block, needle);
  if (found.length === 0) {
    return undefined;
  }
  return attr(found[0] as string, "value");
}

function dedupeKeepOrder(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

function parseSourceEntries(block: string, warnings: string[]): string[] {
  const entries: string[] = [];
  const section = /<sourceEntries>([\s\S]*?)<\/sourceEntries>/.exec(block);
  const scope = section?.[1] ?? block;
  const re = /<entry\b[^>]*>/g;
  let m: RegExpExecArray | null;
  let total = 0;
  while ((m = re.exec(scope)) !== null) {
    const tag = m[0] ?? "";
    const kind = attr(tag, "kind") ?? "";
    if (kind !== "sourcePath") {
      continue;
    }
    total += 1;
    const name = attr(tag, "name") ?? "";
    if (name !== "") {
      entries.push(name);
    }
  }
  if (total > 0 && entries.length === 0) {
    warnings.push("empty sourceEntries: .cproject lists source paths with empty names; nothing to index");
  }
  return entries;
}

function parseToolchainPrefix(defaultsValue: string | undefined): string {
  if (defaultsValue !== undefined && defaultsValue !== "") {
    for (const seg of defaultsValue.split(" || ")) {
      const t = seg.trim();
      if (/^arm-none-eabi-$/.test(t) || /^arm-none-eabi-[a-z-]*-$/.test(t)) {
        return t;
      }
    }
  }
  return "arm-none-eabi-";
}

function parseBuildConfiguration(openTag: string, body: string, opts: ParseOptions | undefined): BuildConfiguration {
  const name = configName(openTag);
  const buildPathRaw = new RegExp("<builder\\b[^>]*buildPath=\"([^\"]*)\"").exec(body)?.[1] ?? "";
  const decodedRaw = decodeEntities(buildPathRaw);
  const buildPathResolved = resolveWorkspaceLoc(decodedRaw, opts).resolved;
  const debugRaw = firstOptionValue(body, "tool.c.compiler.option.debuglevel")
    ?? firstOptionValue(body, "tool.cpp.compiler.option.debuglevel")
    ?? firstOptionValue(body, "tool.assembler.option.debuglevel");
  const optRaw = firstOptionValue(body, "optimization.level");
  const noExcRaw = firstOptionValue(body, "noexceptions");
  let noExceptions: boolean | undefined;
  if (noExcRaw === "true") {
    noExceptions = true;
  } else if (noExcRaw === "false") {
    noExceptions = false;
  } else {
    noExceptions = undefined;
  }
  const cfg: BuildConfiguration = {
    name,
    artifactName: attr(openTag, "artifactName") ?? "${ProjName}",
    buildPathRaw: decodedRaw,
    buildPathResolved,
    debugLevel: enumSuffix(debugRaw),
    optimizationRaw: optRaw === undefined || optRaw === "" ? undefined : enumSuffix(optRaw),
    cppStandard: (() => {
      const s = enumSuffix(firstOptionValue(body, "languagestandard") ?? "");
      return s === "" ? undefined : s;
    })(),
    noExceptions,
  };
  return cfg;
}

function buildMcuFlags(mcu: string, fpuVerbatim: string, floatAbiVerbatim: string, warnings: string[]): McuFlags {
  const { entry, known } = lookupMcu(mcu);
  if (!known) {
    warnings.push(unknownMcuWarning(mcu));
  } else if (entry.mfpu !== "" && fpuVerbatim !== "" && entry.mfpu !== fpuVerbatim) {
    // G1: .cproject text wins over the table guess.
    warnings.push(`FPU divergence: table suggests "${entry.mfpu}" but .cproject says "${fpuVerbatim}"; keeping .cproject`);
  } else if (entry.mfloatAbi !== "" && floatAbiVerbatim !== "" && entry.mfloatAbi !== floatAbiVerbatim) {
    warnings.push(
      `FloatABI divergence: table suggests "${entry.mfloatAbi}" but .cproject says "${floatAbiVerbatim}"; keeping .cproject`,
    );
  }
  const mcpu = known ? entry.mcpu : entry.mcpu;
  const mfpu = fpuVerbatim;
  const mfloatAbi = floatAbiVerbatim;
  const argv: string[] = [`-mcpu=${mcpu}`, "-mthumb"];
  if (mfloatAbi !== "") {
    argv.push(`-mfloat-abi=${mfloatAbi}`);
  }
  if (mfpu !== "") {
    argv.push(`-mfpu=${mfpu}`);
  }
  return { mcpu, mthumb: true, mfloatAbi, mfpu, argv };
}

// A .cproject stores a path that needs quoting as "..." INSIDE the attribute,
// so the quotes survive XML decoding and end up as the first and last
// characters of the path. The compiler would then search a directory whose
// name begins with a double quote, and every include through it fails.
const stripOuterQuotes = (p: string): string =>
  p.length >= 2 && p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p;

export function parseCproject(xmlText: string, opts?: ParseOptions): ProjectConfig {
  const warnings: string[] = [];
  const blocks = configurationBlocks(xmlText);
  if (blocks.length === 0) {
    throw new Error("parseCproject: no <configuration> blocks found; not a CubeIDE .cproject file");
  }

  const projectTag = /<project\b[^>]*>/.exec(xmlText)?.[0] ?? "";
  const projectName = attr(projectTag, "name") ?? opts?.projectNameHint ?? "";

  const hint = projectName !== "" ? projectName : opts?.projectNameHint;
  const withOpts: ParseOptions = {
    ...(hint !== undefined && hint !== "" ? { projectNameHint: hint } : {}),
    ...(opts?.workspaceRoots !== undefined ? { workspaceRoots: opts.workspaceRoots } : {}),
    ...(opts?.defaultRoot !== undefined ? { defaultRoot: opts.defaultRoot } : {}),
  };

  // Prefer Debug (case-insensitive); fall back to the first configuration.
  let primary = blocks[0] as { openTag: string; body: string };
  for (const b of blocks) {
    if (configName(b.openTag).toLowerCase() === "debug") {
      primary = b;
      break;
    }
  }
  const body = primary.body;

  const mcu = firstOptionValue(body, "option.target_mcu") ?? "";
  if (mcu === "") {
    warnings.push("missing target_mcu option; MCU unresolved");
  }
  const fpu = enumSuffix(firstOptionValue(body, "option.fpu"));
  const floatAbi = enumSuffix(firstOptionValue(body, "option.floatabi"));
  const cpuClockRaw = firstOptionValue(body, "debug.option.cpuclock");
  const cpuClockMHz = cpuClockRaw !== undefined && cpuClockRaw !== "" && !Number.isNaN(Number(cpuClockRaw))
    ? Number(cpuClockRaw)
    : undefined;
  const toolchainPrefix = parseToolchainPrefix(firstOptionValue(body, "option.defaults"));

  const defines = dedupeKeepOrder(
    optionsBySuperClass(body, "definedsymbols").flatMap((t) => listValues(t)),
  );
  const includes = dedupeKeepOrder(
    optionsBySuperClass(body, "includepaths")
      .flatMap((t) => listValues(t))
      .map((inc) => resolveWorkspaceLoc(stripOuterQuotes(inc), withOpts).resolved),
  );

  const linkerScriptRaw = firstOptionValue(body, "linker.option.script") ?? "";
  const linkerScriptResolved = resolveWorkspaceLoc(linkerScriptRaw, withOpts).resolved;

  const otherLinkerFlags = dedupeKeepOrder(
    optionsBySuperClass(body, "linker.option.otherflags").flatMap((t) => {
      const inline = attr(t, "value");
      const listed = listValues(t);
      return inline !== undefined && inline !== "" ? [inline, ...listed] : listed;
    }),
  );

  const sourceEntries = parseSourceEntries(body, warnings);
  const configurations = blocks.map((b) => parseBuildConfiguration(b.openTag, b.body, withOpts));
  const mcuFlags = buildMcuFlags(mcu, fpu, floatAbi, warnings);

  if (linkerScriptRaw !== "" && /\$\{[^}]*\}/.test(linkerScriptResolved)) {
    warnings.push(`linker script partly unresolved: "${linkerScriptRaw}" -> "${linkerScriptResolved}"`);
  }
  for (const inc of includes) {
    if (/\$\{[^}]*\}/.test(inc)) {
      warnings.push(`include path partly unresolved: "${inc}"`);
    }
  }

  return {
    projectName,
    mcu,
    fpu,
    floatAbi,
    toolchainPrefix,
    cpuClockMHz,
    includes,
    defines,
    linkerScriptRaw,
    linkerScriptResolved,
    sourceEntries,
    otherLinkerFlags,
    configurations,
    mcuFlags,
    warnings,
  };
}
