// Hermetic CLI stub for tests whose source resolves a tool on PATH before
// consulting the injected spawn mock (e.g. resolvePyocdPath / resolveCliPath).
// Creates a stub executable with the given name in a temp dir, prepends that
// dir to PATH, and returns a restore function that resets PATH and removes
// the dir. Call restore in afterEach so no PATH state leaks between tests.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

export function stubCliOnPath(name: string): () => void {
  const dir = mkdtempSync(join(tmpdir(), "stm32ext-stubcli-"));
  const exe = join(dir, name);
  writeFileSync(exe, "#!/bin/sh\nexit 0\n");
  chmodSync(exe, 0o755);
  const prev = process.env["PATH"] ?? "";
  process.env["PATH"] = `${dir}${delimiter}${prev}`;
  let restored = false;
  return () => {
    if (restored) {
      return;
    }
    restored = true;
    process.env["PATH"] = prev;
    rmSync(dir, { recursive: true, force: true });
  };
}
