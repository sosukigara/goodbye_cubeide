// MCU -> flags table (G11). G4 fully verified; F4/H7/G0 best-effort.
// Values are verbatim GCC spellings — never reinterpreted/rounded (G2).
// Unknown MCU => warn-and-continue with generic Cortex-M4 fallback.

export interface McuTableEntry {
  readonly mcpu: string;
  /** Empty string means "no FPU" (soft cores). */
  readonly mfpu: string;
  readonly mfloatAbi: string;
  readonly verified: boolean;
}

const TABLE: Readonly<Record<string, McuTableEntry>> = {
  STM32G4: { mcpu: "cortex-m4", mfpu: "fpv4-sp-d16", mfloatAbi: "hard", verified: true },
  STM32F4: { mcpu: "cortex-m4", mfpu: "fpv4-sp-d16", mfloatAbi: "hard", verified: false },
  STM32F7: { mcpu: "cortex-m7", mfpu: "fpv5-sp-d16", mfloatAbi: "hard", verified: false },
  STM32H7: { mcpu: "cortex-m7", mfpu: "fpv5-d16", mfloatAbi: "hard", verified: false },
  STM32H5: { mcpu: "cortex-m33", mfpu: "fpv5-sp-d16", mfloatAbi: "hard", verified: false },
  STM32U5: { mcpu: "cortex-m33", mfpu: "fpv5-sp-d16", mfloatAbi: "hard", verified: false },
  STM32L4: { mcpu: "cortex-m4", mfpu: "fpv4-sp-d16", mfloatAbi: "hard", verified: false },
  STM32L5: { mcpu: "cortex-m33", mfpu: "fpv5-sp-d16", mfloatAbi: "hard", verified: false },
  STM32G0: { mcpu: "cortex-m0plus", mfpu: "", mfloatAbi: "soft", verified: false },
  STM32C0: { mcpu: "cortex-m0plus", mfpu: "", mfloatAbi: "soft", verified: false },
  STM32L0: { mcpu: "cortex-m0plus", mfpu: "", mfloatAbi: "soft", verified: false },
  STM32F0: { mcpu: "cortex-m0", mfpu: "", mfloatAbi: "soft", verified: false },
  STM32F1: { mcpu: "cortex-m3", mfpu: "", mfloatAbi: "soft", verified: false },
  STM32F3: { mcpu: "cortex-m4", mfpu: "fpv4-sp-d16", mfloatAbi: "hard", verified: false },
  STM32WB: { mcpu: "cortex-m4", mfpu: "fpv4-sp-d16", mfloatAbi: "hard", verified: false },
  STM32WL: { mcpu: "cortex-m4", mfpu: "", mfloatAbi: "soft", verified: false },
};

export const GENERIC_FALLBACK: McuTableEntry = {
  mcpu: "cortex-m4",
  mfpu: "",
  mfloatAbi: "soft",
  verified: false,
};

export function lookupMcu(mcu: string): { entry: McuTableEntry; family: string; known: boolean } {
  const upper = mcu.toUpperCase();
  // Longest-prefix match so STM32G474RETx hits STM32G4, STM32H503 hits STM32H5, etc.
  const families = Object.keys(TABLE).sort((a, b) => b.length - a.length);
  for (const family of families) {
    if (upper.startsWith(family)) {
      const found = TABLE[family];
      if (found !== undefined) {
        return { entry: found, family, known: true };
      }
    }
  }
  return { entry: GENERIC_FALLBACK, family: "", known: false };
}

export function unknownMcuWarning(mcu: string): string {
  return (
    `unknown MCU "${mcu}": no verified flags table entry; ` +
    `using generic fallback (-mcpu=${GENERIC_FALLBACK.mcpu}) and continuing`
  );
}
