// CLI ELF/target resolution: every branch of src/cli/resolve.ts, driven
// through injected deps (no real python, no real ~/.local writes).
//
// Asserts on the mapped verdict OBJECT and the exit-code-equivalent — never
// on log text. A stripped/no-debug-info ELF is distinguished from a missing
// ELF: different messages, both exit 2.
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STRIP_HINT } from "../src/live/elfResolver.js";
import {
  RESOLVE_EXIT_CODE,
  resolveCliPaths,
  resolveSymbol,
  type CliPathsResult,
  type ResolveSymbolDeps,
} from "../src/cli/resolve.js";
import type { SpawnResult } from "../src/flash/spawn.js";

const ELF = "/fw/build-ext/unit_omni3.elf";
const TARGET = "stm32g474retx";

function okPaths(overrides?: Partial<{ elf: string; target: string; resolution: string }>): CliPathsResult {
  return {
    ok: true,
    elf: overrides?.elf ?? ELF,
    target: overrides?.target ?? TARGET,
    ...(overrides?.resolution === undefined ? {} : { resolution: overrides.resolution }),
  };
}

interface Capture {
  calls: { python: string; script: string; requestJson: string; timeoutMs: number }[];
  results: SpawnResult[];
  deps: ResolveSymbolDeps;
}

function capture(results: SpawnResult | SpawnResult[], overrides?: Partial<ResolveSymbolDeps>): Capture {
  const calls: Capture["calls"] = [];
  const queue = [...(Array.isArray(results) ? results : [results])];
  const deps: ResolveSymbolDeps = {
    spawnWorker: async (python, script, requestJson, timeoutMs) => {
      calls.push({ python, script, requestJson, timeoutMs });
      const next = queue.shift();
      if (next === undefined) {
        throw new Error("unexpected extra spawn");
      }
      return next;
    },
    venvDir: undefined, // system python3 shape; the stub never execs it
    probeOpScript: "/repo/scripts/probe_op.py",
    ...overrides,
  };
  return { calls, results: queue, deps };
}

function workerOk(symbol?: Record<string, unknown>): SpawnResult {
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      ok: true,
      op: "resolve",
      symbol: symbol ?? {
        name: "sys.u32",
        address: "0x20000000",
        size: 4,
        type: "uint32_t",
        kind: "scalar",
        signed: false,
      },
    }),
    stderr: "",
  };
}

function workerRefused(error: string): SpawnResult {
  return {
    exitCode: 2,
    stdout: JSON.stringify({ ok: false, op: "resolve", stage: "resolve", error }),
    stderr: "",
  };
}

describe("resolveCliPaths flag/env precedence", () => {
  const present = { exists: () => true, isDirectory: () => false };

  it("--elf and --target win over the environment", () => {
    const r = resolveCliPaths(
      ["--elf", "/tmp/other.elf", "--target", "stm32f407vg"],
      { STM32_ELF: ELF, STM32_TARGET: TARGET },
      present,
    );
    expect(r).toEqual({ ok: true, elf: "/tmp/other.elf", target: "stm32f407vg" });
  });

  it("falls back to STM32_ELF/STM32_TARGET when flags are absent", () => {
    const r = resolveCliPaths([], { STM32_ELF: ELF, STM32_TARGET: TARGET }, present);
    expect(r).toEqual({ ok: true, elf: ELF, target: TARGET });
  });

  it("an empty --elf falls back to the environment", () => {
    const r = resolveCliPaths(
      ["--elf", "", "--target", TARGET],
      { STM32_ELF: ELF },
      present,
    );
    expect(r).toEqual({ ok: true, elf: ELF, target: TARGET });
  });
});

describe("resolveCliPaths refusals (exit-code-equivalent 2, no spawn)", () => {
  const present = { exists: () => true, isDirectory: () => false };

  it("missing --elf with no env names STM32_ELF and the build hint", () => {
    const r = resolveCliPaths(["--target", TARGET], {}, present);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.stage).toBe("resolve");
      expect(r.exitCode).toBe(2);
      expect(r.exitCode).toBe(RESOLVE_EXIT_CODE);
      expect(r.error).toContain("STM32_ELF");
      expect(r.error).toContain("ninja -C build-ext");
    }
  });

  it("missing target refuses even when the ELF resolves", () => {
    const r = resolveCliPaths(["--elf", ELF], {}, present);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.stage).toBe("resolve");
      expect(r.exitCode).toBe(2);
      expect(r.error).toContain("target");
    }
  });

  it("a whitespace-only target refuses like a missing one", () => {
    const r = resolveCliPaths([], { STM32_ELF: ELF, STM32_TARGET: "   " }, present);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.exitCode).toBe(2);
    }
  });

  it("a missing ELF file names STM32_ELF and the build hint (stale-state case)", () => {
    const r = resolveCliPaths(
      [],
      { STM32_ELF: "/fw/gone.elf", STM32_TARGET: TARGET },
      { exists: () => false, isDirectory: () => false },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.stage).toBe("resolve");
      expect(r.exitCode).toBe(2);
      expect(r.error).toContain("/fw/gone.elf");
      expect(r.error).toContain("STM32_ELF");
      expect(r.error).toContain("ninja -C build-ext");
    }
  });

  it("a directory passed as --elf refuses as not-a-file", () => {
    const dir = mkdtempSync(join(tmpdir(), "stm32-cli-resolve-"));
    const r = resolveCliPaths(
      ["--elf", dir, "--target", TARGET],
      {},
      { exists: () => true, isDirectory: () => true },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.exitCode).toBe(2);
      expect(r.error).toContain("directory");
      expect(r.error).toContain("STM32_ELF");
    }
  });

  it("a pre-built resolution path skips the ELF existence check (fixture/air-gap)", () => {
    const r = resolveCliPaths(
      ["--target", TARGET, "--resolution", "tests/fixtures/mock-resolution.json"],
      {},
      { exists: () => { throw new Error("must not stat when resolution is given"); } },
    );
    expect(r).toEqual({
      ok: true,
      elf: "",
      target: TARGET,
      resolution: "tests/fixtures/mock-resolution.json",
    });
  });
});

describe("resolveSymbol success mapping", () => {
  it("passes symbol meta through verbatim, address 0x-prefixed", async () => {
    const c = capture(workerOk());
    const v = await resolveSymbol("sys.u32", okPaths(), c.deps);
    expect(v).toEqual({
      ok: true,
      symbol: {
        name: "sys.u32",
        address: "0x20000000",
        size: 4,
        type: "uint32_t",
        kind: "scalar",
        signed: false,
      },
      exitCode: 0,
    });
    expect(c.calls).toHaveLength(1);
    const req = JSON.parse(c.calls[0]?.requestJson ?? "{}") as Record<string, unknown>;
    expect(req).toMatchObject({ op: "resolve", name: "sys.u32", elf: ELF, target: TARGET });
  });

  it("forwards the resolution path so fixture runs skip elf_resolve", async () => {
    const c = capture(workerOk());
    const v = await resolveSymbol(
      "sys.u32",
      okPaths({ resolution: "tests/fixtures/mock-resolution.json" }),
      c.deps,
    );
    expect(v.ok).toBe(true);
    const req = JSON.parse(c.calls[0]?.requestJson ?? "{}") as Record<string, unknown>;
    expect(req["resolution"]).toBe("tests/fixtures/mock-resolution.json");
  });
});

describe("resolveSymbol failure mapping (all exit-code-equivalent 2)", () => {
  it("unresolved name maps the worker refusal with stage resolve", async () => {
    const c = capture(workerRefused("refused: sys.nope (not in ELF resolution)"));
    const v = await resolveSymbol("sys.nope", okPaths(), c.deps);
    expect(v).toEqual({
      ok: false,
      stage: "resolve",
      error: "refused: sys.nope (not in ELF resolution)",
      exitCode: 2,
    });
  });

  it("unknown width maps the worker refusal with stage resolve", async () => {
    const c = capture(workerRefused("refused: sys.blob has no usable width (0) (not in ELF resolution)"));
    const v = await resolveSymbol("sys.blob", okPaths(), c.deps);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.stage).toBe("resolve");
      expect(v.exitCode).toBe(2);
      expect(v.error).toContain("not in ELF resolution");
    }
  });

  it("stripped ELF (worker exit 2, elf_resolve strip error) stays a resolve refusal", async () => {
    const c = capture({
      exitCode: 2,
      stdout: JSON.stringify({
        ok: false,
        op: "resolve",
        stage: "resolve",
        error: "elf_resolve failed: no debug info in /fw/fw.elf (stripped?)",
      }),
      stderr: "no debug info",
    });
    const v = await resolveSymbol("sys.u32", okPaths(), c.deps);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.stage).toBe("resolve");
      expect(v.exitCode).toBe(2);
      expect(v.error).toContain("no debug info");
    }
  });

  it("a strip-shaped stderr with non-JSON stdout reuses the strip hint (distinct from missing ELF)", async () => {
    const c = capture({
      exitCode: 2,
      stdout: "Traceback (most recent call last): ... stripped ...",
      stderr: "elf_resolve.py: error: no debug info (stripped or built without -g)",
    });
    const v = await resolveSymbol("sys.u32", okPaths(), c.deps);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.stage).toBe("resolve");
      expect(v.exitCode).toBe(2);
      expect(v.error).toContain(STRIP_HINT);
    }
  });

  it("a non-JSON worker reply without strip markers refuses with the worker tail", async () => {
    const c = capture({ exitCode: 1, stdout: "<not json>", stderr: "worker exploded: boom" });
    const v = await resolveSymbol("sys.u32", okPaths(), c.deps);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.stage).toBe("resolve");
      expect(v.exitCode).toBe(2);
      expect(v.error).toContain("non-JSON");
      expect(v.error).toContain("boom");
    }
  });

  it("a worker reply with missing symbol fields refuses instead of passing undefined through", async () => {
    const c = capture(workerOk({ name: "sys.u32", address: "0x20000000" }));
    const v = await resolveSymbol("sys.u32", okPaths(), c.deps);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.stage).toBe("resolve");
      expect(v.exitCode).toBe(2);
      expect(v.error).toContain("missing fields");
    }
  });

  it("a non-0x address in the reply refuses", async () => {
    const c = capture(workerOk({
      name: "sys.u32",
      address: "not-an-address",
      size: 4,
      type: "uint32_t",
      kind: "scalar",
      signed: false,
    }));
    const v = await resolveSymbol("sys.u32", okPaths(), c.deps);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.exitCode).toBe(2);
    }
  });

  it("a spawn failure becomes a resolve refusal, never a throw", async () => {
    const c = capture([], {
      spawnWorker: async () => { throw new Error("spawn python3 ENOENT"); },
    });
    const v = await resolveSymbol("sys.u32", okPaths(), c.deps);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.stage).toBe("resolve");
      expect(v.exitCode).toBe(2);
      expect(v.error).toContain("ENOENT");
    }
  });

  it("a refused paths result never spawns", async () => {
    const refused = resolveCliPaths([], {}, { exists: () => false, isDirectory: () => false });
    expect(refused.ok).toBe(false);
    const c = capture(workerOk());
    const v = await resolveSymbol("sys.u32", refused, c.deps);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.exitCode).toBe(2);
      expect(v.error).toContain("STM32_ELF");
    }
    expect(c.calls).toHaveLength(0);
  });

  it("an empty symbol name refuses without spawning", async () => {
    const c = capture(workerOk());
    const v = await resolveSymbol("  ", okPaths(), c.deps);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.exitCode).toBe(2);
    }
    expect(c.calls).toHaveLength(0);
  });
});
