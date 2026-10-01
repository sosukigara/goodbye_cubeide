// Single stacked sidebar: one webview carries every function, so opening the
// activity-bar icon is the only step needed. Sections are label-only — no
// guide paragraphs, no "(生監視)" style parentheticals.
import { describe, expect, it } from "vitest";
import { Script } from "node:vm";
import { renderSidebar, SIDEBAR_SECTIONS } from "../src/panels/sidebar.js";
import { SIDEBAR_PANEL_DEFAULT_STATE } from "../src/panels/sidebar.js";

function scriptsOf(html: string): string[] {
  const out: string[] = [];
  const re = /<script>([\s\S]*?)<\/script>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    out.push(m[1] ?? "");
  }
  return out;
}

describe("sidebar section inventory", () => {
  it("stacks exactly the five working sections, in order", () => {
    expect(SIDEBAR_SECTIONS.map((s) => s.id)).toEqual([
      "project", "build", "flash", "live", "graph", "log",
    ]);
  });

  it("titles are bare labels with no parentheticals or prose", () => {
    for (const s of SIDEBAR_SECTIONS) {
      expect(s.title).not.toMatch(/[()（）]/);
      expect(s.title.length).toBeLessThanOrEqual(8);
    }
  });
});

describe("sidebar html", () => {
  const html = renderSidebar(SIDEBAR_PANEL_DEFAULT_STATE);

  it("emits one section element per section id", () => {
    for (const s of SIDEBAR_SECTIONS) {
      expect(html).toContain(`data-section="${s.id}"`);
    }
  });

  it("carries the four working controls: build, flash, watch, write", () => {
    expect(html).toContain('data-testid="build-run"');
    expect(html).toContain('data-testid="build-flash"');
    expect(html).toContain('data-testid="flash-start"');
    expect(html).toContain('data-testid="live-start"');
    expect(html).toContain('data-testid="live-stop"');
    expect(html).toContain('data-testid="live-pause-toggle"');
    expect(html).toContain('data-testid="live-reconnect"');
    expect(html).toContain('data-testid="live-add-watch"');
    expect(html).toContain('data-testid="live-export-csv"');
  });

  it("live section is status + controls + a single tab link, nothing else", () => {
    expect(html).toContain('data-testid="live-state"');
    expect(html).toContain('data-testid="live-source"');
    expect(html).toContain('data-testid="live-hz"');
    expect(html).toContain('data-testid="live-drop-rate"');
    expect(html).toContain('data-testid="variable-open"');
    expect(html).toContain("command:stm32ext.showVariables");
    expect(html).toContain("変数をタブで開く");
    expect(html).toContain('data-testid="live-why"');
    expect(html).toContain('data-testid="live-status-text"');
    expect(html).toContain('data-testid="live-detail"');
    expect(html).not.toContain('data-testid="live-write-result"');
    expect(html).not.toContain('data-testid="live-unresolved"');
    expect(html).not.toContain('data-testid="live-search"');
    expect(html).not.toContain('data-testid="live-tree"');
    expect(html).not.toContain('data-testid="live-rows"');
    expect(html).not.toContain('data-testid="live-empty"');
    expect(html).not.toContain('data-testid="live-add-note"');
  });

  it("default state renders the current poll default, not the retired 50Hz", () => {
    expect(SIDEBAR_PANEL_DEFAULT_STATE.liveHz).toBe(100);
    expect(renderSidebar()).toContain('data-testid="live-hz">100Hz<');
    expect(renderSidebar()).not.toContain("50Hz");
  });

  it("has no guide paragraph or AI-flavored prose", () => {
    expect(html).not.toContain('class="guide"');
    expect(html).not.toContain("使いかた");
    expect(html).not.toContain("手順");
    expect(html).not.toContain("ここに表示");
    expect(html).not.toContain("邮编");
  });

  it("inline script parses as valid JavaScript", () => {
    const scripts = scriptsOf(html);
    expect(scripts.length).toBeGreaterThan(0);
    for (const body of scripts) {
      expect(() => new Script(body)).not.toThrow();
    }
  });
});

