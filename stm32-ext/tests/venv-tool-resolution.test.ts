// The binding that is easiest to break and hardest to notice: a tool that
// first-run setup installed has to be found by the SAME resolveTool call the
// build uses. The pure decision functions can all stay green while the venv's
// bin directory is never actually searched, and then setup "succeeds" and
// every launch still says the tool is missing.
import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTool } from "../src/build/backend.js";
import { setVenvDir, venvBinDir } from "../src/env/venv.js";

/** No such tool on any machine, so a hit can only come from the venv. */
const ABSENT_TOOL = "stm32ext-vonly-tool";

function fakeVenv(tool: string): { root: string; bin: string } {
  const root = mkdtempSync(join(tmpdir(), "stm32ext-vres-"));
  const bin = venvBinDir(join(root, "venv"), "linux");
  mkdirSync(bin, { recursive: true });
  const exe = join(bin, tool);
  writeFileSync(exe, "#!/bin/sh\n");
  chmodSync(exe, 0o755);
  return { root, bin };
}

afterEach(() => {
  setVenvDir(undefined);
});

describe("resolveTool finds what first-run setup installed", () => {
  it("finds a tool that exists only inside the venv", () => {
    // PATH is emptied on purpose: the venv is the only place this tool lives,
    // which is the situation on a machine that never ran apt.
    const { root } = fakeVenv(ABSENT_TOOL);
    try {
      setVenvDir(join(root, "venv"));
      const r = resolveTool(ABSENT_TOOL, { PATH: "/nonexistent" }, "linux");
      expect(r.found).toBe(true);
      expect(r.path).toBe(join(venvBinDir(join(root, "venv"), "linux"), ABSENT_TOOL));
      // ...and it really was searched, not merely found on PATH.
      expect(r.searched).toContain(join(venvBinDir(join(root, "venv"), "linux"), ABSENT_TOOL));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports it missing when the venv holds no such tool", () => {
    const { root } = fakeVenv("other-absent-tool");
    try {
      setVenvDir(join(root, "venv"));
      expect(resolveTool(ABSENT_TOOL, { PATH: "/nonexistent" }, "linux").found).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finds nothing before setup has configured a venv", () => {
    // setVenvDir(undefined) — the state on every machine that has not run
    // setup, and the one that must keep its pre-setup behaviour.
    expect(resolveTool("stm32ext-absent-tool", { PATH: "/nonexistent" }, "linux").found).toBe(false);
  });

  it("leaves a caller-supplied directory list alone", () => {
    // A test (or a caller) that passes its own extraDirs asked for exactly
    // those directories; silently appending the venv would break the
    // isolation the injection exists to provide.
    const { root, bin } = fakeVenv(ABSENT_TOOL);
    try {
      setVenvDir(join(root, "venv"));
      const r = resolveTool(ABSENT_TOOL, { PATH: "/nonexistent" }, "linux", []);
      expect(r.found).toBe(false);
      expect(r.searched).not.toContain(join(bin, ABSENT_TOOL));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
