// CLI entry dispatch: unit tests with the worker spawn stubbed plus a real
// --mock end-to-end test driving the compiled CLI against the fixture.
//
// The unit tests pin the contract: stdout is exactly one JSON object (the
// prompt never leaks there), worker codes propagate verbatim, every error
// carries a stage, and `set` costs exactly two spawns with the gate between.
// The E2E test is what proves IS-1/IS-2/IS-3 — it execs the real
// out/cli/stm32.js with a real python worker, no stubs.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { main, type CliDeps } from "../src/cli/stm32.js";
import type { SpawnResult } from "../src/flash/spawn.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "mock-resolution.json");
const CLI_JS = join(HERE, "..", "out", "cli", "stm32.js");
const ENV = { STM32_ELF: "x", STM32_TARGET: "stm32g474retx" };

interface Capture {
  stdout: string[];
  stderr: string[];
  requests: Record<string, unknown>[];
}

function harness(queue: SpawnResult[], overrides?: Partial<CliDeps>): { deps: CliDeps; cap: Capture } {
  const cap: Capture = { stdout: [], stderr: [], requests: [] };
  const deps: CliDeps = {
    env: { ...ENV },
    // venvDir undefined would consult the real ~/.local tree; the stub never
    // execs the interpreter, so pin a fake dir and assert the request shape.
    venvDir: undefined,
    probeOpScript: join(HERE, "..", "scripts", "probe_op.py"),
    stdout: (t) => { cap.stdout.push(t); },
    stderr: (t) => { cap.stderr.push(t); },
    isTTY: false,
    preflight: async () => ({ ok: true }),
    spawnWorker: async (_python, _script, requestJson, _timeoutMs) => {
      cap.requests.push(JSON.parse(requestJson) as Record<string, unknown>);
      const next = queue.shift();
      if (next === undefined) {
        throw new Error("unexpected extra spawn");
      }
      return next;
    },
    ...overrides,
  };
  return { deps, cap };
}

function ok(stdoutPayload: unknown, exitCode = 0): SpawnResult {
  return { exitCode, stdout: JSON.stringify(stdoutPayload), stderr: "" };
}

const RESOLVE_OK = ok({
  ok: true,
  op: "resolve",
  symbol: { name: "sys.u32", address: "0x20000000", size: 4, type: "uint32_t", kind: "scalar", signed: false },
});

function oneJson(cap: Capture): Record<string, unknown> {
  expect(cap.stdout).toHaveLength(1);
  return JSON.parse(cap.stdout[0] as string) as Record<string, unknown>;
}

describe("stm32 --help", () => {
  it("exits 0 and lists every command", async () => {
    const { deps, cap } = harness([]);
    const code = await main(["--help"], deps);
    expect(code).toBe(0);
    const text = cap.stdout.join("");
    for (const cmd of ["get", "set", "ls", "info", "setup"]) {
      expect(text).toContain(cmd);
    }
  });
});

describe("stm32 usage errors", () => {
  it("unknown command exits 2 with a staged JSON error", async () => {
    const { deps, cap } = harness([]);
    expect(await main(["frobnicate"], deps)).toBe(2);
    const payload = oneJson(cap);
    expect(payload["ok"]).toBe(false);
    expect(payload["stage"]).toBeTruthy();
  });

  it("missing STM32_ELF names the variable and exits 2", async () => {
    const { deps, cap } = harness([], { env: { STM32_TARGET: "stm32g474retx" } });
    expect(await main(["get", "sys.u32"], deps)).toBe(2);
    const payload = oneJson(cap);
    expect(payload["ok"]).toBe(false);
    expect(payload["stage"]).toBe("resolve");
    expect(String(payload["error"])).toContain("STM32_ELF");
    expect(cap.requests).toHaveLength(0);
  });

  it("preflight refusal exits 2 before any spawn", async () => {
    const { deps, cap } = harness([], {
      preflight: async () => ({ ok: false, stage: "preflight", error: "probe busy" }),
    });
    expect(await main(["get", "sys.u32", "--mock", "--resolution", FIXTURE], deps)).toBe(2);
    expect(oneJson(cap)["stage"]).toBe("preflight");
    expect(cap.requests).toHaveLength(0);
  });
});

describe("stm32 get", () => {
  it("does ONE spawn and prints the worker reply verbatim", async () => {
    const reply = { ok: true, op: "get", name: "sys.u32", value: "0x0000002a" };
    const { deps, cap } = harness([ok(reply)]);
    const code = await main(["get", "sys.u32", "--mock", "--resolution", FIXTURE], deps);
    expect(code).toBe(0);
    expect(oneJson(cap)).toEqual(reply);
    expect(cap.requests).toHaveLength(1);
    expect(cap.requests[0]).toMatchObject({ op: "get", name: "sys.u32", mock: true, resolution: FIXTURE });
  });

  it("propagates the worker exit code verbatim on failure", async () => {
    const { deps, cap } = harness([
      { exitCode: 5, stdout: JSON.stringify({ ok: false, op: "get", stage: "attach", error: "no probe" }), stderr: "" },
    ]);
    expect(await main(["get", "sys.u32", "--mock", "--resolution", FIXTURE], deps)).toBe(5);
    const payload = oneJson(cap);
    expect(payload["ok"]).toBe(false);
    expect(payload["stage"]).toBe("attach");
  });
});

describe("stm32 set", () => {
  it("refuses without --yes on a non-TTY: exit 2, staged JSON, audit on stderr, no set spawn", async () => {
    const { deps, cap } = harness([RESOLVE_OK]);
    const code = await main(["set", "sys.u32", "5", "--mock", "--resolution", FIXTURE], deps);
    expect(code).toBe(2);
    const payload = oneJson(cap);
    expect(payload["ok"]).toBe(false);
    expect(payload["stage"]).toBeTruthy();
    expect(cap.stderr.join("")).toContain("REFUSED");
    // resolve only — the op:set spawn must never happen after a refusal
    expect(cap.requests).toHaveLength(1);
    expect(cap.requests[0]).toMatchObject({ op: "resolve", name: "sys.u32" });
  });

  it("with --yes does resolve, gate, then set passing the raw value text", async () => {
    const setReply = { ok: true, op: "set", name: "sys.u32", readback: "0x00000005", note: "ok" };
    const { deps, cap } = harness([RESOLVE_OK, ok(setReply)]);
    const code = await main(["set", "sys.u32", "5", "--mock", "--resolution", FIXTURE, "--yes"], deps);
    expect(code).toBe(0);
    expect(oneJson(cap)).toEqual(setReply);
    expect(cap.requests).toHaveLength(2);
    expect(cap.requests[1]).toMatchObject({
      op: "set",
      address: "0x20000000",
      size: 4,
      base: "0x20000000",
      symbolSize: 4,
      value: "5",
    });
  });

  it("unknown name exits 2 with stage resolve and no gate prompt", async () => {
    const { deps, cap } = harness([
      ok({ ok: false, op: "resolve", stage: "resolve", error: "refused: nope (not in ELF resolution)" }, 2),
    ]);
    const code = await main(["set", "nope", "5", "--mock", "--resolution", FIXTURE, "--yes"], deps);
    expect(code).toBe(2);
    expect(oneJson(cap)["stage"]).toBe("resolve");
    expect(cap.requests).toHaveLength(1);
  });
});

describe("stm32 ls/info", () => {
  it("ls does one list spawn", async () => {
    const reply = { ok: true, op: "list", count: 1, skipped: 0, symbols: [] };
    const { deps, cap } = harness([ok(reply)]);
    expect(await main(["ls", "--resolution", FIXTURE], deps)).toBe(0);
    expect(oneJson(cap)).toEqual(reply);
    expect(cap.requests).toHaveLength(1);
    expect(cap.requests[0]).toMatchObject({ op: "list" });
  });

  it("info does one info spawn and propagates its code", async () => {
    const reply = { ok: true, op: "info", checks: {} };
    const { deps, cap } = harness([ok(reply)]);
    expect(await main(["info"], deps)).toBe(0);
    expect(oneJson(cap)).toEqual(reply);
    expect(cap.requests[0]).toMatchObject({ op: "info" });
  });
});

describe("stm32 --mock E2E (real worker, real fixture)", () => {
  it("get returns one JSON object with a zero-padded hex value", () => {
    expect(existsSync(CLI_JS), `compile first: ${CLI_JS} missing`).toBe(true);
    const out = execFileSync(
      "node",
      [CLI_JS, "get", "sys.u32", "--mock", "--resolution", FIXTURE],
      { encoding: "utf8", env: { ...process.env, ...ENV } },
    );
    const lines = out.trim().split("\n");
    expect(lines).toHaveLength(1);
    const payload = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(payload["ok"]).toBe(true);
    expect(String(payload["value"])).toMatch(/^0x[0-9a-f]{8}$/);
  });

  it("set without --yes on a non-TTY exits 2 with ok:false", () => {
    expect(existsSync(CLI_JS)).toBe(true);
    let code = 0;
    let stdout = "";
    try {
      stdout = execFileSync(
        "node",
        [CLI_JS, "set", "sys.u32", "5", "--mock", "--resolution", FIXTURE],
        { encoding: "utf8", input: "", env: { ...process.env, ...ENV } },
      );
    } catch (err) {
      const e = err as { status?: number; stdout?: string };
      code = e.status ?? -1;
      stdout = e.stdout ?? "";
    }
    expect(code).toBe(2);
    expect((JSON.parse(stdout.trim()) as Record<string, unknown>)["ok"]).toBe(false);
  });
});
