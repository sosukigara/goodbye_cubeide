// CLI probe preflight: every branch of src/cli/preflight.ts, driven through
// injected deps (no real pids, no real `ps`, no real /tmp lock writes).
import { describe, expect, it } from "vitest";
import {
  CUBEIDE_RUNNING_MESSAGE,
  PREFLIGHT_EXIT_CODE,
  PROBE_BUSY_MESSAGE,
  checkPreflight,
  type PreflightDeps,
} from "../src/cli/preflight.js";
import { writeSessionLock } from "../src/live/manager.js";

const CLEAN_PS = "init\ncode\nnode\npython3\n";
const CUBEIDE_PS = "init\nstm32cubeide\ncode\nnode\n";

interface Capture {
  warnings: string[];
  deps: PreflightDeps;
  alivePids: number[];
}

function capture(overrides?: Partial<PreflightDeps> & { alive?: boolean }): Capture {
  const warnings: string[] = [];
  const alivePids: number[] = [];
  const alive = overrides?.alive ?? false;
  const { alive: _dropped, ...rest } = overrides ?? {};
  const deps: PreflightDeps = {
    readLockText: () => undefined,
    isAlive: (pid: number) => {
      alivePids.push(pid);
      return alive;
    },
    listPs: async () => CLEAN_PS,
    warn: (t: string) => { warnings.push(t); },
    ...rest,
  };
  return { warnings, deps, alivePids };
}

describe("live-lock preflight", () => {
  it("refuses when the recorded holder pid is alive", async () => {
    const lock = writeSessionLock({ pid: process.pid, project: "unit_omni3", started: "t" });
    const c = capture({ readLockText: () => lock, alive: true });
    const v = await checkPreflight(c.deps);
    expect(v).toEqual({ ok: false, stage: "preflight", error: PROBE_BUSY_MESSAGE });
    expect(c.alivePids).toEqual([process.pid]);
    expect(c.warnings).toHaveLength(0);
  });

  it("continues past a dead pid AND warns 'stale lock' (the stale-state case)", async () => {
    const lock = writeSessionLock({ pid: 424242, project: "unit_omni3", started: "t" });
    const c = capture({ readLockText: () => lock, alive: false });
    const v = await checkPreflight(c.deps);
    expect(v).toEqual({ ok: true });
    expect(c.warnings).toHaveLength(1);
    expect(c.warnings[0]).toContain("stale lock");
  });

  it("treats a corrupt lock as no lock and continues silently", async () => {
    const c = capture({ readLockText: () => "garbage{truncated" });
    const v = await checkPreflight(c.deps);
    expect(v).toEqual({ ok: true });
    expect(c.alivePids).toHaveLength(0);
    expect(c.warnings).toHaveLength(0);
  });

  it("passes with no lock and a clean process list", async () => {
    const c = capture();
    expect(await checkPreflight(c.deps)).toEqual({ ok: true });
  });
});

describe("CubeIDE preflight", () => {
  it("refuses before any probe use when CubeIDE is running", async () => {
    const c = capture({ listPs: async () => CUBEIDE_PS });
    const v = await checkPreflight(c.deps);
    expect(v).toEqual({ ok: false, stage: "preflight", error: CUBEIDE_RUNNING_MESSAGE });
  });

  it("detects a CubeIDE line inside a realistic `ps -eo comm` dump", async () => {
    const ps = ["COMMAND", "systemd", "code", "stm32cubeide_wa", "node", "python3", ""].join("\n");
    const c = capture({ listPs: async () => ps });
    const v = await checkPreflight(c.deps);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.stage).toBe("preflight");
      expect(v.error).toContain("CubeIDEを完全終了");
    }
  });

  it("a live lock refuses even when CubeIDE is also running (lock checked first)", async () => {
    const lock = writeSessionLock({ pid: process.pid, project: "unit_omni3", started: "t" });
    const c = capture({ readLockText: () => lock, alive: true, listPs: async () => CUBEIDE_PS });
    const v = await checkPreflight(c.deps);
    expect(v).toEqual({ ok: false, stage: "preflight", error: PROBE_BUSY_MESSAGE });
  });
});

describe("malformed lock input (assert on the verdict, never on stderr silence)", () => {
  const cases: ReadonlyArray<readonly [string, string | undefined]> = [
    ["empty file", ""],
    ["pid 0", writeSessionLock({ pid: 0, project: "x", started: "t" })],
    ["negative pid", writeSessionLock({ pid: -7, project: "x", started: "t" })],
    ["pid as a string", '{"pid":"1234","project":"x","started":"t"}'],
    ["truncated JSON", '{"pid":1234,"project":'],
    ["missing project", '{"pid":1234}'],
    ["unreadable lock", undefined],
  ];
  for (const [name, text] of cases) {
    it(`${name}: continues without throwing`, async () => {
      const c = capture({ readLockText: () => text });
      let v;
      await expect((async () => {
        v = await checkPreflight(c.deps);
      })()).resolves.toBeUndefined();
      expect(v).toEqual({ ok: true });
    });
  }

  it("a throwing liveness checker never escapes (treated as stale, continues)", async () => {
    const lock = writeSessionLock({ pid: 424242, project: "x", started: "t" });
    const c = capture({
      readLockText: () => lock,
      isAlive: () => { throw new Error("checker blew up"); },
    });
    await expect(checkPreflight(c.deps)).resolves.toEqual({ ok: true });
  });

  it("an unreadable process list never escapes (treated as no conflict)", async () => {
    const c = capture({
      listPs: async () => { throw new Error("no ps here"); },
    });
    await expect(checkPreflight(c.deps)).resolves.toEqual({ ok: true });
  });
});

describe("refusal contract", () => {
  it("refusals carry stage 'preflight' with exit-code-equivalent 2", async () => {
    const lock = writeSessionLock({ pid: process.pid, project: "x", started: "t" });
    const c = capture({ readLockText: () => lock, alive: true });
    const v = await checkPreflight(c.deps);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.stage).toBe("preflight");
      expect(PREFLIGHT_EXIT_CODE).toBe(2);
      expect(v.error).toContain("⏹ 停止");
    }
  });

  it("never probes liveness when the lock is absent or corrupt", async () => {
    const clean = capture();
    await checkPreflight(clean.deps);
    expect(clean.alivePids).toHaveLength(0);
    const corrupt = capture({ readLockText: () => "not json" });
    await checkPreflight(corrupt.deps);
    expect(corrupt.alivePids).toHaveLength(0);
  });
});
