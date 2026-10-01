// CLI entry: `get|set|ls|info|setup` dispatch over scripts/probe_op.py.
//
// Thin glue only: preflight (preflight.ts), ELF/target + resolve (resolve.ts),
// the write gate (policy.ts), and explicit setup (setup.ts) are the
// authorities — nothing here reimplements them, parses values, prompts on
// stdout, signals pids, or writes the lock file. Value parsing is
// worker-only; this module passes the raw value TEXT through.
//
// Wire contract: stdout is ALWAYS exactly one JSON object (the worker's reply
// verbatim, or a `{ok:false, ..., stage}` error). All human text — worker
// stderr, the confirmation prompt, audit lines — goes to stderr. The only
// stdout exception is `--help`, which prints text and exits 0.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { sidecarPython } from "../env/venv.js";
import type { SpawnResult } from "../flash/spawn.js";
import { gateWrite } from "./policy.js";
import { checkPreflight, type PreflightVerdict } from "./preflight.js";
import {
  argValue,
  defaultCliVenvDir,
  defaultProbeOpScript,
  RESOLVE_TIMEOUT_MS,
  resolveCliPaths,
  resolveSymbol,
} from "./resolve.js";
import { runSetup, type SetupResult } from "./setup.js";

/** Flags that consume the following argv token. */
const VALUE_FLAGS = new Set(["--resolution", "--elf", "--target"]);

/** Split argv into the command plus its positional args, skipping flags. */
function splitCommand(argv: readonly string[]): { cmd: string | undefined; args: string[] } {
  let cmd: string | undefined;
  const args: string[] = [];
  let skipNext = false;
  for (const token of argv) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (VALUE_FLAGS.has(token)) {
      skipNext = true;
      continue;
    }
    if (token.startsWith("--")) {
      continue;
    }
    if (cmd === undefined) {
      cmd = token;
    } else {
      args.push(token);
    }
  }
  return { cmd, args };
}

/** Blank (missing, empty, whitespace-only) means "not provided". */
function nonBlank(v: string | undefined): string | undefined {
  return v !== undefined && v.trim() !== "" ? v : undefined;
}

function usage(): string {
  return [
    "usage: stm32 <command> [options]",
    "commands:",
    "  get <name>            read one live symbol",
    "  set <name> <value>    write one live symbol (TTY prompt or --yes)",
    "  ls                    list watchable symbols",
    "  info                  probe/pyocd/elf checks (always exit 0)",
    "  setup                 install pyocd + pyelftools into the CLI venv",
    "options: --elf <path> --target <id> --resolution <path> --mock --yes --help",
    "env: STM32_ELF STM32_TARGET",
  ].join("\n");
}

export interface CliDeps {
  /** Defaults to process.env. */
  readonly env?: Record<string, string | undefined> | undefined;
  /** Defaults to spawning the real worker with stdin JSON. Tests stub this. */
  readonly spawnWorker?: typeof defaultSpawnWorker | undefined;
  /** Defaults to the CLI-owned venv (undefined = system python3). */
  readonly venvDir?: string | undefined;
  /** Defaults to the discovered scripts/probe_op.py. */
  readonly probeOpScript?: string | undefined;
  /** Stdout sink: exactly one JSON object per command. Defaults to process.stdout. */
  readonly stdout?: ((text: string) => void) | undefined;
  /** Stderr sink: all human text. Defaults to process.stderr. */
  readonly stderr?: ((text: string) => void) | undefined;
  /** True when stdin is a TTY. Defaults to process.stdin.isTTY. */
  readonly isTTY?: boolean | undefined;
  /** Confirmation prompt. Defaults to a readline prompt on stderr (never stdout). */
  readonly prompt?: ((question: string) => Promise<string>) | undefined;
  /** Preflight override. Defaults to the real lock + CubeIDE check. */
  readonly preflight?: (() => Promise<PreflightVerdict>) | undefined;
  /** Setup override. Defaults to the real CLI-venv setup. */
  readonly setup?: (() => Promise<SetupResult>) | undefined;
}

/** Spawn the worker: ONE JSON object on stdin, ONE JSON object on stdout. */
export function defaultSpawnWorker(
  python: string,
  script: string,
  requestJson: string,
  timeoutMs: number,
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script], { shell: false });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    if (typeof timer.unref === "function") {
      timer.unref();
    }
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.stdin.on("error", () => {
      // spawn failure surfaces via "error" below; a broken pipe needs no extra report
    });
    child.on("error", (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
        ...(timedOut ? { timedOut: true } : {}),
      });
    });
    child.stdin.write(requestJson);
    child.stdin.end();
  });
}

/** Readline prompt that writes the question to stderr, never stdout. */
function stderrPrompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * Dispatch one CLI invocation. Async only because the worker spawn, the
 * preflight check, and the write gate are async — the contract shape otherwise
 * matches src/build/cli.ts: argv in, process exit code out.
 */
export async function main(argv: readonly string[], deps?: CliDeps | undefined): Promise<number> {
  const env = deps?.env ?? process.env;
  const toStdout = deps?.stdout ?? ((text: string) => { process.stdout.write(text); });
  const toStderr = deps?.stderr ?? ((text: string) => { process.stderr.write(text); });

  if (argv.includes("--help") || argv.includes("-h")) {
    toStdout(usage() + "\n");
    return 0;
  }

  const emit = (payload: unknown): void => {
    toStdout(JSON.stringify(payload) + "\n");
  };
  const fail = (op: string | null, stage: string, error: string): number => {
    emit({ ok: false, op, stage, error });
    return 2;
  };

  const spawnWorker = deps?.spawnWorker ?? defaultSpawnWorker;
  const venvDir = deps?.venvDir ?? defaultCliVenvDir();
  const script = deps?.probeOpScript ?? defaultProbeOpScript();
  const python = sidecarPython(venvDir, process.platform);
  const mock = argv.includes("--mock");

  /** ONE worker spawn; the reply goes to stdout verbatim, code propagates. */
  const runWorker = async (op: string, request: Record<string, unknown>): Promise<number> => {
    let result: SpawnResult;
    try {
      result = await spawnWorker(python, script, JSON.stringify(request), RESOLVE_TIMEOUT_MS);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return fail(op, "op", `cannot run probe worker (${script}): ${detail}`);
    }
    if (result.stderr !== "") {
      toStderr(result.stderr);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(result.stdout) as unknown;
    } catch {
      const tail = result.stderr.trim().split("\n").filter((l) => l.trim() !== "").pop()
        ?? `exit=${result.exitCode}`;
      return fail(op, "op", `worker ${op} returned non-JSON output: ${tail}`);
    }
    emit(payload);
    return result.exitCode;
  };

  const { cmd, args } = splitCommand(argv);

  switch (cmd) {
    case "get": {
      const name = args[0];
      if (name === undefined || name.trim() === "") {
        return fail("get", "preflight", "usage: stm32 get <name> [--elf <path>] [--target <id>] [--resolution <path>] [--mock]");
      }
      const pf = await (deps?.preflight ?? checkPreflight)();
      if (!pf.ok) {
        return fail("get", "preflight", pf.error);
      }
      const paths = resolveCliPaths(argv, env);
      if (!paths.ok) {
        return fail("get", "resolve", paths.error);
      }
      return runWorker("get", {
        op: "get",
        name,
        elf: paths.elf,
        target: paths.target,
        mock,
        ...(paths.resolution === undefined ? {} : { resolution: paths.resolution }),
      });
    }

    case "set": {
      const name = args[0];
      const rawValue = args[1];
      if (name === undefined || name.trim() === "" || rawValue === undefined) {
        return fail("set", "preflight", "usage: stm32 set <name> <value> [--elf <path>] [--target <id>] [--resolution <path>] [--mock] [--yes]");
      }
      const pf = await (deps?.preflight ?? checkPreflight)();
      if (!pf.ok) {
        return fail("set", "preflight", pf.error);
      }
      const paths = resolveCliPaths(argv, env);
      if (!paths.ok) {
        return fail("set", "resolve", paths.error);
      }
      const resolved = await resolveSymbol(name, paths, {
        spawnWorker,
        venvDir,
        probeOpScript: script,
      });
      if (!resolved.ok) {
        return fail("set", "resolve", resolved.error);
      }
      const verdict = await gateWrite(
        name,
        resolved.symbol.address,
        resolved.symbol.size,
        rawValue,
        { yes: argv.includes("--yes") },
        {
          isTTY: deps?.isTTY ?? (process.stdin.isTTY === true),
          // ponytail: policy's default already asks on stderr (stdout stays
          // pure JSON); pass the CLI's stderr prompt explicitly anyway.
          prompt: deps?.prompt ?? stderrPrompt,
          stderr: toStderr,
        },
      );
      if (!verdict.ok) {
        return fail("set", "op", verdict.reason);
      }
      return runWorker("set", {
        op: "set",
        name,
        address: resolved.symbol.address,
        size: resolved.symbol.size,
        base: resolved.symbol.address,
        symbolSize: resolved.symbol.size,
        value: rawValue,
        elf: paths.elf,
        target: paths.target,
        mock,
        ...(paths.resolution === undefined ? {} : { resolution: paths.resolution }),
      });
    }

    case "ls": {
      return runWorker("list", {
        op: "list",
        elf: nonBlank(argValue(argv, "--elf")) ?? nonBlank(env["STM32_ELF"]) ?? "",
        ...(nonBlank(argValue(argv, "--resolution")) === undefined
          ? {}
          : { resolution: nonBlank(argValue(argv, "--resolution")) as string }),
      });
    }

    case "info": {
      return runWorker("info", {
        op: "info",
        elf: nonBlank(argValue(argv, "--elf")) ?? nonBlank(env["STM32_ELF"]) ?? "",
      });
    }

    case "setup": {
      const run = deps?.setup ?? runSetup;
      const result = await run();
      emit({ op: "setup", ...result });
      return result.ok ? 0 : 1;
    }

    default: {
      return fail(
        cmd ?? null,
        "preflight",
        cmd === undefined
          ? `usage: stm32 <get|set|ls|info|setup> [options] (try --help)`
          : `unknown command: ${cmd} (want get|set|ls|info|setup)`,
      );
    }
  }
}

// Entry point when executed as `node out/cli/stm32.js ...` (CJS output: no import.meta).
if ((process.argv[1] ?? "").endsWith("stm32.js")) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      try {
        process.stdout.write(`${JSON.stringify({ ok: false, op: null, stage: "op", error: detail })}\n`);
      } catch {
        // stdout gone; the exit code still reports the failure
      }
      process.exitCode = 2;
    },
  );
}
