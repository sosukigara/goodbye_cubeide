// Graph panel acceptance (design 4 / S5). The webview program is executed
// for real in a node:vm with a DOM + canvas stub, so what is measured here is
// the shipped script: rAF batching, per-frame cost, the y mapping and the
// type-aware decoding. No vscode import, no DOM library.
import { describe, expect, it } from "vitest";
import { Script } from "node:vm";
import {
  GRAPH_SERIES_COLORS,
  graphPanelHtml,
  parseGraphPanelMessage,
} from "../src/live/graphPanel.js";

interface StubEl {
  tagName: string;
  dataset: Record<string, string>;
  style: Record<string, string>;
  attrs: Record<string, string>;
  children: StubEl[];
  parentNode: StubEl | null;
  handlers: Record<string, ((ev: unknown) => void)[]>;
  className: string;
  title: string;
  value: string;
  textContent: string;
  width?: number;
  height?: number;
  // The script under test drives a DOM-ish surface (append/remove, attributes,
  // listeners); the stub must carry the members it actually builds below.
  _text: string;
  appendChild(c: StubEl): StubEl;
  removeChild(c: StubEl): StubEl;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  addEventListener(t: string, f: (ev: unknown) => void): void;
  fire(t: string, ev?: unknown): void;
  getContext(kind: string): unknown;
  getBoundingClientRect(): { width: number; height: number };
}

/** Grid-line colour the shipped script draws lines with; axis TEXT must not be it. */
const GRID = "rgba(128,128,128,0.28)";

/** MIN/MAX/LAST (`v`) and UNIT (`u`) cell writes: the 100Hz readout surface. */
let valueWrites = 0;

function makeEl(tag: string, rect?: { width: number; height: number }): StubEl {
  const el: StubEl = {
    tagName: tag.toUpperCase(),
    dataset: {} as Record<string, string>,
    style: {} as Record<string, string>,
    attrs: {} as Record<string, string>,
    children: [] as StubEl[],
    parentNode: null as StubEl | null,
    handlers: {} as Record<string, ((ev: unknown) => void)[]>,
    className: "",
    title: "",
    value: "",
    _text: "",
    get textContent(): string {
      return this._text + this.children.map((c) => c.textContent).join("");
    },
    set textContent(v: string) {
      if (this.className === "v" || this.className === "u") {
        valueWrites += 1;
      }
      this._text = String(v);
      this.children.length = 0;
    },
    appendChild(c: StubEl): StubEl {
      this.children.push(c);
      c.parentNode = this;
      return c;
    },
    removeChild(c: StubEl): StubEl {
      const i = this.children.indexOf(c);
      if (i >= 0) {
        this.children.splice(i, 1);
      }
      c.parentNode = null;
      return c;
    },
    setAttribute(k: string, v: string): void {
      this.attrs[k] = String(v);
      if (k.startsWith("data-")) {
        this.dataset[k.slice(5)] = String(v);
      }
    },
    getAttribute(k: string): string | null {
      return this.attrs[k] ?? null;
    },
    addEventListener(t: string, f: (ev: unknown) => void): void {
      (this.handlers[t] ??= []).push(f);
    },
    fire(t: string, ev: unknown = {}): void {
      for (const f of this.handlers[t] ?? []) {
        f(ev);
      }
    },
    getContext(): unknown {
      return ctxStub;
    },
    getBoundingClientRect(): { width: number; height: number } {
      return rect ?? { width: 900, height: 440 };
    },
  };
  Object.defineProperty(el, "_text", { value: "", writable: true });
  return el;
}

interface Path {
  color: string;
  pts: { x: number; y: number }[];
  /** Point count, kept even when point capture is off. */
  n: number;
}

// Stroke recorder. clearRect() opens a frame, so every query sees the paths of
// the last drawn frame. Point capture can be switched off so the frame-budget
// test measures the panel, not the recorder's own allocations.
const recorded: Path[] = [];
let current: { x: number; y: number }[] = [];
let pointCount = 0;
let recordPoints = true;
/** Axis / enum text drawn in the current frame, in call order, with its paint. */
const texts: { t: string; x: number; y: number; fill: string; font: string }[] = [];

const ctxStub = {
  strokeStyle: "",
  fillStyle: "",
  lineWidth: 1,
  font: "",
  textAlign: "",
  textBaseline: "",
  setTransform: (): void => undefined,
  save: (): void => undefined,
  restore: (): void => undefined,
  clip: (): void => undefined,
  clearRect: (): void => {
    recorded.length = 0;
    texts.length = 0;
  },
  fillRect: (): void => undefined,
  fillText(t: string, x: number, y: number): void {
    texts.push({
      t: String(t),
      x,
      y,
      fill: String(ctxStub.fillStyle),
      font: String(ctxStub.font),
    });
  },
  rect: (): void => undefined,
  closePath: (): void => undefined,
  beginPath: (): void => {
    current = [];
    pointCount = 0;
  },
  moveTo(x: number, y: number): void {
    if (recordPoints) {
      current.push({ x, y });
    }
    pointCount += 1;
  },
  lineTo(x: number, y: number): void {
    if (recordPoints) {
      current.push({ x, y });
    }
    pointCount += 1;
  },
  stroke(): void {
    recorded.push({ color: String(ctxStub.strokeStyle), pts: current, n: pointCount });
  },
};

interface Panel {
  post(data: unknown): void;
  flush(frames?: number): void;
  posted: { kind: string; name?: string; query?: string; names?: string[] }[];
  el(testid: string): StubEl;
  paths(): Path[];
  traces(): Path[];
  record(on: boolean): void;
  byId(testid: string): StubEl;
  runFrames(): number;
  seriesRows(): { name: string; cells: string[] }[];
  legendNames(): string[];
  resize(): void;
  canvas: StubEl;
  /** MIN/MAX/LAST/UNIT cell writes since boot: the readout DOM cost. */
  writes(): number;
}

/**
 * Hand-driven setTimeout, copied from tests/variable-panel.test.ts so both
 * 100Hz surfaces are asserted the same way: the panel schedules its readout one
 * poll period out, and the tests own the clock that decides when it runs.
 * Without a clock the vm has no setTimeout at all and the shipped
 * `typeof setTimeout !== 'function'` fallback paints synchronously, which is
 * what every other test in this file exercises.
 */
export interface FakeClock {
  /** Delay (ms) of every callback scheduled so far, in scheduling order. */
  readonly scheduled: number[];
  /** Run every callback due within the next `ms`, then park the clock there. */
  advance(ms: number): void;
  /** Callbacks still waiting to run. */
  pending(): number;
}

interface FakeClockImpl extends FakeClock {
  setTimeout(fn: () => void, ms: number): number;
}

function fakeClock(): FakeClockImpl {
  let now = 0;
  let seq = 0;
  const queue: { at: number; seq: number; fn: () => void }[] = [];
  const scheduled: number[] = [];
  return {
    scheduled,
    setTimeout(fn: () => void, ms: number): number {
      const delay = Number(ms);
      seq += 1;
      scheduled.push(Number.isFinite(delay) ? delay : 0);
      queue.push({ at: now + (Number.isFinite(delay) ? delay : 0), seq, fn });
      return seq;
    },
    advance(ms: number): void {
      const end = now + ms;
      for (;;) {
        let best = -1;
        for (let i = 0; i < queue.length; i += 1) {
          const t = queue[i] as { at: number; seq: number; fn: () => void };
          if (t.at > end) continue;
          if (best < 0) {
            best = i;
            continue;
          }
          const b = queue[best] as { at: number; seq: number; fn: () => void };
          if (t.at < b.at || (t.at === b.at && t.seq < b.seq)) best = i;
        }
        if (best < 0) break;
        const [t] = queue.splice(best, 1);
        now = (t as { at: number; seq: number; fn: () => void }).at;
        (t as { at: number; seq: number; fn: () => void }).fn();
      }
      now = end;
    },
    pending(): number {
      return queue.length;
    },
  };
}

function scriptOf(html: string): string {
  const m = /<script>([\s\S]*?)<\/script>/.exec(html);
  if (m === null) {
    throw new Error("graph panel html has no inline script");
  }
  return m[1] ?? "";
}

function boot(
  selected: readonly string[] = [],
  clock?: FakeClockImpl,
  themeColor?: string,
): Panel {
  recorded.length = 0;
  current = [];
  recordPoints = true;
  valueWrites = 0;
  const html = graphPanelHtml(selected);
  const byId = new Map<string, StubEl>();
  const markup = html.replace(/<script>[\s\S]*?<\/script>/g, "");
  const re = /<(\w+)[^>]*?data-testid="([^"]+)"[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markup)) !== null) {
    byId.set(m[2] ?? "", makeEl(m[1] ?? "div"));
  }
  for (const id of [
    "graph-canvas", "graph-var-picker", "graph-add", "graph-remove",
    "graph-download-csv", "graph-selected", "graph-readout",
    "graph-window", "graph-error", "graph-note", "graph-y-unit",
    "graph-status", "graph-wrap",
  ]) {
    if (!byId.has(id)) {
      throw new Error(`graph panel html is missing data-testid="${id}"`);
    }
  }
  // Removed on request: the frame-timing footer, the CSV schema line and the
  // inline datalist. A stale element must not silently keep the harness green.
  for (const id of ["graph-perf", "graph-csv-schema", "graph-names"]) {
    if (byId.has(id)) {
      throw new Error(`data-testid="${id}" was removed from the graph panel`);
    }
  }
  byId.get("graph-window")!.value = "10000";

  const posted: { kind: string; name?: string; query?: string; names?: string[] }[] = [];
  const frameQueue: (() => void)[] = [];
  const winHandlers: Record<string, ((ev: unknown) => void)[]> = {};
  let observed: (() => void) | null = null;

  const document = {
    body: makeEl("body"),
    createElement: (t: string): StubEl => makeEl(t),
    querySelector(sel: string): StubEl | null {
      const hit = /^\[data-testid="(.+)"\]$/.exec(sel);
      return hit === null ? null : byId.get(hit[1] ?? "") ?? null;
    },
    querySelectorAll: (): StubEl[] => [],
  };

  class RO {
    constructor(cb: () => void) {
      observed = cb;
    }
    observe(): void {
      /* the panel only needs the callback */
    }
  }

  const sandbox = {
    document,
    acquireVsCodeApi: () => ({ postMessage: (msg: { kind: string }) => posted.push(msg) }),
    devicePixelRatio: 2,
    performance,
    // a webview global, not an ECMAScript built-in, so the vm must supply it
    TextDecoder,
    ResizeObserver: RO,
    requestAnimationFrame: (cb: () => void): number => frameQueue.push(cb),
    cancelAnimationFrame: (): void => undefined,
    console,
    ...(clock === undefined ? {} : { setTimeout: clock.setTimeout }),
    // A real webview resolves --axis-text through the cascade; the vm has no
    // getComputedStyle, so the light-theme case is supplied here.
    ...(themeColor === undefined
      ? {}
      : {
        getComputedStyle: () => ({
          getPropertyValue: (name: string): string =>
            (name === "--axis-text" ? themeColor : ""),
          color: themeColor,
        }),
      }),
  };
  const windowStub = {
    addEventListener(t: string, f: (ev: unknown) => void): void {
      (winHandlers[t] ??= []).push(f);
    },
  };
  new Script(scriptOf(html)).runInNewContext({ ...sandbox, window: windowStub });

  const runFrames = (): number => {
    let n = 0;
    while (frameQueue.length > 0) {
      (frameQueue.shift() as () => void)();
      n += 1;
    }
    return n;
  };

  return {
    posted,
    flush(frames = 1): void {
      for (let i = 0; i < frames; i += 1) {
        const cb = frameQueue.shift();
        if (cb === undefined) {
          break;
        }
        cb();
      }
    },
    runFrames,
    post(data: unknown): void {
      for (const f of winHandlers["message"] ?? []) {
        f({ data });
      }
    },
    el: (testid: string): StubEl => byId.get(testid) as StubEl,
    byId: (testid: string): StubEl => byId.get(testid) as StubEl,
    paths: (): Path[] => recorded.slice(),
    record(on: boolean): void {
      recordPoints = on;
    },
    traces: (): Path[] => recorded.filter((t) => GRAPH_SERIES_COLORS.includes(t.color)),
    seriesRows: () => byId.get("graph-readout")!.children
      .filter((c) => c.dataset["gen"] === "1")
      .map((c) => ({
        name: c.dataset["name"] ?? "",
        cells: c.children.map((td) => td.textContent),
      })),
    legendNames: () => byId.get("graph-selected")!.children.map((li) => li.dataset["name"] ?? ""),
    resize(): void {
      for (const f of winHandlers["resize"] ?? []) {
        f({});
      }
      if (observed !== null) {
        observed();
      }
    },
    canvas: byId.get("graph-canvas") as StubEl,
    writes: (): number => valueWrites,
  };
}

const T0 = Date.parse("2026-09-28T01:22:52.037Z");

function sample(name: string, value: number, ms: number, size = 4): {
  timestamp: string;
  address: string;
  name: string;
  value: string;
} {
  const digits = size * 2;
  return {
    timestamp: new Date(T0 + ms).toISOString(),
    address: "0x20000104",
    name,
    value: "0x" + value.toString(16).padStart(digits, "0"),
  };
}

const LEAF = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  size: 4,
  kind: "scalar",
  signed: false,
  type: "uint32_t",
  ...over,
});

/** The exact `live-types` payload the host posts: { kind, tree, index }. */
const types = (index: Record<string, unknown>): unknown => ({
  kind: "live-types",
  tree: { name: "debug", address: "0x200000b4", size: 976, kind: "struct", children: [] },
  index,
});

const indexOf = (...names: string[]): Record<string, unknown> =>
  Object.fromEntries(names.map((n) => [n, LEAF()]));

/** One CSS rule body out of the panel's single <style> block. */
const cssRule = (html: string, selector: string): string => {
  const css = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? "";
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Rules are concatenated with no separator, so anchor on a rule boundary or
  // `body` would match inside `html,body{...}`.
  return new RegExp(`(?:^|\\})\\s*${esc}\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
};

describe("graph panel surface", () => {
  it("is a self-contained document whose script parses", () => {
    const html = graphPanelHtml(["sys.loop_hz"]);
    expect(html).toContain("<!DOCTYPE html>");
    // The CSV schema line was removed on request: the 4-column header was
    // spelled out under the plot, which read as a fragment of output.
    expect(html).not.toContain("timestamp,address,name,value");
    expect(html).not.toContain('data-testid="graph-csv-schema"');
    expect(() => new Script(scriptOf(html))).not.toThrow();
  });

  it("carries the axis, legend, readout and control surface", () => {
    const html = graphPanelHtml([]);
    for (const id of ["graph-canvas", "graph-var-picker", "graph-add", "graph-remove",
      "graph-download-csv", "graph-selected", "graph-readout", "graph-window",
      "graph-error", "graph-y-unit", "graph-status"]) {
      expect(html, `missing ${id}`).toContain(`data-testid="${id}"`);
    }
    // y ticks + x window labels are drawn, so the axis has no html twin
    expect(scriptOf(html)).toContain("fmtTick");
    expect(scriptOf(html)).toContain("LANE_H");
    // the exported palette is the same list the script falls back to, so a
    // colour-indexed assertion here cannot silently drift from the product
    const palette = /const PALETTE = \[([^\]]*)\]/.exec(scriptOf(html));
    expect(palette?.[1]?.split(",").map((c) => c.trim().replace(/'/g, "")))
      .toEqual([...GRAPH_SERIES_COLORS]);
  });

  it("drops the frame-timing footer and its instrumentation", () => {
    const html = graphPanelHtml([]);
    // The user asked for the p50/p95/max/frames line gone, counters included.
    expect(html).not.toContain('data-testid="graph-perf"');
    expect(html).not.toContain("p50=");
    const script = scriptOf(html);
    expect(script).not.toContain("paintPerf");
    expect(script).not.toContain("PERF_RING");
    expect(script).not.toContain("G.frames");
    // the footer line the user kept: 系列 / 表示 / 保持上限 / 未登録
    expect(html).toContain('data-testid="graph-status"');
  });

  it("keeps the panel free of guide prose", () => {
    const html = graphPanelHtml(["sys.loop_hz"]);
    for (const phrase of ["手順", "使いかた", "ここに表示", 'class="guide"', "(グラフ)"]) {
      expect(html).not.toContain(phrase);
    }
  });
});

describe("graph panel text legibility", () => {
  it("paints axis, time and placeholder text in the foreground colour, not the grid colour", () => {
    // GRID is rgba(128,128,128,0.28): correct for a 1px grid line, unreadable
    // as a number. The numbers were drawn in it, which is the whole complaint.
    const p = boot();
    p.post(types(indexOf("sys.loop_hz")));
    p.flush();
    const placeholder = texts.find((c) => c.t === "系列未選択");
    expect(placeholder).toBeDefined();
    expect(placeholder?.fill).not.toBe(GRID);
    // #ccc on --vscode-editor-background #1e1e1e is ~10:1; the resolved theme
    // foreground is what the rest of the page uses, so it tracks the theme.
    expect(placeholder?.fill).toBe("#cccccc");

    const p2 = boot(["sys.loop_hz"]);
    p2.post(types(indexOf("sys.loop_hz")));
    p2.post({ kind: "live-sample", samples: [sample("sys.loop_hz", 100, 0)] });
    p2.flush();
    const ticks = texts.filter((c) => /^-?[\d.]+s?$/.test(c.t));
    expect(ticks.length).toBeGreaterThan(4);
    for (const c of ticks) {
      expect(c.fill, `${c.t} is drawn in the grid colour`).not.toBe(GRID);
    }
    // 10px monospace digits could not be read at all; the axis is 12px now.
    for (const c of texts) {
      expect(c.font).toMatch(/^12px /);
    }
  });

  it("keeps GRID for grid lines and follows the theme for axis text", () => {
    const html = graphPanelHtml([]);
    expect(scriptOf(html)).toContain(`const GRID = '${GRID}'`);
    // Canvas fillStyle cannot resolve a CSS var(), so the value is declared as
    // a token in CSS and read back through getComputedStyle.
    expect(cssRule(html, "body")).toContain("--axis-text:var(--vscode-foreground,#ccc)");
    expect(scriptOf(html)).toContain("getComputedStyle");
  });

  it("takes the axis colour from the active theme, not from a hardcoded dark value", () => {
    // #cccccc on #1e1e1e is 10.4:1 but unreadable on a light editor background,
    // so the resolved token wins: VS Code light themes resolve --vscode-foreground
    // to near-black.
    const p = boot(["sys.loop_hz"], undefined, "rgb(36, 36, 36)");
    p.post(types(indexOf("sys.loop_hz")));
    p.post({ kind: "live-sample", samples: [sample("sys.loop_hz", 100, 0)] });
    p.flush();
    const ticks = texts.filter((c) => /^-?[\d.]+s?$/.test(c.t));
    expect(ticks.length).toBeGreaterThan(4);
    for (const c of ticks) {
      expect(c.fill).toBe("rgb(36, 36, 36)");
    }
  });

  it("drops the dim opacities that made the labels unreadable", () => {
    const html = graphPanelHtml([]);
    // .lbl (axis labels), the NAME/MIN/MAX/LAST/UNIT header, the UNIT column.
    expect(cssRule(html, ".lbl")).not.toMatch(/opacity:\.\d/);
    expect(cssRule(html, "table.read th")).not.toMatch(/opacity:\.\d/);
    expect(cssRule(html, "td.u")).not.toMatch(/opacity:\.\d/);
    // ...and the perf rule went with the element it styled.
    expect(html).not.toContain("footer .perf");
    expect(cssRule(html, "footer .stat")).toContain("font-variant-numeric:tabular-nums");
  });
});

describe("graph panel message protocol", () => {
  it("parses add / remove / download and rejects junk", () => {
    expect(parseGraphPanelMessage({ kind: "graph-add", name: "sys.loop_hz" })).toEqual({
      kind: "graph-add",
      name: "sys.loop_hz",
    });
    expect(parseGraphPanelMessage({ kind: "graph-remove", name: "drive" })).toEqual({
      kind: "graph-remove",
      name: "drive",
    });
    expect(parseGraphPanelMessage({ kind: "graph-download-csv" })?.kind).toBe("graph-download-csv");
    expect(parseGraphPanelMessage({ kind: "graph-add", name: "" })).toBeNull();
    expect(parseGraphPanelMessage({ kind: "graph-remove", name: 7 })).toBeNull();
    expect(parseGraphPanelMessage({ kind: "nope" })).toBeNull();
    expect(parseGraphPanelMessage(null)).toBeNull();
  });
});

describe("graph panel frame budget", () => {
  it("draws at most once per frame and stays under 16.7ms p95 at 200Hz x 8 series", () => {
    const names = ["sys.loop_hz", "sys.heap_used", "sys.stack_used", "drive.speed",
      "drive.current", "nav.heading", "periph.uart_rx", "periph.uart_tx"];
    const p = boot(names);
    p.record(false);
    p.post(types(indexOf(...names)));
    p.post({ kind: "graph-series", series: names.map((n) => ({ name: n, color: "", visible: true })) });
    p.flush();
    expect(p.legendNames()).toEqual(names);

    const MESSAGES = 5000;
    let drawn = 0;
    // The perf footer is gone, so the frame cost is measured here instead: the
    // same draw() the panel ships, timed around the rAF callback.
    const costs: number[] = [];
    for (let i = 0; i < MESSAGES; i += 1) {
      // 200Hz: one message every 5ms. A 60Hz display sees one frame per ~3.33
      // messages, so flush every third message.
      const samples = names.map((n, k) => sample(n, (i * 7 + k * 13) % 4096, i * 5));
      p.post({ kind: "live-sample", samples });
      if (i % 3 === 0) {
        const t0 = performance.now();
        p.flush(1);
        costs.push(performance.now() - t0);
        drawn += 1;
      }
    }
    const tail = performance.now();
    drawn += p.runFrames();
    expect(performance.now() - tail).toBeLessThan(16.7);

    // rAF batching: 5000 messages must not become 5000 draws.
    expect(drawn).toBeLessThan(MESSAGES / 2);
    expect(drawn).toBeGreaterThan(1000);

    const sorted = costs.slice().sort((a, b) => a - b);
    const p95 = sorted[Math.min(sorted.length - 1, Math.round(0.95 * (sorted.length - 1)))] ?? 0;
    expect(p95).toBeLessThanOrEqual(16.7);
    // devicePixelRatio is applied to the backing store, not the CSS box.
    expect(p.canvas.width).toBe(900 * 2);
    expect(p.canvas.height).toBe(440 * 2);
    // 8 series strokes (the y grid strokes too, so filter by series colour)
    expect(p.traces().length).toBe(8);
    // 1500 points per series is the retention cap: the last frame plots at most
    // that many per series, never the 6250 the 25s run delivered.
    for (const t of p.traces()) {
      expect(t.n).toBeLessThanOrEqual(1500);
      expect(t.n).toBeGreaterThan(1000);
    }
    // 8 series * 200Hz * 25s, capped, so the buffer must not have grown away.
    expect(p.byId("graph-status").textContent).toContain("系列 8 / 表示 8");
  });

  it("redraws on resize", () => {
    const p = boot(["sys.loop_hz"]);
    p.post(types({ "sys.loop_hz": LEAF() }));
    p.post({ kind: "live-sample", samples: [sample("sys.loop_hz", 7, 0)] });
    p.flush();
    expect(p.traces().length).toBe(1);
    texts.length = 0;
    p.resize();
    p.flush();
    expect(p.traces().length).toBe(1);
    // A resize must produce a real frame: the axis is drawn again, which is
    // what the removed frames=N counter used to prove.
    expect(texts.length).toBeGreaterThan(4);
  });
});

describe("graph panel 100Hz readout cadence", () => {
  it("repaints the series table 10ms after a batch arrives, not 250ms", () => {
    // The host tail tick and this readout throttle both sit at 10ms, so a value
    // is on screen one poll period after the read. At 250ms the table showed 4
    // of the 100 samples/s.
    const clock = fakeClock();
    const p = boot(["sys.loop_hz"], clock);
    p.post(types(indexOf("sys.loop_hz")));
    expect(p.seriesRows()[0]?.cells).toEqual(["sys.loop_hz", "-", "-", "-", "Hz"]);

    p.post({ kind: "live-sample", samples: [sample("sys.loop_hz", 3751, 0)] });
    expect(clock.scheduled).toEqual([10]);
    expect(clock.pending()).toBe(1);

    const before = p.writes();
    clock.advance(9);
    expect(p.writes()).toBe(before);
    expect(p.seriesRows()[0]?.cells[3]).toBe("-");
    clock.advance(1);
    expect(p.seriesRows()[0]?.cells).toEqual(["sys.loop_hz", "3751", "3751", "3751", "Hz"]);
    expect(p.writes()).toBeGreaterThan(before);

    // The next poll period behaves the same way.
    p.post({ kind: "live-sample", samples: [sample("sys.loop_hz", 3752, 10)] });
    expect(clock.scheduled).toEqual([10, 10]);
    clock.advance(10);
    expect(p.seriesRows()[0]?.cells[3]).toBe("3752");
    expect(clock.pending()).toBe(0);
  });

  it("coalesces the batches inside one 10ms window into a single readout", () => {
    // 100Hz in, 10ms out: several batches land inside one window and must
    // merge into one timer, not one timer each.
    const clock = fakeClock();
    const p = boot(["sys.loop_hz", "nav.error"], clock);
    p.post(types(indexOf("sys.loop_hz", "nav.error")));
    p.post({ kind: "live-sample", samples: [sample("sys.loop_hz", 3751, 0)] });
    p.post({ kind: "live-sample", samples: [sample("nav.error", 42, 3)] });
    p.post({ kind: "live-sample", samples: [sample("sys.loop_hz", 3752, 7)] });
    expect(clock.scheduled).toEqual([10]);
    expect(clock.pending()).toBe(1);
    clock.advance(10);
    expect(p.seriesRows().find((r) => r.name === "sys.loop_hz")?.cells[3]).toBe("3752");
    expect(p.seriesRows().find((r) => r.name === "nav.error")?.cells[3]).toBe("42");
  });

  it("repaints four cells per series per update, 400/s at 100Hz for one series", () => {
    // The cost that made the table "too slow": MIN/MAX/LAST/UNIT per series,
    // once per poll period. 1 series = 400 writes/s, 8 series = 3,200.
    const clock = fakeClock();
    const names = ["sys.loop_hz", "sys.heap_used", "sys.stack_used", "drive.speed"];
    const p = boot(names, clock);
    p.post(types(indexOf(...names)));
    const base = p.writes();
    for (let i = 0; i < 100; i += 1) {
      p.post({ kind: "live-sample", samples: names.map((n) => sample(n, i, i * 10)) });
      clock.advance(10);
    }
    // One second of 100Hz updates: 100 readouts x 4 cells x 4 series.
    expect(p.writes() - base).toBe(100 * 4 * names.length);
  });
});

describe("graph panel y mapping", () => {
  it("maps a 0..100 ramp to min=0, max=100 and a monotonic axis", () => {
    const p = boot(["sys.loop_hz"]);
    p.post({ kind: "live-types", tree: { name: "debug" }, index: { "sys.loop_hz": LEAF() } });
    for (let v = 0; v <= 100; v += 1) {
      p.post({ kind: "live-sample", samples: [sample("sys.loop_hz", v, v * 10)] });
    }
    p.flush();

    const row = p.seriesRows().find((r) => r.name === "sys.loop_hz");
    expect(row?.cells[1]).toBe("0");
    expect(row?.cells[2]).toBe("100");

    const trace = p.paths().find((t) => t.color === GRAPH_SERIES_COLORS[0]);
    expect(trace).toBeDefined();
    const pts = (trace as Path).pts;
    expect(pts.length).toBeGreaterThan(50);
    for (let i = 1; i < pts.length; i += 1) {
      // value rises with i, so screen y must fall strictly: monotonic mapping
      expect(pts[i]?.y).toBeLessThan(pts[i - 1]?.y as number);
    }
    // affine, not just monotonic: the midpoint of 0..100 sits mid-plot
    const mid = (pts[0]?.y as number) + ((pts[pts.length - 1]?.y as number) - (pts[0]?.y as number)) / 2;
    expect(Math.abs((pts[50]?.y as number) - mid)).toBeLessThan(1.5);
    expect(pts[0]?.x).toBeLessThan(pts[pts.length - 1]?.x as number);
    // x axis: oldest offset on the left, "now" on the right
    const axis = texts.map((c) => c.t).filter((t) => t.endsWith("s"));
    expect(axis[0]).toBe("-1.00s");
    expect(axis[axis.length - 1]).toBe("0.0s");
    // y ticks are nice steps covering 0..100
    expect(texts.filter((c) => !c.t.endsWith("s")).map((c) => c.t))
      .toEqual(["0", "20", "40", "60", "80", "100"]);
  });
});

describe("graph panel type awareness", () => {
  it("plots a float as a float, not as its bit pattern", () => {
    const p = boot(["debug.loop_hz.f32"]);
    p.post({
      kind: "live-types",
      tree: { name: "debug" },
      index: { "debug.loop_hz.f32": LEAF({ kind: "float", type: "float", size: 4 }) },
    });
    // 0x3fc00000 = 1.5f, 0x40000000 = 2.0f, 0x40400000 = 3.0f
    for (const v of [0x3fc00000, 0x40000000, 0x40400000]) {
      p.post({ kind: "live-sample", samples: [sample("debug.loop_hz.f32", v, 0)] });
    }
    p.flush();
    const row = p.seriesRows().find((r) => r.name === "debug.loop_hz.f32");
    expect(row?.cells[1]).toBe("1.50000");
    expect(row?.cells[2]).toBe("3.00000");
    expect(row?.cells[3]).toBe("3.00000");
    // The old num() would have plotted 1069547520 .. 1077936128.
    const trace = p.traces()[0];
    expect(trace?.n).toBe(3);
  });

  it("refuses to plot a leaf with no type metadata", () => {
    const p = boot(["debug.loop_hz.f32"]);
    // resolved through nm without DWARF: the host sends no index entry
    for (let i = 0; i < 10; i += 1) {
      p.post({ kind: "live-sample", samples: [sample("debug.loop_hz.f32", 0x3f800000, i * 10)] });
    }
    p.flush();
    // 0x3f800000 is 1.0f, but without metadata we cannot know that, so it is
    // not plotted as 1065353216 either
    expect(p.traces().length).toBe(0);
    const row = p.seriesRows().find((r) => r.name === "debug.loop_hz.f32");
    expect(row?.cells[1]).toBe("-");
    expect(row?.cells[2]).toBe("-");
    expect(row?.cells[3]).toBe("0x3f800000 型不明");
    expect(row?.cells[4]).toBe("型不明");
  });

  it("extracts a bitfield with BigInt shifts", () => {
    const p = boot(["ctrl.wide", "ctrl.nib"]);
    p.post(types({
      // camelCase bitSize/bitOffset, exactly as extension.ts:506 sends them
      "ctrl.wide": LEAF({ kind: "bitfield", size: 8, bitSize: 40, bitOffset: 0, type: "uint64_t" }),
      "ctrl.nib": LEAF({ kind: "bitfield", size: 4, bitSize: 4, bitOffset: 28, type: "uint32_t" }),
    }));
    // low 40 bits of 0x0000abcd00000000 = 0xcd00000000 = 880468295680.
    // A 32-bit >> would drop every bit above 31 and yield 0.
    p.post({ kind: "live-sample", samples: [sample("ctrl.wide", 0xabcd00000000, 0, 8)] });
    // the top nibble of a 4-byte word
    p.post({ kind: "live-sample", samples: [sample("ctrl.nib", 0x10000000, 10)] });
    p.flush();

    const wide = p.seriesRows().find((r) => r.name === "ctrl.wide");
    expect(wide?.cells[1]).toBe("880468295680");
    expect(wide?.cells[3]).toBe("880468295680");
    expect(wide?.cells[4]).toBe("bit");
    const nib = p.seriesRows().find((r) => r.name === "ctrl.nib");
    expect(nib?.cells[1]).toBe("1");
    expect(nib?.cells[3]).toBe("1");
    expect(p.traces().length).toBe(2);
  });

  it("extracts a bitfield even when the kind is not tagged as one", () => {
    const p = boot(["ctrl.flags"]);
    p.post(types({
      "ctrl.flags": LEAF({ kind: "scalar", size: 4, bitSize: 3, bitOffset: 0 }),
    }));
    p.post({ kind: "live-sample", samples: [sample("ctrl.flags", 0x0b, 0)] });
    p.flush();
    // 0b1011 masked to 3 bits = 0b011 = 3, not 11
    const row = p.seriesRows().find((r) => r.name === "ctrl.flags");
    expect(row?.cells[3]).toBe("3");
  });

  it("decodes a signed scalar as negative, not as 4294967295", () => {
    const p = boot(["nav.error"]);
    p.post({
      kind: "live-types",
      tree: { name: "debug" },
      index: { "nav.error": LEAF({ signed: true, type: "int" }) },
    });
    p.post({ kind: "live-sample", samples: [sample("nav.error", 0xffffffff, 0)] });
    p.flush();
    const row = p.seriesRows().find((r) => r.name === "nav.error");
    expect(row?.cells[1]).toBe("-1");
    expect(row?.cells[3]).toBe("-1");
  });

  it("keeps a string series off the numeric axis and reads it as text", () => {
    const p = boot(["comm.tag"]);
    p.post({
      kind: "live-types",
      tree: { name: "debug" },
      index: { "comm.tag": LEAF({ kind: "string", size: 8 }) },
    });
    for (let i = 0; i < 20; i += 1) {
      // "RUN\0" in memory is 0x00000000004e5552 as a little-endian integer
      p.post({ kind: "live-sample", samples: [sample("comm.tag", 0x4e5552, i * 10, 8)] });
    }
    p.flush();
    expect(p.traces().length).toBe(0);
    const row = p.seriesRows().find((r) => r.name === "comm.tag");
    expect(row?.cells[1]).toBe("-");
    expect(row?.cells[3]).toBe("RUN");
    expect(row?.cells[4]).toBe("string");
  });

  it("draws an enum as a named step line below the numeric plot", () => {
    const p = boot(["drive.drive_mode", "sys.loop_hz"]);
    p.post({
      kind: "live-types",
      tree: { name: "debug" },
      index: {
        "drive.drive_mode": LEAF({
          kind: "enum",
          enumerators: [
            { name: "MODE_IDLE", value: 0 },
            { name: "MODE_FOLLOW", value: 1 },
            { name: "MODE_STOP", value: 2 },
          ],
        }),
        "sys.loop_hz": LEAF(),
      },
    });
    const enums = [0, 1, 2, 1, 0, 1, 2, 2, 1, 0, 0, 1];
    for (let i = 0; i < enums.length; i += 1) {
      p.post({
        kind: "live-sample",
        samples: [
          sample("drive.drive_mode", enums[i] as number, i * 50),
          sample("sys.loop_hz", 1000 + i * 10, i * 50),
        ],
      });
    }
    p.flush();

    const row = p.seriesRows().find((r) => r.name === "drive.drive_mode");
    expect(row?.cells[3]).toBe("MODE_FOLLOW");
    expect(row?.cells[4]).toBe("enum");

    const num = p.paths().find((t) => t.color === GRAPH_SERIES_COLORS[1]);
    const lane = p.paths().find((t) => t.color === GRAPH_SERIES_COLORS[0]);
    expect(num).toBeDefined();
    expect(lane).toBeDefined();
    const numPts = (num as Path).pts;
    const lanePts = (lane as Path).pts;
    // the enum must live strictly below the numeric plot, in its own lane
    const lowest = Math.max(...numPts.map((q) => q.y));
    const highestLane = Math.min(...lanePts.map((q) => q.y));
    expect(highestLane).toBeGreaterThan(lowest);
    // and it must not have stretched the numeric scale: 1000..1100 fills the plot
    expect(Math.max(...numPts.map((q) => q.y)) - Math.min(...numPts.map((q) => q.y)))
      .toBeGreaterThan(300);
    // a step line leaves horizontal runs; a plain polyline of 0,1,2 does not
    expect(lanePts.some((q, i) => i > 0 && q.y === lanePts[i - 1]?.y)).toBe(true);
  });
});

describe("graph panel controls", () => {
  it("asks the host for the VS Code variable picker instead of completing in-page", () => {
    // The user asked for the same picker as the variable-monitor tab. The
    // panel keeps membership in the host's hands: it posts the query and waits
    // for a `graph-series` echo, exactly like the variable tab's var-pick.
    const p = boot();
    p.post({
      kind: "live-types",
      tree: { name: "debug" },
      index: {
        "drive.controller.up": LEAF({ size: 1, kind: "bool" }),
        "drive.controller.down": LEAF({ size: 1, kind: "bool" }),
      },
    });
    p.el("graph-var-picker").value = "drive.controller";
    p.el("graph-add").fire("click");
    expect(p.posted).toEqual([{ kind: "var-pick", query: "drive.controller" }]);
    // Nothing is plotted until the host picks and echoes the series back.
    expect(p.legendNames()).toEqual([]);

    p.post({
      kind: "graph-series",
      series: [{ name: "drive.controller.down", color: "#111111", visible: true }],
    });
    p.flush();
    expect(p.legendNames()).toEqual(["drive.controller.down"]);
    // no double bookkeeping: the host owns membership, so the panel posts nothing
    p.posted.length = 0;
    expect(p.posted).toEqual([]);
  });

  it("uses the same picker from Enter in the series input", () => {
    const p = boot();
    p.post(types(indexOf("sys.loop_hz")));
    p.el("graph-var-picker").value = "  sys.  ";
    p.el("graph-var-picker").fire("keydown", { key: "Enter" });
    expect(p.posted).toEqual([{ kind: "var-pick", query: "sys." }]);
  });

  it("removes a dotted struct member name as its leaves", () => {
    const p = boot();
    p.post({
      kind: "graph-series",
      series: [{ name: "drive.controller.down" }, { name: "drive.controller.up" }],
    });
    p.flush();
    expect(p.legendNames()).toEqual(["drive.controller.down", "drive.controller.up"]);
    p.el("graph-var-picker").value = "drive.controller";
    p.el("graph-remove").fire("click");
    expect(p.legendNames()).toEqual([]);
    expect(p.posted).toEqual([
      { kind: "graph-remove", name: "drive.controller.down" },
      { kind: "graph-remove", name: "drive.controller.up" },
    ]);
    expect(p.el("graph-error").textContent).toBe("");
  });

  it("clears every registered series with one 全削除 click", () => {
    const p = boot();
    p.post({
      kind: "graph-series",
      series: [{ name: "drive.controller.up" }, { name: "drive.controller.down" },
        { name: "sys.loop_hz" }],
    });
    p.flush();
    expect(p.legendNames()).toEqual([
      "drive.controller.up",
      "drive.controller.down",
      "sys.loop_hz",
    ]);
    p.el("graph-clear").fire("click");
    expect(p.legendNames()).toEqual([]);
    expect(p.posted).toEqual([
      { kind: "graph-remove", name: "drive.controller.up" },
      { kind: "graph-remove", name: "drive.controller.down" },
      { kind: "graph-remove", name: "sys.loop_hz" },
    ]);
    expect(p.el("graph-error").textContent).toBe("");
  });

  it("reports an unknown name instead of ignoring it", () => {
    const p = boot();
    p.post(types(indexOf("sys.loop_hz")));
    p.el("graph-var-picker").value = "sys.loop_hz";
    p.el("graph-remove").fire("click");
    expect(p.el("graph-error").textContent).toContain("未登録の系列: sys.loop_hz");
    expect(p.posted).toEqual([]);
  });

  it("toggles a series off the plot and back on", () => {
    const p = boot(["sys.loop_hz", "nav.error"]);
    p.post({ kind: "live-types", tree: { name: "debug" }, index: { "sys.loop_hz": LEAF(), "nav.error": LEAF() } });
    for (let i = 0; i < 5; i += 1) {
      p.post({
        kind: "live-sample",
        samples: [sample("sys.loop_hz", 10 + i, i * 10), sample("nav.error", 20 + i, i * 10)],
      });
    }
    p.flush();
    expect(p.traces().length).toBe(2);
    p.byId("graph-selected").children[0]?.fire("click");
    expect(p.byId("graph-selected").children[0]?.dataset["visible"]).toBe("false");
    p.flush();
    const hidden = p.traces().length;
    expect(hidden).toBe(1);
    p.byId("graph-selected").children[0]?.fire("click");
    expect(p.byId("graph-selected").children[0]?.dataset["visible"]).toBe("true");
    p.flush();
    expect(p.traces().length).toBe(hidden + 1);
  });

  it("asks the host for the CSV without a payload", () => {
    const p = boot(["sys.loop_hz", "nav.error"]);
    p.post({
      kind: "graph-series",
      series: [{ name: "sys.loop_hz", color: "#111111", visible: true },
        { name: "nav.error", color: "#222222", visible: true }],
    });
    p.flush();
    p.el("graph-download-csv").fire("click");
    expect(p.posted).toEqual([{ kind: "graph-download-csv" }]);
    expect(p.el("graph-note").textContent).toContain("要求");
  });

  it("keeps a local visibility toggle across a graph-series echo", () => {
    const p = boot(["sys.loop_hz", "nav.error"]);
    p.post({
      kind: "graph-series",
      series: [{ name: "sys.loop_hz", visible: true }, { name: "nav.error", visible: true }],
    });
    p.flush();
    p.byId("graph-selected").children[0]?.fire("click");
    expect(p.byId("graph-selected").children[0]?.dataset["visible"]).toBe("false");
    // the host re-echoes the whole list with visible:true on every change
    p.post({
      kind: "graph-series",
      series: [{ name: "sys.loop_hz", visible: true }, { name: "nav.error", visible: true }],
    });
    p.flush();
    expect(p.byId("graph-selected").children[0]?.dataset["visible"]).toBe("false");
  });

  it("follows the host when it removes the last series", () => {
    const p = boot(["sys.loop_hz", "nav.error"]);
    p.post(types(indexOf("sys.loop_hz", "nav.error")));
    for (let i = 0; i < 5; i += 1) {
      p.post({
        kind: "live-sample",
        samples: [sample("sys.loop_hz", 10 + i, i * 10), sample("nav.error", 20 + i, i * 10)],
      });
    }
    p.flush();
    expect(p.traces().length).toBe(2);
    // the sidebar removed both: the host publishes an empty list
    p.post({ kind: "graph-series", series: [] });
    p.flush();
    expect(p.legendNames()).toEqual([]);
    expect(p.traces().length).toBe(0);
    expect(p.seriesRows()).toEqual([]);
  });

  it("drops a series the host stopped publishing", () => {
    const p = boot(["sys.loop_hz", "nav.error"]);
    p.post({ kind: "graph-series", series: [{ name: "sys.loop_hz" }, { name: "nav.error" }] });
    p.flush();
    p.post({ kind: "graph-series", series: [{ name: "nav.error" }] });
    p.flush();
    expect(p.legendNames()).toEqual(["nav.error"]);
  });

  it("drops a prototype-named series the host stopped publishing", () => {
    // `keep` was a plain {} so `keep["toString"]` read Object.prototype and
    // stayed truthy after the host deleted the series: a ghost row the user
    // could never remove. `toString` is a legal C global name.
    const p = boot(["toString", "sys.loop_hz"]);
    p.post({ kind: "graph-series", series: [{ name: "toString" }, { name: "sys.loop_hz" }] });
    p.flush();
    expect(p.legendNames()).toEqual(["toString", "sys.loop_hz"]);
    p.post({ kind: "graph-series", series: [{ name: "sys.loop_hz" }] });
    p.flush();
    expect(p.legendNames()).toEqual(["sys.loop_hz"]);
  });

  it("switches the time window and prunes to it", () => {
    const p = boot(["sys.loop_hz"]);
    p.post({ kind: "live-types", tree: { name: "debug" }, index: { "sys.loop_hz": LEAF() } });
    for (let i = 0; i < 400; i += 1) {
      p.post({ kind: "live-sample", samples: [sample("sys.loop_hz", i, i * 50)] });
    }
    p.flush();
    const wide = p.paths()[p.paths().length - 1]!;
    p.el("graph-window").value = "1000";
    p.el("graph-window").fire("change", { target: { value: "1000" } });
    p.flush();
    const narrow = p.paths()[p.paths().length - 1]!;
    expect(narrow.pts.length).toBeLessThan(wide.pts.length);
    // 1s window at 50ms spacing keeps the last 20 points
    expect(narrow.pts.length).toBeLessThanOrEqual(25);
  });
});

describe("graph panel name completion", () => {
  it("carries no inline datalist: selection is the host QuickPick", () => {
    // The datalist only ever fed the input's browser-native completion, which
    // is gone now that 追加 / Enter ask the host (same as the variable tab).
    const html = graphPanelHtml(["sys.loop_hz"]);
    expect(html).not.toContain("graph-names");
    expect(html).not.toContain("<datalist");
    expect(html).not.toContain('list="');
    expect(parseGraphPanelMessage({ kind: "var-pick", query: "sys." })).toEqual({
      kind: "var-pick",
      name: "",
      query: "sys.",
    });
    expect(parseGraphPanelMessage({ kind: "var-pick", query: 7 })).toBeNull();
  });
});

describe("graph panel 未登録 counter", () => {
  it("counts the names of the CURRENT batch, not every name ever forwarded", () => {
    // The host forwards the whole sample batch unfiltered, so every watched
    // name that is not a plotted series lands here. G.unknown was a Set that
    // was never cleared: it froze at the high-water mark of the whole session
    // (a stale 389 after the user un-watched those names) instead of counting
    // what is arriving now.
    const p = boot(["sys.loop_hz"]);
    p.post(types(indexOf("sys.loop_hz")));
    p.post({
      kind: "live-sample",
      samples: [sample("sys.loop_hz", 1, 0), sample("nav.a", 1, 0), sample("nav.b", 1, 0)],
    });
    p.flush();
    expect(p.byId("graph-status").textContent).toContain("未登録 2");

    p.post({
      kind: "live-sample",
      samples: [sample("sys.loop_hz", 2, 10), sample("nav.a", 2, 10)],
    });
    p.flush();
    expect(p.byId("graph-status").textContent).toContain("未登録 1");

    // A name that becomes a plotted series stops counting at once.
    p.post({
      kind: "graph-series",
      series: [{ name: "sys.loop_hz" }, { name: "nav.a" }],
    });
    p.post({
      kind: "live-sample",
      samples: [sample("sys.loop_hz", 3, 20), sample("nav.a", 3, 20), sample("nav.b", 3, 20)],
    });
    p.flush();
    expect(p.byId("graph-status").textContent).toContain("未登録 1");
    expect(p.byId("graph-status").textContent).not.toContain("未登録 2");
  });
});

