// Parity check logic (todo3): build-ext/*.elf vs existing Debug/*.elf.
// Criteria (G12): per-section size within +-1% AND defined-symbol sets match.
// Symbol identity ignores load addresses (layout may shift by bytes) and
// compares name -> "type:size" so real content drift still fails.

export interface SectionSizes {
  readonly text: number;
  readonly data: number;
  readonly bss: number;
}

export interface SectionRow {
  readonly name: "text" | "data" | "bss";
  readonly ref: number;
  readonly ours: number;
  readonly diffPct: number;
  readonly pass: boolean;
}

/** Compare one section. Zero-size reference sections pass only when also zero. */
export function checkSection(name: SectionRow["name"], ref: number, ours: number, tolPct: number): SectionRow {
  if (ref === 0) {
    return { name, ref, ours, diffPct: ours === 0 ? 0 : 100, pass: ours === 0 };
  }
  const diffPct = (Math.abs(ours - ref) / ref) * 100;
  return { name, ref, ours, diffPct, pass: diffPct <= tolPct };
}

export function checkSections(ref: SectionSizes, ours: SectionSizes, tolPct = 1): { pass: boolean; rows: readonly SectionRow[] } {
  const rows = [
    checkSection("text", ref.text, ours.text, tolPct),
    checkSection("data", ref.data, ours.data, tolPct),
    checkSection("bss", ref.bss, ours.bss, tolPct),
  ];
  return { pass: rows.every((r) => r.pass), rows };
}

/**
 * Compare defined symbols: key = symbol name, value = "type:size".
 * Returns missing (in ref, absent in ours), extra, and changed entries.
 */
export function checkSymbols(
  ref: ReadonlyMap<string, string>,
  ours: ReadonlyMap<string, string>,
): { pass: boolean; missing: readonly string[]; extra: readonly string[]; changed: readonly string[] } {
  const missing: string[] = [];
  const changed: string[] = [];
  for (const [name, sig] of ref) {
    const got = ours.get(name);
    if (got === undefined) {
      missing.push(name);
    } else if (got !== sig) {
      changed.push(`${name}: ref=${sig} ours=${got}`);
    }
  }
  const extra: string[] = [];
  for (const name of ours.keys()) {
    if (!ref.has(name)) {
      extra.push(name);
    }
  }
  missing.sort();
  extra.sort();
  changed.sort();
  return { pass: missing.length === 0 && extra.length === 0 && changed.length === 0, missing, extra, changed };
}

/** Parse `arm-none-eabi-size -B` output (berkeley: text/data/bss/dec/hex columns). */
export function parseBerkeleySize(output: string): SectionSizes {
  const lines = output.trim().split("\n");
  if (lines.length < 2 || lines[0] === undefined) {
    throw new Error("parseBerkeleySize: expected header + data lines");
  }
  const data = lines[1]?.trim().split(/\s+/) ?? [];
  const text = Number(data[0]);
  const dataSeg = Number(data[1]);
  const bss = Number(data[2]);
  if (!Number.isFinite(text) || !Number.isFinite(dataSeg) || !Number.isFinite(bss)) {
    throw new Error(`parseBerkeleySize: unparsable line: ${lines[1] ?? ""}`);
  }
  return { text, data: dataSeg, bss };
}

/**
 * Parse `arm-none-eabi-nm -S --defined-only` output into name -> "type:size".
 * Lines look like: "08001234 00000020 T main" (address may be absent for some).
 */
export function parseNmDefined(output: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    if (line === "") {
      continue;
    }
    const parts = line.split(/\s+/);
    // Forms: [addr] size type name  OR  [addr] type name (no size)
    if (parts.length === 4) {
      const size = parts[1] ?? "";
      const type = parts[2] ?? "";
      const name = parts[3] ?? "";
      if (name !== "") {
        map.set(name, `${type}:${size}`);
      }
    } else if (parts.length === 3) {
      const type = parts[1] ?? "";
      const name = parts[2] ?? "";
      if (name !== "") {
        const prev = map.get(name);
        if (prev === undefined) {
          map.set(name, `${type}:?`);
        }
      }
    }
  }
  return map;
}

/** One-line human summary for logs and the Build panel. */
export function formatParitySummary(
  sections: { pass: boolean; rows: readonly SectionRow[] },
  symbols: { pass: boolean; missing: readonly string[]; extra: readonly string[]; changed: readonly string[] },
  tolPct: number,
): string {
  const sec = sections.rows.map((r) => `${r.name} ref=${r.ref} ours=${r.ours} ${r.diffPct.toFixed(3)}%`).join(", ");
  const sym =
    `missing=${symbols.missing.length} extra=${symbols.extra.length} changed=${symbols.changed.length}`;
  const pass = sections.pass && symbols.pass;
  return `${pass ? "PASS" : "FAIL"} (tol=+-${tolPct}%): ${sec}; symbols ${sym}`;
}
