import { describe, expect, it } from "vitest";
import { Script } from "node:vm";
import {
  BUILD_PANEL_TITLE,
  BUILD_PANEL_VIEW_TYPE,
  buildPanelHtml,
  mountBuildPanel,
  parseBuildPanelMessage,
  pushBuildPanelMessage,
  unmountBuildPanel,
  type BuildPanelSeed,
} from "../src/live/buildPanel.js";

const SEED: BuildPanelSeed = {
  state: {
    status: "failed",
    buildPercent: 42,
    elfPath: "/fw/build-ext/unit_omni3.elf",
    elapsedMs: 3200,
    diagnostics: [
      { kind: "error", file: "/fw/Core/Src/main.c", line: 12, col: 3, message: "boom" },
    ],
    failureCause: "link failed",
  },
};

function scriptOf(html: string): string {
  const m = /<script>([\s\S]*?)<\/script>/.exec(html);
  if (m === null) {
    throw new Error("build panel html has no inline script");
  }
  return m[1] ?? "";
}

describe("build tab document", () => {
  it("is self-contained and carries the settled state", () => {
    const html = buildPanelHtml(SEED);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain(BUILD_PANEL_TITLE);
    expect(html).toContain('data-testid="build-run"');
    expect(html).toContain('data-testid="build-diags"');
    expect(html).toContain("command:stm32ext.openBuildDiag");
    expect(() => new Script(scriptOf(html))).not.toThrow();
  });

  it("parses tab actions and rejects junk", () => {
    expect(parseBuildPanelMessage({ kind: "build-run" })).toBe("build-run");
    expect(parseBuildPanelMessage({ kind: "build-flash" })).toBe("build-flash");
    expect(parseBuildPanelMessage({ kind: "graph-add" })).toBeNull();
    expect(parseBuildPanelMessage(null)).toBeNull();
  });
});

describe("build tab mount wiring", () => {
  it("mount assigns the document once and forwards host messages", () => {
    const posted: unknown[] = [];
    const view = {
      options: {},
      html: "",
      postMessage: (msg: unknown): void => {
        posted.push(msg);
      },
    };
    expect(BUILD_PANEL_VIEW_TYPE).toBe("stm32ext.build");
    mountBuildPanel(view as never, SEED);
    expect(view.html).toContain(BUILD_PANEL_TITLE);
    pushBuildPanelMessage({ kind: "build-progress", percent: 7 });
    expect(posted).toEqual([{ kind: "build-progress", percent: 7 }]);
    unmountBuildPanel(view as never);
    pushBuildPanelMessage({ kind: "build-progress", percent: 8 });
    expect(posted).toHaveLength(1);
  });
});
