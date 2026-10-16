// CLI flash + poll dispatch: stdout stays exactly one JSON object, the
// confirmation gate mirrors `set` (--yes or TTY prompt), and poll collects
// worker `get` replies into a single summary payload.
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main, type CliDeps } from "../src/cli/stm32.js";
import type { FlashResult } from "../src/flash/backend.js";
import type { SpawnResult } from "../src/flash/spawn.js";

// resolveCliPaths checks ELF existence on the real fs: stage a real file.
const STAGE = join(tmpdir(), "stm32-cli-flash-poll-test");
mkdirSync(STAGE, { recursive: true });
const STAGED_ELF = join(STAGE, "fw.elf");
writeFileSync(STAGED_ELF, "");
const ENV = { STM32_ELF: STAGED_ELF, STM32_TARGET: "stm32g474retx" };

interface Capture {
  stdout: string[];
  stderr: string[];
  flashCalls: { mcu: string; req: unknown }[];
  gets: string[];
  workerOps: string[];
  timeouts: number[];
}

function harness(overrides?: Partial<CliDeps>): { deps: CliDeps; cap: Capture } {
  const cap: Capture = { stdout: [], stderr: [], flashCalls: [], gets: [], workerOps: [], timeouts: [] };
  const deps: CliDeps = {
    env: { ...ENV },
    venvDir: undefined,
    probeOpScript: "scripts/probe_op.py",
    stdout: (t) => { cap.stdout.push(t); },
    stderr: (t) => { cap.stderr.push(t); },
    isTTY: false,
    preflight: async () => ({ ok: true }),
    spawnWorker: async (_python, _script, requestJson, timeoutMs) => {
      const req = JSON.parse(requestJson) as {
        op: string;
        name?: string;
        names?: string[];
        count?: number;
        interval_ms?: number;
      };
      cap.workerOps.push(req.op);
      cap.timeouts.push(timeoutMs);
      if (req.op === "poll") {
        const names = req.names ?? [];
        const count = req.count ?? 0;
        const samples: unknown[] = [];
        for (let tick = 0; tick < count; tick++) {
          for (const name of names) {
            samples.push({ tick, name, value: "0x01" });
          }
        }
        cap.gets.push(...names);
        const res: SpawnResult = {
          exitCode: 0,
          stdout: JSON.stringify({
            ok: true, op: "poll", count, intervalMs: req.interval_ms ?? 0, samples,
          }),
          stderr: "",
        };
        return res;
      }
      cap.gets.push(String(req.name));
      const res: SpawnResult = {
        exitCode: 0,
        stdout: JSON.stringify({ ok: true, op: "get", name: req.name, value: "0x01" }),
        stderr: "",
      };
      return res;
    },
    flashRunner: async (mcu: string, req: { elfPath: string; confirmed: boolean; dryRun?: boolean }) => {
      cap.flashCalls.push({ mcu, req });
      const res: FlashResult = {
        ok: true,
        command: `pyocd load --target stm32g474retx ${req.elfPath}`,
        message: req.dryRun === true ? "dry-run" : "flashed",
        ...(req.dryRun === true ? { dryRun: true as const } : {}),
        details: [],
      };
      return res;
    },
    ...overrides,
  };
  return { deps, cap };
}

function json(cap: Capture): Record<string, unknown> {
  expect(cap.stdout).toHaveLength(1);
  return JSON.parse(cap.stdout[0] as string) as Record<string, unknown>;
}

describe("stm32 flash", () => {
  it("dry-run needs no confirmation and emits one JSON", async () => {
    const { deps, cap } = harness();
    const code = await main(["flash", STAGED_ELF, "--dry-run"], deps);
    expect(code).toBe(0);
    expect(cap.flashCalls).toHaveLength(1);
    expect(json(cap)).toMatchObject({ ok: true, op: "flash", dryRun: true });
  });

  it("--yes confirms a real flash with confirmed:true", async () => {
    const { deps, cap } = harness();
    const code = await main(["flash", STAGED_ELF, "--yes"], deps);
    expect(code).toBe(0);
    expect(cap.flashCalls).toHaveLength(1);
    expect(cap.flashCalls[0]).toMatchObject({ mcu: "stm32g474retx" });
    expect((cap.flashCalls[0]?.req as { confirmed: boolean }).confirmed).toBe(true);
  });

  it("non-TTY without --yes refuses before spawning flash", async () => {
    const { deps, cap } = harness();
    const code = await main(["flash", STAGED_ELF], deps);
    expect(code).toBe(2);
    expect(cap.flashCalls).toHaveLength(0);
    expect(json(cap)).toMatchObject({ ok: false, op: "flash" });
  });

  it("non-elf path is refused", async () => {
    const { deps, cap } = harness();
    const code = await main(["flash", join(STAGE, "fw.bin"), "--yes"], deps);
    expect(code).toBe(2);
    expect(cap.flashCalls).toHaveLength(0);
  });
});

describe("stm32 poll", () => {
  it("samples count x names in ONE worker call, not one per sample", async () => {
    const { deps, cap } = harness();
    const code = await main(
      ["poll", "a", "b", "--count", "2", "--interval-ms", "0"],
      deps,
    );
    expect(code).toBe(0);
    // One attach for the whole run: the per-sample spawn is what made the
    // effective period the attach cost instead of --interval-ms.
    expect(cap.workerOps).toEqual(["poll"]);
    expect(cap.gets).toEqual(["a", "b"]);
    const payload = json(cap);
    expect(payload).toMatchObject({ ok: true, op: "poll", count: 2, intervalMs: 0 });
    expect(payload["samples"] as unknown[]).toHaveLength(4);
  });

  it("gives the worker a budget that covers the whole run, not the 60s default", async () => {
    const { deps, cap } = harness();
    const code = await main(
      ["poll", "a", "--count", "100", "--interval-ms", "1000"],
      deps,
    );
    expect(code).toBe(0);
    // 100 ticks x 1s alone exceeds the 60s resolution default.
    expect(cap.timeouts[0]).toBeGreaterThan(100_000);
  });

  it("invalid --count is a usage failure", async () => {
    const { deps, cap } = harness();
    const code = await main(["poll", "a", "--count", "0"], deps);
    expect(code).toBe(2);
    expect(cap.workerOps).toHaveLength(0);
  });
});
