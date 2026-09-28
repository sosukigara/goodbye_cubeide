import { describe, expect, it } from "vitest";
import {
  discoverProjects,
  getSelectedDir,
  parseProjectPanelMessage,
  setSelectedDir,
} from "../src/project/discover.js";
import { renderSidebar, SIDEBAR_PANEL_DEFAULT_STATE } from "../src/panels/sidebar.js";

const FW_MAIN = "/home/so/robocon_ubuntu/NHK2026/nhk-2026-b-ros-android-controller/main";

describe("multi-project discovery (read-only FW tree)", () => {
  it("finds all container projects under main/", () => {
    const found = discoverProjects(FW_MAIN);
    const names = found.map((p) => p.name);
    expect(names).toContain("unit_omni3");
    expect(names).toContain("unit_pc-stm");
    expect(found.length).toBeGreaterThanOrEqual(2);
    for (const p of found) {
      expect(p.dir.startsWith(FW_MAIN)).toBe(true);
    }
  });
  it(".ioc-only dir is not a buildable project (.cproject is source of truth)", () => {
    const found = discoverProjects(FW_MAIN);
    const names = found.map((p) => p.name);
    // pid_tuner_stm_bridge has only .ioc + .ld, no .cproject -> not buildable,
    // .ioc is regen-watch only (plan constraint G1).
    expect(names).not.toContain("pid_tuner_stm_bridge");
  });
  it("single-project mode returns the root itself", () => {
    const found = discoverProjects(`${FW_MAIN}/unit_omni3`);
    expect(found).toEqual([{ name: "unit_omni3", dir: `${FW_MAIN}/unit_omni3` }]);
  });
  it("missing dir returns empty (no throw)", () => {
    expect(discoverProjects("/no/such/dir-xyz")).toEqual([]);
  });
  it("selection state round-trips", () => {
    setSelectedDir(undefined);
    expect(getSelectedDir()).toBeUndefined();
    setSelectedDir("/fw/unit_omni3");
    expect(getSelectedDir()).toBe("/fw/unit_omni3");
    setSelectedDir(undefined);
  });
  it("sidebar project section lists projects with select buttons", () => {
    const html = renderSidebar({
      ...SIDEBAR_PANEL_DEFAULT_STATE,
      projects: [
        { name: "unit_omni3", dir: "/fw/unit_omni3" },
        { name: "unit_pc-stm", dir: "/fw/unit_pc-stm" },
      ],
      selectedDir: "/fw/unit_omni3",
    });
    expect(html).toContain("unit_omni3");
    expect(html).toContain("unit_pc-stm");
    expect(html).toContain('data-testid="project-select"');
    expect(html).toContain('data-testid="project-refresh"');
  });
  it("project panel message parser accepts only known kinds", () => {
    expect(parseProjectPanelMessage({ kind: "select-project" })).toBe("select-project");
    expect(parseProjectPanelMessage({ kind: "refresh" })).toBe("refresh");
    expect(parseProjectPanelMessage({ kind: "nope" })).toBeNull();
  });
});
