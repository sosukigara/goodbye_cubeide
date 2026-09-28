// Multi-project discovery (generic app): an opened folder may be a single
// STM32 project (has .cproject at root) or a container of several projects
// (e.g. main/ holding unit_omni3/, unit_pc-stm/, ...). Pure fs logic so
// vitest can assert against the real firmware tree (read-only).

import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

export interface DiscoveredProject {
  readonly name: string;
  readonly dir: string;
}

/** Directories never descended into during discovery. */
const SKIP_DIRS = new Set(["node_modules", ".git", "build-ext", "Debug", "Release", "Debug-fast", ".vscode", "out"]);

/**
 * Find all STM32 projects under rootDir.
 * - root itself has .cproject -> [root] (single-project mode)
 * - otherwise depth-1 subdirs containing .cproject (container mode)
 * Sorted by name for stable UI order. Never writes.
 */
export function discoverProjects(rootDir: string): DiscoveredProject[] {
  let rootStat;
  try {
    rootStat = statSync(rootDir);
  } catch {
    return [];
  }
  if (!rootStat.isDirectory()) {
    return [];
  }
  if (existsSync(join(rootDir, ".cproject"))) {
    return [{ name: basename(rootDir), dir: rootDir }];
  }
  let entries: string[];
  try {
    entries = readdirSync(rootDir);
  } catch {
    return [];
  }
  const found: DiscoveredProject[] = [];
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) {
      continue;
    }
    const full = join(rootDir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (!st.isDirectory()) {
      continue;
    }
    if (existsSync(join(full, ".cproject"))) {
      found.push({ name: entry, dir: full });
    }
  }
  found.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return found;
}

/** Currently selected project dir (module state; cleared when workspace changes). */
let selectedDir: string | undefined;

export function getSelectedDir(): string | undefined {
  return selectedDir;
}

export function setSelectedDir(dir: string | undefined): void {
  selectedDir = dir;
}

/** Host-side message kinds posted by the project section. */
export type ProjectPanelMessageKind = "select-project" | "refresh";

export function parseProjectPanelMessage(raw: unknown): ProjectPanelMessageKind | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const kind = (raw as Record<string, unknown>)["kind"];
  return kind === "select-project" || kind === "refresh" ? kind : null;
}
