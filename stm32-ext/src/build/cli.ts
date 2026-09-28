// CLI: generate build-ext/build.ninja from a .cproject file (todo3).
// Usage:
//   node out/build/cli.js --cproject <file> --project-root <abs dir>
//     --out-dir <abs build-ext dir> [--artifact <name>] [--no-ccache]
// Reads the firmware tree only; writes build.ninja (+ sources.list) into out-dir.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { parseCproject } from "../parser/index.js";
import {
  artifactOf,
  debugBuildDirOf,
  discoverSources,
  linkerAbsOf,
  renderNinja,
  resolveIncludes,
} from "./ninjaGen.js";

function usage(): string {
  return [
    "gen build.ninja from .cproject",
    "  --cproject <file> --project-root <dir> --out-dir <dir> [--artifact <name>] [--no-ccache]",
  ].join("\n");
}

function argValue(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  const v = i >= 0 ? argv[i + 1] : undefined;
  return v;
}

export function main(argv: readonly string[]): number {
  const cproject = argValue(argv, "--cproject");
  const projectRootRaw = argValue(argv, "--project-root");
  const outDirRaw = argValue(argv, "--out-dir");
  if (cproject === undefined || projectRootRaw === undefined || outDirRaw === undefined) {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }
  const projectRoot = resolve(projectRootRaw);
  const outDirAbs = isAbsolute(outDirRaw) ? outDirRaw : resolve(process.cwd(), outDirRaw);
  if (outDirAbs.includes(`${"/"}Debug`) && basename(outDirAbs) === "Debug") {
    process.stderr.write("refusing to write into a Debug/ directory; use an independent build-ext/ dir\n");
    return 2;
  }
  const projectName = basename(projectRoot);
  const xml = readFileSync(cproject, "utf8");
  const cfg = parseCproject(xml, {
    projectNameHint: projectName,
    workspaceRoots: { [projectName]: projectRoot },
    defaultRoot: projectRoot,
  });
  const debugBuildDirAbs = debugBuildDirOf(cfg, projectRoot);
  const linkerAbs = linkerAbsOf(cfg, projectRoot);
  const includesAbs = resolveIncludes(cfg.includes, debugBuildDirAbs);
  const artifactName = argValue(argv, "--artifact") ?? artifactOf(cfg);
  const { sources, warnings } = discoverSources(projectRoot, cfg.sourceEntries);
  const useCcache = !argv.includes("--no-ccache");
  const ninja = renderNinja({
    cfg,
    projectRoot,
    outDirAbs,
    artifactName,
    sources,
    useCcache,
    linkerAbs,
    includesAbs,
    debugBuildDirAbs,
  });
  mkdirSync(outDirAbs, { recursive: true });
  mkdirSync(join(outDirAbs, "obj"), { recursive: true });
  writeFileSync(join(outDirAbs, "build.ninja"), ninja);
  writeFileSync(join(outDirAbs, "sources.list"), sources.map((s) => `${s.kind} ${s.relPath}`).join("\n") + "\n");
  const summary = {
    project: cfg.projectName,
    mcu: cfg.mcu,
    artifact: `${artifactName}.elf`,
    sources: sources.length,
    outDir: outDirAbs,
    warnings: [...cfg.warnings, ...warnings],
  };
  process.stdout.write(`${JSON.stringify(summary, undefined, 2)}\n`);
  return 0;
}

// Entry point when executed as `node out/build/cli.js ...` (CJS output: no import.meta).
if ((process.argv[1] ?? "").endsWith("cli.js")) {
  process.exitCode = main(process.argv.slice(2));
}
