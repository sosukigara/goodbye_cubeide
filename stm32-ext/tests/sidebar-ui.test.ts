// Runs the sidebar webview script for real: renderSidebar() -> a stub DOM
// parsed from that exact HTML -> node:vm -> postMessage. Everything asserted
// here is observed DOM state, not a regex over source.
import { describe, expect, it } from "vitest";
import { Script, createContext } from "node:vm";
import { readFileSync } from "node:fs";
import {
  renderSidebar,
  parseSidebarMessage,
  SIDEBAR_SCRIPT,
  SIDEBAR_PANEL_DEFAULT_STATE,
  type SidebarState,
} from "../src/panels/sidebar.js";

describe("sidebar: font size is a user setting, and the columns follow it", () => {
  it("injects the configured size as a CSS variable", () => {
    expect(renderSidebar(undefined as never, 16)).toContain("--stm32ext-ui-font:16px");
    expect(renderSidebar(undefined as never, 12)).toContain("--stm32ext-ui-font:12px");
  });

  it("clamps a nonsensical setting instead of emitting broken CSS", () => {
    // A raw value would otherwise become `--stm32ext-ui-font:NaNpx`, which
    // silently invalidates every width derived from it. Out-of-range numbers
    // clamp to the bounds; a non-finite one falls back to the default.
    expect(renderSidebar(undefined as never, 0)).toContain("--stm32ext-ui-font:12px");
    expect(renderSidebar(undefined as never, 999)).toContain("--stm32ext-ui-font:16px");
    expect(renderSidebar(undefined as never, Number.NaN)).toContain("--stm32ext-ui-font:15px");
    for (const bad of [0, 999, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(renderSidebar(undefined as never, bad)).not.toContain("NaN");
    }
  });

  it("sizes the value and op columns from that variable, not a fixed px", () => {
    // A hardcoded px width is correct for exactly one font size and silently
    // ellipsises a hex value or clips the rightmost button at any other. The
    // width must be an absolute calc over the injected size.
    const css = renderSidebar(undefined as never, 15);
    expect(css).toMatch(/--valw:calc\(var\(--stm32ext-ui-font/);
    expect(css).toMatch(/--opw:calc\(var\(--stm32ext-ui-font/);
    expect(css).not.toMatch(/td\.v\{width:\d+px/);
    expect(css).not.toMatch(/td\.o\{width:\d+px/);
    // th and td must consume the SAME variable, or table-layout:fixed (which
    // takes the <thead> value) silently wins with the wrong one.
    expect(css).toMatch(/th:nth-child\(2\)\{width:var\(--valw\)\}/);
    expect(css).toMatch(/td\.v\{width:var\(--valw\)/);
    expect(css).toMatch(/th:nth-child\(3\)\{width:var\(--opw\)\}/);
    expect(css).toMatch(/td\.o\{width:var\(--opw\)/);
  });

  it("sizes the text from the SAME variable the columns are sized from", () => {
    // The trap this closes: body was max(vscode-font-size, uiFontPx) while
    // the columns used uiFontPx alone, so anyone on a 16px editor font got
    // 16px glyphs in a 15px column and lost 5px of the rightmost control at
    // the DEFAULT setting. Two sources can disagree; one cannot.
    const css = renderSidebar(SIDEBAR_PANEL_DEFAULT_STATE, 15);
    const body = /body\{[^}]*font-size:([^;}]+)/.exec(css);
    expect(body?.[1]).toBe("var(--stm32ext-ui-font,15px)");
    // No second font-size source may creep back into the body rule.
    expect(body?.[1]).not.toContain("max(");
    expect(body?.[1]).not.toContain("vscode-font-size");
  });

  it("caps at 16px, and the cap is the same number in the schema", () => {
    // The name column is whatever the two fixed columns leave over, and both
    // grow with the font: name = 284 - 11.2*font at a 300px sidebar. Measured
    // in a real browser that is 13 monospace characters at the 15px default,
    // 11 at 16px, 8 at 18px and only 5 at 20px, where a 27-character name
    // reduces to "req…". The cap sits where a typical name still shows its
    // meaningful part, not merely where the layout holds together. Raising it
    // means re-running that measurement, and the schema and the clamp must
    // not drift apart while doing so.
    const css = renderSidebar(SIDEBAR_PANEL_DEFAULT_STATE, 16);
    expect(css).toContain("--stm32ext-ui-font:16px");
    // Anything larger is pulled back to the same bound.
    expect(renderSidebar(SIDEBAR_PANEL_DEFAULT_STATE, 20)).toContain("--stm32ext-ui-font:16px");
    // ...and the Settings UI offers the same range the code enforces.
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    const schema = pkg.contributes.configuration.properties["stm32ext.uiFontPx"];
    expect(schema.minimum).toBe(12);
    expect(schema.maximum).toBe(16);
  });
});

// --------------------------------------------------------------- DOM stub
class StubText {
  nodeType = 3;
  parentNode: StubEl | null = null;
  constructor(public data: string) {}
  get parentElement(): StubEl | null {
    return this.parentNode;
  }
}

class StubEl {
  nodeType = 1;
  parentNode: StubEl | null = null;
  childNodes: (StubEl | StubText)[] = [];
  attrs = new Map<string, string>();
  listeners = new Map<string, ((ev: unknown) => void)[]>();
  style: Record<string, string> = {};
  checked = false;
  disabled = false;
  scrollTop = 0;
  scrollHeight = 0;
  width = 300;
  height = 150;
  __w = 0;

  constructor(public tagName: string) {}

  get parentElement(): StubEl | null {
    return this.parentNode;
  }
  get children(): StubEl[] {
    return this.childNodes.filter((c): c is StubEl => c.nodeType === 1);
  }
  get firstChild(): StubEl | StubText | null {
    return this.childNodes[0] ?? null;
  }
  get classList() {
    const self = this;
    return {
      add: (c: string) => self.setAttribute("class", ((self.getAttribute("class") ?? "") + " " + c).trim()),
      remove: (c: string) => self.setAttribute("class", (self.getAttribute("class") ?? "").split(/\s+/).filter((x) => x !== c).join(" ")),
      contains: (c: string) => (self.getAttribute("class") ?? "").split(/\s+/).includes(c),
    };
  }
  get className(): string {
    return this.getAttribute("class") ?? "";
  }
  set className(v: string) {
    this.setAttribute("class", v);
  }
  get value(): string {
    return this.getAttribute("value") ?? "";
  }
  set value(v: string) {
    this.setAttribute("value", String(v));
  }
  get id(): string {
    return this.getAttribute("id") ?? "";
  }
  get title(): string {
    return this.getAttribute("title") ?? "";
  }
  set title(v: string) {
    this.setAttribute("title", v);
  }
  get hidden(): boolean {
    return this.attrs.has("hidden");
  }
  set hidden(v: boolean) {
    if (v) {
      this.attrs.set("hidden", "");
    } else {
      this.attrs.delete("hidden");
    }
  }
  get dataset(): Record<string, string | undefined> {
    const self = this;
    return new Proxy({}, {
      get: (_t, k: string) => self.getAttribute("data-" + k),
      set: (_t, k: string, v: string) => {
        self.setAttribute("data-" + k, String(v));
        return true;
      },
      has: (_t, k: string) => self.attrs.has("data-" + k),
    });
  }
  get textContent(): string {
    return this.childNodes.map((c) => (c.nodeType === 3 ? (c as StubText).data : (c as StubEl).textContent)).join("");
  }
  set textContent(v: string) {
    this.__w += 1;
    this.childNodes = v === "" ? [] : [new StubText(String(v))];
  }
  set innerHTML(v: string) {
    this.__w += 1;
    docStats.innerHtml += 1;
    this.childNodes = [new StubText(String(v))];
  }
  get innerHTML(): string {
    return this.textContent;
  }
  getAttribute(n: string): string | null {
    return this.attrs.has(n) ? this.attrs.get(n) ?? "" : null;
  }
  setAttribute(n: string, v: string): void {
    this.attrs.set(n, v);
  }
  removeAttribute(n: string): void {
    this.attrs.delete(n);
  }
  hasAttribute(n: string): boolean {
    return this.attrs.has(n);
  }
  appendChild<T extends StubEl | StubText>(c: T): T {
    c.parentNode?.removeChild(c);
    c.parentNode = this;
    this.childNodes.push(c);
    return c;
  }
  insertBefore<T extends StubEl | StubText>(c: T, ref: StubEl | StubText): T {
    const i = this.childNodes.indexOf(ref);
    c.parentNode?.removeChild(c);
    c.parentNode = this;
    if (i < 0) {
      this.childNodes.push(c);
    } else {
      this.childNodes.splice(i, 0, c);
    }
    return c;
  }
  removeChild<T extends StubEl | StubText>(c: T): T {
    const i = this.childNodes.indexOf(c);
    if (i >= 0) this.childNodes.splice(i, 1);
    c.parentNode = null;
    return c;
  }
  remove(): void {
    this.parentNode?.removeChild(this);
  }
  addEventListener(type: string, fn: (ev: unknown) => void): void {
    const a = this.listeners.get(type) ?? [];
    a.push(fn);
    this.listeners.set(type, a);
  }
  dispatchEvent(ev: Record<string, unknown>): boolean {
    if (typeof ev.preventDefault !== "function") ev.preventDefault = () => undefined;
    const start = ev.target as StubEl | StubText;
    let node: StubEl | null = (start.nodeType === 1 ? start : start.parentElement) as StubEl | null;
    while (node) {
      for (const fn of node.listeners.get(String(ev.type)) ?? []) fn(ev);
      node = node.parentNode;
    }
    return true;
  }
  closest(sel: string): StubEl | null {
    let n: StubEl | null = this;
    while (n) {
      if (n.matches(sel)) return n;
      n = n.parentNode;
    }
    return null;
  }
  matches(sel: string): boolean {
    return matchCompound(this, sel.trim());
  }
  querySelectorAll(sel: string): StubEl[] {
    const parts = sel.trim().split(/\s+/);
    const out: StubEl[] = [];
    const walk = (n: StubEl) => {
      for (const c of n.children) {
        if (matchParts(c, parts)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel: string): StubEl | null {
    return this.querySelectorAll(sel)[0] ?? null;
  }
  focus(): void {
    activeEl = this;
  }
  blur(): void {
    if (activeEl === this) activeEl = null;
  }
}

const docStats = { innerHtml: 0 };
let activeEl: StubEl | null = null;

function matchCompound(el: StubEl, sel: string): boolean {
  const re = /(\[[^\]]+\])|(\.[\w-]+)|(#[\w-]+)|([\w-]+)/g;
  let m: RegExpExecArray | null;
  let tagSeen = false;
  while ((m = re.exec(sel)) !== null) {
    const tok = m[0];
    if (tok.startsWith("[")) {
      const body = tok.slice(1, -1);
      const eq = body.indexOf("=");
      if (eq < 0) {
        if (!el.hasAttribute(body)) return false;
        continue;
      }
      // CSS puts the operator before the "=": [a^="v"], so the key ends one
      // character earlier whenever an operator is present.
      const prev = eq > 0 ? body[eq - 1] : "=";
      const op = prev === "^" || prev === "*" || prev === "$" ? prev : "=";
      const key = op === "=" ? body.slice(0, eq) : body.slice(0, eq - 1);
      const val = body.slice(eq + 1);
      const got = el.getAttribute(key);
      const want = val.startsWith('"') ? val.slice(1, -1) : val;
      if (got === null) return false;
      if (op === "=" && got !== want) return false;
      if (op === "^" && !got.startsWith(want)) return false;
      if (op === "*" && !got.includes(want)) return false;
      if (op === "$" && !got.endsWith(want)) return false;
    } else if (tok.startsWith(".")) {
      if (!el.classList.contains(tok.slice(1))) return false;
    } else if (tok.startsWith("#")) {
      if (el.id !== tok.slice(1)) return false;
    } else if (!tagSeen) {
      if (el.tagName.toLowerCase() !== tok.toLowerCase()) return false;
      tagSeen = true;
    }
  }
  return true;
}

function matchParts(el: StubEl, parts: string[]): boolean {
  if (!matchCompound(el, parts[parts.length - 1])) return false;
  if (parts.length === 1) return true;
  const rest = parts.slice(0, -1);
  let p = el.parentNode;
  while (p) {
    if (matchParts(p, rest)) return true;
    p = p.parentNode;
  }
  return false;
}

// --------------------------------------------------------- HTML mini parser
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);

function decodeEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|#39);/g, (_, k: string) => (
    { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" }[k] ?? k
  ));
}

function parseHtml(html: string): StubEl {
  const root = new StubEl("#root");
  const stack: StubEl[] = [root];
  let i = 0;
  const top = (): StubEl => stack[stack.length - 1];
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) break;
    if (lt > i) {
      const text = decodeEntities(html.slice(i, lt));
      if (text.trim() !== "") top().appendChild(new StubText(text));
    }
    if (html.startsWith("<!--", lt)) {
      i = html.indexOf("-->", lt) + 3;
      continue;
    }
    if (html.startsWith("<!", lt)) {
      i = html.indexOf(">", lt) + 1;
      continue;
    }
    const gt = html.indexOf(">", lt);
    if (gt < 0) break;
    const inner = html.slice(lt + 1, gt);
    if (inner.startsWith("/")) {
      if (stack.length > 1) stack.pop();
      i = gt + 1;
      continue;
    }
    const selfClose = inner.endsWith("/");
    const bodyTxt = selfClose ? inner.slice(0, -1) : inner;
    const sp = bodyTxt.search(/\s/);
    const tag = (sp < 0 ? bodyTxt : bodyTxt.slice(0, sp)).toLowerCase();
    const el = new StubEl(tag);
    const attrTxt = sp < 0 ? "" : bodyTxt.slice(sp + 1);
    const are = /([\w:-]+)(?:\s*=\s*"([^"]*)")?/g;
    let am: RegExpExecArray | null;
    while ((am = are.exec(attrTxt)) !== null) {
      el.setAttribute(am[1], decodeEntities(am[2] ?? ""));
    }
    if (tag === "input") el.checked = el.hasAttribute("checked");
    top().appendChild(el);
    if (VOID.has(tag) || selfClose) {
      i = gt + 1;
      continue;
    }
    if (tag === "script" || tag === "style") {
      const close = html.toLowerCase().indexOf("</" + tag, gt);
      const raw = html.slice(gt + 1, close);
      if (raw !== "") el.appendChild(new StubText(raw));
      i = html.indexOf(">", close) + 1;
      continue;
    }
    stack.push(el);
    i = gt + 1;
  }
  return root;
}

// -------------------------------------------------------------- boot harness
interface Booted {
  readonly doc: StubEl;
  readonly body: StubEl;
  readonly posted: Record<string, unknown>[];
  readonly prompts: { message: string; initial: string }[];
  answer(v: string | null): void;
  send(data: unknown): void;
  tick(): void;
  flushRaf(): void;
  $(sel: string): StubEl | null;
  $$(sel: string): StubEl[];
}

function boot(state: SidebarState = SIDEBAR_PANEL_DEFAULT_STATE): Booted {
  docStats.innerHtml = 0;
  const root = parseHtml(renderSidebar(state));
  const body = root.querySelector("body") ?? root;
  const posted: Record<string, unknown>[] = [];
  const prompts: { message: string; initial: string }[] = [];
  const raf: (() => void)[] = [];
  const winListeners: ((ev: unknown) => void)[] = [];

  const document = {
    get body() {
      return body;
    },
    get activeElement() {
      return activeEl;
    },
    querySelector: (s: string) => root.querySelector(s),
    querySelectorAll: (s: string) => root.querySelectorAll(s),
    createElement: (t: string) => new StubEl(t.toLowerCase()),
    createTextNode: (t: string) => new StubText(String(t)),
    addEventListener: () => undefined,
  };
  const window = {
    addEventListener: (t: string, fn: (ev: unknown) => void) => {
      if (t === "message") winListeners.push(fn);
    },
    prompt: (message: string, initial?: string) => {
      prompts.push({ message, initial: String(initial) });
      return promptAnswer;
    },
  };
  let promptAnswer: string | null = null;
  const timers: { fn: () => void; at: number }[] = [];
  let clock = 0;
  const ctx = createContext({
    acquireVsCodeApi: () => ({ postMessage: (m: Record<string, unknown>) => posted.push(m) }),
    document,
    window,
    console,
    TextDecoder,
    setTimeout: (fn: () => void, ms: number) => {
      timers.push({ fn, at: clock + (ms ?? 0) });
      return timers.length;
    },
    clearTimeout: (id: number) => {
      const i = timers.findIndex((_, k) => k === id - 1);
      if (i >= 0) timers.splice(i, 1);
    },
    requestAnimationFrame: (fn: () => void) => {
      raf.push(fn);
      return raf.length;
    },
  });
  new Script(SIDEBAR_SCRIPT).runInContext(ctx);

  return {
    doc: root,
    body,
    posted,
    prompts,
    answer: (v) => { promptAnswer = v; },
    send(data: unknown) {
      for (const fn of winListeners) fn({ data });
      this.tick();
    },
    tick() {
      while (timers.length > 0) {
        clock += 1000;
        const due = timers.filter((t) => t.at <= clock);
        for (const t of due) timers.splice(timers.indexOf(t), 1);
        for (const t of due) t.fn();
      }
      while (raf.length > 0) (raf.shift() as () => void)();
    },
    flushRaf() {
      while (raf.length > 0) (raf.shift() as () => void)();
    },
    $: (s: string) => root.querySelector(s),
    $$: (s: string) => root.querySelectorAll(s),
  };
}

// ------------------------------------------------------------------ fixtures
interface Leaf {
  readonly path: string;
  readonly size: number;
  readonly kind: string;
  readonly signed?: boolean;
  readonly type?: string;
  readonly enumerators?: { name: string; value: number }[];
  readonly length?: number;
  readonly bit_size?: number;
  readonly bit_offset?: number;
}

function leaf(l: Leaf): Record<string, unknown> {
  return { children: [], kind: "scalar", signed: false, type: "int", ...l, name: l.path.split(".").pop() };
}

function node(name: string, type: string, children: unknown[]): Record<string, unknown> {
  return { name, type, kind: "struct", size: 16, address: "0x20000000", children };
}

function indexOf(leaves: Leaf[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const l of leaves) {
    const { path, ...meta } = l;
    out[path] = meta;
  }
  return out;
}

const TYPE_TREE: { tree: Record<string, unknown>; index: Record<string, unknown> } = (() => {
  const leaves: Leaf[] = [
    { path: "sys.loop_hz", size: 4, kind: "scalar", signed: true, type: "int32_t" },
    { path: "sys.bias", size: 4, kind: "float", type: "float" },
    { path: "sys.stamp_ns", size: 8, kind: "scalar", signed: false, type: "uint64_t" },
    { path: "sys.tag", size: 4, kind: "string", type: "char[4]", length: 4 },
    { path: "drive.mode", size: 4, kind: "enum", type: "drive_mode_t", enumerators: [{ name: "MODE_IDLE", value: 0 }, { name: "MODE_FOLLOW", value: 2 }] },
    { path: "drive.motor_timeout", size: 1, kind: "scalar", signed: false, type: "uint8_t" },
    { path: "drive.emergency.req", size: 1, kind: "bool", type: "_Bool" },
    { path: "drive.emergency.flag", size: 1, kind: "scalar", signed: false, type: "uint8_t" },
    { path: "drive.controller.up", size: 1, kind: "bool", type: "_Bool" },
    { path: "drive.controller.down", size: 1, kind: "bool", type: "_Bool" },
    { path: "drive.kp", size: 4, kind: "float", type: "float" },
  ];
  const tree = {
    name: "DebugGlobal",
    type: "DebugGlobal",
    kind: "struct",
    size: 976,
    children: [
      node("sys", "SysState", leaves.filter((l) => l.path.startsWith("sys.")).map(leaf)),
      {
        name: "drive",
        type: "DriveState",
        kind: "struct",
        size: 64,
        children: [
          leaf({ path: "drive.mode", size: 4, kind: "enum", type: "drive_mode_t", enumerators: [{ name: "MODE_IDLE", value: 0 }, { name: "MODE_FOLLOW", value: 2 }] }),
          leaf({ path: "drive.motor_timeout", size: 1, kind: "scalar", signed: false, type: "uint8_t" }),
          node("emergency", "Emergency", [leaf({ path: "drive.emergency.req", size: 1, kind: "bool", type: "_Bool" }), leaf({ path: "drive.emergency.flag", size: 1, kind: "scalar", signed: false, type: "uint8_t" })]),
          node("controller", "Controller", [leaf({ path: "drive.controller.up", size: 1, kind: "bool", type: "_Bool" }), leaf({ path: "drive.controller.down", size: 1, kind: "bool", type: "_Bool" })]),
          leaf({ path: "drive.kp", size: 4, kind: "float", type: "float" }),
        ],
      },
    ],
  };
  return { tree, index: indexOf(leaves) };
})();

function bigTree(group: string, n: number): { tree: Record<string, unknown>; index: Record<string, unknown> } {
  const leaves: Leaf[] = [];
  const children: unknown[] = [];
  for (let i = 0; i < n; i += 1) {
    leaves.push({ path: `${group}.leaf${i}`, size: 4, kind: "scalar", signed: false, type: "uint32_t" });
    children.push(leaf({ path: `${group}.leaf${i}`, size: 4, kind: "scalar", signed: false, type: "uint32_t" }));
  }
  return {
    tree: { name: "DebugGlobal", type: "DebugGlobal", kind: "struct", size: 976, children: [node(group, "Periph", children)] },
    index: indexOf(leaves),
  };
}

function sample(name: string, value: string): Record<string, string> {
  return { timestamp: "2026-09-28T01:22:52.037", address: "0x200000b4", name, value };
}

const withTree = (b: Booted, t = TYPE_TREE): Booted => {
  b.send({ kind: "live-types", tree: t.tree, index: t.index });
  return b;
};

/**
 * The shape the real resolver emits, measured on `build-ext/unit_omni3.elf`
 * with `--all-members`: 327 leaf nodes, none of whose `name` contains a dot
 * (they carry the last segment) alongside a `path` with the full dotted path,
 * and most nested types NAMELESS (`struct <anonymous>`). The earlier fixture
 * gave every type a name and no node a `path`, which is why a rendering defect
 * shipped: every leaf row drew an EMPTY name column while its value column
 * filled in normally.
 */
function realTree(): { tree: Record<string, unknown>; index: Record<string, unknown> } {
  const anon = (name: string, children: unknown[]): Record<string, unknown> =>
    ({ name, type: "struct <anonymous>", kind: "struct", size: 16, address: "0x20000000", children });
  const leaves: Leaf[] = [];
  const group = (name: string, n: number, size: number, type: string): Record<string, unknown> => {
    const children: unknown[] = [];
    for (let i = 0; i < n; i += 1) {
      const l: Leaf = { path: `${name}.m${i}`, size, kind: size === 1 ? "bool" : "scalar", type };
      leaves.push(l);
      children.push(leaf(l));
    }
    return anon(name, children);
  };
  return {
    tree: {
      name: "debug",
      type: "DebugGlobal",
      kind: "struct",
      size: 976,
      children: [
        group("sys", 14, 4, "uint32_t"),
        group("comm", 11, 1, "_Bool"),
        { name: "drive", type: "struct <anonymous>", kind: "struct", size: 64, address: "0x20000100",
          children: [group2("controller", 16, 1, "_Bool"), { name: "mode", type: "int", kind: "scalar", size: 4, children: [] }] },
      ],
    },
    index: indexOf(leaves),
  };
  function group2(name: string, n: number, size: number, type: string): Record<string, unknown> {
    const children: unknown[] = [];
    for (let i = 0; i < n; i += 1) {
      const l: Leaf = { path: `drive.${name}.m${i}`, size, kind: "bool", type };
      children.push(leaf(l));
    }
    return { name, type: "Controller", kind: "struct", size: 16, address: "0x20000108", children };
  }
}

describe("sidebar: the tree is actually readable (real resolver shape)", () => {
  it("every leaf row shows its name — the 変数 column is never blank", () => {
    const b = withTree(boot(), realTree());
    const rows = b.$$('tr[data-kind="leaf"]');
    expect(rows.length).toBeGreaterThan(30);
    const blank = rows.filter((r) => (r.children[0]?.textContent ?? "").trim() === "");
    expect(blank.map((r) => r.dataset.name)).toEqual([]);
  });

  it("a leaf shows its own name, with the full dotted path in the tooltip", () => {
    const b = withTree(boot(), realTree());
    const row = b.$('tr[data-name="sys.m3"]');
    expect(row?.children[0].textContent).toBe("m3");
    expect(row?.children[0].title).toContain("sys.m3");
  });

  it("a nameless type shows only the member name, never 'struct <anonymous>'", () => {
    const b = withTree(boot(), realTree());
    const texts = b.$$('tr[data-kind="group"]').map((r) => r.children[0].textContent);
    expect(texts.some((t) => t.includes("<anonymous>"))).toBe(false);
    expect(texts).toContain("sys");
    // A genuinely named type is still worth showing.
    expect(texts).toContain("controller : Controller");
    expect(texts).toContain("debug : DebugGlobal");
  });

  it("a sample updates the value of an already-labelled tree row", () => {
    const b = withTree(boot(), realTree());
    b.send({ kind: "live-sample", samples: [sample("sys.m0", "0x00000508")] });
    const row = b.$('tr[data-name="sys.m0"]');
    expect(row?.children[0].textContent).toBe("m0");
    expect(row?.children[1].textContent).toBe("1288");
  });

  it("a variable seen before live-types is still labelled with its last segment", () => {
    const b = boot();
    b.send({ kind: "live-sample", samples: [sample("legacy.var", "0x0000002a")] });
    const row = b.$('tr[data-name="legacy.var"]');
    expect(row?.children[0].textContent).toBe("var");
    expect(row?.children[0].title).toBe("legacy.var");
  });

  it("a node's own `path` wins over re-concatenating its name", () => {
    // If the renderer rebuilt paths by concatenation, a node whose `name`
    // already contains a dot would be keyed `sys.sys.loop_hz`: the row would
    // look right, but add/remove/write would target a symbol that does not
    // exist and still report success.
    const b = boot();
    b.send({
      kind: "live-types",
      tree: {
        name: "debug", type: "DebugGlobal", kind: "struct", size: 976, path: "",
        children: [{
          name: "sys", path: "sys", type: "struct <anonymous>", kind: "struct", size: 16,
          children: [{ name: "sys.loop_hz", path: "sys.loop_hz", type: "uint32_t", kind: "scalar", size: 4, children: [] }],
        }],
      },
      index: { "sys.loop_hz": { size: 4, kind: "scalar", type: "uint32_t" } },
    });
    expect(b.$('tr[data-name="sys.sys.loop_hz"]')).toBeNull();
    const row = b.$('tr[data-name="sys.loop_hz"]');
    expect(row).not.toBeNull();
    // The label is the path's LAST SEGMENT even when `name` carries the whole
    // dotted path: rendering the full path would overflow a 150px column.
    expect(row?.children[0].textContent).toBe("loop_hz");
    // ...while the row keeps the full path for every add/remove/write.
    expect(row?.children[0].title).toBe("sys.loop_hz — uint32_t");
    b.send({ kind: "live-sample", samples: [sample("sys.loop_hz", "0x00000508")] });
    expect(b.$('tr[data-name="sys.loop_hz"]')?.children[1].textContent).toBe("1288");
  });

  it("an array node is listed but not counted as a watchable leaf", () => {
    // Measured on the real ELF: 327 leaf nodes, 324 symbols. The 3 extra are
    // arrays (`float[4]`, `struct [3]`) which resolve to no scalar symbol, so
    // they can never show a value. Counting them made every group read
    // "3/327 監視" with a denominator the user could never reach.
    const b = boot();
    b.send({
      kind: "live-types",
      tree: {
        name: "debug",
        type: "DebugGlobal",
        kind: "struct",
        children: [{
          name: "periph",
          type: "struct <anonymous>",
          kind: "struct",
          children: [
            { name: "fdcan", path: "periph.fdcan", type: "struct <anonymous>[3]", kind: "array", size: 24, children: [] },
            { name: "loop", path: "periph.loop", type: "uint32_t", kind: "scalar", size: 4, children: [] },
          ],
        }],
      },
      index: { "periph.loop": { size: 4, kind: "scalar", type: "uint32_t" } },
    });
    const group = b.$('tr[data-path="periph"]');
    // The array is still in the catalogue…
    expect(b.$('tr[data-name="periph.fdcan"]')).not.toBeNull();
    expect(b.$('tr[data-name="periph.fdcan"]')?.children[0].textContent).toBe("fdcan");
    // …but it is dimmed, explained, and carries no watch button that could only fail.
    const arr = b.$('tr[data-name="periph.fdcan"]');
    expect(arr?.dataset.pollable).toBe("0");
    expect(arr?.children[0].title).toContain("配列");
    expect(arr?.children[2].textContent).toBe("—");
    // The group leaf count covers only what can actually be watched.
    expect(group?.children[1].textContent).toBe("1葉");
  });
});

// --------------------------------------------------------------------- tests
describe("sidebar: typed value decode (spec 3.4)", () => {
  const cases: [string, string, string][] = [
    ["sys.loop_hz", "0xffffffff", "-1"],
    ["sys.loop_hz", "0x00000508", "1288"],
    ["sys.bias", "0x3f800000", "1.00000"],
    ["sys.bias", "0xc0490fdb", "-3.14159"],
    ["sys.stamp_ns", "0xffffffffffffffff", "18446744073709551615"],
    ["sys.tag", "0x004e5552", "RUN"],
    ["drive.mode", "0x00000002", "MODE_FOLLOW"],
    ["drive.mode", "0x00000009", "9 (unknown)"],
    ["drive.emergency.req", "0x01", "true"],
    ["drive.emergency.req", "0x00", "false"],
    ["drive.controller.up", "0xff000001", "true"],
    ["drive.motor_timeout", "0x01", "1"],
  ];
  for (const [name, hex, want] of cases) {
    it(`${name} ${hex} renders "${want}", never as a raw unsigned int`, () => {
      const b = withTree(boot());
      b.send({ kind: "live-sample", samples: [sample(name, hex)] });
      const tr = b.$(`[data-name="${name}"]`);
      expect(tr).not.toBeNull();
      expect(tr?.children[1].textContent).toBe(want);
    });
  }

  it("a 1-byte bool is never shown as 0xff000001 garbage", () => {
    const b = withTree(boot());
    b.send({ kind: "live-sample", samples: [sample("drive.controller.up", "0x01"), sample("drive.controller.down", "0x00")] });
    expect(b.$('[data-name="drive.controller.up"]')?.children[1].textContent).toBe("true");
    expect(b.$('[data-name="drive.controller.down"]')?.children[1].textContent).toBe("false");
  });

  it("an unknown type falls back to raw hex with a 型不明 note", () => {
    const b = boot();
    b.send({ kind: "live-sample", samples: [sample("mystery.word", "0x00001234")] });
    expect(b.$('[data-name="mystery.word"]')?.children[1].textContent).toBe("0x00001234 型不明");
  });

  it("a bitfield leaf masks with the keys the host actually sends (bitSize/bitOffset)", () => {
    // extension.ts:505-510 builds the index from elfResolver's LeafMeta, which
    // spells these bitSize / bitOffset (src/live/poller.ts:74-76). Asserting a
    // snake_case payload here is what let this bug through a green suite.
    const meta = { size: 8, kind: "bitfield", type: "uint64_t", signed: false, bitSize: 2, bitOffset: 1 };
    const tree = {
      name: "DebugGlobal", type: "DebugGlobal", kind: "struct", size: 8,
      children: [leaf({ path: "flags", ...meta })],
    };
    const b = boot();
    b.send({ kind: "live-types", tree, index: { flags: meta } });
    b.send({ kind: "live-sample", samples: [sample("flags", "0x000000000000000a")] });
    // (10 >> 1) & 3 === 1. A non-bitfield decode would have shown the whole 10.
    expect(b.$('[data-name="flags"]')?.children[1].textContent).toBe("1");
    // 0xff >> 1 & 3 === 3; a non-bitfield decode would have shown the whole 255.
    b.send({ kind: "live-sample", samples: [sample("flags", "0x00000000000000ff")] });
    expect(b.$('[data-name="flags"]')?.children[1].textContent).toBe("3");
    b.send({ kind: "live-sample", samples: [sample("flags", "0x0000000000000000")] });
    expect(b.$('[data-name="flags"]')?.children[1].textContent).toBe("0");
  });

  it("the write prompt is seeded with the decoded value, not the bit pattern", () => {
    const b = withTree(boot());
    b.send({ kind: "live-sample", samples: [sample("sys.bias", "0x3f800000")] });
    b.answer("2.5");
    b.$('[data-name="sys.bias"] [data-op="write"]')?.dispatchEvent({ type: "click", target: b.$('[data-name="sys.bias"] [data-op="write"]') });
    expect(b.prompts[0]?.message).toBe("sys.bias の値");
    expect(b.prompts[0]?.initial).toBe("1");
  });
});

describe("sidebar: struct tree", () => {
  it("renders one row per node with the C type name on every struct", () => {
    const b = withTree(boot());
    const groups = b.$$('[data-kind="group"]');
    expect(groups.length).toBe(5); // DebugGlobal, sys, drive, emergency, controller
    const labels = groups.map((g) => g.children[0].textContent);
    expect(labels).toContain("drive : DriveState");
    expect(labels).toContain("controller : Controller");
  });

  it("a leaf row is keyed by its dotted path and starts unwatched", () => {
    const b = withTree(boot());
    const tr = b.$('[data-name="drive.emergency.flag"]');
    expect(tr?.dataset.kind).toBe("leaf");
    expect(tr?.dataset.watched).toBe("0");
  });

  it("collapsing a group hides its subtree and toggles aria-expanded", () => {
    const b = withTree(boot());
    const head = b.$('[data-name="drive"] td.n');
    head?.dispatchEvent({ type: "click", target: head });
    const group = b.$('[data-name="drive"]');
    expect(group?.dataset.collapsed).toBe("1");
    expect(b.$('[data-name="drive.kp"]')?.dataset.hidden).toBe("1");
    expect(b.$('[data-name="drive.emergency"]')?.dataset.hidden).toBe("1");
    expect(group?.children[0].getAttribute("aria-expanded")).toBe("false");
  });

  it("the value cell is keyboard reachable and Enter toggles dec/hex", () => {
    const b = withTree(boot());
    b.send({ kind: "live-sample", samples: [sample("sys.loop_hz", "0x00000508")] });
    const v = b.$('[data-name="sys.loop_hz"] td.v');
    expect(v?.getAttribute("tabindex")).toBe("0");
    expect(v?.getAttribute("role")).toBe("button");
    v?.dispatchEvent({ type: "keydown", key: "Enter", target: v });
    expect(v?.textContent).toBe("0x00000508");
    v?.dispatchEvent({ type: "keydown", key: " ", target: v });
    expect(v?.textContent).toBe("1288");
  });

  it("the collapse control is keyboard reachable too", () => {
    const b = withTree(boot());
    const head = b.$('[data-name="sys"] td.n');
    expect(head?.getAttribute("tabindex")).toBe("0");
    head?.dispatchEvent({ type: "keydown", key: "Enter", target: head });
    expect(b.$('[data-name="sys"]')?.dataset.collapsed).toBe("1");
  });
});

describe("sidebar: difference-based rendering", () => {
  it("a stream of live-sample updates cells in place with no innerHTML rebuild", () => {
    const b = withTree(boot());
    b.send({ kind: "live-sample", samples: [sample("sys.loop_hz", "0x00000508")] });
    const tr = b.$('[data-name="sys.loop_hz"]');
    const nameCell = tr?.children[0];
    for (let i = 0; i < 200; i += 1) {
      b.send({ kind: "live-sample", samples: [sample("sys.loop_hz", "0x00000" + (0x510 + i).toString(16))] });
    }
    expect(docStats.innerHtml).toBe(0);
    expect(b.$('[data-name="sys.loop_hz"]')).toBe(tr);
    expect(tr?.children[0]).toBe(nameCell);
    expect(tr?.children[1].textContent).toBe(String(0x510 + 199));
  });

  it("costs one value-cell write per sample, not four DOM writes", () => {
    const b = withTree(boot());
    const names = ["sys.loop_hz", "sys.bias", "drive.motor_timeout", "drive.mode"];
    b.send({ kind: "live-sample", samples: names.map((n) => sample(n, "0x00000001")) });
    const rows = names.map((n) => b.$(`[data-name="${n}"]`));
    const before = rows.map((r) => r?.children[1].__w ?? 0);
    const nameBefore = rows.map((r) => r?.children[0].__w ?? 0);
    for (let i = 0; i < 100; i += 1) {
      b.send({ kind: "live-sample", samples: names.map((n) => sample(n, "0x0000000" + (i % 9))) });
    }
    expect(rows.map((r) => r?.children[1].__w ?? 0).map((w, i) => w - before[i])).toEqual([100, 100, 100, 100]);
    // The name cell never changes after creation, so it must never be rewritten.
    expect(rows.map((r) => r?.children[0].__w ?? 0).map((w, i) => w - nameBefore[i])).toEqual([0, 0, 0, 0]);
  });

  it("an unknown variable arriving before live-types still gets a row", () => {
    const b = boot();
    b.send({ kind: "live-sample", samples: [sample("legacy.var", "0x0000002a")] });
    expect(b.$('[data-name="legacy.var"]')).not.toBeNull();
    expect(b.$('[data-name="legacy.var"]')?.children[1].textContent).toBe("0x0000002a 型不明");
  });

  it("a sample for a name outside the type tree is ignored, not invented as a row", () => {
    const b = withTree(boot());
    b.send({ kind: "live-sample", samples: [sample("not.in.tree", "0x00000001")] });
    expect(b.$('[data-name="not.in.tree"]')).toBeNull();
  });
});

describe("sidebar: bulk add (D4)", () => {
  it("adds every leaf of a group, with no cap", () => {
    // It used to stop at 32 and report the rest as 未追加. The host polls the
    // whole watchlist now, so slicing here only produced a watchlist that
    // looked complete and quietly was not: the user added the group, and 153
    // of its leaves were never watched.
    const b = withTree(boot(), bigTree("periph", 185));
    const add = b.$('[data-name="periph"] [data-op="add"]');
    add?.dispatchEvent({ type: "click", target: add });
    const names = b.posted.filter((m) => m.kind === "live-add").at(-1)?.names as string[];
    expect(names).toHaveLength(185);
    expect(names[0]).toBe("periph.leaf0");
    expect(names.at(-1)).toBe("periph.leaf184");
    const note = b.$('[data-testid="live-add-note"]')?.textContent ?? "";
    expect(note).toBe("periph : Periph: 185 件追加");
    expect(note).not.toContain("上限");
    expect(note).not.toContain("未追加");
  });

  it("says how many were added", () => {
    const b = withTree(boot(), bigTree("periph", 5));
    const add = b.$('[data-name="periph"] [data-op="add"]');
    add?.dispatchEvent({ type: "click", target: add });
    const note = b.$('[data-testid="live-add-note"]')?.textContent ?? "";
    expect(note).toBe("periph : Periph: 5 件追加");
  });

  it("adding the root subtree adds every leaf too", () => {
    const b = withTree(boot(), bigTree("periph", 185));
    const add = b.$('[data-name="DebugGlobal"] [data-op="add"]');
    add?.dispatchEvent({ type: "click", target: add });
    const names = b.posted.filter((m) => m.kind === "live-add").at(-1)?.names as string[];
    expect(names).toHaveLength(185);
  });
});

describe("sidebar: removal by prefix", () => {
  it("live-remove-names on a group drops every leaf row under it from the DOM", () => {
    const b = withTree(boot(), bigTree("periph", 6));
    b.send({ kind: "live-watchlist", names: ["periph.leaf0", "periph.leaf1"] });
    expect(b.$$('[data-kind="leaf"][data-name^="periph."]').length).toBe(6);
    const rm = b.$('[data-name="periph"] [data-op="remove"]');
    rm?.dispatchEvent({ type: "click", target: rm });
    expect(b.posted.at(-1)).toEqual({ kind: "live-remove-names", names: ["periph"] });
    expect(b.$$('[data-kind="leaf"][data-name^="periph."]').length).toBe(0);
  });

  it("removing one leaf only drops that leaf", () => {
    const b = withTree(boot());
    const rm = b.$('[data-name="drive.motor_timeout"] [data-op="remove"]');
    rm?.dispatchEvent({ type: "click", target: rm });
    expect(b.posted.at(-1)).toEqual({ kind: "live-remove-names", names: ["drive.motor_timeout"] });
    expect(b.$('[data-name="drive.motor_timeout"]')).toBeNull();
    expect(b.$('[data-name="drive.mode"]')).not.toBeNull();
  });

  it("a removed leaf stops receiving values and the empty state returns", () => {
    const b = withTree(boot(), bigTree("periph", 2));
    for (const n of ["periph.leaf0", "periph.leaf1"]) {
      const rm = b.$(`[data-name="${n}"] [data-op="remove"]`);
      rm?.dispatchEvent({ type: "click", target: rm });
    }
    b.send({ kind: "live-sample", samples: [sample("periph.leaf0", "0x00000009")] });
    expect(b.$('[data-name="periph.leaf0"]')).toBeNull();
    expect(b.$('[data-testid="live-empty"]')?.hidden).toBe(false);
  });

  it("the watchlist marks rows and never resurrects a removed one", () => {
    const b = withTree(boot(), bigTree("periph", 3));
    b.send({ kind: "live-watchlist", names: ["periph.leaf1"] });
    expect(b.$('[data-name="periph.leaf0"]')?.dataset.watched).toBe("0");
    expect(b.$('[data-name="periph.leaf1"]')?.dataset.watched).toBe("1");
    expect(b.$('[data-name="periph"]')?.children[1].textContent).toBe("1/3 監視");
  });
});

describe("sidebar: states and affordances", () => {
  it("the table has a thead and an empty state that tracks the row count", () => {
    const b = boot();
    expect(b.$$('[data-testid="live-tree"] th').map((t) => t.textContent)).toEqual(["変数", "値", "操作"]);
    expect(b.$('[data-testid="live-empty"]')?.hidden).toBe(false);
    withTree(b);
    expect(b.$('[data-testid="live-empty"]')?.hidden).toBe(true);
  });

  it("pause is one toggle and is visible on screen in both states", () => {
    const b = withTree(boot());
    b.send({ kind: "live-status", state: "running" });
    const t = b.$('[data-testid="live-pause-toggle"]');
    expect(b.$$('[data-testid="live-pause-toggle"]').length).toBe(1);
    expect(t?.textContent).toBe("一時停止");
    expect(b.$('[data-testid="live-state"]')?.textContent).toBe("監視中");
    t?.dispatchEvent({ type: "click", target: t });
    expect(b.posted.at(-1)).toEqual({ kind: "live-pause" });
    b.send({ kind: "live-status", state: "paused" });
    expect(t?.textContent).toBe("再開");
    expect(b.$('[data-testid="live-state"]')?.textContent).toBe("一時停止");
    t?.dispatchEvent({ type: "click", target: t });
    expect(b.posted.at(-1)).toEqual({ kind: "live-resume" });
  });

  it("shows the host's error text and detail instead of a bare state word", () => {
    // The host funnels every failure explanation through postStatus(text, detail)
    // (extension.ts:485-487, and :755 / :904 / :999 are the real call sites).
    const b = boot();
    b.send({ kind: "live-status", state: "error", text: "USBError: [Errno 110] Operation timed out" });
    expect(b.$('[data-testid="live-status-text"]')?.textContent).toBe("USBError: [Errno 110] Operation timed out");
    expect(b.$('[data-testid="live-state"]')?.textContent).toBe("エラー");
    b.send({
      kind: "live-status",
      state: "error",
      text: "プローブ競合のため開始しませんでした",
      detail: "別のセッションが ST-LINK を掴んでいます。サイドバー「停止」で解放してください。",
    });
    expect(b.$('[data-testid="live-status-text"]')?.textContent).toBe("プローブ競合のため開始しませんでした");
    expect(b.$('[data-testid="live-detail"]')?.textContent).toContain("別のセッションが ST-LINK を掴んでいます");
    // A later state push must not resurrect the stale reason.
    b.send({ kind: "live-status", state: "idle", text: "停止しました (プローブ解放)" });
    expect(b.$('[data-testid="live-status-text"]')?.textContent).toBe("停止しました (プローブ解放)");
    expect(b.$('[data-testid="live-detail"]')?.textContent).toBe("");
  });

  it("disables the eight live buttons and states why", () => {
    const b = boot();
    const why = (): string => b.$('[data-testid="live-why"]')?.textContent ?? "";
    expect(b.$('[data-testid="live-start"]')?.disabled).toBe(true);
    expect(why()).toContain("プロジェクト未選択");
    expect(b.$('[data-testid="live-export-csv"]')?.disabled).toBe(true);
    expect(b.$('[data-testid="live-stop"]')?.title).toBe("監視していません");
    b.send({ kind: "live-bootstrap", project: "/fw/a", hz: 100, state: { ...SIDEBAR_PANEL_DEFAULT_STATE, selectedDir: "/fw/a" } });
    expect(b.$('[data-testid="live-start"]')?.disabled).toBe(false);
    expect(why()).not.toContain("プロジェクト未選択");
    withTree(b);
    b.send({ kind: "live-status", state: "running" });
    expect(b.$('[data-testid="live-start"]')?.disabled).toBe(true);
    expect(b.$('[data-testid="live-stop"]')?.disabled).toBe(false);
    expect(b.$('[data-testid="live-export-csv"]')?.disabled).toBe(false);
    expect(why()).toContain("監視中です");
  });

  it("flash-retry is revealed by a failure and hidden again on the next attempt", () => {
    const b = boot();
    const retry = b.$('[data-testid="flash-retry"]');
    expect(retry?.hidden).toBe(true);
    b.send({ kind: "flash-progress", phase: "書き込み中 (verify 付き)…", percent: null });
    expect(retry?.hidden).toBe(true);
    b.send({ kind: "flash-progress", phase: "書き込み失敗: probe busy", percent: null });
    expect(retry?.hidden).toBe(false);
    expect(retry?.disabled).toBe(false);
    // extension.ts:2283 reports a missing configuration as a phase. It is not
    // a flash attempt, so 書込 must be usable again, not stuck on 書き込み中です.
    b.send({ kind: "live-bootstrap", project: "/fw/a", hz: 100, state: { ...SIDEBAR_PANEL_DEFAULT_STATE, elfPath: "build-ext/fw.elf" } });
    b.send({ kind: "flash-progress", phase: "設定不足: probe / interface / resetMode を設定してください", percent: null });
    expect(b.$('[data-testid="flash-start"]')?.disabled).toBe(false);
    expect(retry?.hidden).toBe(true);
    b.send({ kind: "flash-progress", phase: "先にビルドしてください", percent: null });
    expect(b.$('[data-testid="flash-start"]')?.disabled).toBe(false);
    b.send({ kind: "flash-progress", phase: "書き込み中 (verify 付き)…", percent: null });
    expect(b.$('[data-testid="flash-start"]')?.disabled).toBe(true);
    expect(b.$('[data-testid="flash-why"]')?.textContent).toContain("書き込み中");
    b.send({ kind: "flash-progress", phase: "failed", percent: null });
    expect(retry?.hidden).toBe(false);
    b.send({ kind: "flash-progress", phase: "erasing", percent: 0 });
    expect(retry?.hidden).toBe(true);
  });

  it("a successful flash leaves 書込 clickable again", () => {
    const b = boot();
    b.send({ kind: "live-bootstrap", project: "/fw/a", hz: 100, state: { ...SIDEBAR_PANEL_DEFAULT_STATE, elfPath: "build-ext/fw.elf" } });
    b.send({ kind: "flash-progress", phase: "書き込み成功 (verify OK)", percent: 100 });
    expect(b.$('[data-testid="flash-start"]')?.disabled).toBe(false);
    expect(b.$('[data-testid="flash-retry"]')?.hidden).toBe(true);
  });

  it("flash-start explains a missing ELF instead of silently doing nothing", () => {
    const b = boot();
    expect(b.$('[data-testid="flash-start"]')?.disabled).toBe(true);
    expect(b.$('[data-testid="flash-why"]')?.textContent).toContain("ELF がありません");
    b.send({ kind: "live-bootstrap", project: "/fw/a", hz: 100, state: { ...SIDEBAR_PANEL_DEFAULT_STATE, elfPath: "build-ext/fw.elf" } });
    expect(b.$('[data-testid="flash-start"]')?.disabled).toBe(false);
  });

  it("build progress reaches the screen and blocks a second build", () => {
    const b = boot();
    b.send({ kind: "live-bootstrap", project: "/fw/a", hz: 100, state: { ...SIDEBAR_PANEL_DEFAULT_STATE, selectedDir: "/fw/a" } });
    b.send({ kind: "build-progress", phase: "CC foo.c", percent: 40, done: 4, total: 10 });
    expect(b.$('[data-testid="build-pct"]')?.textContent).toBe("4/10 40%");
    expect(b.$('[data-testid="build-bar"]')?.getAttribute("value")).toBe("40");
    expect(b.$('[data-testid="build-pill"]')?.textContent).toBe("CC foo.c");
    expect(b.$('[data-testid="build-run"]')?.disabled).toBe(true);
  });

  it("project-select posts the dir of the row that was clicked", () => {
    const b = boot();
    b.send({
      kind: "live-bootstrap",
      project: "/fw/a",
      hz: 100,
      state: { ...SIDEBAR_PANEL_DEFAULT_STATE, selectedDir: "/fw/a", projects: [{ name: "a", dir: "/fw/a" }, { name: "b", dir: "/fw/b" }] },
    });
    const row = b.$('[data-dir="/fw/b"]');
    row?.dispatchEvent({ type: "click", target: row });
    expect(b.posted.at(-1)).toEqual({ kind: "project-select", dir: "/fw/b" });
  });

  it("drop, unresolved, write result and log all land as differences", () => {
    const b = withTree(boot());
    b.send({ kind: "live-drop", summary: "ticks=790 collected=787" });
    expect(b.$('[data-testid="live-drop-rate"]')?.textContent).toBe("ticks=790 collected=787");
    b.send({ kind: "live-unresolved", names: ["sys.gone"] });
    expect(b.$('[data-testid="live-unresolved"]')?.textContent).toBe("未解決 sys.gone");
    b.send({ kind: "live-write-result", message: "書き込ました" });
    expect(b.$('[data-testid="live-write-result"]')?.textContent).toBe("書き込ました");
    b.send({ kind: "log-append", lines: ["[live] started", "[live] tick"] });
    expect(b.$('[data-testid="log-tail"]')?.textContent).toContain("[live] started");
    expect(docStats.innerHtml).toBe(0);
  });

  it("the log offers clear, a filter that is reported, and an Output link", () => {
    const b = boot();
    expect(b.$('[data-testid="log-open"]')?.getAttribute("href")).toBe("command:stm32ext.showLog");
    b.send({ kind: "log-append", lines: ["[live] started", "[diag] probing"] });
    const filter = b.$('[data-testid="log-filter"]');
    filter!.value = "diag";
    filter?.dispatchEvent({ type: "input", target: filter });
    expect(b.$('[data-testid="log-tail"]')?.textContent).toBe("[diag] probing\n");
    b.tick();
    expect(b.posted.at(-1)).toEqual({ kind: "log-filter", text: "diag" });
    const clr = b.$('[data-testid="log-clear"]');
    clr?.dispatchEvent({ type: "click", target: clr });
    expect(b.posted.at(-1)).toEqual({ kind: "log-clear" });
    expect(b.$('[data-testid="log-tail"]')?.textContent).toBe("");
  });
});

describe("sidebar: graph section is a launcher plus a series list, not a second plot", () => {
  it("offers a launcher that routes to the real graph panel command", () => {
    const b = boot();
    const open = b.$('[data-testid="graph-open"]');
    expect(open?.getAttribute("href")).toBe("command:stm32ext.showGraph");
    expect(open?.getAttribute("role")).toBe("button");
    expect(open?.textContent).toBe("グラフを開く");
  });

  it("no longer renders a canvas, so there is exactly one plotter", () => {
    const b = boot();
    expect(b.$$("canvas").length).toBe(0);
    expect(b.$('[data-testid="graph-canvas"]')).toBeNull();
    expect(b.$('[data-section="graph"]')).not.toBeNull();
  });

  it("lists each series from graph-series with its visibility and colour", () => {
    const b = withTree(boot());
    b.send({
      kind: "graph-series",
      series: [
        { name: "sys.bias", color: "#4c9aff", visible: true },
        { name: "drive.mode", color: "#f78166", visible: false },
      ],
    });
    const rows = b.$$('[data-testid="graph-series"] li');
    expect(rows.map((r) => r.dataset.name)).toEqual(["sys.bias", "drive.mode"]);
    expect(rows.map((r) => r.dataset.visible)).toEqual(["1", "0"]);
    expect(rows[0].children[0].style.background).toBe("#4c9aff");
    expect(rows[1].children[3].textContent).toBe("非表示");
    // Only the visible series belong in the picker, so the list cannot disagree with it.
    expect(b.$('[data-testid="graph-input"]')?.getAttribute("value")).toBe("sys.bias");
  });

  it("shows the last DECODED value per series, updated in place, not the bit pattern", () => {
    const b = withTree(boot());
    b.send({ kind: "graph-series", series: [{ name: "sys.bias", color: "#4c9aff", visible: true }] });
    const li = b.$('[data-testid="graph-series"] li');
    expect(li?.children[2].textContent).toBe("—");
    const writesAtBuild = li?.children[2].__w ?? 0;
    b.send({ kind: "live-sample", samples: [sample("sys.bias", "0x3f800000")] });
    expect(li?.children[2].textContent).toBe("1.00000");
    b.send({ kind: "live-sample", samples: [sample("sys.bias", "0xc0490fdb")] });
    expect(li?.children[2].textContent).toBe("-3.14159");
    // Same <li> throughout, and only the value cell is rewritten: no re-render.
    expect(b.$('[data-testid="graph-series"] li')).toBe(li);
    expect((li?.children[2].__w ?? 0) - writesAtBuild).toBe(2);
  });

  it("an empty series set says so instead of showing a blank box", () => {
    const b = boot();
    expect(b.$('[data-testid="graph-series"] li')?.textContent).toBe("系列がありません");
    b.send({ kind: "graph-series", series: [{ name: "sys.loop_hz", color: "#4c9aff", visible: true }] });
    expect(b.$('[data-testid="graph-series"] li')?.dataset.name).toBe("sys.loop_hz");
  });

  it("add/remove gate on an empty name and post ONE message per name", () => {
    const b = boot();
    const add = b.$('[data-testid="graph-add"]');
    expect(add?.disabled).toBe(true);
    expect(b.$('[data-testid="graph-why"]')?.textContent).toContain("変数名を入力");
    const input = b.$('[data-testid="graph-input"]');
    input!.value = "sys.loop_hz";
    input?.dispatchEvent({ type: "input", target: input });
    expect(add?.disabled).toBe(false);
    add?.dispatchEvent({ type: "click", target: add });
    expect(b.posted.at(-1)).toEqual({ kind: "graph-add", name: "sys.loop_hz" });
    const rm = b.$('[data-testid="graph-remove"]');
    rm?.dispatchEvent({ type: "click", target: rm });
    expect(b.posted.at(-1)).toEqual({ kind: "graph-remove", name: "sys.loop_hz" });
  });

  it("a single leaf row can be added to the watch, not only whole groups", () => {
    // The leaf row used to carry only 変更 and 除外, so a single variable could
    // be removed but never added from the tree: the only route was the
    // QuickPick, or adding the entire parent group.
    const b = withTree(boot());
    const add = b.$('[data-name="drive.motor_timeout"] [data-op="add"]');
    expect(add).not.toBeNull();
    add?.dispatchEvent({ type: "click", target: add });
    // Exactly that one variable, not its siblings and not its parent group.
    expect(b.posted.at(-1)).toEqual({ kind: "live-add", names: ["drive.motor_timeout"] });
  });

  it("the graph input offers completion for leaves and struct groups", () => {
    const b = withTree(boot());
    const values = b.$$('[data-testid="graph-names"] option').map((o) => o.getAttribute("value"));
    // Every leaf is offered...
    expect(values).toContain("sys.loop_hz");
    expect(values).toContain("drive.emergency.req");
    // ...and so is every struct node above them: `drive.emergency` is a valid
    // graph target (the host expands it to its leaves), so hiding the groups
    // made the picker look incapable of something it does.
    expect(values).toContain("drive");
    expect(values).toContain("drive.emergency");
    expect(values).toContain("drive.controller");
    // Sorted, so the browser's own prefix filter walks them in order.
    expect([...values].sort()).toEqual(values);
  });

  it("the graph input is wired to the completion list", () => {
    const b = boot();
    expect(b.$('[data-testid="graph-input"]')?.getAttribute("list")).toBe("graph-name-list");
  });

  it("a multi-name picker posts one message per name, never a literal \"a, b\"", () => {
    // The host seeds this field with graphSeries.join(", ") (extension.ts:2118)
    // and adds a series by exact name, so the whole field must be split.
    const b = boot();
    const input = b.$('[data-testid="graph-input"]');
    input!.value = "sys.loop_hz, drive.mode ,  sys.bias ,";
    input?.dispatchEvent({ type: "input", target: input });
    b.posted.length = 0;
    b.$('[data-testid="graph-add"]')?.dispatchEvent({ type: "click", target: b.$('[data-testid="graph-add"]') });
    expect(b.posted).toEqual([
      { kind: "graph-add", name: "sys.loop_hz" },
      { kind: "graph-add", name: "drive.mode" },
      { kind: "graph-add", name: "sys.bias" },
    ]);
    b.posted.length = 0;
    b.$('[data-testid="graph-remove"]')?.dispatchEvent({ type: "click", target: b.$('[data-testid="graph-remove"]') });
    expect(b.posted).toEqual([
      { kind: "graph-remove", name: "sys.loop_hz" },
      { kind: "graph-remove", name: "drive.mode" },
      { kind: "graph-remove", name: "sys.bias" },
    ]);
    // And the local list follows the same three names.
    expect(b.$$('[data-testid="graph-series"] li').map((r) => r.dataset.name))
      .toEqual(["sys.loop_hz", "drive.mode", "sys.bias"]);
  });

  it("a host state push does not wipe a name the user is typing", () => {
    const b = boot();
    const input = b.$('[data-testid="graph-input"]');
    input!.focus();
    input!.value = "sys.l";
    // The host pushes state on every build settle / project select / flash phase.
    b.send({ kind: "live-bootstrap", project: "/fw/a", hz: 100, state: { ...SIDEBAR_PANEL_DEFAULT_STATE, graphSeries: ["sys.loop_hz"] } });
    expect(b.$('[data-testid="graph-input"]')?.getAttribute("value")).toBe("sys.l");
    // Once the field loses focus the host is authoritative again.
    input!.blur();
    b.send({ kind: "live-bootstrap", project: "/fw/a", hz: 100, state: { ...SIDEBAR_PANEL_DEFAULT_STATE, graphSeries: ["sys.loop_hz"] } });
    expect(b.$('[data-testid="graph-input"]')?.getAttribute("value")).toBe("sys.loop_hz");
  });
});

describe("parseSidebarMessage: new tree messages", () => {
  it("accepts live-add and live-remove-names with their name lists", () => {
    expect(parseSidebarMessage({ kind: "live-add", names: ["periph.a", "periph.b"] }))
      .toEqual({ kind: "live-add", dir: "", name: "", value: "", names: ["periph.a", "periph.b"] });
    expect(parseSidebarMessage({ kind: "live-remove-names", names: ["periph"] }))
      .toEqual({ kind: "live-remove-names", dir: "", name: "", value: "", names: ["periph"] });
    expect(parseSidebarMessage({ kind: "live-add", names: [] })).toBeNull();
    expect(parseSidebarMessage({ kind: "live-remove-names", names: "periph" })).toBeNull();
  });

  it("accepts the log controls", () => {
    expect(parseSidebarMessage({ kind: "log-clear" })?.kind).toBe("log-clear");
    expect(parseSidebarMessage({ kind: "log-filter", text: "drop" })?.name).toBe("drop");
  });

  it("keeps the four-field shape for every pre-existing kind", () => {
    expect(Object.keys(parseSidebarMessage({ kind: "live-write", name: "a", value: "1" }) as object))
      .toEqual(["kind", "dir", "name", "value"]);
  });
});
