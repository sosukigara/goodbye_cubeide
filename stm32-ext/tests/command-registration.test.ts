// Regression guard for the class of defect where a user-visible affordance is
// declared or built but never reachable: a command listed in package.json with
// no `registerCommand`, or a webview document rendered by a module that no
// host path ever mounts. Both shipped once already in this extension —
// `stm32ext.showGraph` was registered but focused the sidebar, so `graphPanelHtml`
// was never called and the whole graph renderer was dead weight behind a green
// test suite.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  contributes: { commands: { command: string; title: string }[] };
  activationEvents: string[];
};
const extensionSource = readFileSync(join(root, "src/extension.ts"), "utf8");

describe("every declared command is registered", () => {
  const commands = pkg.contributes.commands;
  it("package.json declares commands", () => {
    expect(commands.length).toBeGreaterThan(0);
  });

  // The sidebar-focusing commands are registered from one array literal, so
  // parse that array instead of guessing from a substring.
  const loopIds: string[] = [
    ...extensionSource.matchAll(/for \(const cmd of \[([\s\S]*?)\]\)/g),
  ].flatMap((m) => [...(m[1] ?? "").matchAll(/"([^"]+)"/g)].map((s) => s[1] ?? ""));

  for (const { command, title } of commands) {
    it(`registers ${command}`, () => {
      const individually = extensionSource.includes(`registerCommand("${command}"`);
      expect(individually || loopIds.includes(command)).toBe(true);
      expect(title.trim()).not.toBe("");
    });
  }

  it("no command is registered twice", () => {
    const ids = commands.map((c) => c.command);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("the graph panel is actually mounted", () => {
  it("the host creates the panel it renders", () => {
    expect(extensionSource).toContain("createWebviewPanel");
    expect(extensionSource).toContain("GRAPH_PANEL_VIEW_TYPE");
    expect(extensionSource).toContain("graphPanel.mount(");
  });

  it("opening the graph command does not just focus the sidebar", () => {
    const at = extensionSource.indexOf('registerCommand("stm32ext.showGraph"');
    expect(at).toBeGreaterThan(-1);
    const body = extensionSource.slice(at, at + 200);
    expect(body).toContain("openGraphPanel");
    expect(body).not.toContain("openSidebar");
  });

  it("the sidebar exposes a launcher for it", () => {
    const sidebar = readFileSync(join(root, "src/panels/sidebar.ts"), "utf8");
    expect(sidebar).toContain("command:stm32ext.showGraph");
  });

  it("opening the build command mounts the editor-area build tab", () => {
    const at = extensionSource.indexOf('registerCommand("stm32ext.showBuild"');
    expect(at).toBeGreaterThan(-1);
    expect(extensionSource.slice(at, at + 200)).toContain("openBuildPanel");
    expect(extensionSource).toContain("mountBuildPanel(");
    const sidebar = readFileSync(join(root, "src/panels/sidebar.ts"), "utf8");
    expect(sidebar).toContain("command:stm32ext.showBuild");
  });
});

describe("the panel inventory stays at six", () => {
  it("exactly one webview view is contributed", () => {
    const views = (pkg.contributes as unknown as {
      views: Record<string, { id: string; type: string }[]>;
    }).views;
    const all = Object.values(views).flat();
    expect(all).toHaveLength(1);
    expect(all[0]?.type).toBe("webview");
  });
});
