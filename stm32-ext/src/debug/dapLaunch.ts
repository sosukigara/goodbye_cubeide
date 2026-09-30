import { targetOfMcu } from "../live/manager.js";
import type { PersistedLiveElf } from "../extension.js";

/** Raw launch.json fragment for type stm32-dap (all fields optional). */
export interface DapLaunchInput {
  readonly elf?: unknown;
  readonly target?: unknown;
}

export type ResolvedDapLaunch =
  | { readonly ok: true; readonly elf: string; readonly target: string }
  | { readonly ok: false; readonly error: string };

/**
 * Q7-A: launch.jsonは最小でよく、空でも動く。正本は既存の
 * stm32ext.* 設定とビルド済みELF (LIVE_ELF_KEY) で、ここでは
 * 明示指定 > 永続化されたビルド成果物の順で解決する。
 */
export function resolveDapLaunch(
  input: DapLaunchInput,
  persisted: PersistedLiveElf | undefined,
): ResolvedDapLaunch {
  const elf = typeof input.elf === "string" && input.elf !== ""
    ? input.elf
    : persisted?.elfPath ?? "";
  if (elf === "") {
    return {
      ok: false,
      error: "ELF が未解決です — 先にビルドしてください (STM32: ビルド)",
    };
  }
  const target = typeof input.target === "string" && input.target !== ""
    ? input.target
    : persisted?.mcu !== undefined && persisted.mcu !== ""
      ? targetOfMcu(persisted.mcu)
      : "";
  if (target === "") {
    return {
      ok: false,
      error: "ターゲットが不明です — 先にビルドしてください (MCU はビルド結果から解決します)",
    };
  }
  return { ok: true, elf, target };
}
