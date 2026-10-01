// First-run environment setup. These assert the decisions, not the machine:
// every filesystem and subprocess effect is injected, because "ninja is
// missing here" is a property of whoever ran the suite, and a test that
// depends on that stops meaning anything the moment it runs somewhere else.
import { describe, expect, it } from "vitest";
import {
  AUTO_PACKAGES,
  ensureVenv,
  installPackages,
  packagesFor,
  planSetup,
  setVenvDir,
  sidecarPython,
  venvBinDir,
  venvExtraDirs,
  venvPython,
  venvReady,
  venvToolPath,
} from "../src/env/venv.js";
import type { SpawnResult } from "../src/flash/spawn.js";

const ok = (stdout = ""): SpawnResult => ({ exitCode: 0, stdout, stderr: "" });
const fail = (stderr: string): SpawnResult => ({ exitCode: 1, stdout: "", stderr });

describe("setup: which tools a wheel can honestly provide", () => {
  it("covers ninja, pyocd and pyelftools, and nothing else", () => {
    expect(AUTO_PACKAGES.map((c) => c.tool)).toEqual(["ninja", "pyocd", "pyelftools"]);
  });

  it("maps only the missing tools to packages", () => {
    expect(packagesFor(["ninja", "ccache"])).toEqual(["ninja"]);
    expect(packagesFor([])).toEqual([]);
  });

  it("keeps the cross toolchain and the interpreter out of the plan", () => {
    // Neither can be provisioned by pip: gcc-arm-none-eabi is a large
    // root-owned package, and python3 cannot install a venv without already
    // existing. Reporting them as installable would be a lie the user
    // discovers only after a long, failing download.
    const plan = planSetup(["arm-none-eabi-gcc", "python3", "ccache"]);
    expect(plan.packages).toEqual([]);
    expect(plan.manual).toEqual(["arm-none-eabi-gcc", "python3", "ccache"]);
    expect(plan.ready).toBe(false);
  });

  it("splits a mixed shortfall into installable and manual", () => {
    const plan = planSetup(["ninja", "arm-none-eabi-gcc"]);
    expect(plan.packages).toEqual(["ninja"]);
    expect(plan.manual).toEqual(["arm-none-eabi-gcc"]);
  });

  it("is ready only when nothing at all is missing", () => {
    expect(planSetup([]).ready).toBe(true);
  });
});

describe("setup: venv paths", () => {
  it("uses bin/ on posix and Scripts/ on win32", () => {
    // Built with the target platform's own join: on Linux, path.join would
    // produce "C:\v/Scripts" and a test asserting that shape would be
    // pinning a path Windows would reject.
    expect(venvBinDir("/v", "linux")).toBe("/v/bin");
    expect(venvBinDir("C:\\v", "win32")).toBe("C:\\v\\Scripts");
    expect(venvPython("/v", "linux")).toBe("/v/bin/python");
    expect(venvPython("C:\\v", "win32")).toBe("C:\\v\\Scripts\\python.exe");
  });

  it("treats a missing pyvenv.cfg as not built", () => {
    // The marker, not the directory: a half-created venv left by an
    // interrupted run must be rebuilt, not adopted.
    expect(venvReady("/v", () => false)).toBe(false);
    expect(venvReady("/v", (p) => p === "/v/pyvenv.cfg")).toBe(true);
  });

  it("resolves a tool inside the venv only once it is built", () => {
    expect(venvToolPath("/v", "ninja", "linux", () => false)).toBeUndefined();
    const found = (p: string) => p === "/v/pyvenv.cfg" || p === "/v/bin/ninja";
    expect(venvToolPath("/v", "ninja", "linux", found)).toBe("/v/bin/ninja");
  });

  it("finds ninja.exe on win32 without doubling the extension", () => {
    const found = (p: string) => p === "C:\\v\\pyvenv.cfg" || p === "C:\\v\\Scripts\\ninja.exe";
    expect(venvToolPath("C:\\v", "ninja", "win32", found)).toBe("C:\\v\\Scripts\\ninja.exe");
  });
});

describe("setup: the sidecar interpreter", () => {
  it("falls back to the system python3 when no venv exists", () => {
    // The pre-setup behaviour has to survive: a machine that declines or fails
    // setup must still build and monitor, just without the wheels.
    expect(sidecarPython(undefined, "linux")).toBe("python3");
    expect(sidecarPython("/v", "linux", () => false)).toBe("python3");
  });

  it("prefers the venv python when it is built", () => {
    expect(sidecarPython("/v", "linux", (p) => p === "/v/bin/python")).toBe("/v/bin/python");
  });

  it("contributes no search directory before setup is configured", () => {
    setVenvDir(undefined);
    expect(venvExtraDirs("linux")).toEqual([]);
    setVenvDir("/v");
    expect(venvExtraDirs("linux")).toEqual(["/v/bin"]);
    setVenvDir(undefined);
  });
});

describe("setup: running it", () => {
  it("creates the venv and installs into it", async () => {
    const calls: string[][] = [];
    // The venv "appears" only once python3 -m venv has been asked for, so the
    // post-create check sees what it would actually see in the field.
    let built = false;
    const exists = (p: string) => (built ? p === "/v/pyvenv.cfg" || p === "/v/bin/python" : false);
    const run = async (bin: string, args: string[]): Promise<SpawnResult> => {
      calls.push([bin, ...args]);
      if (args[0] === "-m" && args[1] === "venv") {
        built = true;
      }
      return ok();
    };
    const created = await ensureVenv("/v", "python3", run, "linux", 1000, exists);
    expect(created.result.ok).toBe(true);
    expect(created.python).toBe("/v/bin/python");
    expect(calls[0]).toEqual(["python3", "-m", "venv", "/v"]);

    const installed = await installPackages("/v/bin/python", ["ninja", "pyocd"], run);
    expect(installed.ok).toBe(true);
    // The venv's own pip, not the system one — that is what makes this work
    // on a PEP 668 host, where `pip install --user` is refused outright.
    expect(calls[1]?.[0]).toBe("/v/bin/python");
    expect(calls[1]).toContain("install");
    expect(calls[1]?.slice(-2)).toEqual(["ninja", "pyocd"]);
  });

  it("reuses an existing venv instead of recreating it", async () => {
    const calls: string[][] = [];
    const run = async (bin: string, args: string[]): Promise<SpawnResult> => {
      calls.push([bin, ...args]);
      return ok();
    };
    const alreadyThere = (p: string) => p === "/v/pyvenv.cfg" || p === "/v/bin/python";
    const r = await ensureVenv("/v", "python3", run, "linux", 1000, alreadyThere);
    // pyvenv.cfg is present, so no spawn at all.
    expect(calls).toEqual([]);
    expect(r.result.ok).toBe(true);
    expect(r.python).toBe("/v/bin/python");
  });

  it("reports a failure instead of pretending the venv exists", async () => {
    const run = async (): Promise<SpawnResult> => fail("No module named venv");
    const r = await ensureVenv("/v", "python3", run, "linux", 1000, () => false);
    expect(r.python).toBeUndefined();
    expect(r.result.ok).toBe(false);
    expect(r.result.detail).toContain("No module named venv");
  });

  it("installs nothing when there is nothing to install", async () => {
    let called = false;
    const run = async (): Promise<SpawnResult> => {
      called = true;
      return ok();
    };
    const r = await installPackages("/v/bin/python", [], run);
    expect(r.ok).toBe(true);
    expect(called).toBe(false);
  });

  it("surfaces the line pip printed when it fails", async () => {
    const run = async (): Promise<SpawnResult> => fail("  \nerror: No matching distribution\n");
    const r = await installPackages("/v/bin/python", ["pyocd"], run);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("No matching distribution");
  });
});
