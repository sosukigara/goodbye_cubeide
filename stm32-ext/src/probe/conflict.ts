// CubeIDE / ST-LINK-server conflict detection (pure, testable).
// When CubeIDE holds the probe, CLI/pyOCD fail with DEV_CONNECT_ERR —
// surfacing "CubeIDE is running" beats a cryptic exit code.

export interface ConflictStatus {
  readonly cubeIde: boolean;
  readonly details: readonly string[];
}

/** Scan `ps` comm output for CubeIDE-related processes. Pure. */
export function detectConflicts(psOutput: string): ConflictStatus {
  const hits: string[] = [];
  for (const raw of psOutput.split("\n")) {
    const name = raw.trim().toLowerCase();
    if (!name) {
      continue;
    }
    if (name.includes("stm32cubeide") || name === "stm32cubeide_wa" || name === "stlink-server"
      || name.includes("st-link_cli") || name.includes("st-link_gdbserver")) {
      hits.push(raw.trim());
    }
  }
  return { cubeIde: hits.length > 0, details: hits };
}

/** Platform-aware process lister (injected runner keeps it testable). */
export async function listProcesses(
  run: (bin: string, args: readonly string[]) => Promise<string>,
): Promise<string> {
  if (process.platform === "win32") {
    return run("tasklist", ["/FO", "CSV", "/NH"]);
  }
  return run("ps", ["-eo", "comm"]);
}

export const CUBEIDE_RUNNING_MESSAGE =
  "STM32CubeIDEが起動しています。CubeIDEのデバッグサーバーがST-LINKを掴むため、"
  + "書込・監視が失敗します (DEV_CONNECT_ERR)。CubeIDEを完全終了してから再試行してください。";

export const PROBE_BUSY_MESSAGE =
  "プローブ使用中: 別のウィンドウ/プロセスが監視セッションで掴んでいます。"
  + "相手のLiveパネルの「⏹ 停止」ボタンで解放するか、そちらを閉じてから再接続してください。";

/** "Resource busy" USB errors mean another session/process holds the probe. */
export function isProbeBusyOutput(output: string): boolean {
  return /resource busy/i.test(output);
}

/**
 * Find OUR OWN live_poll.py sessions in `ps -eo pid,args` output.
 * A line matches only when it contains both the marker (our installed
 * scripts dir) and live_poll.py — never foreign processes. Pure.
 */
export function findOwnPollPids(psOutput: string, marker: string): number[] {
  const out: number[] = [];
  for (const raw of psOutput.split("\n")) {
    const line = raw.trim();
    if (!line.includes("live_poll.py") || !line.includes(marker)) {
      continue;
    }
    const m = /^(\d+)\s+/.exec(line);
    if (m) {
      const pid = Number(m[1]);
      if (pid > 0 && pid !== process.pid) {
        out.push(pid);
      }
    }
  }
  return out;
}
