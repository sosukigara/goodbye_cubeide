// Audit round 1: sidebar webview robustness.
// 1. A missing `graph-input` element must not kill the whole sidebar script:
//    every `gi` dereference is guarded the way `rows`/`cf`/`lf`/`la` already are.
// 2. `expandGraphNames` was dead code (defined, never called): the script must
//    parse and the graph-add flow must post identical messages without it.
//
// Harness below mirrors tests/sidebar-ui.test.ts (stub DOM parsed from the
// exact emitted HTML, run in node:vm), plus a `dropGraphInput` switch that
// removes the input after parsing to simulate renderer drift.
import { describe, expect, it } from "vitest";
import { Script, createContext } from "node:vm";
import {
  renderSidebar,
  SIDEBAR_SCRIPT,
  SIDEBAR_PANEL_DEFAULT_STATE,
  type SidebarState,
} from "../src/panels/sidebar.js";

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
  if (!matchCompound(el, parts[parts.length - 1]!)) return false;
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
  const top = (): StubEl => stack[stack.length - 1]!;
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
      el.setAttribute(am[1]!, decodeEntities(am[2] ?? ""));
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
  send(data: unknown): void;
  tick(): void;
  $(sel: string): StubEl | null;
  $$(sel: string): StubEl[];
}

function boot(state: SidebarState = SIDEBAR_PANEL_DEFAULT_STATE, dropGraphInput = false): Booted {
  const root = parseHtml(renderSidebar(state));
  if (dropGraphInput) {
    // Renderer drift: the input the script captured as `gi` is absent, so
    // `el('graph-input')` returns null and every `gi.` touch must be guarded.
    root.querySelector('[data-testid="graph-input"]')?.remove();
  }
  const body = root.querySelector("body") ?? root;
  const posted: Record<string, unknown>[] = [];
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
    prompt: () => null,
  };
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
    $: (s: string) => root.querySelector(s),
    $$: (s: string) => root.querySelectorAll(s),
  };
}

// --------------------------------------------------------------------- tests
describe("audit-round1: sidebar survives a missing graph-input element", () => {
  it("evaluates the script and keeps the surviving controls responding", () => {
    // Before the fix this throws during top-level evaluation:
    // TypeError: Cannot read properties of null (reading 'value')
    // at applySeries(gi.value), killing every button and renderer at once.
    const b = boot(SIDEBAR_PANEL_DEFAULT_STATE, true);
    expect(b.$('[data-testid="graph-input"]')).toBeNull();
    // A state round-trip still lands: the live pill updates in place.
    b.send({ kind: "live-status", state: "running" });
    expect(b.$('[data-testid="live-state"]')?.textContent).toBe("監視中");
    // A surviving button still posts: 停止 fires live-stop while running.
    const stop = b.$('[data-testid="live-stop"]');
    stop?.dispatchEvent({ type: "click", target: stop });
    expect(b.posted.at(-1)).toEqual({ kind: "live-stop" });
    // The host state path that re-seeds the input must not throw either.
    b.send({ kind: "live-bootstrap", project: "/fw/a", hz: 100, state: { ...SIDEBAR_PANEL_DEFAULT_STATE, graphSeries: ["sys.loop_hz"] } });
    expect(b.$('[data-testid="live-state"]')?.textContent).toBe("監視中");
    // And the graph-series message path renders the list without the input.
    b.send({ kind: "graph-series", series: [{ name: "sys.loop_hz", color: "#4c9aff", visible: true }] });
    expect(b.$('[data-testid="graph-series"] li')?.dataset.name).toBe("sys.loop_hz");
  });
});

describe("audit-round1: expandGraphNames deletion changed nothing observable", () => {
  it("the dead function is gone and the script still parses", () => {
    expect(SIDEBAR_SCRIPT).not.toContain("expandGraphNames");
    expect(() => new Script(SIDEBAR_SCRIPT)).not.toThrow();
  });

  it("the graph-add flow still splits nothing and posts the parse shape verbatim", () => {
    // The parse layer never depended on the CSV helper: the add path asks the
    // host picker with the field's text as the seed, exactly as it arrives.
    const b = boot();
    const input = b.$('[data-testid="graph-input"]');
    input!.value = "sys.loop_hz, drive.mode";
    input?.dispatchEvent({ type: "input", target: input });
    b.posted.length = 0;
    b.$('[data-testid="graph-add"]')?.dispatchEvent({ type: "click", target: b.$('[data-testid="graph-add"]') });
    expect(b.posted).toEqual([
      { kind: "var-pick", query: "sys.loop_hz, drive.mode" },
    ]);
  });
});
