// Panel webview <script> syntax audit: a single stray line kills the whole
// panel script (all buttons + rendering dead). Every renderer's inline
// scripts must parse as valid JavaScript.
import { describe, expect, it } from "vitest";
import { Script } from "node:vm";
import { graphPanelHtml } from "../src/live/graphPanel.js";
import { renderSidebar, SIDEBAR_PANEL_DEFAULT_STATE } from "../src/panels/sidebar.js";

function scriptsOf(html: string): string[] {
  const out: string[] = [];
  const re = /<script>([\s\S]*?)<\/script>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    out.push(m[1] ?? "");
  }
  return out;
}

const PANELS: [string, () => string][] = [
  ["sidebar", () => renderSidebar(SIDEBAR_PANEL_DEFAULT_STATE)],
  ["graph", () => graphPanelHtml(["sys.loop_hz"])],
];

describe("panel script syntax audit", () => {
  for (const [name, render] of PANELS) {
    it(`${name}: inline scripts parse`, () => {
      const scripts = scriptsOf(render());
      expect(scripts.length).toBeGreaterThan(0);
      for (const body of scripts) {
        expect(() => new Script(body), `${name} script must parse`).not.toThrow();
      }
    });
  }
});

// No renderer may reintroduce guide paragraphs or chatty parentheticals.
const BANNED = [
  'class="guide"',
  "使いかた",
  "手順",
  "おすすめ",
  "ここに表示",
  "邮编",
  "(生監視)",
  "(対象選択)",
  "(書き込み)",
  "(グラフ)",
];

describe("no AI-flavored prose in any renderer", () => {
  for (const [name, render] of PANELS) {
    it(`${name}: carries no guide text`, () => {
      const html = render();
      for (const phrase of BANNED) {
        expect(html, `${name} must not contain ${phrase}`).not.toContain(phrase);
      }
    });
  }
});
