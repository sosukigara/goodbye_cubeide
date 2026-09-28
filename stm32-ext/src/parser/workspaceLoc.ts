// ${workspace_loc} multi-root resolution (G3). Pure string ops, no fs access.

import type { ParseOptions } from "./types.js";

export interface ResolvedPath {
  readonly raw: string;
  readonly resolved: string;
}

/** Leaf name of a ${workspace_loc:/Proj/...} reference, e.g. "unit_omni3". */
export function workspaceProjectOf(raw: string): string | undefined {
  const m = /\$\{workspace_loc:\/([^/}]+)/.exec(raw);
  return m?.[1];
}

export function resolveWorkspaceLoc(raw: string, opts?: ParseOptions): ResolvedPath {
  const roots = opts?.workspaceRoots ?? {};
  const defaultRoot = opts?.defaultRoot ?? "";
  const projHint = opts?.projectNameHint ?? "";

  let resolved = raw;

  // ${ProjName} -> hint (verbatim otherwise).
  if (projHint !== "") {
    resolved = resolved.split("${ProjName}").join(projHint);
  }

  // ${workspace_loc:/Proj/rest...} -> roots[Proj]/rest...
  resolved = resolved.replace(/\$\{workspace_loc:\/([^/}]+)(\/[^}]*)?\}/g, (_whole, proj: string, rest: string | undefined) => {
    const root = roots[proj];
    const suffix = rest ?? "";
    if (root !== undefined && root !== "") {
      return root.replace(/\/+$/, "") + suffix;
    }
    if (defaultRoot !== "") {
      return defaultRoot.replace(/\/+$/, "") + `/${proj}` + suffix;
    }
    // Best-effort: strip the variable, keep a root-anchored path verbatim.
    return `/${proj}${suffix}`;
  });

  // Bare ${workspace_loc} (no project segment).
  if (resolved.includes("${workspace_loc}")) {
    const base = defaultRoot !== "" ? defaultRoot : projHint !== "" && roots[projHint] !== undefined
      ? (roots[projHint] as string)
      : "";
    resolved = resolved.split("${workspace_loc}").join(base);
  }

  return { raw, resolved };
}
