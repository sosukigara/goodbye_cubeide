// CLI explicit setup into the CLI-owned venv. These assert the decisions,
// not the machine: the command runner and the filesystem probe are injected,
// so no test here ever creates a real venv or runs a real pip install.
import { describe, expect, it } from "vitest";
import type { SpawnResult } from "../src/flash/spawn.js";
import {
  CLI_VENV_DIR,
  resolveCliVenvDir,
  runSetup,
  type SetupDeps,
} from "../src/cli/setup.js";

const VENV = "/cli-venv";
const VENV_PY = "/cli-venv/bin/python";
const MARKER = "/cli-venv/pyvenv.cfg";

const ok = (stdout = ""): SpawnResult => ({ exitCode: 0, stdout, stderr: "" });
const fail = (stderr: string, stdout = ""): SpawnResult => ({ exitCode: 1, stdout, stderr });

interface Harness {
  /** Modules the venv python can import right now. */
  importable: Set<string>;
  /** False makes `python3 -m venv` fail. */
  venvCreatable: boolean;
  /** When true the pip install spawn fails. */
  installFails: boolean;
  /** When true every import probe throws instead of returning. */
  probeThrows: boolean;
  built: boolean;
  readonly calls: string[][];
  readonly run: SetupDeps["run"];
  readonly exists: (p: string) => boolean;
}

/** Stateful stub: the venv "appears" once created, imports work once installed. */
function harness(init?: {
  importable?: string[] | undefined;
  venvCreatable?: boolean | undefined;
  installFails?: boolean | undefined;
  probeThrows?: boolean | undefined;
  built?: boolean | undefined;
}): Harness {
  const h: Harness = {
    importable: new Set(init?.importable ?? []),
    venvCreatable: init?.venvCreatable ?? true,
    installFails: init?.installFails ?? false,
    probeThrows: init?.probeThrows ?? false,
    built: init?.built ?? false,
    calls: [],
    run: undefined,
    exists: (p: string) => h.built && (p === MARKER || p === VENV_PY),
  };
  h.run = async (bin: string, args: string[]): Promise<SpawnResult> => {
    h.calls.push([bin, ...args]);
    if (args[0] === "-c" && args[1] !== undefined && args[1].startsWith("import ")) {
      if (h.probeThrows) {
        throw new Error("interrupted");
      }
      const module = args[1].slice("import ".length);
      return h.importable.has(module)
        ? ok()
        : fail(`No module named '${module}'`);
    }
    if (args[0] === "-m" && args[1] === "venv") {
      if (!h.venvCreatable) {
        return fail("Error: venv creation failed (ensurepip missing)");
      }
      h.built = true;
      return ok();
    }
    if (bin === VENV_PY && args[0] === "-m" && args[1] === "pip") {
      if (h.installFails) {
        return fail("error: No matching distribution", "garbage-that-is-not-json");
      }
      // A successful install makes the modules importable, like the field.
      for (const pkg of args.slice(4)) {
        h.importable.add(pkg === "pyelftools" ? "elftools" : pkg);
      }
      return ok();
    }
    return fail(`unexpected call: ${bin} ${args.join(" ")}`);
  };
  return h;
}

function deps(h: Harness, extra?: Partial<SetupDeps>): SetupDeps {
  return { venvDir: VENV, run: h.run, platform: "linux", exists: h.exists, ...extra };
}

/** Spawn invocations that install something (as opposed to import probes). */
function installs(h: Harness): string[][] {
  return h.calls.filter((c) => c[0] === VENV_PY && c.includes("install"));
}

describe("resolveCliVenvDir", () => {
  it("lives under ~/.local/share/stm32-cli/venv by default", () => {
    expect(resolveCliVenvDir({}, "/home/u")).toBe("/home/u/.local/share/stm32-cli/venv");
  });

  it("respects XDG_DATA_HOME when set", () => {
    expect(resolveCliVenvDir({ XDG_DATA_HOME: "/data/x" }, "/home/u")).toBe(
      "/data/x/stm32-cli/venv",
    );
  });

  it("ignores a blank XDG_DATA_HOME", () => {
    expect(resolveCliVenvDir({ XDG_DATA_HOME: "   " }, "/home/u")).toBe(
      "/home/u/.local/share/stm32-cli/venv",
    );
  });

  it("the process default stays inside the stm32-cli data tree", () => {
    expect(CLI_VENV_DIR).toContain("stm32-cli");
    expect(CLI_VENV_DIR.endsWith("venv")).toBe(true);
  });
});

describe("runSetup: the four contract cases", () => {
  it("nothing missing -> no-op with zero installs", async () => {
    const h = harness({ built: true, importable: ["pyocd", "elftools"] });
    const r = await runSetup(deps(h));
    expect(r.ok).toBe(true);
    expect(r.created).toBe(false);
    expect(r.missing).toEqual([]);
    expect(r.installed).toEqual([]);
    expect(r.skipped).toEqual(["pyocd", "pyelftools"]);
    expect(installs(h)).toEqual([]);
    // The only spawns are the two venv-only import probes.
    expect(h.calls).toEqual([
      [VENV_PY, "-c", "import pyocd"],
      [VENV_PY, "-c", "import elftools"],
    ]);
  });

  it("pyocd missing -> installs ONLY pyocd", async () => {
    const h = harness({ built: true, importable: ["elftools"] });
    const r = await runSetup(deps(h));
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual(["pyocd"]);
    expect(r.installed).toEqual(["pyocd"]);
    expect(r.skipped).toEqual(["pyelftools"]);
    const inv = installs(h);
    expect(inv).toHaveLength(1);
    expect(inv[0]?.slice(-1)).toEqual(["pyocd"]);
    expect(inv[0]).not.toContain("pyelftools");
  });

  it("both missing -> installs both", async () => {
    const h = harness({ built: true, importable: [] });
    const r = await runSetup(deps(h));
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual(["pyocd", "pyelftools"]);
    expect(r.installed).toEqual(["pyocd", "pyelftools"]);
    expect(r.skipped).toEqual([]);
    expect(installs(h)).toHaveLength(1);
  });

  it("venv creation failure -> ok:false with the system-continues wording", async () => {
    const h = harness({ built: false, venvCreatable: false });
    const r = await runSetup(deps(h));
    expect(r.ok).toBe(false);
    expect(r.installed).toEqual([]);
    expect(r.detail).toContain("will continue to be used");
    expect(r.detail).toContain("python3");
    expect(installs(h)).toEqual([]);
  });
});

describe("runSetup: unbuilt venv never consults the system interpreter", () => {
  it("counts both tools missing without spawning python3 for probes", async () => {
    const h = harness({ built: false });
    const r = await runSetup(deps(h));
    expect(r.ok).toBe(true);
    expect(r.created).toBe(true);
    expect(r.installed).toEqual(["pyocd", "pyelftools"]);
    // python3 runs ONLY for `python3 -m venv`; the import probes run against
    // the venv python (which fails closed when unbuilt -> missing).
    for (const c of h.calls) {
      if (c[0] === "python3") {
        expect(c.slice(1, 3)).toEqual(["-m", "venv"]);
      }
    }
    expect(h.calls.filter((c) => c[0] === "python3")).toHaveLength(1);
  });

  it("a second run is a no-op (idempotent)", async () => {
    const h = harness({ built: false });
    const first = await runSetup(deps(h));
    expect(first.ok).toBe(true);
    expect(first.installed).toEqual(["pyocd", "pyelftools"]);
    const installsAfterFirst = installs(h).length;
    const second = await runSetup(deps(h));
    expect(second.ok).toBe(true);
    expect(second.created).toBe(false);
    expect(second.installed).toEqual([]);
    expect(installs(h)).toHaveLength(installsAfterFirst);
  });
});

describe("runSetup: win32 venv shape (no posix hardcoding)", () => {
  it("probes and installs through Scripts\\python.exe, never bin/python", async () => {
    const V32 = "C:\\v";
    const PY32 = "C:\\v\\Scripts\\python.exe";
    const h = harness({ built: false });
    // Rewire the harness to the win32 tree: built + importable flip once the
    // venv is created and pip runs, exactly like the posix harness.
    h.exists = (p: string) => h.built && (p === "C:\\v\\pyvenv.cfg" || p === PY32);
    h.run = async (bin: string, args: string[]): Promise<SpawnResult> => {
      h.calls.push([bin, ...args]);
      if (args[0] === "-c" && args[1] !== undefined && args[1].startsWith("import ")) {
        const module = args[1].slice("import ".length);
        return h.importable.has(module)
          ? ok()
          : fail(`No module named '${module}'`);
      }
      if (args[0] === "-m" && args[1] === "venv") {
        h.built = true;
        return ok();
      }
      if (bin === PY32 && args[0] === "-m" && args[1] === "pip") {
        for (const pkg of args.slice(4)) {
          h.importable.add(pkg === "pyelftools" ? "elftools" : pkg);
        }
        return ok();
      }
      return fail(`unexpected call: ${bin} ${args.join(" ")}`);
    };
    const r = await runSetup({ venvDir: V32, run: h.run, platform: "win32", exists: h.exists });
    expect(r.ok).toBe(true);
    expect(r.python).toBe(PY32);
    expect(r.installed).toEqual(["pyocd", "pyelftools"]);
    // Every venv-side spawn targets the Scripts interpreter; the posix shape
    // never appears, and python3 runs only for `-m venv`.
    for (const c of h.calls) {
      if (c[0] === "python3") {
        expect(c.slice(1, 3)).toEqual(["-m", "venv"]);
      } else {
        expect(c[0]).toBe(PY32);
      }
    }
    expect(h.calls.filter((c) => c[0] === "python3")).toHaveLength(1);
    expect(h.calls.some((c) => c[0].includes("/bin/python"))).toBe(false);
  });
});

describe("runSetup: malformed input and misleading output (assert on the parsed object)", () => {
  it("a runner that throws on probes treats them as missing, not as success", async () => {
    const h = harness({ built: true, probeThrows: true });
    const r = await runSetup(deps(h));
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual(["pyocd", "pyelftools"]);
    expect(r.installed).toEqual(["pyocd", "pyelftools"]);
  });

  it("non-zero exit with empty stdout on a probe counts as missing", async () => {
    const strict: Harness = harness({ built: true });
    strict.run = async (bin: string, args: string[]): Promise<SpawnResult> => {
      strict.calls.push([bin, ...args]);
      if (args[0] === "-c") {
        return { exitCode: 1, stdout: "", stderr: "" };
      }
      return ok();
    };
    const r = await runSetup(deps(strict));
    expect(r.missing).toEqual(["pyocd", "pyelftools"]);
    expect(r.installed).toEqual(["pyocd", "pyelftools"]);
  });

  it("garbage on stdout with exit 0 counts as present (exit-code-driven)", async () => {
    const h = harness({ built: true });
    h.run = async (bin: string, args: string[]): Promise<SpawnResult> => {
      h.calls.push([bin, ...args]);
      if (args[0] === "-c") {
        return ok("this is not JSON and must be ignored");
      }
      return fail("unexpected");
    };
    const r = await runSetup(deps(h));
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
    expect(r.installed).toEqual([]);
    expect(installs(h)).toEqual([]);
  });

  it("a failing install parses the last stderr line and reports ok:false", async () => {
    const h = harness({ built: true, installFails: true });
    const r = await runSetup(deps(h));
    expect(r.ok).toBe(false);
    expect(r.installed).toEqual([]);
    // Asserted on the parsed detail, not on absence of stderr.
    expect(r.detail).toContain("No matching distribution");
  });
});
