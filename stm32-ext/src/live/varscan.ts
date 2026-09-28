// Source-level variable scan (pure, testable): harvest watchable global
// identifiers from firmware C/C++ sources so the add-watch QuickPick can
// suggest names the user is typing — including globals the ELF resolution
// does not list (resolved later via nm at confirm time).

export interface ScannedVar {
  readonly name: string;
  readonly file: string;
  readonly line: number;
}

const C_KEYWORDS = new Set([
  "if", "else", "for", "while", "do", "switch", "case", "return", "break",
  "continue", "goto", "sizeof", "typedef", "struct", "union", "enum", "class",
  "namespace", "using", "include", "define", "ifdef", "ifndef", "endif",
  "template", "typename", "public", "private", "protected", "virtual",
  "override", "final", "new", "delete", "try", "catch", "throw", "consteval",
  "constexpr", "static_assert", "extern",
]);

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");
}

/**
 * Scan one translation unit for file-scope variable declarations.
 * Heuristic: brace depth 0, no parens (excludes functions/prototypes),
 * ends with ';', takes the identifier before '='/'['/';'.
 */
export function scanSourceVars(path: string, text: string): ScannedVar[] {
  const out: ScannedVar[] = [];
  const clean = stripComments(text);
  let depth = 0;
  const lines = clean.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (depth === 0 && trimmed && !trimmed.startsWith("#") && trimmed.endsWith(";")
      && !trimmed.includes("(") && !trimmed.includes("}")) {
      const head = trimmed.slice(0, -1);
      const m = /([A-Za-z_][A-Za-z0-9_]*)\s*(?:\[[^\]]*\]\s*)?(?:=\s*.+)?$/.exec(head);
      const name = m?.[1];
      if (name && !C_KEYWORDS.has(name)) {
        out.push({ name, file: path, line: i + 1 });
      }
    }
    for (const ch of line) {
      if (ch === "{") {
        depth += 1;
      } else if (ch === "}") {
        depth = Math.max(0, depth - 1);
      }
    }
  }
  return out;
}

/** Merge scanned globals under their resolved dotted names (dedupe, stable order). */
export function mergeSuggestions(
  resolved: readonly string[],
  scanned: readonly ScannedVar[],
): { name: string; detail: string }[] {
  const seen = new Set(resolved);
  const out = resolved.map((name) => ({ name, detail: "ELF解決済み" }));
  const extra = new Map<string, string>();
  for (const s of scanned) {
    if (!seen.has(s.name) && !extra.has(s.name)) {
      extra.set(s.name, `${s.file.split("/").slice(-1)[0]}:${s.line}`);
    }
  }
  for (const [name, where] of extra) {
    out.push({ name, detail: `ソース内検出 (${where})・要解決` });
  }
  return out;
}
