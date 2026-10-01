// Variable panel acceptance: values must track the sample stream.
//
// Harness mirrors tests/graph-panel.test.ts: the shipped inlined VAR_SCRIPT
// is executed for real in a node:vm with a stub DOM, then driven with the
// EXACT message sequence the host sends on panel open + live ticks:
//
//   mount(webview) with NO watched-list argument  (openVariablePanel,
//   src/extension.ts ~2873: `mountVariablePanel(panel.webview)`)
//   -> live-types                                 (addTypeTarget -> sendTypesTo)
//   -> live-status                                (sendTypesTo also posts this)
//   -> live-watchlist                             (post() forwards to typeTargets)
//   -> live-sample {0x00000ea7}                   (pushVariableSamples via sink)
//   -> live-sample {0x00000ea8}                   (next tick, value changed)
//
// LiveSample shape follows src/live/poller.ts: value is a lowercase 0x-hex
// string sized to the member width ("0x00000ea7" for a 4-byte leaf).
import { describe, expect, it } from "vitest";
import { Script } from "node:vm";
import {
  variablePanelHtml,
  parseVariablePanelMessage,
} from "../src/live/variablePanel.js";
import { CSV_HEADER } from "../src/live/poller.js";

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
  // Same contract as graph-panel.test.ts: the stub builds these members, so
  // the interface must carry them instead of hiding them behind a cast.
  _text: string;
  appendChild(c: StubEl): StubEl;
  removeChild(c: StubEl): StubEl;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  addEventListener(t: string, f: (ev: unknown) => void): void;
  fire(t: string, ev?: unknown): void;
}

function makeEl(tag: string): StubEl {
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
  };
  Object.defineProperty(el, "_text", { value: "", writable: true });
  return el;
}

interface Panel {
  post(data: unknown): void;
  posted: { kind: string; name?: string; value?: string }[];
  /** Value-cell text for a row, or undefined when the row is missing. */
  valueOf(name: string): string | undefined;
  rowNames(): string[];
  el(testid: string): StubEl;
}

/**
 * Hand-driven setTimeout. The panel throttles its repaint with setTimeout, and
 * a real timer would make the cadence assertions either flaky or slow, so the
 * tests own the clock: advance(ms) runs exactly the callbacks due within that
 * window, oldest deadline first (ties broken by scheduling order), which is
 * what the real event loop does.
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
    throw new Error("variable panel html has no inline script");
  }
  return m[1] ?? "";
}

/**
 * `clock` installs a fake setTimeout so the repaint throttle is observable.
 * Without it the vm has no setTimeout at all and the shipped
 * `typeof setTimeout !== 'function'` fallback paints synchronously — which is
 * what every other test in this file exercises.
 */
function boot(
  watched: readonly string[] = [],
  stripTestid?: string,
  clock?: FakeClockImpl,
): Panel {
  // mount(webview) is called with NO watched-list argument, so the default
  // seed ([]) is what the product boots with.
  const html = variablePanelHtml(watched);
  const byId = new Map<string, StubEl>();
  const markup = html.replace(/<script>[\s\S]*?<\/script>/g, "");
  const re = /<(\w+)[^>]*?data-testid="([^"]+)"[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markup)) !== null) {
    byId.set(m[2] ?? "", makeEl(m[1] ?? "div"));
  }
  for (const id of [
    "var-picker", "var-add", "var-remove", "var-search", "var-error",
    "var-note", "var-table", "var-rows", "var-status",
    "var-csv-schema",
  ]) {
    if (!byId.has(id)) {
      throw new Error(`variable panel html is missing data-testid="${id}"`);
    }
  }
  // Simulate renderer drift (the script header warns HTML and script share
  // one owner and can drift apart): one control absent, the rest must still
  // register. An unguarded querySelector(...).addEventListener throws here
  // and silently kills seed/rebuild plus every later-registered handler.
  if (stripTestid !== undefined) {
    byId.delete(stripTestid);
  }

  const posted: { kind: string; name?: string; value?: string }[] = [];
  const winHandlers: Record<string, ((ev: unknown) => void)[]> = {};

  const document = {
    body: makeEl("body"),
    createElement: (t: string): StubEl => makeEl(t),
    createTextNode: (t: string): StubEl => {
      const el = makeEl("#text");
      (el as unknown as { _text: string })._text = String(t);
      return el;
    },
    querySelector(sel: string): StubEl | null {
      const hit = /^\[data-testid="(.+)"\]$/.exec(sel);
      return hit === null ? null : byId.get(hit[1] ?? "") ?? null;
    },
    querySelectorAll: (): StubEl[] => [],
  };

  const sandbox = {
    document,
    acquireVsCodeApi: () => ({ postMessage: (msg: { kind: string }) => posted.push(msg) }),
    // a webview global, not an ECMAScript built-in, so the vm must supply it
    TextDecoder,
    console,
    ...(clock === undefined ? {} : { setTimeout: clock.setTimeout }),
  };
  const windowStub = {
    addEventListener(t: string, f: (ev: unknown) => void): void {
      (winHandlers[t] ??= []).push(f);
    },
  };
  new Script(scriptOf(html)).runInNewContext({ ...sandbox, window: windowStub });

  const rows = (): StubEl[] => byId.get("var-rows")!.children;
  const rowFor = (name: string): StubEl | undefined =>
    rows().find((tr) => tr.getAttribute("data-name") === name);

  return {
    posted,
    post(data: unknown): void {
      for (const f of winHandlers["message"] ?? []) {
        f({ data });
      }
    },
    valueOf(name: string): string | undefined {
      const tr = rowFor(name);
      return tr === undefined ? undefined : tr.children[1]?.textContent;
    },
    rowNames(): string[] {
      return rows().map((tr) => tr.getAttribute("data-name") ?? "");
    },
    el: (testid: string): StubEl => byId.get(testid) as StubEl,
  };
}

const T0 = Date.parse("2026-09-28T01:22:52.037Z");

/** One CSV row -> LiveSample, exactly as readNewSamples builds it. */
function sample(name: string, hexValue: string, ms: number): {
  timestamp: string;
  address: string;
  name: string;
  value: string;
} {
  return {
    timestamp: new Date(T0 + ms).toISOString(),
    address: "0x20000104",
    name,
    value: hexValue,
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

describe("variable panel surface", () => {
  it("is a self-contained document whose script parses", () => {
    const html = variablePanelHtml();
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain(CSV_HEADER);
    expect(html).toContain('data-testid="var-csv-schema"');
    expect(() => new Script(scriptOf(html))).not.toThrow();
  });

  it("parses var-add / var-remove / var-write and rejects junk", () => {
    expect(parseVariablePanelMessage({ kind: "var-add", name: "sys.loop_hz" })).toEqual({
      kind: "var-add",
      name: "sys.loop_hz",
      value: "",
    });
    expect(parseVariablePanelMessage({ kind: "var-remove", name: "sys.loop_hz" })).toEqual({
      kind: "var-remove",
      name: "sys.loop_hz",
      value: "",
    });
    expect(parseVariablePanelMessage({ kind: "var-write", name: "sys.loop_hz", value: "42" })).toEqual({
      kind: "var-write",
      name: "sys.loop_hz",
      value: "42",
    });
    expect(parseVariablePanelMessage({ kind: "var-add", name: "" })).toBeNull();
    expect(parseVariablePanelMessage({ kind: "var-write", name: "sys.loop_hz", value: "" })).toBeNull();
    expect(parseVariablePanelMessage({ kind: "var-pick", query: "sys." })).toEqual({
      kind: "var-pick",
      name: "",
      value: "",
      query: "sys.",
    });
    expect(parseVariablePanelMessage({ kind: "var-pick", query: 7 })).toBeNull();
    expect(parseVariablePanelMessage({ kind: "nope" })).toBeNull();
    expect(parseVariablePanelMessage(null)).toBeNull();
  });

  it("the 追加 button asks the host QuickPick instead of completing inline", () => {
    const p = boot();
    p.post(types({ "sys.loop_hz": LEAF() }));
    p.post({ kind: "live-watchlist", names: [] });
    p.el("var-picker").value = "sys.";
    p.el("var-add").fire("click");
    expect(p.posted).toEqual([{ kind: "var-pick", query: "sys." }]);
  });
});

describe("variable panel live values", () => {
  it("hides compiler and libc noise (_Z mangled, __ internals) from the auto list", () => {
    const p = boot();
    p.post(types({
      "sys.loop_hz": LEAF(),
      "_ZN10__cxxabiv119__terminate_handlerE": LEAF(),
      __sf: LEAF(),
      "_impure_ptr.data._errno": LEAF(),
    }));
    p.post({ kind: "live-watchlist", names: [] });
    expect(p.rowNames()).toEqual(["sys", "sys.loop_hz"]);
    expect(p.valueOf("sys")).toBe("1件");
  });

  it("renders a struct group as a counted row that filters to its leaves on click", () => {
    const p = boot();
    p.post(types({
      "debug.target_transform.vx": LEAF(),
      "debug.target_transform.vy": LEAF(),
    }));
    p.post({ kind: "live-watchlist", names: [] });
    expect(p.rowNames()).toEqual(["debug", "debug.target_transform", "debug.target_transform.vx", "debug.target_transform.vy"]);
    expect(p.valueOf("debug")).toBe("2件");
    expect(p.valueOf("debug.target_transform")).toBe("2件");
  });

  it("creates a row for every watched name before the first sample batch", () => {
    const p = boot();
    p.post(types({ "sys.loop_hz": LEAF() }));
    p.post({ kind: "live-watchlist", names: ["sys.loop_hz"] });
    // No sample has arrived: the row must already exist with a placeholder,
    // never a missing row or a blank value cell.
    expect(p.rowNames()).toEqual(["sys.loop_hz", "sys"]);
    expect(p.valueOf("sys.loop_hz")).toBe("-");
    expect(p.valueOf("sys")).toBe("1件");
  });

  it("creates a row even for a watched name that collides with Object.prototype", () => {
    // Membership used to be plain objects ({}), so `constructor` / `toString`
    // / `valueOf` read back inherited members, looked "already registered",
    // and never reached V.order: a registered variable with no row at all.
    // The graph panel fixed the same class with a Set (graphPanel.ts); this
    // panel never got the fix. `constructor` is a legal C global name.
    const p = boot();
    p.post(types({ constructor: LEAF(), "sys.loop_hz": LEAF() }));
    p.post({ kind: "live-watchlist", names: ["sys.loop_hz", "constructor"] });
    expect(p.rowNames()).toEqual(["sys.loop_hz", "constructor", "sys"]);
    expect(p.valueOf("constructor")).toBe("-");
  });

  it("removing one group member keeps an unrelated prototype-named row", () => {
    // `drop` was a plain {} so `drop["toString"]` read Object.prototype and
    // was truthy: removing "grp.myvar" stripped the unrelated "toString" row
    // from V.order while V.watched still held it, desyncing the two.
    const p = boot();
    p.post(types({ "grp.myvar": LEAF(), "toString": LEAF() }));
    p.post({ kind: "live-watchlist", names: ["grp.myvar", "toString"] });
    expect(p.rowNames()).toContain("toString");
    p.el("var-picker").value = "myvar";
    p.el("var-remove").fire("click");
    expect(p.posted).toEqual([{ kind: "var-remove", name: "grp.myvar" }]);
    expect(p.rowNames()).toContain("toString");
    expect(watchedOf(p, "toString")).toBe("1");
  });

  it("changes the value cell when the next batch carries a new value", () => {
    const p = boot();
    // Exact host order: mount (seed []) -> addTypeTarget (live-types +
    // live-status) -> watchlist forward -> sample batches via the sink.
    // `constructor` rides along: a prototype-colliding name must track the
    // wire exactly like an ordinary one.
    p.post(types({ "sys.loop_hz": LEAF(), constructor: LEAF() }));
    p.post({ kind: "live-status", state: "running", text: "監視中" });
    p.post({ kind: "live-watchlist", names: ["sys.loop_hz", "constructor"] });
    p.post({
      kind: "live-sample",
      samples: [
        sample("sys.loop_hz", "0x00000ea7", 0),
        sample("constructor", "0x00000ea7", 0),
      ],
    });
    const first = p.valueOf("sys.loop_hz");
    expect(first).toBe("3751");
    expect(p.valueOf("constructor")).toBe("3751");

    // The sidecar reports 0x0ea8 on the next tick: the cells must follow.
    p.post({
      kind: "live-sample",
      samples: [
        sample("sys.loop_hz", "0x00000ea8", 10),
        sample("constructor", "0x00000ea8", 10),
      ],
    });
    const second = p.valueOf("sys.loop_hz");
    expect(second).toBe("3752");
    expect(second).not.toBe(first);
    expect(p.valueOf("constructor")).toBe("3752");
  });

  it("keeps the last known value when a batch carries no sample for the row", () => {
    const p = boot();
    p.post(types({ "sys.loop_hz": LEAF(), "sys.uptime": LEAF() }));
    p.post({ kind: "live-watchlist", names: ["sys.loop_hz", "sys.uptime"] });
    p.post({ kind: "live-sample", samples: [sample("sys.loop_hz", "0x00000ea7", 0)] });
    expect(p.valueOf("sys.loop_hz")).toBe("3751");
    expect(p.valueOf("sys.uptime")).toBe("-");
    // A batch with only the other variable must not blank this row.
    p.post({ kind: "live-sample", samples: [sample("sys.uptime", "0x0000002a", 10)] });
    expect(p.valueOf("sys.loop_hz")).toBe("3751");
    expect(p.valueOf("sys.uptime")).toBe("42");
  });

  it("survives one missing control: the rest of registration still runs", () => {
    // The 追加 button is absent (renderer drift). Booting must not throw,
    // and everything registered after it — removal wiring, seed, rebuild,
    // and the message pipeline — must keep working.
    const p = boot([], "var-add");
    p.post(types({ "sys.loop_hz": LEAF() }));
    p.post({ kind: "live-watchlist", names: ["sys.loop_hz"] });
    expect(p.rowNames()).toEqual(["sys.loop_hz", "sys"]);
    p.post({ kind: "live-sample", samples: [sample("sys.loop_hz", "0x00000ea7", 0)] });
    expect(p.valueOf("sys.loop_hz")).toBe("3751");
    p.post({ kind: "live-sample", samples: [sample("sys.loop_hz", "0x00000ea8", 10)] });
    expect(p.valueOf("sys.loop_hz")).toBe("3752");
    // The surviving 削除 button is wired: clicking it posts var-remove.
    // The row stays visible as an unwatched type leaf (union membership):
    // var-remove only leaves the watchlist, it never deletes the row.
    p.el("var-picker").value = "sys.loop_hz";
    p.el("var-remove").fire("click");
    expect(p.posted).toEqual([{ kind: "var-remove", name: "sys.loop_hz" }]);
    expect(p.rowNames()).toEqual(["sys", "sys.loop_hz"]);
    expect(watchedOf(p, "sys.loop_hz")).toBe("0");
  });

  it("lists every live-types leaf even with no live-watchlist at all", () => {
    const p = boot();
    p.post(types({ "sys.c": LEAF(), "sys.a": LEAF(), "sys.b": LEAF() }));
    expect(p.rowNames()).toEqual(["sys", "sys.a", "sys.b", "sys.c"]);
    expect(p.valueOf("sys.a")).toBe("-");
    expect(p.valueOf("sys.b")).toBe("-");
    expect(p.valueOf("sys.c")).toBe("-");
    expect(watchedOf(p, "sys.a")).toBe("0");
  });

  it("orders watched names first, marks them, and keeps unwatched rows searchable", () => {
    const p = boot();
    p.post(types({ "sys.c": LEAF(), "sys.a": LEAF(), "sys.b": LEAF() }));
    p.post({ kind: "live-watchlist", names: ["sys.c"] });
    expect(p.rowNames()).toEqual(["sys.c", "sys", "sys.a", "sys.b"]);
    expect(watchedOf(p, "sys.c")).toBe("1");
    expect(watchedOf(p, "sys.a")).toBe("0");
    expect(watchedOf(p, "sys.b")).toBe("0");
    // Search filters but never deletes: the unwatched rows are still there.
    p.el("var-search").value = "sys.a";
    p.el("var-search").fire("input");
    expect(p.rowNames()).toEqual(["sys.c", "sys", "sys.a", "sys.b"]);
    expect(hiddenOf(p, "sys.a")).toBe("0");
    expect(hiddenOf(p, "sys.c")).toBe("1");
  });

  it("a live-drop message never changes the watchlist row set", () => {
    const p = boot();
    p.post(types({ "sys.c": LEAF(), "sys.a": LEAF(), "sys.b": LEAF() }));
    p.post({ kind: "live-watchlist", names: ["sys.c"] });
    const before = p.rowNames();
    p.post({ kind: "live-drop", summary: "sys.c を除外しました" });
    expect(p.rowNames()).toEqual(before);
    expect(p.valueOf("sys.c")).toBe("-");
  });

  it("a live-watchlist-note surfaces as a status note without touching rows", () => {
    const p = boot();
    p.post(types({ "sys.c": LEAF(), "sys.a": LEAF(), "sys.b": LEAF() }));
    p.post({ kind: "live-watchlist", names: ["sys.c"] });
    const before = p.rowNames();
    p.post({ kind: "live-watchlist-note", summary: "sys.c を除外しました (1 件)" });
    expect(p.rowNames()).toEqual(before);
    expect(p.el("var-note").textContent).toContain("を除外しました");
  });

  it("lists catalog rows from the index when tree is null (catalog-only resolution)", () => {
    // A catalog-only body has tree: null and flat RAM-catalog leaves in the
    // index. The row set is driven by the index, so a null tree must still
    // render every leaf — watched first, then the rest sorted.
    const p = boot();
    p.post({
      kind: "live-types",
      tree: null,
      index: { counter: LEAF(), flag: LEAF({ kind: "bool", size: 1, type: "bool" }) },
    });
    p.post({ kind: "live-watchlist", names: ["counter"] });
    expect(p.rowNames()).toEqual(["counter", "flag"]);
    expect(p.valueOf("counter")).toBe("-");
    expect(p.valueOf("flag")).toBe("-");
    p.post({ kind: "live-sample", samples: [sample("counter", "0x0000002a", 0)] });
    expect(p.valueOf("counter")).toBe("42");
    expect(p.valueOf("flag")).toBe("-");
  });
});

function rowTr(p: Panel, name: string): StubEl {
  const tr = p.el("var-rows").children.find((r) => r.getAttribute("data-name") === name);
  if (tr === undefined) {
    throw new Error(`missing row for ${name}`);
  }
  return tr;
}

function watchedOf(p: Panel, name: string): string | null {
  return rowTr(p, name).getAttribute("data-watched");
}

function hiddenOf(p: Panel, name: string): string | null {
  return rowTr(p, name).getAttribute("data-hidden");
}

function writeInputOf(p: Panel, name: string): StubEl {
  const cell = rowTr(p, name).children[2];
  if (cell === undefined || cell.children[0] === undefined) {
    throw new Error(`missing write input for ${name}`);
  }
  return cell.children[0] as StubEl;
}

function markerOf(p: Panel, name: string): string | undefined {
  const op = rowTr(p, name).children[3];
  if (op === undefined) {
    return undefined;
  }
  return op.children.find((c) => c.getAttribute("data-wmark") === "1")?.textContent;
}

describe("variable panel write feedback", () => {
  it("Enter on a row write input emits exactly one var-write, not a picker add", () => {
    const p = boot();
    p.post(types({ "sys.loop_hz": LEAF() }));
    p.post({ kind: "live-watchlist", names: ["sys.loop_hz"] });
    p.post({ kind: "live-sample", samples: [sample("sys.loop_hz", "0x00000ea7", 0)] });
    const inp = writeInputOf(p, "sys.loop_hz");
    inp.value = "42";
    inp.fire("keydown", { key: "Enter", stopPropagation: () => {}, preventDefault: () => {} });
    expect(p.posted).toEqual([{ kind: "var-write", name: "sys.loop_hz", value: "42" }]);
  });

  it("live-write-result marks rows, shows the message, and clears only the successful input", () => {
    const p = boot();
    p.post(types({ "sys.loop_hz": LEAF(), "sys.uptime": LEAF() }));
    p.post({ kind: "live-watchlist", names: ["sys.loop_hz", "sys.uptime"] });
    p.post({
      kind: "live-sample",
      samples: [
        sample("sys.loop_hz", "0x00000ea7", 0),
        sample("sys.uptime", "0x0000002a", 0),
      ],
    });
    writeInputOf(p, "sys.loop_hz").value = "42";
    writeInputOf(p, "sys.uptime").value = "zz";
    p.post({ kind: "live-write-result", name: "sys.loop_hz", ok: true, message: "sys.loop_hz = 42 (readback 42)" });
    expect(p.el("var-note").textContent).toContain("sys.loop_hz = 42");
    p.post({ kind: "live-write-result", name: "sys.uptime", ok: false, message: "書き込み拒否: bad value" });
    expect(p.el("var-note").textContent).toContain("書き込み拒否");
    // The two rows must differ: success vs failure markers.
    expect(markerOf(p, "sys.loop_hz")).toBe("✓");
    expect(markerOf(p, "sys.uptime")).toBe("✗");
    expect(markerOf(p, "sys.uptime")).not.toBe(markerOf(p, "sys.loop_hz"));
    // Only the successful row's input is cleared; the failed text stays
    // so the user can correct it.
    expect(writeInputOf(p, "sys.loop_hz").value).toBe("");
    expect(writeInputOf(p, "sys.uptime").value).toBe("zz");
  });
});

describe("variable panel paint cost", () => {
  it("a small sample batch touches only dirty rows, not the whole table", () => {
    // Regression: paintAll() repainted EVERY row on every 100ms sample
    // batch (4 DOM writes + decode() per row: ~13,500 mutations per paint
    // at the real 3,380-symbol scale), saturating the webview main thread
    // so values appeared frozen. A 2-sample batch must cost ~2 rows,
    // not all N rows. Flat names keep the row set leaf-only (no groups).
    const N = 3000;
    const index: Record<string, unknown> = {};
    for (let i = 0; i < N; i += 1) {
      index[`sig${String(i).padStart(4, "0")}`] = LEAF();
    }
    const p = boot();
    p.post(types(index));
    p.post({ kind: "live-watchlist", names: ["sig0001", "sig0002"] });
    expect(p.el("var-rows").children.length).toBe(N);

    // Spy on the REAL cost driver: value-cell textContent writes and
    // per-row data-hidden writes. A cosmetic fix that still walks every
    // row (e.g. only skipping unchanged textContent) still fails on
    // hiddenWrites, which the old paintAll sets unconditionally per row.
    let valueWrites = 0;
    let hiddenWrites = 0;
    for (const tr of p.el("var-rows").children) {
      const vcell = tr.children[1] as StubEl;
      let cur = vcell.textContent;
      Object.defineProperty(vcell, "textContent", {
        configurable: true,
        get: () => cur,
        set: (v: string) => {
          valueWrites += 1;
          cur = String(v);
        },
      });
      const origSet = tr.setAttribute.bind(tr);
      tr.setAttribute = (k: string, v: string): void => {
        if (k === "data-hidden") {
          hiddenWrites += 1;
        }
        origSet(k, v);
      };
    }

    p.post({
      kind: "live-sample",
      samples: [sample("sig0001", "0x00000ea7", 0), sample("sig0002", "0x00000ea8", 0)],
    });

    // Values still track the wire...
    expect(p.valueOf("sig0001")).toBe("3751");
    expect(p.valueOf("sig0002")).toBe("3752");
    expect(p.valueOf("sig0003")).toBe("-");
    // ...but the paint cost scales with the 2 changed rows, not all 3000.
    expect(valueWrites).toBeLessThanOrEqual(10);
    expect(hiddenWrites).toBe(0);

    // The active search filter still applies on query change, and later
    // sample batches preserve it without a full filter pass.
    p.el("var-search").value = "sig0001";
    p.el("var-search").fire("input");
    expect(hiddenOf(p, "sig0001")).toBe("0");
    expect(hiddenOf(p, "sig0002")).toBe("1");
    p.post({ kind: "live-sample", samples: [sample("sig0001", "0x00000ea9", 10)] });
    expect(p.valueOf("sig0001")).toBe("3753");
    expect(hiddenOf(p, "sig0001")).toBe("0");
    expect(hiddenOf(p, "sig0002")).toBe("1");
  });
});

describe("variable panel 100Hz display cadence", () => {
  it("repaints a sample batch 10ms after it arrives, not 100ms", () => {
    // The panel is the display surface for a 100Hz sidecar: the host tail tick
    // and this paint throttle both sit at 10ms, so a value is on screen one
    // poll period after the read. At the old 100ms throttle the table showed
    // at most 10 of the 100 samples/s and the display lagged a full tenth of
    // a second behind the wire.
    const clock = fakeClock();
    const p = boot([], undefined, clock);
    p.post(types({ "sys.loop_hz": LEAF() }));
    p.post({ kind: "live-watchlist", names: ["sys.loop_hz"] });
    p.post({ kind: "live-sample", samples: [sample("sys.loop_hz", "0x00000ea7", 0)] });

    expect(clock.scheduled).toEqual([10]);
    // Nothing painted yet at 9ms: the repaint is throttled, not immediate.
    clock.advance(9);
    expect(p.valueOf("sys.loop_hz")).toBe("-");
    clock.advance(1);
    expect(p.valueOf("sys.loop_hz")).toBe("3751");

    // The next poll period behaves the same way.
    p.post({ kind: "live-sample", samples: [sample("sys.loop_hz", "0x00000ea8", 10)] });
    clock.advance(10);
    expect(p.valueOf("sys.loop_hz")).toBe("3752");
  });

  it("coalesces the batches inside one 10ms window into a single repaint", () => {
    // 100Hz in, 10ms out: several sample batches land inside one paint
    // window. They must merge into one scheduled repaint (the dirty set is
    // drained once), not one timer each.
    const clock = fakeClock();
    const p = boot([], undefined, clock);
    p.post(types({ "sys.loop_hz": LEAF(), "sys.uptime": LEAF() }));
    p.post({ kind: "live-watchlist", names: ["sys.loop_hz", "sys.uptime"] });
    p.post({ kind: "live-sample", samples: [sample("sys.loop_hz", "0x00000ea7", 0)] });
    p.post({ kind: "live-sample", samples: [sample("sys.uptime", "0x0000002a", 3)] });
    p.post({ kind: "live-sample", samples: [sample("sys.loop_hz", "0x00000ea8", 7)] });
    expect(clock.pending()).toBe(1);
    clock.advance(10);
    // The last value of the window wins for both rows.
    expect(p.valueOf("sys.loop_hz")).toBe("3752");
    expect(p.valueOf("sys.uptime")).toBe("42");
    expect(clock.pending()).toBe(0);
  });
});

describe("variable panel row lookup cost", () => {
  it("resolves each dirty name with O(1) lookups, not a scan of every row", () => {
    // Prerequisite for 100Hz: paintDirty() resolves one row per dirty name.
    // With a linear rowFor over tbody.children, one batch costs
    // dirty x total getAttribute('data-name') calls — ~74M/s at the real
    // 220 names x 3,380 rows x 100Hz — which is what froze the panel.
    // The dirty names here are deliberately NOT watched: watched rows are
    // always rendered first, so a watched dirty row would sit at index 0 and
    // let a linear scan pass after a single comparison.
    const N = 1200;
    const index: Record<string, unknown> = {};
    for (let i = 0; i < N; i += 1) {
      index[`sig${String(i).padStart(4, "0")}`] = LEAF();
    }
    const p = boot();
    p.post(types(index));
    p.post({ kind: "live-watchlist", names: ["sig0000"] });
    expect(p.el("var-rows").children.length).toBe(N);

    let nameLookups = 0;
    for (const tr of p.el("var-rows").children) {
      const orig = tr.getAttribute.bind(tr);
      tr.getAttribute = (k: string): string | null => {
        if (k === "data-name") nameLookups += 1;
        return orig(k);
      };
    }

    p.post({
      kind: "live-sample",
      samples: [sample(`sig${String(N - 2).padStart(4, "0")}`, "0x00000ea7", 0)],
    });
    p.post({
      kind: "live-sample",
      samples: [sample(`sig${String(N - 1).padStart(4, "0")}`, "0x0000002a", 0)],
    });
    // Snapshot before any assertion helper reads an attribute itself.
    const lookups = nameLookups;
    expect(lookups).toBe(2);

    // The two rows near the END of the table still resolve and repaint.
    expect(p.valueOf(`sig${String(N - 2).padStart(4, "0")}`)).toBe("3751");
    expect(p.valueOf(`sig${String(N - 1).padStart(4, "0")}`)).toBe("42");
  });
});
