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
}

function makeEl(tag: string): StubEl {
  const el = {
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
  } as unknown as StubEl;
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

function scriptOf(html: string): string {
  const m = /<script>([\s\S]*?)<\/script>/.exec(html);
  if (m === null) {
    throw new Error("variable panel html has no inline script");
  }
  return m[1] ?? "";
}

function boot(watched: readonly string[] = [], stripTestid?: string): Panel {
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
    "var-note", "var-table", "var-rows", "var-status", "var-names",
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
    expect(parseVariablePanelMessage({ kind: "nope" })).toBeNull();
    expect(parseVariablePanelMessage(null)).toBeNull();
  });
});

describe("variable panel live values", () => {
  it("creates a row for every watched name before the first sample batch", () => {
    const p = boot();
    p.post(types({ "sys.loop_hz": LEAF() }));
    p.post({ kind: "live-watchlist", names: ["sys.loop_hz"] });
    // No sample has arrived: the row must already exist with a placeholder,
    // never a missing row or a blank value cell.
    expect(p.rowNames()).toEqual(["sys.loop_hz"]);
    expect(p.valueOf("sys.loop_hz")).toBe("-");
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
    expect(p.rowNames()).toEqual(["sys.loop_hz", "constructor"]);
    expect(p.valueOf("constructor")).toBe("-");
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
    expect(p.rowNames()).toEqual(["sys.loop_hz"]);
    p.post({ kind: "live-sample", samples: [sample("sys.loop_hz", "0x00000ea7", 0)] });
    expect(p.valueOf("sys.loop_hz")).toBe("3751");
    p.post({ kind: "live-sample", samples: [sample("sys.loop_hz", "0x00000ea8", 10)] });
    expect(p.valueOf("sys.loop_hz")).toBe("3752");
    // The surviving 削除 button is wired: clicking it posts var-remove.
    p.el("var-picker").value = "sys.loop_hz";
    p.el("var-remove").fire("click");
    expect(p.posted).toEqual([{ kind: "var-remove", name: "sys.loop_hz" }]);
    expect(p.rowNames()).toEqual([]);
  });
});

function rowTr(p: Panel, name: string): StubEl {
  const tr = p.el("var-rows").children.find((r) => r.getAttribute("data-name") === name);
  if (tr === undefined) {
    throw new Error(`missing row for ${name}`);
  }
  return tr;
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
