import * as vscode from "vscode";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import { DEFAULT_CLI, resolveCliPath, runFlash, type FlashSettings } from "./flash/backend";
import { parseSidebarMessage, renderSidebar, SIDEBAR_VIEW_ID, type SidebarState } from "./panels/sidebar";
import { discoverProjects, getSelectedDir, setSelectedDir, type DiscoveredProject } from "./project/discover";
import { parseCproject } from "./parser/index";
import {
  artifactOf,
  debugBuildDirOf,
  discoverSources,
  linkerAbsOf,
  renderNinja,
  resolveIncludes,
} from "./build/ninjaGen";
import { describeBuildFailure, resolveTool, runNinja, type BuildPanelState, type GccDiagnostic } from "./build/backend";
import { spawnCli } from "./flash/spawn";
import { runPyocdFlash } from "./flash/pyocd";
import {
  decideWrite,
  isMotorDrivePath,
  MOTOR_DRIVE_WARNING,
} from "./live/allowlist";
import {
  buildWriteRequest,
  PendingWrites,
  type WriteResult,
} from "./live/writeChannel";
import {
  debugRange,
  findSymbol,
  resolveElf,
  type ElfResolution,
} from "./live/elfResolver";
import {
  assertCsvHeader,
  decodeValue,
  dropStats,
  encodeWriteValue,
  formatCsv,
  formatDropSummary,
  type LeafMeta,
  type LiveSample,
} from "./live/poller";
import {
  PROBE_BUSY_MESSAGE,
  WATCHLIST_KEY,
  buildResolutionJson,
  DEFAULT_EXTRA_SIZE,
  EXIT_NO_SYMBOLS,
  exitCodeReason,
  extraArgs,
  filterWatchedSymbols,
  isProbeBusyOutput,
  parseNmSymbol,
  readNewSamples,
  readSessionLock,
  resolveWatchlist,
  targetOfMcu,
  usbErrorSummary,
  writeSessionLock,
  type SessionLock,
} from "./live/manager";
import { mergeSuggestions, scanSourceVars } from "./live/varscan";
import { CUBEIDE_RUNNING_MESSAGE, detectConflicts, findOwnPollPids, listProcesses } from "./probe/conflict";
import { GRAPH_PANEL_TITLE, GRAPH_PANEL_VIEW_TYPE, graphPanelHtml, parseGraphPanelMessage } from "./live/graphPanel";
import { WatchBatcher } from "./live/watchBatch";

/**
 * How many times one user-requested session may resume itself after the
 * sidecar dies on its own. Bounded so a sidecar that cannot start at all
 * (missing pyOCD, no symbols in range) cannot spin; the user still has
 * 再接続.
 */
const MAX_AUTO_RESTARTS = 3;

/**
 * Word widths live_write.py can actually move. A leaf resolved to any other
 * width (0 for an unknown type, 3 for a packed struct member) is refused
 * here rather than dying on the sidecar with no explanation.
 */
const WRITE_WIDTHS: readonly number[] = [1, 2, 4, 8];

export type FlashTool = "pyocd" | "cubeprogr";

export interface Stm32Settings {
  readonly cliPath: string;
  readonly flashTool: FlashTool;
  readonly probe: string;
  readonly iface: string;
  readonly resetMode: string;
  readonly pollHz: number;
}

export function readSettings(): { ok: true; value: Stm32Settings } | { ok: false; error: string } {
  const cfg = vscode.workspace.getConfiguration("stm32ext");
  const cliPath = cfg.get<string>("cliPath", "");
  const flashTool = cfg.get<string>("flashTool", "pyocd");
  const probe = cfg.get<string>("probe", "");
  const iface = cfg.get<string>("interface", "");
  const resetMode = cfg.get<string>("resetMode", "");
  const pollHz = cfg.get<number>("pollHz", 0);
  const tool: FlashTool = flashTool === "cubeprogr" ? "cubeprogr" : "pyocd";
  const missing: string[] = [];
  // The CLI path only matters for the CubeProgrammer backend; pyOCD needs no
  // vendor toolchain, so an empty cliPath must not block it.
  if (!cliPath && tool === "cubeprogr") { missing.push("stm32ext.cliPath"); }
  if (!probe) { missing.push("stm32ext.probe"); }
  if (!iface) { missing.push("stm32ext.interface"); }
  if (!resetMode) { missing.push("stm32ext.resetMode"); }
  if (typeof pollHz !== "number" || !(pollHz > 0)) { missing.push("stm32ext.pollHz"); }
  if (missing.length > 0) {
    return { ok: false, error: `STM32: missing settings (${missing.join(", ")}). Open Settings and fill them; no operation performed.` };
  }
  return {
    ok: true,
    value: {
      cliPath,
      flashTool: tool,
      probe,
      iface,
      resetMode,
      pollHz,
    },
  };
}

/**
 * Pre-flight: is CubeIDE (or its ST-LINK server) holding the probe?
 * Returns true when a conflict was found AND the user chose to stop.
 * Best-effort: process listing failures mean "no info", never a block.
 */
export async function checkProbeConflict(
  channel: vscode.OutputChannel,
  opts?: { silent?: boolean },
): Promise<boolean> {
  let ps = "";
  try {
    ps = await listProcesses(
      (bin, args) =>
        new Promise<string>((resolve) => {
          execFile(bin, [...args], { timeout: 10000 }, (err, stdout) => {
            resolve(err ? "" : String(stdout));
          });
        }),
    );
  } catch {
    return false;
  }
  const found = detectConflicts(ps);
  const issues: string[] = [];
  if (found.cubeIde) {
    const line = `[probe] CONFLICT: ${CUBEIDE_RUNNING_MESSAGE} (ps: ${found.details.join(", ")})`;
    channel.appendLine(line);
    issues.push("STM32CubeIDEが起動中 (プローブ掴み・DEV_CONNECT_ERRの原因)");
  }
  // Our own live session (possibly another window) holding the probe.
  try {
    const raw = readFileSync(join(tmpdir(), "stm32ext-live.lock"), "utf8");
    const lock = readSessionLock(raw);
    if (lock !== undefined) {
      let alive = false;
      try {
        process.kill(lock.pid, 0);
        alive = true;
      } catch {
        alive = false;
      }
      if (alive) {
        channel.appendLine(`[probe] CONFLICT: live session holds probe (${lock.project}, pid=${lock.pid})`);
        issues.push(`監視セッションがプローブ使用中 (${lock.project}) — サイドバーの⏹ 停止で解放`);
      }
    }
  } catch {
    /* no lock */
  }
  if (issues.length === 0) {
    return false;
  }
  if (opts?.silent) {
    return false;
  }
  const choice = await vscode.window.showWarningMessage(
    `プローブ競合の可能性:\n- ${issues.join("\n- ")}`,
    { modal: true },
    "このまま続行",
    "中止",
  );
  return choice !== "このまま続行";
}

/** Projects directly under the opened folder (single- or container-mode). */
function currentProjects(): DiscoveredProject[] {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder === undefined) {
    return [];
  }
  return discoverProjects(folder.uri.fsPath);
}

/**
 * Scan the firmware sources belonging to an ELF for global identifiers.
 * Best-effort and read-only; failures yield an empty suggestion list.
 */
export function scanProjectSources(elfPath: string, resolvedNames: readonly string[]): { name: string; detail: string }[] {
  try {
    let dir = dirname(elfPath);
    let root = "";
    for (let i = 0; i < 3; i++) {
      if (existsSync(join(dir, ".cproject"))) {
        root = dir;
        break;
      }
      const parent = dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
    if (!root) {
      return [];
    }
    const files: string[] = [];
    for (const sub of ["Core/Src", "Core/Inc"]) {
      const abs = join(root, sub);
      let entries: string[];
      try {
        entries = readdirSync(abs);
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!/\.(cpp|c|hpp|h)$/.test(e) || files.length >= 50) {
          continue;
        }
        const full = join(abs, e);
        try {
          if (statSync(full).isFile() && statSync(full).size <= 1024 * 1024) {
            files.push(full);
          }
        } catch {
          continue;
        }
      }
    }
    const resolved = new Set(resolvedNames);
    const out: { name: string; detail: string }[] = [];
    const seen = new Set<string>();
    for (const f of files) {
      let text: string;
      try {
        text = readFileSync(f, "utf8");
      } catch {
        continue;
      }
      for (const v of scanSourceVars(f, text)) {
        if (!resolved.has(v.name) && !seen.has(v.name)) {
          seen.add(v.name);
          out.push({ name: v.name, detail: `ソース内検出 (${f.split("/").slice(-1)[0]}:${v.line})・要解決` });
        }
      }
      if (out.length >= 120) {
        break;
      }
    }
    return out;
  } catch {
    return [];
  }
}
export async function chooseProject(forcePick = false): Promise<string | undefined> {
  const projects = currentProjects();
  if (projects.length === 0) {
    void vscode.window.showErrorMessage("STM32: 開いたフォルダーに.cprojectがありません。STM32プロジェクトのフォルダーを開いてください。");
    return undefined;
  }
  if (projects.length === 1) {
    const only = projects[0];
    if (only !== undefined) {
      setSelectedDir(only.dir);
      return only.dir;
    }
    return undefined;
  }
  const kept = projects.find((p) => p.dir === getSelectedDir());
  if (kept !== undefined && !forcePick) {
    return kept.dir;
  }
  const pick = await vscode.window.showQuickPick(
    projects.map((p) => ({ label: p.name, description: p.dir })),
    { placeHolder: "対象プロジェクトを選択 (フォルダー内の全プロジェクト)" },
  );
  if (pick?.description === undefined) {
    return undefined;
  }
  setSelectedDir(pick.description);
  return pick.description;
}

function flashToolOf(s: Stm32Settings): FlashTool {
  return s.flashTool === "cubeprogr" ? "cubeprogr" : "pyocd";
}

function flashSettingsFrom(s: Stm32Settings): FlashSettings {
  return {
    cliPath: s.cliPath || DEFAULT_CLI,
    probe: s.probe === "J-LINK" ? "J-LINK" : "ST-LINK",
    iface: s.iface === "JTAG" ? "JTAG" : "SWD",
    resetMode: (s.resetMode || "connect-under-reset") as FlashSettings["resetMode"],
  };
}

/** Live panel: variable table + allowlisted writes + CSV export + real polling session. */
export class LivePanelProvider {
  /**
   * Where status/sample messages go. Normally the sidebar's webview (single
   * stacked view); falls back to `view` so the standalone panel still works.
   */
  private postTarget?: vscode.Webview;
  private resolution?: ElfResolution;
  private mcu = "";
  private scriptsDir = "";
  private storage?: vscode.Memento;
  private readonly samples: LiveSample[] = [];
  /**
   * Single forwarding subscription: Live tail -> Graph panel.
   * Set exactly once in activate(); assignment overwrites so a second
   * subscription can never accumulate (no double-delivery).
   */
  private sampleSink?: (samples: readonly LiveSample[]) => void;
  private child: ChildProcess | undefined;
  private childPid: number | undefined;
  private tailTimer: NodeJS.Timeout | undefined;
  /** True after an intentional stop: suppresses the abnormal-exit auto-restart. */
  private stopped = false;
  /** Display paused (panel button): session keeps polling, rows stop updating. */
  private paused = false;
  private csvPath = "";
  private resJsonPath = "";
  private logPath = "";
  private csvOffset = 0;
  /** Incremental tail state: byte offset + incomplete trailing bytes. */
  private tailByte = 0;
  private tailLeftover = "";
  /** File header row already consumed (never delivered as a sample). */
  private headerSkipped = false;
  /** Inode of the CSV being tailed, so a renamed-in rotation is noticed. */
  private tailIno = 0;
  private restarts = 0;
  /**
   * CSV line accounting for the drop report (D-4): every complete data line
   * the tail sees is `expected`; a line that is not 4 columns is `dropped`.
   */
  private tailExpected = 0;
  private tailCollected = 0;
  private lastDropReport = 0;
  /** Leaf metadata for the webview decoder and the write dialog. */
  private leafMeta = new Map<string, LeafMeta>();
  /** In-flight DebugGlobal writes awaiting the sidecar's answer. */
  private readonly pendingWrites = new PendingWrites(3000);
  constructor(private readonly channel: vscode.OutputChannel) {}
  configure(scriptsDir: string, storage: vscode.Memento): void {
    this.scriptsDir = scriptsDir;
    this.storage = storage;
  }
  /** Redirect status/sample messages to the combined sidebar webview. */
  setPostTarget(target: vscode.Webview): void {
    this.postTarget = target;
  }
  /** Status summary for the combined sidebar renderer. */
  get sidebarState(): { connected: boolean; elfPath: string; unresolved: string[] } {
    return {
      connected: this.child !== undefined,
      elfPath: this.resolution?.elf ?? "",
      unresolved: this.lastUnresolved,
    };
  }
  private lastUnresolved: string[] = [];
  /** All live controls, reachable from the sidebar's 変数 section. */
  async handleLiveAction(action: string, name = "", value = ""): Promise<void> {
    if (action === "csv") {
      await this.exportCsv();
      return;
    }
    if (action === "reconnect") {
      this.slog("reconnect requested: restarting session");
      await this.restart();
      return;
    }
    if (action === "stop") {
      const hadOwn = this.child !== undefined;
      await this.stop();
      const killedForeign = await this.killForeignSession();
      const summary = hadOwn || killedForeign
        ? "停止しました (プローブ解放)"
        : "停止するセッションがありません";
      this.slog(`stop done: own=${hadOwn} foreign=${killedForeign}`);
      this.postStatus("idle", summary);
      return;
    }
    if (action === "add-watch") {
      await this.addWatchFlow();
      return;
    }
    if (action === "add-names") {
      await this.addNames(name);
      return;
    }
    if (action === "remove-names") {
      await this.removeNames(name);
      return;
    }
    if (action === "remove") {
      await this.removeWatchFlow(name);
      return;
    }
    if (action === "pause") {
      this.paused = true;
      this.slog("display paused (session keeps recording)");
      this.postStatus("paused", "表示一時停止 (記録は継続)");
      return;
    }
    if (action === "resume") {
      this.paused = false;
      this.slog("display resumed");
      this.postStatus(this.child !== undefined ? "running" : "idle", "表示再開");
      return;
    }
    await this.writeFlow(name, value);
  }
  private post(msg: unknown): void {
    for (const target of this.postTargets()) {
      void target.postMessage(msg);
    }
  }
  /**
   * Every live surface, most recently attached first: the sidebar webview is
   * the primary one, and the graph panel attaches as a second subscriber so
   * it decodes values with the same type metadata.
   */
  private postTargets(): vscode.Webview[] {
    return this.postTarget === undefined ? [] : [this.postTarget];
  }
  private postToTypeTargets(msg: unknown): void {
    for (const target of this.typeTargets) {
      void target.postMessage(msg);
    }
  }
  /**
   * Surfaces that need `live-types` but must NOT receive the sample stream
   * again. The graph panel decodes with the same type metadata; its samples
   * already arrive through the Live->Graph sample sink, so making it a post
   * target delivered every batch twice (750 real samples in a 1500-point
   * window, every frame scanned twice).
   *
   * This is a REGISTRATION, not a one-shot send. `sendTypesTo` fired once at
   * panel-open, so a panel opened before the first build received nothing:
   * `setResolution` posts `live-types` to `postTargets()` (the sidebar only),
   * the panel's type map stayed empty, and every sample decoded as
   * non-plottable — a blank canvas with a full legend and no error anywhere.
   */
  private readonly typeTargets = new Set<vscode.Webview>();
  /** Register a decode-only surface and seed it with what is known so far. */
  addTypeTarget(target: vscode.Webview): void {
    this.typeTargets.add(target);
    this.sendTypesTo(target);
  }
  removeTypeTarget(target: vscode.Webview): void {
    this.typeTargets.delete(target);
  }
  sendTypesTo(target: vscode.Webview): void {
    const res = this.resolution;
    if (res !== undefined) {
      const index: Record<string, LeafMeta> = {};
      for (const [name, meta] of this.leafMeta) {
        index[name] = meta;
      }
      void target.postMessage({ kind: "live-types", tree: res.tree, index });
    }
    void target.postMessage({
      kind: "live-status",
      state: this.child === undefined ? "idle" : "running",
      text: this.child === undefined ? "" : "監視中",
    });
  }
  /**
   * One status/drop line. The sink exists so the sidebar's own copy of the
   * last message stays in step: without it `SidebarState.liveDrop` was
   * always "" and the next `live-bootstrap` wiped the line the user was
   * reading (D-12).
   */
  private dropSink?: (summary: string) => void;
  setDropSink(sink: (summary: string) => void): void {
    this.dropSink = sink;
  }
  private drop(summary: string): void {
    this.post({ kind: "live-drop", summary });
    this.dropSink?.(summary);
  }
  private postStatus(state: "idle" | "starting" | "running" | "paused" | "error", text: string, detail?: string): void {
    this.post({ kind: "live-status", state, text, ...(detail === undefined ? {} : { detail }) });
  }
  /**
   * There is no standalone live panel any more: the sidebar webview is the
   * only control surface and the graph panel a second subscriber. Both are
   * built from messages, never from an HTML assignment.
   */
  setResolution(res: ElfResolution, mcu: string): void {
    this.resolution = res;
    this.mcu = mcu;
    const index: Record<string, LeafMeta> = {};
    this.leafMeta = new Map();
    for (const s of res.symbols) {
      const meta: LeafMeta = {
        size: s.size,
        kind: s.kind,
        signed: s.signed,
        type: s.type,
        ...(s.enumerators === undefined ? {} : { enumerators: s.enumerators }),
        ...(s.length === undefined ? {} : { length: s.length }),
        ...(s.bitSize === undefined ? {} : { bitSize: s.bitSize }),
        ...(s.bitOffset === undefined ? {} : { bitOffset: s.bitOffset }),
      };
      this.leafMeta.set(s.name, meta);
      index[s.name] = meta;
    }
    // Registered type targets get it too: a graph panel opened before this
    // build has no type map yet, and without this it decoded every sample as
    // unplottable — a blank canvas with a populated legend.
    const types = { kind: "live-types", tree: res.tree, index };
    this.post(types);
    this.postToTypeTargets(types);
    this.post({ kind: "live-watchlist", names: this.watchNames() });
    void this.startSession();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.pendingWrites.abandon("live session stopped before the write completed");
    if (this.tailTimer !== undefined) {
      clearInterval(this.tailTimer);
      this.tailTimer = undefined;
    }
    await this.waitForExit();
    this.clearOwnLock();
  }
  /**
   * SIGKILL the poll process and resolve only once it is really gone.
   *
   * The libusb interface is released when the process dies, not when kill()
   * returns, so a restart that spawns the next live_poll too early loses the
   * claim race and dies with "usb.core.USBError: [Errno 16] Resource busy".
   */
  private waitForExit(timeoutMs = 3000): Promise<void> {
    const child = this.child;
    if (child === undefined) {
      return Promise.resolve();
    }
    this.child = undefined;
    if (child.exitCode !== null || child.signalCode !== null) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        child.off("exit", done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      if (timer.unref) {
        timer.unref();
      }
      child.on("exit", done);
      try {
        child.kill("SIGKILL");
      } catch {
        done();
      }
    });
  }
  /** pyocd target id for this project, e.g. "stm32g474retx" ("" if unknown). */
  get mcuTargetId(): string {
    return this.mcu === "" ? "" : targetOfMcu(this.mcu);
  }
  /** Current poll child pid (so flash can spare it while freeing others). */
  get pollPid(): number | undefined {
    return this.childPid;
  }
  /** Restart polling (used after a flash that paused the session). */
  async restartLive(): Promise<void> {
    await this.restart();
  }
  /** Session lock path (shared across VSCode windows on this machine). */
  private lockPath(): string {
    return join(tmpdir(), "stm32ext-live.lock");
  }
  private clearOwnLock(): void {
    try {
      const raw = readFileSync(this.lockPath(), "utf8");
      const lock = readSessionLock(raw);
      if (lock !== undefined && this.childPid !== undefined && lock.pid === this.childPid) {
        unlinkSync(this.lockPath());
      } else if (lock === undefined) {
        try {
          unlinkSync(this.lockPath());
        } catch {
          /* already gone */
        }
      }
    } catch {
      /* no lock file */
    }
    this.childPid = undefined;
  }
  /**
   * Kill a FOREIGN live session (typically another VSCode window) holding
   * the probe. Returns true when something was killed. Never touches
   * non-extension processes: only the exact pid recorded in our lock file.
   */
  private async killForeignSession(): Promise<boolean> {
    let raw: string;
    try {
      raw = readFileSync(this.lockPath(), "utf8");
    } catch {
      return false;
    }
    const lock = readSessionLock(raw);
    if (lock === undefined) {
      return false;
    }
    let alive = false;
    try {
      process.kill(lock.pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    if (!alive) {
      try {
        unlinkSync(this.lockPath());
      } catch {
        /* best-effort */
      }
      return false;
    }
    const choice = await vscode.window.showWarningMessage(
      `別セッションがプローブ使用中です (${lock.project}, 開始${lock.started || "不明"})。強制終了しますか?`,
      { modal: true },
      "強制終了する",
      "やめる",
    );
    if (choice !== "強制終了する") {
      return false;
    }
    try {
      process.kill(lock.pid, "SIGTERM");
      this.slog(`SIGTERM sent to foreign session pid=${lock.pid} (${lock.project})`);
    } catch (err) {
      this.slog(`cannot signal pid=${lock.pid}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
    try {
      unlinkSync(this.lockPath());
    } catch {
      /* best-effort */
    }
    return true;
  }
  private async claimProbe(projectName: string): Promise<boolean> {
    let raw: string;
    try {
      raw = readFileSync(this.lockPath(), "utf8");
    } catch {
      return true;
    }
    const lock = readSessionLock(raw);
    if (lock === undefined) {
      return true;
    }
    let alive = false;
    try {
      process.kill(lock.pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    if (!alive) {
      this.slog(`stale lock from pid=${lock.pid} (${lock.project}); taking over`);
      try {
        unlinkSync(this.lockPath());
      } catch {
        /* best-effort */
      }
      return true;
    }
    const choice = await vscode.window.showWarningMessage(
      `別セッションがプローブ使用中です (${lock.project}, ${lock.started})。強制的に取り直しますか?`,
      { modal: true },
      "強制的に取り直す",
      "待つ",
    );
    if (choice !== "強制的に取り直す") {
      this.drop(`待機中: ${lock.project} がプローブ使用中。相手はサイドバー「⏹ 停止」で解放`);
      return false;
    }
    try {
      process.kill(lock.pid, "SIGTERM");
      this.slog(`SIGTERM sent to holder pid=${lock.pid} (${lock.project})`);
    } catch (err) {
      this.slog(`cannot signal holder pid=${lock.pid}: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      unlinkSync(this.lockPath());
    } catch {
      /* best-effort */
    }
    return true;
  }
  /** Session log: output channel + build-ext/live-session.log (diagnosis file). */
  private slog(line: string): void {
    const stamped = `[live] ${new Date().toISOString()} ${line}`;
    this.channel.appendLine(stamped);
    this.logSink?.(stamped);
    if (this.logPath) {
      try {
        appendFileSync(this.logPath, `${stamped}\n`);
      } catch {
        /* log file is best-effort */
      }
    }
  }
  private logSink?: (line: string) => void;
  /** Mirror the live session's log lines into the sidebar's ログ section. */
  setLogSink(sink: (line: string) => void): void {
    this.logSink = sink;
  }
  private watchNames(): string[] {
    const stored = this.storage?.get<unknown>(WATCHLIST_KEY);
    return Array.isArray(stored) ? stored.filter((s): s is string => typeof s === "string") : [];
  }
  private async startSession(): Promise<void> {
    await this.stop();
    // Intentional-stop flag consumed: a fresh session is running, so
    // subsequent abnormal exits must auto-restart again.
    this.stopped = false;
    if (this.resolution === undefined || !this.scriptsDir) {
      this.postStatus("idle", "ELF 未解決 — 先にビルドしてください");
      return;
    }    const res = this.resolution;
    const dir = dirname(res.elf);
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      this.slog(`cannot create session dir ${dir}; session aborted`);
      this.postStatus("error", `セッションディレクトリを作れません: ${dir}`);
      return;
    }
    this.csvPath = join(dir, "live.csv");
    this.resJsonPath = join(dir, "live-resolution.json");
    this.logPath = join(dir, "live-session.log");
    this.csvOffset = 0;
    this.tailByte = 0;
    this.tailLeftover = "";
    this.headerSkipped = false;
    this.tailIno = 0;
    this.restarts = 0;
    this.tailExpected = 0;
    this.tailCollected = 0;
    this.lastDropReport = 0;
    const checked = readSettings();
    const hz = checked.ok ? checked.value.pollHz : 100;
    this.postStatus("starting", `監視を開始します (${hz}Hz)`);
    // D-5: the probe check was computed and thrown away, so a CubeIDE that
    // holds the ST-LINK was reported and then ignored. Act on the answer.
    if (await checkProbeConflict(this.channel)) {
      this.postStatus("error", "プローブ競合のため開始しませんでした", PROBE_BUSY_MESSAGE);
      return;
    }
    const names = this.watchNames();
    // P0-1: nmLookup used to be `(name) => undefined`, so every user-added
    // variable was "unresolved" and never polled once. Resolve the ones the
    // type tree does not know against the built ELF's symbol table.
    const nmAddrs = await this.nmResolveAll(names, res.elf);
    const { extras, unresolved } = resolveWatchlist(names, res, (n) => nmAddrs.get(n));
    // D11: the sidecar polls symbols[] verbatim, so only the watched leaves
    // go into the file. --all-members resolves 355 leaves; polling them all
    // is 35,500 CSV rows per second.
    //
    // No upper bound: whatever the user selected is what gets polled. The old
    // 64-leaf cap reported the rest as overflow, so a plotted series could sit
    // in the legend while nothing was ever read for it — a blank canvas with
    // the only clue in a log channel.
    const filter = filterWatchedSymbols(res, names);
    this.slog(`watch leaves: ${filter.symbols.length} (of ${names.length} watched names)`);
    const allUnresolved = [...unresolved, ...filter.unmatched];
    this.lastUnresolved = allUnresolved;
    if (filter.symbols.length === 0 && extras.length === 0) {
      this.slog("session not started: nothing watched");
      this.postStatus("idle", "監視する変数がありません — 「変数追加」から選ぶか、ビルドしてください",
        allUnresolved.length > 0 ? `未解決: ${allUnresolved.join(", ")}` : undefined);
      this.post({ kind: "live-unresolved", names: allUnresolved });
      return;
    }
    try {
      writeFileSync(this.resJsonPath, buildResolutionJson(res, filter.symbols));
    } catch (err) {
      this.slog(`cannot write ${this.resJsonPath}: ${err instanceof Error ? err.message : String(err)}`);
      this.postStatus("error", `解決 JSON を書けません: ${this.resJsonPath}`);
      return;
    }
    if (allUnresolved.length > 0) {
      this.post({ kind: "live-unresolved", names: allUnresolved });
    }
    this.post({ kind: "live-watchlist", names: this.watchNames() });
    const projectName = basename(dirname(dirname(res.elf)));
    if (!(await this.claimProbe(projectName))) {
      this.slog("session deferred: probe held by another session");
      this.postStatus("error", "別のセッションがプローブを使用中です", PROBE_BUSY_MESSAGE);
      return;
    }
    const args = [join(this.scriptsDir, "live_poll.py"),
      "--resolution", this.resJsonPath, "--out", this.csvPath,
      "--hz", String(hz),
      // P0-12: the hard 3600s cap made every session die silently after an
      // hour. The sidecar takes a duration, so ask for one that outlives any
      // session; the session ends when the user stops it, not on a clock.
      "--seconds", "2147483647",
      "--target", targetOfMcu(this.mcu), ...extraArgs(extras)];
    this.slog(`start: python3 ${args.join(" ")} (leaves=${filter.symbols.length} extras=${extras.length})`);
    await this.spawnPoll(args);
  }
  private async spawnPoll(args: string[]): Promise<void> {
    await this.stop();
    // Fresh spawn clears the intentional-stop flag (see startSession).
    this.stopped = false;
    const child = spawn("python3", args, { cwd: dirname(this.csvPath) || "." });
    this.child = child;
    this.childPid = child.pid;
    let errTail = "";
    this.slog(`spawned live_poll pid=${child.pid ?? "?"}`);
    try {
      const projectName = basename(dirname(dirname(this.csvPath)));
      if (child.pid !== undefined) {
        writeFileSync(this.lockPath(), writeSessionLock({
          pid: child.pid,
          project: projectName,
          started: new Date().toISOString(),
        }));
      }
    } catch {
      /* lock is best-effort */
    }
    child.stdout?.on("data", (d: Buffer) => {
      for (const line of String(d).split("\n")) {
        if (!line.trim()) {
          continue;
        }
        if (this.pendingWrites.settle(line.trim())) {
          this.slog(`[poll] write result: ${line.trim()}`);
          continue;
        }
        this.slog(`[poll] ${line}`);
      }
    });
    child.stderr?.on("data", (d: Buffer) => {
      const text = String(d);
      errTail = (errTail + text).slice(-4000);
      for (const line of text.split("\n")) {
        if (line.trim()) {
          this.slog(`[poll:err] ${line}`);
        }
      }
    });
    child.on("error", (err: Error) => {
      this.slog(`spawn error: ${err.message}`);
      this.drop(`spawn failed: ${err.message}`);
    });
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      const how = code !== null ? `code=${code}` : `signal=${signal ?? "?"}`;
      this.slog(`live_poll exited ${how}`);
      const wasCurrent = this.child === child;
      if (wasCurrent) {
        this.child = undefined;
      }
      if (this.tailTimer !== undefined) {
        clearInterval(this.tailTimer);
        this.tailTimer = undefined;
      }
      if (!wasCurrent) {
        // Stale close from a previous session (stop() already replaced
        // this.child): never auto-restart, or we would kill the new poll.
        this.slog("stale close from superseded session; no auto-restart");
        return;
      }
      this.reportTailDrops(true);
      // S2's sidecar contract: exit 6 = nothing pollable, exit 5 = USB
      // attach failed after its bounded retries. Both are the user's to fix,
      // not something to resume into.
      const reason = code === null ? undefined : exitCodeReason(code);
      if (reason !== undefined) {
        this.slog(`close cause: exit=${code} (${reason})`);
        this.postStatus("error", reason);
        return;
      }
      if (this.stopped) {
        // Intentional stop (⏹ button, dispose, or killForeignSession path):
        // never auto-restart.
        this.slog("stopped intentionally; no auto-restart");
        this.postStatus("idle", "停止しました (プローブ解放)");
        return;
      }
      if (signal === "SIGTERM" || signal === "SIGKILL") {
        // Intentional stop (⏹ button, dispose, or operator kill): no restart.
        this.slog("stopped intentionally; no auto-restart");
        this.postStatus("idle", "停止しました (プローブ解放)");
        return;
      }
      if (isProbeBusyOutput(errTail)) {
        this.slog("close cause: probe busy (another session holds USB)");
        this.postStatus("error", PROBE_BUSY_MESSAGE);
        return;
      }
      const usb = usbErrorSummary(errTail);
      if (usb !== undefined) {
        this.slog(`close cause: ${usb}`);
        this.postStatus("error", usb);
        return;
      }
      // P0-12: a clean exit used to be reported as "session ended" and left
      // the values frozen forever. Any exit the user did not ask for — a
      // finished --seconds window, a crash, a dropped USB handle — means the
      // session they are still looking at is over, so it is resumed.
      if (this.restarts < MAX_AUTO_RESTARTS && this.postTargets().length > 0) {
        this.restarts += 1;
        this.slog(`auto-restart ${this.restarts}/${MAX_AUTO_RESTARTS} after ${how}`);
        this.postStatus("starting", code === 0
          ? "セッションが終了したため再開します"
          : `監視が切断されました (${how}) — 再開します`);
        void this.spawnPoll(args);
        return;
      }
      this.postStatus("error", `監視が終了しました (${how}) — STM32 ログを確認してください`,
        "「再接続」で再開できます");
    });
    // Display refresh scales with the sample rate (25..100ms): the panel
    // must drain faster than the poller appends, otherwise updates bunch
    // up and the table looks frozen between bursts. Each tick only reads
    // appended bytes (O(delta)), so the shorter interval is cheap.
    // Parsed from args (spawnPoll's signature stays stable for the
    // auto-restart path, which reuses the same args).
    const hzIdx = args.indexOf("--hz");
    const hzArg = hzIdx >= 0 ? Number(args[hzIdx + 1]) : NaN;
    const hz = Number.isFinite(hzArg) && hzArg > 0 ? hzArg : 100;
    const tailMs = Math.min(100, Math.max(25, Math.round(1000 / hz)));
    this.tailTimer = setInterval(() => {
      void this.tailOnce();
    }, tailMs);
  }
  /**
   * Incremental CSV tail: reads only bytes appended since the last tick
   * (O(delta) per tick). The old full-file readFileSync made every 500ms
   * tick O(file size) — updates slowed as the session CSV grew.
   */
  private async tailOnce(): Promise<void> {
    if (!this.csvPath) {
      return;
    }
    let size: number;
    let ino: number;
    try {
      const st = statSync(this.csvPath);
      size = st.size;
      ino = st.ino;
    } catch {
      return;
    }
    // P0-11: the file was rotated. The byte offset restarts from the top AND
    // the header must be consumed again: leaving headerSkipped set made the
    // rotated-in header row parse as a sample named "name". The inode is
    // checked too, because a rotation that swaps in a file which is already
    // longer than our offset would otherwise be read from the middle.
    if (size < this.tailByte || (this.tailIno !== 0 && ino !== this.tailIno)) {
      this.tailByte = 0;
      this.tailLeftover = "";
      this.csvOffset = 0;
      this.headerSkipped = false;
      this.slog("CSV rotated: header will be re-consumed");
    }
    this.tailIno = ino;
    if (size === this.tailByte) {
      return;
    }
    let fd: number | undefined;
    try {
      fd = openSync(this.csvPath, "r");
      const len = size - this.tailByte;
      const buf = Buffer.alloc(Math.min(len, 8 * 1024 * 1024));
      const read = readSync(fd, buf, 0, buf.length, this.tailByte);
      this.tailByte += read;
      const chunk = this.tailLeftover + buf.subarray(0, read).toString("utf8");
      const lastNl = chunk.lastIndexOf("\n");
      if (lastNl < 0) {
        this.tailLeftover = chunk;
        return;
      }
      this.tailLeftover = chunk.slice(lastNl + 1);
      let complete = chunk.slice(0, lastNl + 1);
      if (!this.headerSkipped) {
        // The file's own header row leads every generation of the file. It is
        // verified (not just dropped) so schema drift is reported instead of
        // being silently mis-parsed into the table (D-4).
        const nl = complete.indexOf("\n");
        const header = (nl < 0 ? complete : complete.slice(0, nl)).replace(/\r$/, "");
        complete = nl < 0 ? "" : complete.slice(nl + 1);
        this.headerSkipped = true;
        try {
          assertCsvHeader(header);
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          this.slog(`csv header rejected: ${detail}`);
          this.postStatus("error", "CSV スキーマが想定と違うため読み取りを中止しました", detail);
          return;
        }
      }
      if (!complete) {
        return;
      }
      const dataLines = complete.split("\n").filter((l) => l.trim() !== "").length;
      const { samples, nextLine } = readNewSamples(
        `timestamp,address,name,value\n${complete}`,
        this.csvOffset === 0 ? 0 : 1,
      );
      this.csvOffset += nextLine - 1;
      this.tailExpected += dataLines;
      this.tailCollected += samples.length;
      this.reportTailDrops(false);
      if (samples.length > 0 && !this.paused) {
        this.pushSamples(samples);
      } else if (samples.length > 0) {
        // Paused: keep the offset advancing + archive rows for CSV export.
        this.samples.push(...samples);
        if (this.samples.length > 5000) {
          this.samples.splice(0, this.samples.length - 5000);
        }
      }
    } catch {
      return;
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          /* best-effort */
        }
      }
    }
  }
  /**
   * Report CSV ingest loss (D-4). `dropStats` used to be dead: malformed or
   * missing rows were skipped by readNewSamples with nothing to show for it,
   * so the log claimed a 0% loss rate. Lines the tail saw but could not use
   * are surfaced — always on session end, and within 5s of the first loss
   * during a run.
   */
  private reportTailDrops(final: boolean): void {
    const stats = dropStats(this.tailExpected, this.tailCollected);
    if (stats.dropped === 0) {
      if (final && stats.expected > 0) {
        this.slog(formatDropSummary(stats));
      }
      return;
    }
    const now = Date.now();
    if (!final && now - this.lastDropReport < 5000) {
      return;
    }
    this.lastDropReport = now;
    const summary = `CSV 取り込み欠損: ${formatDropSummary(stats)}`;
    this.slog(summary);
    this.drop(summary);
  }
  private async restart(): Promise<void> {
    if (this.resolution === undefined) {
      this.slog("restart requested but no ELF resolution yet (build first)");
      this.postStatus("idle", "ELF 未解決 — 先にビルドしてください");
      return;
    }
    await this.startSession();
  }
  /**
   * Add watched names from the webview's struct tree. A name may be a struct
   * node: the resolution filter decides how many leaves that expands to.
   *
   * A name that is already watched changes nothing, so it must not restart.
   * The log showed `+backup.armed (104 -> 104)` followed by SIGKILL and a fresh
   * spawn: clicking `+` on an already-watched row tore down a running session
   * and cost the user a second of samples for no change at all.
   */
  private async addNames(raw: string): Promise<void> {
    const incoming = raw.split(",").map((s) => s.trim()).filter((s) => s !== "");
    if (incoming.length === 0) {
      return;
    }
    const current = this.watchNames();
    const merged = [...current, ...incoming.filter((n) => !current.includes(n))];
    if (merged.length === current.length) {
      this.slog(`watchlist: ${incoming.join(",")} は監視済み (${current.length} 個 unchanged)`);
      return;
    }
    await this.storage?.update(WATCHLIST_KEY, merged);
    this.slog(`watchlist: +${incoming.join(",")} (${current.length} -> ${merged.length})`);
    this.post({ kind: "live-watchlist", names: merged });
    await this.restart();
  }
  /** Remove watched names; a struct prefix takes its whole subtree with it. */
  private async removeNames(raw: string): Promise<void> {
    const drop = raw.split(",").map((s) => s.trim()).filter((s) => s !== "");
    if (drop.length === 0) {
      return;
    }
    const kept = this.watchNames().filter((n) =>
      !drop.some((d) => n === d || n.startsWith(`${d}.`)));
    await this.storage?.update(WATCHLIST_KEY, kept);
    this.slog(`watchlist: -${drop.join(",")} (${kept.length} left)`);
    this.post({ kind: "live-watchlist", names: kept });
    this.drop(`${drop.join(", ")} を除外しました`);
    await this.restart();
  }
  /** Remove a variable from the watchlist, then restart the session. */
  private async removeWatchFlow(name: string): Promise<void> {
    await this.removeNames(name);
  }
  /** User picks extra variables: resolved list multi-select + free symbol name via nm. */
  async addWatchFlow(): Promise<void> {
    try {
      await this.addWatchFlowInner();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.slog(`add-watch failed: ${detail}`);
      this.drop(`変数追加に失敗: ${detail}`);
    }
  }

  private async addWatchFlowInner(): Promise<void> {
    if (this.resolution === undefined) {
      this.drop("no ELF yet — build first");
      return;
    }
    const res = this.resolution;
    this.slog(`add-watch: QuickPick over ${res.symbols.length} resolved symbols`);
    const current = new Set(this.watchNames());
    // Struct-aware completion: group dotted names (sys.loop_hz -> group sys)
    // with separator headers; typing "sys." narrows to its members via the
    // built-in fuzzy/substring filter (member prediction).
    const groups = new Map<string, { name: string; address: string }[]>();
    for (const s of res.symbols) {
      const dot = s.name.indexOf(".");
      const group = dot > 0 ? s.name.slice(0, dot) : "(global)";
      const list = groups.get(group) ?? [];
      list.push({ name: s.name, address: s.address });
      groups.set(group, list);
    }
    type PickItem = { label: string; description?: string; picked?: boolean; kind?: vscode.QuickPickItemKind };
    const items: PickItem[] = [];
    for (const [group, members] of [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      items.push({ label: group, kind: vscode.QuickPickItemKind.Separator });
      for (const m of members) {
        items.push({ label: m.name, description: `${m.address}${current.has(m.name) ? " ●監視中" : ""}`, picked: current.has(m.name) });
      }
    }
    // Source-scanned globals (code.cpp and friends): predicted suggestions
    // for names the ELF resolution does not list; resolved via nm at confirm.
    const scanned = scanProjectSources(res.elf, res.symbols.map((s) => s.name));
    if (scanned.length > 0) {
      items.push({ label: "ソース内変数 (自動分析)", kind: vscode.QuickPickItemKind.Separator });
      for (const s of scanned.slice(0, 60)) {
        items.push({ label: s.name, description: `${s.detail}${current.has(s.name) ? " ●監視中" : ""}`, picked: current.has(s.name) });
      }
    }
    items.push({ label: "✏️ 任意のシンボル名を入力…", description: "nmで解決します" });
    const picks = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      placeHolder: "監視する変数を選択 (例: sys. と打つとsysメンバーのみ表示)",
      matchOnDescription: true,
    });
    if (picks === undefined) {
      this.slog("add-watch: QuickPick dismissed");
      return;
    }
    this.slog(`add-watch: picked ${picks.length} item(s)`);
    let names = picks.filter((p) => !p.label.startsWith("✏️")).map((p) => p.label);
    if (picks.some((p) => p.label.startsWith("✏️"))) {
      const free = await vscode.window.showInputBox({
        prompt: "変数名 (ELF内のグローバルシンボル、カンマ区切り可)",
        placeHolder: "tuner_params, my_counter",
      });
      if (free !== undefined && free.trim()) {
        names = [...names, ...free.split(",").map((s) => s.trim()).filter((s) => s)];
      }
    }
    await this.addNames(names.join(","));
  }
  private async nmResolveAll(names: readonly string[], elf: string): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (names.length === 0) {
      return out;
    }
    try {
      const r = await spawnCli("arm-none-eabi-nm", ["-S", "--defined-only", elf]);
      for (const n of names) {
        const addr = parseNmSymbol(`${r.stdout}\n${r.stderr}`, n);
        if (addr !== undefined) {
          out.set(n, addr);
        }
      }
    } catch (err) {
      this.slog(`nm resolve failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return out;
  }
  pushSamples(samples: readonly LiveSample[]): void {
    this.samples.push(...samples);
    if (this.samples.length > 5000) {
      this.samples.splice(0, this.samples.length - 5000);
    }
    this.post({ kind: "live-sample", samples });
    // Forward the SAME batch reference to the Graph panel exactly once.
    this.sampleSink?.(samples);
  }
  /**
   * A webview that was hidden (or reloaded) starts with an empty document,
   * so it is re-fed the state it cannot derive: the type index, the
   * watchlist and the newest value per watched name. Without this the table
   * stayed blank until the next tick and the values came back undecoded.
   */
  replayTo(target: vscode.Webview): void {
    if (this.resolution !== undefined) {
      const index: Record<string, LeafMeta> = {};
      for (const [name, meta] of this.leafMeta) {
        index[name] = meta;
      }
      const types = { kind: "live-types", tree: this.resolution.tree, index };
      void target.postMessage(types);
      // Same reason as setResolution: a surface that was hidden or reloaded
      // has an empty type map, and a graph panel registered later than the
      // resolution is exactly that case.
      for (const extra of this.typeTargets) {
        if (extra !== target) {
          void extra.postMessage(types);
        }
      }
    }
    void target.postMessage({ kind: "live-watchlist", names: this.watchNames() });
    const latest = new Map<string, LiveSample>();
    for (const s of this.samples) {
      latest.set(s.name, s);
    }
    if (latest.size > 0) {
      void target.postMessage({ kind: "live-sample", samples: [...latest.values()] });
    }
    if (this.lastUnresolved.length > 0) {
      void target.postMessage({ kind: "live-unresolved", names: this.lastUnresolved });
    }
  }
  /**
   * Register the single Live->Graph forwarding sink (activate only).
   * Overwrites any previous sink: there is exactly one subscription point.
   */
  setSampleSink(sink: (samples: readonly LiveSample[]) => void): void {
    this.sampleSink = sink;
  }
  /**
   * P0-2: the button did nothing because `this.view` is never set any more,
   * so the guard returned before writing a byte. The export now also prefers
   * the sidecar's own CSV over the in-memory ring: the ring is capped at
   * 5000 rows, the file holds everything since the last rotation (D-11).
   */
  private async exportCsv(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder === undefined) {
      void vscode.window.showErrorMessage("ワークスペースが開かれていません: CSV を書き出せません");
      return;
    }
    const fromFile = this.readSessionCsv();
    const body = fromFile ?? formatCsv(this.samples);
    const rows = body.split("\n").filter((l) => l.trim() !== "").length - 1;
    const uri = vscode.Uri.joinPath(folder.uri, "live.csv");
    await vscode.workspace.fs.writeFile(uri, Buffer.from(body, "utf8"));
    const how = fromFile === undefined
      ? `${this.samples.length} rows (memory)`
      : `${Math.max(0, rows)} rows (${this.csvPath})`;
    this.channel.appendLine(`[live] CSV exported: ${uri.fsPath} (${how}, schema timestamp,address,name,value)`);
    void vscode.window.showInformationMessage(`Live CSV を保存しました: ${uri.fsPath} (${how})`);
  }
  /** Whole sidecar CSV (header included), or undefined when unusable. */
  private readSessionCsv(): string | undefined {
    if (this.csvPath === "") {
      return undefined;
    }
    let text: string;
    try {
      text = readFileSync(this.csvPath, "utf8");
    } catch {
      return undefined;
    }
    const first = text.slice(0, text.indexOf("\n") < 0 ? text.length : text.indexOf("\n"));
    try {
      assertCsvHeader(first.replace(/\r$/, ""));
    } catch (err) {
      this.slog(`session csv not exportable: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
    return text.endsWith("\n") ? text : `${text}\n`;
  }
  /** DebugGlobal-allowlisted write: unresolved/out-of-range refused, modal confirm + motor warning. */
  private async writeFlow(name: string, value: string): Promise<void> {
    const stamp = new Date().toISOString();
    const done = (message: string): void => {
      this.post({ kind: "live-write-result", message });
    };
    if (this.resolution === undefined) {
      const reason = `refused: no ELF resolution yet (build first) — ${name} unresolved`;
      this.channel.appendLine(`[live-write] ${stamp} REFUSED(${reason}) ${name} value=${value}`);
      done(reason);
      return;
    }
    const sym = findSymbol(this.resolution, name);
    if (sym === undefined) {
      const reason = `refused: ${name} unresolved (not in ELF resolution)`;
      this.channel.appendLine(`[live-write] ${stamp} REFUSED(${reason}) ${name} value=${value}`);
      done(reason);
      return;
    }
    // D12: the leaf width is what live_write.py needs and what the sidecar
    // can actually move (1/2/4/8). A struct member resolved to 0 or 3 bytes
    // would be refused there with no explanation, so say so here.
    if (!WRITE_WIDTHS.includes(sym.size)) {
      const reason = `書き込み拒否: ${name} の幅が ${sym.size} バイト (書き込み対応は 1/2/4/8 バイトのみ)`;
      this.channel.appendLine(`[live-write] ${stamp} REFUSED(${reason})`);
      done(reason);
      return;
    }
    // The prompt is seeded with the DECODED text (the same decoder draws the
    // table), while the sidecar's protocol is integer-only. Encode here, once,
    // next to the range fence: without it every bool leaf was refused with
    // `bad value: 'true'` and a whole-number float was stored as an integer
    // bit pattern (1.0f -> 0x00000001 -> reads back 1.4e-45).
    const encoded = encodeWriteValue(value, this.leafMeta.get(name), sym.size);
    if (!encoded.ok) {
      const reason = `書き込み拒否: ${name} — ${encoded.reason}`;
      this.channel.appendLine(`[live-write] ${stamp} REFUSED(${reason})`);
      done(reason);
      return;
    }
    const bits = encoded.bits;
    // Pre-modal probe: decideWrite is pure (no side effects — verdict + audit
    // string only), so probe with confirmed:true to check range/resolution.
    // Probing with confirmed:false would ALWAYS refuse and make the modal
    // below dead code. The modal + final confirmed:true gate stay mandatory.
    const verdict = decideWrite(
      { target: { name, address: sym.address, size: sym.size }, value: bits, confirmed: true },
      debugRange(this.resolution),
      stamp,
    );
    if (!verdict.ok) {
      this.channel.appendLine(verdict.audit);
      done(verdict.reason);
      return;
    }
    // P0-4: the value the user edits is the decoded one, and the same
    // decoder draws the table, so the confirm dialog must show it too.
    const current = this.lastValueOf(name);
    const shown = current === undefined ? "" : ` 現在値: ${decodeValue(current, this.leafMeta.get(name))}`;
    const warn = isMotorDrivePath(name) ? `${MOTOR_DRIVE_WARNING}\n\n` : "";
    const confirm = await vscode.window.showWarningMessage(
      `${warn}Write ${value} to ${name}@${sym.address}? (${sym.type}, ${sym.size} byte${shown})\n→ 0x${BigInt(bits).toString(16).padStart(sym.size * 2, "0")}\n(DebugGlobal allowlist)`,
      { modal: true },
      "Write",
    );
    if (confirm !== "Write") {
      this.channel.appendLine(`[live-write] ${stamp} REFUSED(modal confirmation not given) ${name}@${sym.address} value=${value}`);
      done("refused: modal confirmation not given");
      return;
    }
    const finalVerdict = decideWrite(
      { target: { name, address: sym.address, size: sym.size }, value: bits, confirmed: true },
      debugRange(this.resolution),
      stamp,
    );
    if (!finalVerdict.ok) {
      this.channel.appendLine(finalVerdict.audit);
      done(finalVerdict.reason);
      return;
    }
    // Transport write goes through the pyOCD sidecar, which owns the single
    // probe session: the request goes down the child's stdin and the answer
    // comes back on stdout. The sidecar re-checks the range before the bus is
    // touched, and reads the word back to confirm.
    this.channel.appendLine(finalVerdict.audit);
    const result = await this.sendWrite(sym.address, sym.size, bits);
    if (result.ok) {
      const note = result.note === undefined ? "" : ` — ${result.note}`;
      this.channel.appendLine(
        `[live-write] ${stamp} OK ${name}@${sym.address} wrote=${result.value} readback=${result.readback}${note}`);
      done(`${name} = ${result.value} (readback ${result.readback ?? "?"})${note}`);
      return;
    }
    const reason = result.error ?? "sidecar reported an unknown failure";
    this.channel.appendLine(`[live-write] ${stamp} FAILED(${reason}) ${name}@${sym.address}`);
    done(`書き込み失敗: ${reason}`);
  }

  /** Most recent raw value hex for a watched name, or undefined if unseen. */
  private lastValueOf(name: string): string | undefined {
    for (let i = this.samples.length - 1; i >= 0; i--) {
      const s = this.samples[i];
      if (s !== undefined && s.name === name) {
        return s.value;
      }
    }
    return undefined;
  }

  /** One write over the running sidecar's stdin, answered on its stdout. */
  private async sendWrite(address: string, size: number, value: string): Promise<WriteResult> {
    const stdin = this.child?.stdin;
    if (stdin === undefined || stdin === null || stdin.destroyed) {
      return { id: "", ok: false, error: "no live session (start 監視開始 first)" };
    }
    const { id, done: answer } = this.pendingWrites.expect();
    const line = buildWriteRequest(id, address, size, value);
    await new Promise<void>((resolve, reject) => {
      stdin.write(`${line}\n`, (err) => (err === null || err === undefined ? resolve() : reject(err)));
    }).catch((err: unknown) => {
      this.pendingWrites.abandon(`stdin write failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    return answer;
  }
}

/** Graph panel: time-series canvas + CSV download (todo5). */
export class GraphPanelProvider {
  private selected: string[] = [];
  /**
   * Archived rows for the selected series, so `graph-download-csv` can hand
   * back real history instead of nothing: the graph had no host handler at
   * all, so the button silently did nothing.
   */
  private readonly archive: LiveSample[] = [];
  private static readonly ARCHIVE_MAX = 20000;
  private onDownloadCsv?: (rows: readonly LiveSample[]) => void;
  /** Host-side CSV writer (activate only; assigned once). */
  setDownloadHandler(handler: (rows: readonly LiveSample[]) => void): void {
    this.onDownloadCsv = handler;
  }
  /**
   * Mount the real editor-area panel.
   *
   * This class used to implement `WebviewViewProvider` and nothing ever
   * registered it, so `graphPanelHtml` was never called: the whole renderer
   * shipped unmounted and `stm32ext.showGraph` merely focused the sidebar.
   * `activate` creates the panel and calls this.
   */
  mount(webview: vscode.Webview): void {
    this.postTarget = webview;
    // enableCommandUris: the panel's CSV/link affordances are command: URIs.
    webview.options = { enableScripts: true, enableCommandUris: true };
    // The graph document is built exactly once, here. Re-assigning it would
    // wipe the canvas and the plot buffer.
    webview.html = graphPanelHtml(this.selected);
    // Without this the panel's messages are dropped: `追加` updated only its
    // own legend and `CSV保存` did nothing, because handleMessage had no
    // caller. The registered sidebar view is the only other subscriber.
    webview.onDidReceiveMessage((raw: unknown) => { this.handleMessage(raw); });
    this.publishSeries();
    // A panel opened mid-session would otherwise start blank: replay the tail
    // of the archive so traces are on screen before the next batch arrives.
    if (this.archive.length > 0) {
      void webview.postMessage({ kind: "live-sample", samples: this.archive.slice(-600) });
    }
  }
  unmount(webview: vscode.Webview): void {
    if (this.postTarget === webview) {
      this.postTarget = undefined;
    }
  }
  private handleMessage(raw: unknown): void {
    const msg = parseGraphPanelMessage(raw);
    if (msg === null) {
      return;
    }
    if (msg.kind === "graph-add") {
      this.addSeries(msg.name);
      return;
    }
    if (msg.kind === "graph-remove") {
      this.removeSeries(msg.name);
      return;
    }
    this.onDownloadCsv?.(this.archive.slice());
  }
  pushSamples(samples: readonly LiveSample[]): void {
    for (const s of samples) {
      if (this.selected.includes(s.name)) {
        this.archive.push(s);
      }
    }
    if (this.archive.length > GraphPanelProvider.ARCHIVE_MAX) {
      this.archive.splice(0, this.archive.length - GraphPanelProvider.ARCHIVE_MAX);
    }
    if (this.postTarget !== undefined) {
      void this.postTarget.postMessage({ kind: "live-sample", samples });
    }
  }
  private postTarget: vscode.Webview | undefined;
  seriesNames(): readonly string[] {
    return this.selected;
  }
  /**
   * Watchlist sync lives HERE, not at the call sites.
   *
   * A plotted series is only real if the live session polls it. The sidebar
   * did both halves (addSeries + add-names) while the graph panel did only
   * addSeries, so `追加` in the panel filled the legend and left the canvas
   * permanently blank with no error. One choke point makes the two surfaces
   * identical by construction; addNames is already dedup-safe, so the
   * previous duplicate call from the sidebar is removed, not merged.
   */
  private onWatchChange?: (name: string, add: boolean) => void;
  setWatchHandler(handler: (name: string, add: boolean) => void): void {
    this.onWatchChange = handler;
  }
  addSeries(name: string): void {
    const n = name.trim();
    if (n !== "" && !this.selected.includes(n)) {
      this.selected.push(n);
      this.onWatchChange?.(n, true);
      this.publishSeries();
    }
  }
  removeSeries(name: string): void {
    const n = name.trim();
    const at = this.selected.indexOf(n);
    if (at >= 0) {
      this.selected.splice(at, 1);
      this.onWatchChange?.(n, false);
      // Only the removed series' history goes: dropping the whole archive
      // made removing one line throw away every other line's CSV rows.
      for (let i = this.archive.length - 1; i >= 0; i--) {
        if (this.archive[i]?.name === n) {
          this.archive.splice(i, 1);
        }
      }
      this.publishSeries();
    }
  }
  /**
   * Series list as a message. The panel HTML is built once in `mount`:
   * re-assigning it would wipe the canvas and the plot buffer, exactly like
   * the live table used to.
   */
  private publishSeries(): void {
    const colors = ["#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd", "#8c564b"];
    const series = this.selected.map((name, i) => ({
      name,
      color: colors[i % colors.length] as string,
      visible: true,
    }));
    // The series list is shown in the sidebar too, so both surfaces get it.
    for (const target of [this.postTarget, this.sidebarTarget]) {
      if (target !== undefined) {
        void target.postMessage({ kind: "graph-series", series });
      }
    }
  }
  /**
   * The sidebar's own series list, kept apart from `postTarget` (the mounted
   * graph renderer) because the sample stream is only worth sending to the
   * real renderer while the series list belongs in both places.
   */
  private sidebarTarget: vscode.Webview | undefined;
  setSidebarTarget(webview: vscode.Webview): void {
    this.sidebarTarget = webview;
    this.publishSeries();
  }
}

/**
 * Another window's active Live session (pid recorded in the shared lock file
 * and still alive). Flash must NEVER SIGTERM it without the lock-modal path —
 * it is spared by the orphan sweep below and resolved via ⏹ stop / modal.
 * Returns undefined when there is no live foreign holder (no lock, stale
 * lock, or the lock is our own pid).
 */
function liveForeignHolderPid(ownPid?: number): number | undefined {
  let raw: string;
  try {
    raw = readFileSync(join(tmpdir(), "stm32ext-live.lock"), "utf8");
  } catch {
    return undefined;
  }
  const lock = readSessionLock(raw);
  if (lock === undefined) {
    return undefined;
  }
  if (ownPid !== undefined && lock.pid === ownPid) {
    return undefined;
  }
  try {
    process.kill(lock.pid, 0);
  } catch {
    return undefined;
  }
  return lock.pid;
}

/**
 * Flash-time self-probe reclaim (todo3): SIGTERM orphaned live_poll.py
 * processes matched by OUR scripts-dir marker only (findOwnPollPids).
 * Never signals foreign processes (marker mismatch) or CubeIDE (its command
 * line never contains live_poll.py). The current window's session is stopped
 * via LivePanelProvider.stop(), not here — sparePid skips it defensively —
 * and another window's active session (lock holder) is spared so the
 * lock-modal path stays mandatory. Best-effort: listing/signaling failures
 * never block the flash.
 */
async function freeOwnPollForFlash(
  channel: vscode.OutputChannel,
  scriptsDir: string,
  sparePid?: number,
): Promise<void> {
  if (process.platform === "win32" || scriptsDir === "") {
    return;
  }
  let ps = "";
  try {
    ps = await new Promise<string>((resolve) => {
      execFile("ps", ["-eo", "pid,args"], { timeout: 10000 }, (err, stdout) => {
        resolve(err ? "" : String(stdout));
      });
    });
  } catch {
    return;
  }
  if (!ps) {
    return;
  }
  const foreign = liveForeignHolderPid(sparePid);
  for (const pid of findOwnPollPids(ps, scriptsDir)) {
    if (sparePid !== undefined && pid === sparePid) {
      continue;
    }
    if (foreign !== undefined && pid === foreign) {
      channel.appendLine(`[flash] keeping foreign live session pid=${pid} (use its ⏹ 停止 to release)`);
      continue;
    }
    try {
      process.kill(pid, "SIGTERM");
      channel.appendLine(`[flash] freed own orphaned live session pid=${pid} (SIGTERM)`);
    } catch (err) {
      channel.appendLine(`[flash] cannot signal own live_poll pid=${pid}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

async function flashElfFlow(
  channel: vscode.OutputChannel,
  live?: LivePanelProvider,
  scriptsDir?: string,
  report?: (phase: string, percent: number | null) => void,
): Promise<void> {
  const checked = readSettings();
  if (!checked.ok) {
    void vscode.window.showErrorMessage(checked.error);
    return;
  }
  if (await checkProbeConflict(channel)) {
    return;
  }
  const elfPath = await vscode.window.showInputBox({
    prompt: "ELF file to flash (verify -v is always on)",
    value: "build-ext/firmware.elf",
  });
  if (!elfPath) {
    return;
  }
  const confirm = await vscode.window.showWarningMessage(
    `Flash ${elfPath}? This overwrites target firmware.`,
    { modal: true },
    "Flash",
  );
  if (confirm !== "Flash") {
    return;
  }
  // Self-probe reclaim: this window's session stops here (covered by the
  // Flash modal above), plus orphaned own live_poll.py processes are
  // SIGTERMed by scripts-dir marker match only.
  const spare = live?.pollPid;
  const hadLive = spare !== undefined;
  await live?.stop();
  if (scriptsDir !== undefined && scriptsDir !== "") {
    await freeOwnPollForFlash(channel, scriptsDir, spare);
  }
  const settings = flashSettingsFrom(checked.value);
  const flashed = await runFlashOnce(flashToolOf(checked.value), live?.mcuTargetId ?? "", settings, elfPath, channel, report);
  if (flashed && hadLive && live !== undefined) {
    channel.appendLine("[flash] flash OK — restarting Live session");
    await live.restartLive();
  }
}

/**
 * Single flash attempt with at most one manual retry — auto-flash loops are
 * forbidden. Returns true only when the flash + verify succeeded.
 *
 * `report` is how flash progress reaches the sidebar at all: P0-9 had every
 * caller passing `""`, so a write that took 30s looked like nothing had
 * started, and the `stm32ext.flash` command never reported its outcome.
 */
async function runFlashOnce(
  tool: FlashTool,
  mcuTarget: string,
  settings: Parameters<typeof runFlash>[0],
  elfPath: string,
  channel: vscode.OutputChannel,
  report?: (phase: string, percent: number | null) => void,
): Promise<boolean> {
  if (tool === "pyocd" && mcuTarget === "") {
    channel.appendLine("[flash] MCU不明 — ビルドしてから再実行 (pyocd はターゲット ID が要ります)");
    void vscode.window.showErrorMessage("MCU が不明です。ビルドしてから再度書き込みしてください。");
    report?.("書き込み失敗: MCU が不明です (先にビルド)", null);
    return false;
  }
  const runOnce = async (): Promise<"ok" | "retry" | "done"> => {
    report?.("書き込み中 (verify 付き)…", null);
    const result = tool === "pyocd"
      ? await runPyocdFlash(mcuTarget, settings, { elfPath, confirmed: true })
      : await runFlash(settings, { elfPath, confirmed: true });
    channel.appendLine(`[flash] ${result.command}`);
    for (const line of result.details ?? []) {
      channel.appendLine(`[flash] ${line}`);
    }
    channel.appendLine(`[flash] ${result.message}`);
    if (result.ok) {
      report?.("書き込み成功 (verify OK)", 100);
      void vscode.window.showInformationMessage("STM32 flash + verify OK.");
      return "ok";
    }
    if (result.retryable) {
      report?.(`書き込み失敗 (再試行できます): ${result.message}`, null);
      const retry = await vscode.window.showErrorMessage(result.message, "Retry once");
      return retry === "Retry once" ? "retry" : "done";
    }
    report?.(`書き込み失敗: ${result.message}`, null);
    void vscode.window.showErrorMessage(result.message);
    return "done";
  };
  const first = await runOnce();
  if (first === "ok") {
    return true;
  }
  if (first === "retry") {
    return (await runOnce()) === "ok";
  }
  return false;
}

/** Build the workspace project, then flash the freshly built ELF (auto-selected, no picker). */
async function buildAndFlashFlow(
  channel: vscode.OutputChannel,
  panel: BuildPanelProvider,
  collection: vscode.DiagnosticCollection,
  live: LivePanelProvider | undefined,
  scriptsDir: string,
  report?: (phase: string, percent: number | null) => void,
): Promise<void> {
  const checked = readSettings();
  if (!checked.ok) {
    void vscode.window.showErrorMessage(checked.error);
    return;
  }
  if (await checkProbeConflict(channel)) {
    return;
  }
  const elfPath = await buildProjectFlow(channel, panel, collection, live, scriptsDir);
  if (elfPath === undefined) {
    return;
  }
  const confirm = await vscode.window.showWarningMessage(
    `Build OK. Flash ${elfPath}? This overwrites target firmware.`,
    { modal: true },
    "Build & Flash",
  );
  if (confirm !== "Build & Flash") {
    return;
  }
  // Self-probe reclaim AFTER the build: buildProjectFlow re-resolved the ELF
  // and restarted Live above, so stop this window's session now (covered by
  // the Build & Flash modal) + SIGTERM orphaned own live_poll.py by marker.
  const spare = live?.pollPid;
  const hadLive = spare !== undefined;
  await live?.stop();
  await freeOwnPollForFlash(channel, scriptsDir, spare);
  const flashed = await runFlashOnce(
    flashToolOf(checked.value), live?.mcuTargetId ?? "",
    flashSettingsFrom(checked.value), elfPath, channel, report);
  if (flashed && hadLive && live !== undefined) {
    channel.appendLine("[flash] flash OK — restarting Live session");
    await live.restartLive();
  }
}

/**
 * Build progress. The standalone build view is never registered, so its HTML
 * render path was dead: progress was computed and thrown away, and a build
 * looked frozen at 0% for seconds to minutes (P0-7). This is now a state
 * holder that posts `build-progress` to the one registered webview.
 */
class BuildPanelProvider {
  private state: BuildPanelState = { status: "idle", diagnostics: [] };
  /** Latest state for the combined sidebar renderer. */
  get sidebarState(): BuildPanelState {
    return this.state;
  }
  private postTarget?: vscode.Webview;
  private onSettled?: (state: BuildPanelState) => void;
  setPostTarget(target: vscode.Webview): void {
    this.postTarget = target;
  }
  /** Called once per settled state change (the sidebar re-sends its state). */
  setSettledHandler(handler: (state: BuildPanelState) => void): void {
    this.onSettled = handler;
  }
  private post(msg: unknown): void {
    if (this.postTarget !== undefined) {
      void this.postTarget.postMessage(msg);
    }
  }
  /**
   * `announce` is for the transitions a human notices (start, OK, failure);
   * per-object progress ticks only send `build-progress`, because a full
   * state re-send per compiled file is what froze the UI.
   */
  set(state: BuildPanelState, announce = false): void {
    this.state = state;
    const p = state.progress;
    const percent = p !== undefined && p.total > 0
      ? Math.min(100, Math.round((p.done / p.total) * 100))
      : null;
    this.post({
      kind: "build-progress",
      phase: state.currentAction ?? state.status,
      percent,
      done: p?.done ?? 0,
      total: p?.total ?? null,
    });
    if (announce) {
      this.onSettled?.(state);
    }
  }
}

function diagSeverity(kind: GccDiagnostic["kind"]): vscode.DiagnosticSeverity {
  switch (kind) {
    case "error":
      return vscode.DiagnosticSeverity.Error;
    case "warning":
      return vscode.DiagnosticSeverity.Warning;
    default:
      return vscode.DiagnosticSeverity.Information;
  }
}

/** Push GCC diagnostics into the Problems panel, grouped by file. */
function publishBuildDiagnostics(
  collection: vscode.DiagnosticCollection,
  diagnostics: readonly GccDiagnostic[],
): void {
  collection.clear();
  const byFile = new Map<string, vscode.Diagnostic[]>();
  for (const d of diagnostics) {
    const line = Math.max(0, d.line - 1);
    const col = Math.max(0, d.col - 1);
    const range = new vscode.Range(line, col, line, col);
    const list = byFile.get(d.file) ?? [];
    list.push(new vscode.Diagnostic(range, `${d.message} [${d.kind}]`, diagSeverity(d.kind)));
    byFile.set(d.file, list);
  }
  for (const [file, list] of byFile) {
    collection.set(vscode.Uri.file(file), list);
  }
}

interface BuildJumpTarget {
  readonly file?: unknown;
  readonly line?: unknown;
  readonly col?: unknown;
}

/** file:line:col jump target for Build-panel diagnostic links. */
async function openBuildDiag(raw: unknown): Promise<void> {
  const loc = raw as BuildJumpTarget | undefined;
  if (typeof loc?.file !== "string" || loc.file === "") {
    return;
  }
  const line = typeof loc.line === "number" && loc.line > 0 ? loc.line - 1 : 0;
  const col = typeof loc.col === "number" && loc.col > 0 ? loc.col - 1 : 0;
  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(loc.file));
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    editor.selection = new vscode.Selection(line, col, line, col);
    editor.revealRange(new vscode.Range(line, col, line, col));
  } catch {
    void vscode.window.showErrorMessage(`STM32: cannot open ${loc.file}`);
  }
}

/** Generate build-ext/build.ninja from the workspace .cproject, then run ninja. */
async function buildProjectFlow(
  channel: vscode.OutputChannel,
  panel: BuildPanelProvider,
  collection: vscode.DiagnosticCollection,
  live?: LivePanelProvider,
  scriptsDir?: string,
): Promise<string | undefined> {
  const projectRoot = await chooseProject();
  if (projectRoot === undefined) {
    return undefined;
  }
  const projectName = basename(projectRoot);
  let xml: string;
  try {
    xml = readFileSync(join(projectRoot, ".cproject"), "utf8");
  } catch {
    void vscode.window.showErrorMessage(`STM32: no .cproject in ${projectRoot}; open an STM32 project folder.`);
    return undefined;
  }
  const cfg = parseCproject(xml, {
    projectNameHint: projectName,
    workspaceRoots: { [projectName]: projectRoot },
    defaultRoot: projectRoot,
  });
  const debugBuildDirAbs = debugBuildDirOf(cfg, projectRoot);
  const outDirAbs = join(projectRoot, "build-ext");
  const ninjaText = renderNinja({
    cfg,
    projectRoot,
    outDirAbs,
    artifactName: artifactOf(cfg),
    sources: discoverSources(projectRoot, cfg.sourceEntries).sources,
    useCcache: true,
    linkerAbs: linkerAbsOf(cfg, projectRoot),
    includesAbs: resolveIncludes(cfg.includes, debugBuildDirAbs),
    debugBuildDirAbs,
  });
  mkdirSync(outDirAbs, { recursive: true });
  mkdirSync(join(outDirAbs, "obj"), { recursive: true });
  writeFileSync(join(outDirAbs, "build.ninja"), ninjaText);
  const elfPath = join(outDirAbs, `${artifactOf(cfg)}.elf`);
  panel.set({ status: "running", diagnostics: [], elfPath }, true);
  channel.appendLine(`[build] ninja -C ${outDirAbs}`);
  let lastPct = 0;
  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "STM32 build (ninja)", cancellable: false },
    async (progress) => runNinja({
      buildDir: outDirAbs,
      onProgress: (p, action) => {
        const pct = p.total > 0 ? Math.min(100, Math.round((p.done / p.total) * 100)) : 0;
        panel.set({ status: "running", progress: p, diagnostics: [], elfPath, currentAction: action });
        progress.report({ increment: Math.max(0, pct - lastPct), message: `${pct}% ${action}` });
        lastPct = pct;
      },
    }),
  );
  publishBuildDiagnostics(collection, result.diagnostics);
  const errors = result.diagnostics.filter((d) => d.kind === "error").length;
  const warnings = result.diagnostics.filter((d) => d.kind === "warning").length;
  const tail = `${result.stdout}\n${result.stderr}`.trim().split("\n").slice(-30).join("\n");
  const done: BuildPanelState = result.progress !== undefined
    ? {
      status: result.ok ? "ok" : "failed",
      progress: { done: result.progress.done, total: result.progress.total },
      diagnostics: result.diagnostics,
      elfPath,
      elapsedMs: result.elapsedMs,
      logTail: tail,
      ...(result.ok ? {} : { failureCause: describeBuildFailure(result) }),
    }
    : {
      status: result.ok ? "ok" : "failed",
      diagnostics: result.diagnostics,
      elfPath,
      elapsedMs: result.elapsedMs,
      logTail: tail,
      ...(result.ok ? {} : { failureCause: describeBuildFailure(result) }),
    };
  panel.set(done, true);
  channel.appendLine(`[build] ${result.ok ? "OK" : "FAILED"} in ${(result.elapsedMs / 1000).toFixed(1)}s, ${errors} error(s), ${warnings} warning(s)`);
  if (result.ok) {
    void vscode.window.showInformationMessage(`STM32 build OK: ${elfPath}`);
    await reresolveLive(channel, live, scriptsDir, elfPath, cfg.mcu);
    return elfPath;
  } else {
    const cause = describeBuildFailure(result);
    channel.appendLine(`[build] cause: ${cause}`);
    void vscode.window.showErrorMessage(
      errors > 0
        ? `STM32 build failed (${errors} error(s)): ${firstError(result.diagnostics)} — 詳細は ビルド / Problems。`
        : `STM32 build failed: ${cause}`,
    );
    return undefined;
  }
}

/** First compiler error, in a form that fits a toast. */
function firstError(diagnostics: readonly GccDiagnostic[]): string {
  const first = diagnostics.find((d) => d.kind === "error");
  if (first === undefined) {
    return "";
  }
  const where = first.file.split("/").pop() ?? first.file;
  return `${where}:${first.line} ${first.message}`;
}

/** Per-build ELF re-resolution for the Live monitor (todo5a). */
async function reresolveLive(
  channel: vscode.OutputChannel,
  live: LivePanelProvider | undefined,
  scriptsDir: string | undefined,
  elfPath: string,
  mcu: string,
): Promise<void> {
  if (live === undefined || scriptsDir === undefined) {
    return;
  }
  try {
    // --all-members: the whole DWARF tree, so the sidebar can offer struct
    // selection and every leaf carries its real width and signedness. The
    // host then filters it down to the watchlist before the sidecar sees it.
    const res = await resolveElf(
      elfPath,
      (elf: string, extra: readonly string[] = []) =>
        spawnCli("python3", [join(scriptsDir, "elf_resolve.py"), elf, ...extra, "--json"]),
      ["--all-members"],
    );
    live.setResolution(res, mcu);
    channel.appendLine(`[live] resolved ${res.symbols.length} symbols from ${elfPath} (${res.backend}, base=${res.base})`);
    if (res.unresolved.length > 0) {
      channel.appendLine(`[live] unresolved: ${res.unresolved.join(", ")}`);
    }
  } catch (err) {
    channel.appendLine(`[live] resolve failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * The one stacked sidebar view. Owns the single webview: every function
 * (project / build / flash / live / graph / log) is a section in it, so
 * opening the activity-bar icon is the only step needed.
 *
 * P0-3: `webview.html` is assigned exactly once, here. Everything else is a
 * message. The old code re-rendered the whole DOM on every log line, so at
 * 100Hz the table rows, the plot buffer, the half-typed input and the focus
 * were destroyed dozens of times a second.
 */
class SidebarProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private flashProgress = "";
  private flashResult = "";
  private liveDrop = "";
  private logTail = "";
  constructor(
    private readonly deps: {
      buildPanel: BuildPanelProvider;
      livePanel: LivePanelProvider;
      graphPanel: GraphPanelProvider;
      doBuild: () => Promise<string | undefined>;
      doBuildFlash: () => Promise<void>;
      doFlash: (elfPath: string) => Promise<void>;
      liveStart: () => Promise<void>;
    },
  ) {}
  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    // enableCommandUris: the sidebar links to the graph panel, the build
    // diagnostics and the output channel with command: URIs.
    view.webview.options = { enableScripts: true, enableCommandUris: true };
    this.deps.livePanel.setPostTarget(view.webview);
    this.deps.buildPanel.setPostTarget(view.webview);
    this.deps.buildPanel.setSettledHandler(() => { this.pushState(); });
    this.deps.livePanel.setLogSink((line) => { this.appendLog(line); });
    this.deps.graphPanel.setSidebarTarget(view.webview);
    this.deps.livePanel.setDropSink((summary) => { this.liveDrop = summary; });
    view.webview.onDidReceiveMessage((raw: unknown) => { void this.onMessage(raw); });
    // The one and only HTML assignment in the product.
    // The font size is read here rather than through readSettings(): that
    // function is a required-settings gate that blocks every operation, and
    // a presentation preference with a default must never be able to do that.
    const uiFontPx = vscode.workspace.getConfiguration("stm32ext").get<number>("uiFontPx", 15);
    this.view.webview.html = renderSidebar(this.sidebarState(), uiFontPx);
    this.deps.livePanel.replayTo(view.webview);
  }
  private post(msg: unknown): void {
    if (this.view !== undefined) {
      void this.view.webview.postMessage(msg);
    }
  }
  private async onMessage(raw: unknown): Promise<void> {
    const msg = parseSidebarMessage(raw);
    if (msg === null) {
      return;
    }
    switch (msg.kind) {
      case "project-select":
        // D-9: the row carries the directory it represents; ignoring it made
        // the click open a picker over every project instead of selecting.
        setSelectedDir(msg.dir !== "" ? msg.dir : undefined);
        if (msg.dir === "") {
          await chooseProject(true);
        }
        this.pushState();
        return;
      case "project-refresh":
        setSelectedDir(undefined);
        this.pushState();
        return;
      case "build-run":
        await this.deps.doBuild();
        return;
      case "build-flash":
        await this.deps.doBuildFlash();
        return;
      case "flash": {
        const elf = this.currentElf();
        if (elf === "") {
          this.setFlashPhase("先にビルドしてください", null);
          return;
        }
        await this.deps.doFlash(elf);
        return;
      }
      case "flash-retry":
        await this.deps.doBuildFlash();
        return;
      case "live-start":
        await this.deps.liveStart();
        return;
      case "live-stop":
      case "live-pause":
      case "live-resume":
      case "live-reconnect":
      case "live-export-csv":
        await this.deps.livePanel.handleLiveAction(msg.kind.slice("live-".length));
        return;
      case "live-add-watch":
        await this.deps.livePanel.handleLiveAction("add-watch");
        return;
      case "live-add":
        await this.deps.livePanel.handleLiveAction("add-names", (msg.names ?? []).join(","));
        return;
      case "live-write":
        await this.deps.livePanel.handleLiveAction("write", msg.name, msg.value);
        return;
      case "live-remove":
      case "live-remove-names":
        await this.deps.livePanel.handleLiveAction("remove-names", [msg.name, ...(msg.names ?? [])].join(","));
        return;
      case "log-clear":
        // The host keeps a tail for the next bootstrap; without clearing it
        // here the "erased" log would come back on the next state push.
        this.logTail = "";
        this.post({ kind: "log-append", lines: [] });
        return;
      case "log-filter":
        // Filtering is a webview-local view concern; the host stores nothing.
        return;
      case "graph-add":
      case "graph-remove":
        // The watchlist half moved into GraphPanelProvider.addSeries /
        // removeSeries. It used to be repeated here, which is how the graph
        // panel ended up able to add a legend entry that nothing ever polls.
        // Both surfaces now go through one implementation.
        if (msg.kind === "graph-add") {
          this.deps.graphPanel.addSeries(msg.name);
        } else {
          this.deps.graphPanel.removeSeries(msg.name);
        }
        this.pushState();
        return;
    }
  }
  private currentElf(): string {
    const st = this.deps.buildPanel.sidebarState;
    return st.elfPath !== undefined ? st.elfPath : "";
  }
  /**
   * The flash status line. `phase` is the visible text and doubles as the
   * machine state the webview keys its "reveal 再試行" off: it starts with
   * `書き込み失敗:` exactly when a retry is worth offering.
   */
  setFlashPhase(phase: string, percent: number | null): void {
    this.flashProgress = phase;
    this.flashResult = phase.startsWith("書き込み失敗") ? phase : "";
    this.post({ kind: "flash-progress", phase, percent });
    this.pushState();
  }
  /** One log line, as a delta. No DOM is touched. */
  appendLog(line: string): void {
    const stamp = new Date().toISOString().slice(11, 19);
    this.logTail = `${this.logTail}${stamp} ${line}\n`.slice(-8000);
    this.post({ kind: "log-append", lines: [`${stamp} ${line}`] });
  }
  /**
   * Re-send the whole state. This is a message, not an HTML assignment, so
   * it is safe to call on the rare user-driven transitions (project picked,
   * build settled) — unlike the old full re-render it never destroys the
   * table, the plot or the focus.
   */
  private pushState(): void {
    const state = this.sidebarState();
    this.post({
      kind: "live-bootstrap",
      state,
      hz: state.liveHz,
      project: state.selectedDir ?? "",
    });
  }
  private sidebarState(): SidebarState {
    const b = this.deps.buildPanel.sidebarState;
    const checked = readSettings();
    const lp = this.deps.livePanel.sidebarState;
    return {
      projects: currentProjects(),
      selectedDir: getSelectedDir(),
      buildStatus: b.status,
      buildPercent: b.progress !== undefined && b.progress.total > 0
        ? Math.min(100, Math.round((b.progress.done / b.progress.total) * 100))
        : b.status === "ok" ? 100 : 0,
      diagnostics: b.diagnostics,
      elfPath: b.elfPath ?? "",
      flashProgress: this.flashProgress,
      flashResult: this.flashResult,
      liveHz: checked.ok ? checked.value.pollHz : 50,
      liveConnected: lp.connected,
      liveSource: lp.elfPath,
      liveDrop: this.liveDrop,
      unresolved: lp.unresolved,
      graphSeries: this.deps.graphPanel.seriesNames(),
      logTail: this.logTail,
    };
  }
}

/**
 * `graph-download-csv` host handler: the graph panel's CSV button asks the
 * host to write the file, because a webview has no filesystem. Same frozen
 * schema as the live CSV, so both exports stay machine-comparable.
 */
async function writeGraphCsv(channel: vscode.OutputChannel, rows: readonly LiveSample[]): Promise<void> {
  if (rows.length === 0) {
    void vscode.window.showWarningMessage("グラフの記録がありません — 変数を追加してしばらく監視してください");
    return;
  }
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder === undefined) {
    void vscode.window.showErrorMessage("ワークスペースが開かれていません: グラフ CSV を書き出せません");
    return;
  }
  const uri = vscode.Uri.joinPath(folder.uri, "stm32-graph.csv");
  await vscode.workspace.fs.writeFile(uri, Buffer.from(formatCsv(rows), "utf8"));
  channel.appendLine(`[graph] CSV exported: ${uri.fsPath} (${rows.length} rows, schema timestamp,address,name,value)`);
  void vscode.window.showInformationMessage(`グラフ CSV を保存しました: ${uri.fsPath} (${rows.length} 行)`);
}

/**
 * The quickstart the "導入手順を開く" button opens: the README that ships
 * INSIDE the .vsix, not a github.com URL. A remote link was wrong twice over
 * — it pointed at `main` while the default branch was a feature branch (404),
 * and its `#anchor` had to track a heading slug by hand. A bundled file
 * cannot rot and works offline.
 */
const QUICKSTART_RELATIVE_PATH = "README.md";

/** One external program the extension needs, and how to get it if absent. */
export interface ToolRequirement {
  readonly name: string;
  /** What breaks without it, in the user's terms. */
  readonly needed: string;
  /** Concrete install command for the common platforms, best-effort. */
  readonly install: string;
  /** False = a first-time user is blocked until they install it. */
  readonly required: boolean;
}

/**
 * The external tools this extension shells out to.
 *
 * Kept as data (not scattered spawn sites) so `STM32: 診断` can report them all
 * at once. A user who cannot build used to meet the failure one command at a
 * time: ninja missing, then ccache missing, then a cryptic "executable file
 * not found" from the linker. One list, one message, one fix.
 */
export const TOOL_REQUIREMENTS: readonly ToolRequirement[] = [
  {
    name: "arm-none-eabi-gcc",
    needed: "ファームウェアのコンパイル",
    install: "Linux: sudo apt install gcc-arm-none-eabi\nmacOS: brew install --cask gcc-arm-embedded\nWindows: https://developer.arm.com/downloads/-/arm-gnu-toolchain-downloads",
    required: true,
  },
  {
    name: "ninja",
    needed: "ビルドの実行",
    install: "Linux: sudo apt install ninja-build\nmacOS: brew install ninja\nWindows: choco install ninja / pip install ninja",
    required: true,
  },
  {
    name: "ccache",
    needed: "ビルドキャッシュ（無くても動きますが遅くなります）",
    install: "Linux: sudo apt install ccache\nmacOS: brew install ccache\nWindows: choco install ccache",
    required: false,
  },
  {
    // NOT required: the whole point of the pyOCD backend is that the build
    // and the type tree work without it. Marking it required made this
    // extension claim "必須ツールが未導入" on a machine that can build, which
    // contradicts the README and trains people to ignore the notice.
    name: "pyocd",
    needed: "「書き込み」と「Live 監視」が使えません（ビルドは問題なく動きます）",
    install: "pip install --user pyocd",
    required: false,
  },
  {
    name: "python3",
    needed: "DWARF からの型解決と Live 監視のサイドカー",
    install: "Linux: sudo apt install python3\nmacOS: brew install python3\nWindows: https://www.python.org/downloads/",
    required: true,
  },
];

/**
 * Which tools are missing, and the single line to tell the user about it.
 * Pure over its `found` argument so the wording is testable without a PATH.
 */
export function describeMissingTools(
  reqs: readonly ToolRequirement[],
  found: (name: string) => boolean,
): { missing: readonly ToolRequirement[]; summary: string; install: string } {
  const missing = reqs.filter((r) => !found(r.name));
  const blocking = missing.filter((r) => r.required);
  if (blocking.length === 0) {
    return {
      missing,
      summary: missing.length === 0
        ? "環境 OK — 必要なツールはすべて揃っています"
        : `環境 OK（任意ツール ${missing.length} 件は未導入: ${missing.map((m) => m.name).join(", ")}）`,
      install: "",
    };
  }
  // Every blocker gets its own install line: a single "install the toolchain"
  // sentence is what a first-time user cannot act on.
  const install = blocking
    .map((r) => `  ${r.name} — ${r.needed}\n    ${r.install}`)
    .join("\n");
  return {
    missing,
    summary: `${blocking.length} 個の必須ツールが未導入: ${blocking.map((m) => m.name).join(", ")}`,
    install,
  };
}

/**
 * The first-run notice text.
 *
 * A VS Code notification is rendered as ONE row: newlines in the message are
 * dropped. The multi-line install block this used to embed was therefore
 * formatted carefully and then thrown away unreadable. The message names the
 * missing tools and points at the buttons instead; the commands themselves go
 * to the output channel, which does preserve line breaks.
 */
export function firstRunMessage(blockers: readonly ToolRequirement[]): string {
  const names = blockers.map((m) => m.name).join(", ");
  return `STM32: 必須ツールが未導入です (${names}) — 導入手順を確認してください`;
}

/** STM32: 診断 — ツールチェーン・設定・競合をまとめて点検します。 */
async function diagnose(channel: vscode.OutputChannel): Promise<void> {
  channel.appendLine("[diagnose] STM32 environment check");
  const tools = describeMissingTools(TOOL_REQUIREMENTS, (n) => resolveTool(n).found);
  channel.appendLine(`[diagnose] ${tools.summary}`);
  for (const r of TOOL_REQUIREMENTS) {
    channel.appendLine(`[diagnose]   ${resolveTool(r.name).found ? "OK  " : "MISS"} ${r.name} (${r.needed})`);
  }
  if (tools.install !== "") {
    channel.appendLine("[diagnose] 導入方法:");
    channel.appendLine(tools.install);
  }
  const checked = readSettings();
  const settingsOk = checked.ok;
  channel.appendLine(settingsOk
    ? `[diagnose] settings OK (probe=${checked.value.probe} iface=${checked.value.iface} reset=${checked.value.resetMode} pollHz=${checked.value.pollHz})`
    : `[diagnose] settings MISSING: ${checked.error}`);
  const cli = resolveCliPath(settingsOk ? checked.value.cliPath : "");
  channel.appendLine(`[diagnose] CLI: ${cli.cli} (${cli.found ? "found" : "NOT FOUND"})`);
  let ps = "";
  try {
    ps = await listProcesses(
      (bin, args) =>
        new Promise<string>((resolve) => {
          execFile(bin, [...args], { timeout: 10000 }, (err, stdout) => {
            resolve(err ? "" : String(stdout));
          });
        }),
    );
  } catch {
    ps = "";
  }
  const conflict = detectConflicts(ps);
  channel.appendLine(conflict.cubeIde
    ? `[diagnose] CubeIDE: RUNNING (${conflict.details.join(", ")}) — 終了推奨`
    : "[diagnose] CubeIDE: not running (OK)");
  const summary = `診断: ツール ${tools.missing.filter((m) => m.required).length === 0 ? "OK" : "不足"} / 設定${settingsOk ? "OK" : "不足"} / CLI ${cli.found ? "検出" : "未検出"} / CubeIDE ${conflict.cubeIde ? "起動中⚠️" : "停止中"}`;
  channel.appendLine(`[diagnose] ${summary} (詳細はこの出力パネル)`);
  // The verdict is one line: a VS Code toast collapses newlines, so an
  // embedded install block was unreadable. The full per-tool commands are in
  // the output channel above, which preserves them, and the button goes
  // there rather than to Settings — a missing binary is not a setting.
  if (tools.install !== "") {
    void vscode.window.showErrorMessage(
      `${summary} — 導入コマンドは出力パネルにあります`,
      "出力パネルを開く",
    ).then((choice) => {
      if (choice === "出力パネルを開く") {
        channel.show(true);
      }
    });
    return;
  }
  void vscode.window.showInformationMessage(summary);
}

export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel("STM32");
  context.subscriptions.push(channel);
  const buildPanel = new BuildPanelProvider();
  const livePanel = new LivePanelProvider(channel);
  const graphPanel = new GraphPanelProvider();
  const buildDiags = vscode.languages.createDiagnosticCollection("stm32ext-build");
  context.subscriptions.push(buildDiags);
  const scriptsDir = join(context.extensionPath, "scripts");
  livePanel.configure(scriptsDir, context.workspaceState);
  // Single Live->Graph forwarding subscription (todo2): every sample batch
  // reaching the Live table is forwarded to the Graph panel exactly once.
  // The sink overwrites on assignment, so no duplicate subscription can exist.
  livePanel.setSampleSink((samples) => { graphPanel.pushSamples(samples); });
  context.subscriptions.push(new vscode.Disposable(() => { void livePanel.stop(); }));
  const doBuild = (): Promise<string | undefined> =>
    buildProjectFlow(channel, buildPanel, buildDiags, livePanel, scriptsDir);
  const doBuildFlash = (): Promise<void> =>
    buildAndFlashFlow(channel, buildPanel, buildDiags, livePanel, scriptsDir,
      (phase, percent) => { sidebar.setFlashPhase(phase, percent); });
  const flashConfig = (): { tool: FlashTool; settings: FlashSettings } | undefined => {
    const checked = readSettings();
    return checked.ok
      ? { tool: flashToolOf(checked.value), settings: flashSettingsFrom(checked.value) }
      : undefined;
  };
  const sidebar = new SidebarProvider({
    buildPanel,
    livePanel,
    graphPanel,
    doBuild,
    doBuildFlash,
    doFlash: async (elfPath: string): Promise<void> => {
      const cfgFlash = flashConfig();
      if (cfgFlash === undefined) {
        sidebar.setFlashPhase("設定不足: probe / interface / resetMode を設定してください", null);
        return;
      }
      // runFlashOnce reports running / OK / failed on its own, so there is no
      // second summary line here to overwrite it with.
      await runFlashOnce(
        cfgFlash.tool, livePanel.mcuTargetId, cfgFlash.settings, elfPath, channel,
        (phase, percent) => { sidebar.setFlashPhase(phase, percent); });
    },
    liveStart: () => livePanel.restartLive(),
  });
  // graph-download-csv had no host handler at all: the panel asked, nothing
  // answered. The host owns the file write, so the panel needs no reply.
  graphPanel.setDownloadHandler((rows) => { void writeGraphCsv(channel, rows); });
  // A graph series is only plottable if the live session polls it. The wiring
  // lives in GraphPanelProvider so the sidebar and the graph panel cannot
  // drift apart again: the panel used to add a legend entry that nothing
  // polled, which drew a permanently blank canvas with no error anywhere.
  //
  // The changes are BATCHED. Both surfaces post one message per name, and one
  // struct-prefix click is up to 32 of them. Forwarding each on its own made
  // addNames (a read-modify-write of the stored watchlist) run 32 times
  // concurrently off the same base, so all but the last write were lost, and
  // made restart() spawn the sidecar 32 times over the same probe, which is
  // where the `Errno 16 Resource busy` USB claim race comes from.
  const watchBatcher = new WatchBatcher({
    sink: (add, remove) => {
      if (add.length > 0) {
        void livePanel.handleLiveAction("add-names", add.join(","));
      }
      if (remove.length > 0) {
        void livePanel.handleLiveAction("remove-names", remove.join(","));
      }
    },
  });
  context.subscriptions.push(new vscode.Disposable(() => { watchBatcher.dispose(); }));
  graphPanel.setWatchHandler((name, add) => { watchBatcher.push(name, add); });
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SIDEBAR_VIEW_ID, sidebar, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );
  const openSidebar = (): Thenable<void> =>
    vscode.commands.executeCommand(`${SIDEBAR_VIEW_ID}.focus`);
  /**
   * The graph is a real editor-area panel (D1), not a seventh sidebar section.
   * It used to be routed to `openSidebar()` like every other show* command,
   * which meant `graphPanelHtml` was never called anywhere: the renderer
   * shipped unmounted and the sidebar's launcher focused the sidebar.
   */
  let graphWebviewPanel: vscode.WebviewPanel | undefined;
  const openGraphPanel = (): void => {
    if (graphWebviewPanel !== undefined) {
      graphWebviewPanel.reveal(vscode.ViewColumn.Beside, true);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      GRAPH_PANEL_VIEW_TYPE,
      GRAPH_PANEL_TITLE,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, enableCommandUris: true, retainContextWhenHidden: true },
    );
    graphWebviewPanel = panel;
    // The document is assigned once, inside graphPanel.mount().
    graphPanel.mount(panel.webview);
    // The panel decodes with the same type metadata the table uses. Its
    // SAMPLES come from the Live->Graph sample sink alone; registering it as a
    // post target too delivered every batch twice.
    //
    // Registration, not a one-shot send: a panel opened before the first
    // build has no types yet, and a one-shot send left it decoding every
    // sample as unplottable for the rest of the session (blank canvas).
    livePanel.addTypeTarget(panel.webview);
    panel.onDidDispose(() => {
      graphPanel.unmount(panel.webview);
      livePanel.removeTypeTarget(panel.webview);
      if (graphWebviewPanel === panel) {
        graphWebviewPanel = undefined;
      }
    });
  };
  // The sidebar keeps Project/Build/Flash/Live/Log; Graph has its own panel.
  for (const cmd of [
    "stm32ext.showProject", "stm32ext.showBuild", "stm32ext.showFlash",
    "stm32ext.showLive", "stm32ext.showLog",
  ]) {
    context.subscriptions.push(vscode.commands.registerCommand(cmd, () => { void openSidebar(); }));
  }
  context.subscriptions.push(
    vscode.commands.registerCommand("stm32ext.showGraph", () => { openGraphPanel(); }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("stm32ext.flash", () =>
      flashElfFlow(channel, livePanel, scriptsDir,
        (phase, percent) => { sidebar.setFlashPhase(phase, percent); })),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("stm32ext.build", () =>
      buildProjectFlow(channel, buildPanel, buildDiags, livePanel, join(context.extensionPath, "scripts"))),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("stm32ext.buildAndFlash", () =>
      buildAndFlashFlow(channel, buildPanel, buildDiags, livePanel, scriptsDir,
        (phase, percent) => { sidebar.setFlashPhase(phase, percent); })),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("stm32ext.openBuildDiag", (loc: unknown) => openBuildDiag(loc)),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("stm32ext.selectProject", () => chooseProject(true)),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("stm32ext.diagnose", () => diagnose(channel)),
  );
  channel.appendLine("STM32 extension active (sidebar).");

  // Say what is missing BEFORE the user hits a build button and reads
  // "executable file not found". Never blocks activation.
  //
  // One rule: while a required tool is missing, say so — every launch. There
  // is deliberately no "already seen" flag. It used to be written to
  // globalState but never read to suppress anything, so it was ceremony whose
  // comment claimed it spared a returning user, which it did not. A stored
  // flag would be wrong anyway: dismissing a notice about a missing compiler
  // is not the same as having installed one, so the user who ignores it once
  // is exactly the user who needs it again after installing half of it.
  const tools = describeMissingTools(TOOL_REQUIREMENTS, (n) => resolveTool(n).found);
  const blockers = tools.missing.filter((m) => m.required);
  if (blockers.length > 0) {
    void vscode.window.showWarningMessage(
      firstRunMessage(blockers),
      "診断する",
      "導入手順を開く",
    ).then((choice) => {
      if (choice === "診断する") {
        void vscode.commands.executeCommand("stm32ext.diagnose");
      } else if (choice === "導入手順を開く") {
        void vscode.commands.executeCommand(
          "vscode.open",
          vscode.Uri.file(join(context.extensionPath, QUICKSTART_RELATIVE_PATH)),
        );
      }
    });
  }
}

export function deactivate(): void {}
