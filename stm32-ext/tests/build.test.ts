// todo3 tests: ninja generation (verbatim flags), diagnostics parsing, parity logic.
import { describe, expect, it } from "vitest";
import { describeBuildFailure, resolveTool, runNinja } from "../src/build/backend.js";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  artifactOf,
  classifySource,
  cxxStdFlag,
  debugBuildDirOf,
  linkerAbsOf,
  optimizationFlag,
  renderNinja,
  resolveIncludes,
  type DiscoveredSource,
  type RenderArgs,
} from "../src/build/ninjaGen";
import { parseGccDiagnostics, parseNinjaProgress } from "../src/build/backend";
import {
  checkSections,
  checkSymbols,
  formatParitySummary,
  parseBerkeleySize,
  parseNmDefined,
} from "../src/build/parity";
import { diagJumpHref } from "../src/build/backend";
import type { ProjectConfig } from "../src/parser/index";
import { parseCproject } from "../src/parser/index";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = (name: string): string => readFileSync(join(HERE, "fixtures", name), "utf8");

function fakeConfig(): ProjectConfig {
  return {
    projectName: "unit_omni3",
    mcu: "STM32G474RETx",
    fpu: "fpv4-sp-d16",
    floatAbi: "hard",
    toolchainPrefix: "arm-none-eabi-",
    cpuClockMHz: 160,
    includes: ["../Core/Inc", "../../shared"],
    defines: ["DEBUG", "USE_HAL_DRIVER", "STM32G474xx", "TR_HAL_ENABLED"],
    linkerScriptRaw: "${workspace_loc:/${ProjName}/STM32G474RETX_FLASH.ld}",
    linkerScriptResolved: "/fw/unit_omni3/STM32G474RETX_FLASH.ld",
    sourceEntries: ["Core", "Drivers"],
    otherLinkerFlags: ["-Wl,--allow-multiple-definition"],
    configurations: [
      {
        name: "Debug",
        artifactName: "${ProjName}",
        buildPathRaw: "${workspace_loc:/unit_omni3}/Debug",
        buildPathResolved: "/fw/unit_omni3/Debug",
        debugLevel: "g3",
        optimizationRaw: undefined,
        cppStandard: "gnupp20",
        noExceptions: false,
      },
    ],
    mcuFlags: {
      mcpu: "cortex-m4",
      mthumb: true,
      mfloatAbi: "hard",
      mfpu: "fpv4-sp-d16",
      argv: ["-mcpu=cortex-m4", "-mthumb", "-mfloat-abi=hard", "-mfpu=fpv4-sp-d16"],
    },
    warnings: [],
  };
}

const SOURCES: readonly DiscoveredSource[] = [
  { absPath: "/fw/unit_omni3/Core/Src/main.c", relPath: "Core/Src/main.c", kind: "c" },
  { absPath: "/fw/unit_omni3/Core/Src/code.cpp", relPath: "Core/Src/code.cpp", kind: "cxx" },
  { absPath: "/fw/unit_omni3/Core/Startup/startup_stm32g474retx.s", relPath: "Core/Startup/startup_stm32g474retx.s", kind: "asm" },
];

function renderArgs(cfg: ProjectConfig = fakeConfig()): RenderArgs {
  return {
    cfg,
    projectRoot: "/fw/unit_omni3",
    outDirAbs: "/fw/build-ext",
    artifactName: "unit_omni3",
    sources: SOURCES,
    useCcache: true,
    linkerAbs: "/fw/unit_omni3/STM32G474RETX_FLASH.ld",
    includesAbs: ["/fw/unit_omni3/Core/Inc", "/fw/shared"],
    debugBuildDirAbs: "/fw/unit_omni3/Debug",
  };
}

describe("ninjaGen verbatim flags", () => {
  it("carries the canonical MCU quartet verbatim", () => {
    const ninja = renderNinja(renderArgs());
    for (const f of ["-mcpu=cortex-m4", "-mthumb", "-mfloat-abi=hard", "-mfpu=fpv4-sp-d16"]) {
      expect(ninja).toContain(f);
    }
  });
  it("enforces Debug -g3 and CubeIDE-default -O0 (verbatim Debug/subdir.mk), gnu++20", () => {
    const ninja = renderNinja(renderArgs());
    expect(ninja).toContain("-g3");
    expect(ninja).toContain("-std=gnu++20");
    expect(ninja).toContain("-std=gnu11");
    expect(ninja).toContain("-O0");
    expect(ninja).not.toContain("-Og");
  });
  it("drops CubeIDE-only -fcyclomatic-complexity (stock GCC rejects it; no codegen effect)", () => {
    const ninja = renderNinja(renderArgs());
    const commands = ninja.split("\n").filter((l) => l.startsWith("  command ="));
    expect(commands.length).toBeGreaterThan(0);
    for (const c of commands) {
      expect(c).not.toContain("-fcyclomatic-complexity");
    }
    expect(ninja).toContain("-fstack-usage");
    expect(ninja).toContain("dropped CubeIDE-only analysis flags");
  });
  it("uses ccache-prefixed toolchain and keeps all defines/includes", () => {
    const ninja = renderNinja(renderArgs());
    expect(ninja).toContain("ccache arm-none-eabi-gcc");
    expect(ninja).toContain("ccache arm-none-eabi-g++");
    for (const d of ["-DDEBUG", "-DUSE_HAL_DRIVER", "-DSTM32G474xx", "-DTR_HAL_ENABLED"]) {
      expect(ninja).toContain(d);
    }
    expect(ninja).toContain("-I/fw/unit_omni3/Core/Inc");
    expect(ninja).toContain("-Wl,--allow-multiple-definition");
    expect(ninja).toContain("--specs=nano.specs");
    expect(ninja).toContain("--specs=nosys.specs");
    expect(ninja).toContain("-Wl,--gc-sections");
  });
  it("outputs to build-ext only and never references Debug/ as output", () => {
    const ninja = renderNinja(renderArgs());
    expect(ninja).toContain("/fw/build-ext/unit_omni3.elf");
    expect(ninja).toContain("build /fw/build-ext/obj/Core/Src/main.o: cc");
    expect(ninja).toContain("build /fw/build-ext/obj/Core/Src/code.o: cxx");
    expect(ninja).toContain("build /fw/build-ext/obj/Core/Startup/startup_stm32g474retx.o: asm");
    expect(ninja).not.toMatch(/^build .*Debug\//m);
  });
  it("assembler gets only -DDEBUG (verbatim CubeIDE template)", () => {
    const ninja = renderNinja(renderArgs());
    const asmRule = ninja.split("\n").find((l) => l.startsWith("  command = ccache arm-none-eabi-gcc -g3"));
    expect(asmRule).toBeDefined();
    expect(asmRule).toContain("-DDEBUG");
    expect(asmRule).not.toContain("-DUSE_HAL_DRIVER");
  });
  it("link rule mirrors Debug/makefile (Map, static, start-group libs)", () => {
    const ninja = renderNinja(renderArgs());
    const linkRule = ninja.split("\n").find((l) => l.includes("Wl,--start-group"));
    expect(linkRule).toBeDefined();
    expect(ninja).toContain("-lc -lm -lstdc++ -lsupc++");
    expect(ninja).toContain("-static");
    expect(ninja).toContain("STM32G474RETX_FLASH.ld");
  });
});

describe("ninjaGen helpers", () => {
  it("optimizationFlag: empty Debug level means CubeIDE default -O0", () => {
    expect(optimizationFlag(undefined).flag).toBe("-O0");
    expect(optimizationFlag("os").flag).toBe("-Os");
    expect(optimizationFlag("og").flag).toBe("-Og");
  });
  it("cxxStdFlag renders gnupp20 like CubeIDE", () => {
    expect(cxxStdFlag("gnupp20")).toBe("-std=gnu++20");
    expect(cxxStdFlag("")).toBe("-std=gnu++20");
  });
  it("classifySource splits c/cxx/asm", () => {
    expect(classifySource("main.c")).toBe("c");
    expect(classifySource("code.cpp")).toBe("cxx");
    expect(classifySource("startup.s")).toBe("asm");
    expect(classifySource("startup.S")).toBe("asm");
    expect(classifySource("readme.md")).toBeUndefined();
  });
  it("artifactOf falls back to projectName on ${ProjName}", () => {
    expect(artifactOf(fakeConfig())).toBe("unit_omni3");
  });
  it("resolveIncludes anchors relative -I at the Debug build dir", () => {
    expect(resolveIncludes(["../Core/Inc"], "/fw/unit_omni3/Debug")).toEqual(["/fw/unit_omni3/Core/Inc"]);
  });
  it("debugBuildDirOf prefers the parsed absolute build path", () => {
    expect(debugBuildDirOf(fakeConfig(), "/fw/unit_omni3")).toBe("/fw/unit_omni3/Debug");
  });
  it("linkerAbsOf prefers the parsed absolute script", () => {
    expect(linkerAbsOf(fakeConfig(), "/fw/unit_omni3")).toBe("/fw/unit_omni3/STM32G474RETX_FLASH.ld");
  });
});

describe("backend diagnostics", () => {
  it("parses error/warning/note with file:line:col", () => {
    const out = [
      "FAILED: obj/Core/Src/code.o",
      "/fw/unit_omni3/Core/Src/code.cpp:123:5: error: 'foo' was not declared in this scope",
      "/fw/unit_omni3/Core/Src/code.cpp:124:5: warning: unused variable 'x' [-Wunused-variable]",
      "/fw/unit_omni3/Core/Src/code.cpp:123:5: note: suggested alternative: 'bar'",
      "In file included from /fw/unit_omni3/Core/Src/main.c:10:",
      "ninja: build stopped: subcommand failed.",
    ].join("\n");
    const diags = parseGccDiagnostics(out);
    expect(diags).toHaveLength(3);
    expect(diags[0]).toMatchObject({ file: "/fw/unit_omni3/Core/Src/code.cpp", line: 123, col: 5, kind: "error" });
    expect(diags[1]?.kind).toBe("warning");
    expect(diags[2]?.kind).toBe("note");
  });
  it("parses ninja [done/total] progress", () => {
    expect(parseNinjaProgress("[12/318] CC ...\n[13/318] CXX ...\n") ).toEqual({ done: 13, total: 318 });
    expect(parseNinjaProgress("no progress here")).toBeUndefined();
  });
});

describe("parity logic", () => {
  it("passes identical sections, fails beyond +-1%", () => {
    const ref = { text: 156620, data: 1452, bss: 14524 };
    expect(checkSections(ref, ref, 1).pass).toBe(true);
    // +0.5% text drift passes
    expect(checkSections(ref, { ...ref, text: 157400 }, 1).pass).toBe(true);
    // +5% text drift fails
    const bad = checkSections(ref, { ...ref, text: 164451 }, 1);
    expect(bad.pass).toBe(false);
    expect(bad.rows.find((r) => r.name === "text")?.pass).toBe(false);
  });
  it("symbol check ignores addresses but catches missing/changed", () => {
    const ref = new Map([["main", "T:100"], ["g_var", "D:4"]]);
    const same = new Map([["main", "T:100"], ["g_var", "D:4"]]);
    expect(checkSymbols(ref, same).pass).toBe(true);
    const missing = checkSymbols(ref, new Map([["main", "T:100"]]));
    expect(missing.pass).toBe(false);
    expect(missing.missing).toEqual(["g_var"]);
    const changed = checkSymbols(ref, new Map([["main", "T:104"], ["g_var", "D:4"]]));
    expect(changed.pass).toBe(false);
    expect(changed.changed).toHaveLength(1);
  });
  it("parses berkeley size and nm output", () => {
    const sizes = parseBerkeleySize("   text\t   data\t    bss\t    dec\t    hex\tfilename\n 156620\t   1452\t  14524\t 172596\t  2a234\tunit_omni3.elf\n");
    expect(sizes).toEqual({ text: 156620, data: 1452, bss: 14524 });
    const syms = parseNmDefined("08001234 00000020 T main\n20000000 00000004 D g_var\n         U memcpy\n");
    expect(syms.get("main")).toBe("T:00000020");
    expect(syms.get("g_var")).toBe("D:00000004");
  });
  it("summary line reports PASS/FAIL", () => {
    const ref = { text: 1000, data: 100, bss: 100 };
    const s = formatParitySummary(checkSections(ref, ref, 1), checkSymbols(new Map(), new Map()), 1);
    expect(s.startsWith("PASS")).toBe(true);
  });
});

describe("build panel", () => {
  it("jump href encodes file/line/col payload", () => {
    const href = diagJumpHref({ file: "/fw/a.c", line: 3, col: 1, kind: "error", message: "m", raw: "r" });
    expect(href).toContain("stm32ext.openBuildDiag");
    expect(decodeURIComponent(href)).toContain("/fw/a.c");
  });
});

describe("failure cause reporting", () => {
  const base = {
    ok: false, exitCode: 1, elapsedMs: 10, progress: undefined,
    diagnostics: [], stdout: "", stderr: "",
  };

  it("names the tool that could not be started", () => {
    const cause = describeBuildFailure({
      ...base, exitCode: 127,
      stderr: "\nspawn ninja failed (not installed?)",
    });
    expect(cause).toMatch(/ninja/);
    expect(cause).toMatch(/(PATH|インストール|not installed)/);
  });

  it("reports a ninja fatal line verbatim so the user can act on it", () => {
    const cause = describeBuildFailure({
      ...base,
      stdout: "ninja: Entering directory `build-ext'\n",
      stderr: "ninja: fatal: chdir to 'build-ext' - No such file or directory\n",
    });
    expect(cause).toContain("No such file or directory");
  });

  it("surfaces a link error even when the line has no file:line:col prefix", () => {
    const cause = describeBuildFailure({
      ...base,
      stderr: "arm-none-eabi-ld: region `FLASH' overflowed by 312 bytes",
    });
    expect(cause).toMatch(/overflowed/);
  });

  it("falls back to the exit code when the output says nothing useful", () => {
    expect(describeBuildFailure({ ...base, stderr: "", stdout: "" }))
      .toMatch(/exit 1/);
  });

  it("never invents a cause for a build that succeeded", () => {
    expect(describeBuildFailure({ ...base, ok: true, exitCode: 0 })).toBe("");
  });

  it("says plainly that no compiler error was reported", () => {
    const cause = describeBuildFailure({ ...base, stderr: "ninja: error: unknown target 'x'" });
    expect(cause).toMatch(/unknown target/);
  });
});

describe("runNinja resolves the build dir exactly once", () => {
  it("builds successfully with a RELATIVE buildDir (no double chdir)", async () => {
    // Regression: `-C buildDir` plus `cwd: buildDir` made ninja chdir twice,
    // so a relative buildDir always died with "chdir ... No such file".
    const rel = mkdtempSync(join(tmpdir(), "stm32ext-build-"));
    writeFileSync(join(rel, "build.ninja"),
      "rule stamp\n  command = echo built > $out\nbuild out.txt: stamp\ndefault out.txt\n");
    const prev = process.cwd();
    try {
      process.chdir(rel);
      const r = await runNinja({ buildDir: "." });
      expect(r.ok).toBe(true);
      expect(`${r.stdout}${r.stderr}`).toContain("built");
    } finally {
      process.chdir(prev);
      rmSync(rel, { recursive: true, force: true });
    }
  });
});

describe("toolchain lookup", () => {
  it("finds a tool in an extra dir that the supplied PATH omits", () => {
    // The regression: a desktop session's PATH omits ~/.local/bin, so a tool
    // living there could not be spawned. The earlier version asserted against
    // a real /usr/bin/ninja, so it only proved anything on a machine that has
    // ninja — a green suite that hid the very regression it was written for.
    // With the extra directory injected, the file is this test's own.
    const dir = mkdtempSync(join(tmpdir(), "stm32ext-localbin-"));
    writeFileSync(join(dir, "stm32ext-absent-tool"), "");
    const r = resolveTool("stm32ext-absent-tool", { PATH: "/nonexistent" }, "linux", [dir]);
    expect(r.found).toBe(true);
    expect(r.path).toBe(join(dir, "stm32ext-absent-tool"));
    // ...and it is genuinely unreachable via PATH alone.
    expect(resolveTool("stm32ext-absent-tool", { PATH: "/nonexistent" }, "linux", []).found).toBe(false);
  });
  it("reports a searched list when nothing is found", () => {
    const r = resolveTool("definitely-not-a-real-tool-xyz", { PATH: "/usr/bin:/bin" });
    expect(r.found).toBe(false);
    expect(r.searched.length).toBeGreaterThan(0);
  });
  it("prefers an explicit configured path when it is given", () => {
    const r = resolveTool("/usr/bin/make", { PATH: "/usr/bin:/bin" });
    expect(r.found).toBe(true);
    expect(r.path).toBe("/usr/bin/make");
  });
  it("reports a missing configured path rather than silently falling back", () => {
    const r = resolveTool("/nope/ninja", { PATH: "/usr/bin:/bin" });
    expect(r.found).toBe(false);
  });

  it("finds ninja.exe on win32, where the binary carries an extension", () => {
    // The first-run preflight reports a tool as missing when this returns
    // false, and the notice only clears once everything resolves — so a
    // permanent false here means the warning reappears on EVERY launch, with
    // install instructions that cannot possibly help.
    const dir = mkdtempSync(join(tmpdir(), "stm32ext-win-"));
    writeFileSync(join(dir, "ninja.exe"), "");
    const win = resolveTool("ninja", { PATH: dir }, "win32");
    expect(win.found).toBe(true);
    expect(win.path).toBe(join(dir, "ninja.exe"));
    // The bare name is still tried first, so a POSIX-style install on Windows
    // (git bash, WSL shims) keeps working.
    expect(win.searched[0]).toBe(join(dir, "ninja"));
  });

  it("does not append .exe on posix, so linux lookups are unchanged", () => {
    // A name that exists nowhere else: resolveTool always also searches
    // ~/.local/bin, and a real ninja lives there on this machine, which would
    // mask what this is actually asserting.
    const dir = mkdtempSync(join(tmpdir(), "stm32ext-nix-"));
    writeFileSync(join(dir, "stm32ext-absent-tool.exe"), "");
    // Only the .exe exists: on linux this must NOT be found, or a stray file
    // would satisfy the check and then fail to spawn.
    const r = resolveTool("stm32ext-absent-tool", { PATH: dir }, "linux");
    expect(r.found).toBe(false);
    // ...and the .exe was never even considered.
    expect(r.searched.some((p) => p.endsWith(".exe"))).toBe(false);
  });

  it("does not double the extension when the name already has one", () => {
    const dir = mkdtempSync(join(tmpdir(), "stm32ext-ext-"));
    writeFileSync(join(dir, "pyocd.exe"), "");
    const r = resolveTool("pyocd.exe", { PATH: dir }, "win32");
    expect(r.found).toBe(true);
    expect(r.searched.some((p) => p.endsWith("pyocd.exe.exe"))).toBe(false);
  });
});

// The include path is the one option list a project can get wrong without the
// parser looking broken: a real project stored "\"${workspace_loc}/tr\"" and
// the generated -I reached GCC as a path whose first character was a quote, so
// every shared-header include failed with "No such file or directory" while
// parseCproject still reported a plausible config. This pins the emitted
// command, which is what the compiler actually reads.
describe("a workspace_loc include path reaches the compiler resolved", () => {
  const configWithWorkspaceLocIncludes = (): ProjectConfig =>
    parseCproject(
      FIX("unit_omni3.cproject")
        .replaceAll("../../tr", '&quot;${workspace_loc}/tr&quot;')
        .replaceAll("../../shared", '&quot;${workspace_loc}/shared&quot;'),
      {
        projectNameHint: "unit_omni3",
        workspaceRoots: { unit_omni3: "/ws/unit_omni3" },
        defaultRoot: "/ws",
      },
    );

  it("emits an absolute -I with neither the macro nor a quote left in it", () => {
    const cfg = configWithWorkspaceLocIncludes();
    const ninja = renderNinja({
      ...renderArgs(cfg),
      projectRoot: "/ws/unit_omni3",
      debugBuildDirAbs: "/ws/unit_omni3/Debug",
      includesAbs: resolveIncludes(cfg.includes, "/ws/unit_omni3/Debug"),
    });
    expect(ninja).toContain("-I/ws/tr");
    expect(ninja).toContain("-I/ws/shared");
    expect(ninja).not.toContain("${workspace_loc}");
    expect(ninja).not.toMatch(/-I"/);
  });
});

