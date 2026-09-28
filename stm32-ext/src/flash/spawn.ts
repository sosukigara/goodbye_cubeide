// todo4: process spawn helper, isolated so unit tests can inject a fake.
//
// The optional timeout exists because `pyocd load` prints
// "Waiting for a debug probe to be connected..." and blocks forever when no
// probe is attached. Without a bound here, the flash button sits dead until the
// caller's own timeout (20 minutes) expires.
import { spawn } from "node:child_process";

export interface SpawnResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** True when the process was killed because it outlived `timeoutMs`. */
  readonly timedOut?: boolean;
}

export async function spawnCli(
  cli: string,
  args: string[],
  timeoutMs?: number,
): Promise<SpawnResult> {
  const { promise, resolve, reject } = Promise.withResolvers<SpawnResult>();
  const child = spawn(cli, args, { shell: false });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  const timer = timeoutMs === undefined
    ? undefined
    : setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
  if (timer !== undefined && typeof timer.unref === "function") {
    timer.unref();
  }
  child.stdout.on("data", (d: Buffer) => {
    stdout += d.toString();
  });
  child.stderr.on("data", (d: Buffer) => {
    stderr += d.toString();
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
  return promise;
}
