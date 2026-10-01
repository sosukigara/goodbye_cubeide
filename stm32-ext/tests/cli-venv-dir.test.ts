// S2-2 regression: `stm32 setup` must install into the venv directory that
// every other CLI command imports from.
//
// The failure this pins is silent and total. With XDG_DATA_HOME set, setup
// reported ok:true after pip-installing into $XDG_DATA_HOME/stm32-cli/venv,
// while get/set/ls/info resolved ~/.local/share/stm32-cli/venv, found no
// interpreter there, fell back to the bare system python3, and ran the whole
// command without pyocd. No stage, no non-zero exit, no warning.
//
// Every assertion here goes through the real functions — the CLI's own
// interpreter resolution and runSetup's own default — with only the command
// runner and the filesystem probe injected. `venvDir` is deliberately NOT
// injected: injecting it would be asserting that a path passed in equals
// itself. Nothing here creates a venv or runs pip; the only thing written to
// disk is one empty file standing in for the interpreter inside the agreed
// directory, so the real existsSync can find it.
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main, type CliDeps } from "../src/cli/stm32.js";
import { runSetup } from "../src/cli/setup.js";
import { venvBinDir, venvPython } from "../src/env/venv.js";
import type { SpawnResult } from "../src/flash/spawn.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "mock-resolution.json");
const OK: SpawnResult = { exitCode: 0, stdout: "", stderr: "" };

const SAVED = {
  HOME: process.env["HOME"],
  XDG_DATA_HOME: process.env["XDG_DATA_HOME"],
};
const roots: string[] = [];

function restore(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

afterEach(() => {
  restore("HOME", SAVED.HOME);
  restore("XDG_DATA_HOME", SAVED.XDG_DATA_HOME);
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

interface Env {
  readonly home: string;
  /** The venv directory the README documents for this environment. */
  readonly venvDir: string;
  /** The interpreter inside it, which is what the CLI must spawn. */
  readonly python: string;
}

/**
 * Stage one environment for a real resolution: a throwaway HOME (and XDG
 * data dir), plus the empty interpreter file the documented venv directory
 * would contain. Three directories and one 0-byte file, all removed in
 * afterEach.
 */
function stageEnv(withXdg: boolean): Env {
  const root = mkdtempSync(join(tmpdir(), "stm32ext-clivenv-"));
  roots.push(root);
  const home = join(root, "home");
  const xdg = join(root, "xdg");
  mkdirSync(home, { recursive: true });
  mkdirSync(xdg, { recursive: true });
  process.env["HOME"] = home;
  if (withXdg) {
    process.env["XDG_DATA_HOME"] = xdg;
  } else {
    delete process.env["XDG_DATA_HOME"];
  }
  const venvDir = withXdg
    ? join(xdg, "stm32-cli", "venv")
    : join(home, ".local", "share", "stm32-cli", "venv");
  const python = venvPython(venvDir, "linux");
  mkdirSync(venvBinDir(venvDir, "linux"), { recursive: true });
  writeFileSync(python, "");
  return { home, venvDir, python };
}

interface Cli {
  readonly deps: CliDeps;
  /** The interpreter each worker spawn was handed, in order. */
  readonly pythons: string[];
}

/** CLI deps with the worker stubbed; `venvDir` left unset on purpose. */
function cli(): Cli {
  const pythons: string[] = [];
  const replies: Record<string, unknown>[] = [
    {
      ok: true,
      op: "resolve",
      symbol: { name: "sys.u32", address: "0x20000000", size: 4, type: "uint32_t", kind: "scalar", signed: false },
    },
    { ok: true, op: "set", name: "sys.u32", readback: "0x00000005" },
    { ok: true, op: "list", symbols: [] },
    { ok: true, op: "info", checks: {} },
  ];
  let next = 0;
  const deps: CliDeps = {
    env: { STM32_ELF: "x", STM32_TARGET: "stm32g474retx" },
    probeOpScript: join(HERE, "..", "scripts", "probe_op.py"),
    stdout: () => {},
    stderr: () => {},
    isTTY: false,
    preflight: async () => ({ ok: true }),
    spawnWorker: async (python: string) => {
      pythons.push(python);
      return { exitCode: 0, stdout: JSON.stringify(replies[next++]), stderr: "" };
    },
  };
  return { deps, pythons };
}

/** Every command that talks to the worker, in the order they dispatch. */
const COMMANDS: readonly (readonly string[])[] = [
  ["info"],
  ["ls", "--resolution", FIXTURE],
  ["get", "sys.u32", "--mock", "--resolution", FIXTURE],
  ["set", "sys.u32", "5", "--mock", "--resolution", FIXTURE, "--yes"],
];

describe("every CLI command runs the interpreter out of the documented venv", () => {
  it("uses $XDG_DATA_HOME/stm32-cli/venv when XDG_DATA_HOME is set", async () => {
    const env = stageEnv(true);
    for (const argv of COMMANDS) {
      const { deps, pythons } = cli();
      const code = await main(argv, deps);
      expect(code, `${argv.join(" ")} exit code`).toBe(0);
      expect(pythons.length, `${argv.join(" ")} worker spawns`).toBeGreaterThan(0);
      // Not "contains" and not a prefix: the exact interpreter inside the
      // documented venv, so a bare `python3` fallback fails here too.
      for (const python of pythons) {
        expect(python, `${argv.join(" ")} interpreter`).toBe(env.python);
      }
    }
  });

  it("uses ~/.local/share/stm32-cli/venv when XDG_DATA_HOME is unset", async () => {
    const env = stageEnv(false);
    for (const argv of COMMANDS) {
      const { deps, pythons } = cli();
      const code = await main(argv, deps);
      expect(code, `${argv.join(" ")} exit code`).toBe(0);
      expect(pythons.length, `${argv.join(" ")} worker spawns`).toBeGreaterThan(0);
      for (const python of pythons) {
        expect(python, `${argv.join(" ")} interpreter`).toBe(env.python);
      }
    }
  });
});

/**
 * `runSetup` with no `venvDir`, so its own default picks the directory. The
 * venv "builds" inside the stub runner: the fake exists() only reports a
 * directory ready once `python -m venv` was asked for it, which is what lets
 * the pip interpreter be observed without a real venv.
 */
async function setupTarget(): Promise<{
  readonly venvDir: string;
  readonly createdInto: string;
  readonly pipInterpreter: string;
}> {
  const calls: string[][] = [];
  const built = new Set<string>();
  const exists = (p: string): boolean =>
    (p.endsWith("/pyvenv.cfg") && built.has(dirname(p))) ||
    (p.endsWith("/bin/python") && built.has(dirname(dirname(p))));
  const run = async (bin: string, args: string[]): Promise<SpawnResult> => {
    calls.push([bin, ...args]);
    if (args[0] === "-m" && args[1] === "venv") {
      built.add(args[2] as string);
      return OK;
    }
    return OK;
  };
  const result = await runSetup({ run, exists, platform: "linux" });
  const venvCall = calls.find((c) => c[1] === "-m" && c[2] === "venv");
  const pipCall = calls.find((c) => c[1] === "-m" && c[2] === "pip");
  return {
    venvDir: result.venvDir,
    createdInto: venvCall?.[3] ?? "",
    pipInterpreter: pipCall?.[0] ?? "",
  };
}

describe("setup installs into the directory the other commands import from", () => {
  it("agrees with the interpreter get/spawned, under XDG_DATA_HOME", async () => {
    const env = stageEnv(true);
    const setup = await setupTarget();
    const { deps, pythons } = cli();
    await main(["get", "sys.u32", "--mock", "--resolution", FIXTURE], deps);

    // setup's own words: the documented directory, created and installed into.
    expect(setup.venvDir).toBe(env.venvDir);
    expect(setup.createdInto).toBe(env.venvDir);
    expect(setup.pipInterpreter).toBe(env.python);
    // ...and the same directory the read path actually runs.
    expect(pythons).toEqual([env.python]);
    expect(setup.pipInterpreter).toBe(pythons[0]);
  });

  it("agrees with the interpreter get/spawned, without XDG_DATA_HOME", async () => {
    const env = stageEnv(false);
    const setup = await setupTarget();
    const { deps, pythons } = cli();
    await main(["get", "sys.u32", "--mock", "--resolution", FIXTURE], deps);

    expect(setup.venvDir).toBe(env.venvDir);
    expect(setup.pipInterpreter).toBe(env.python);
    expect(setup.pipInterpreter).toBe(pythons[0]);
  });
});
