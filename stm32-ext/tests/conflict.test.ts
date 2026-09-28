import { describe, expect, it } from "vitest";
import { CUBEIDE_RUNNING_MESSAGE, detectConflicts, findOwnPollPids } from "../src/probe/conflict.js";

describe("cubeide conflict detection", () => {
  it("detects running cubeide processes", () => {
    const r = detectConflicts("init\nstm32cubeide_wa\nstm32cubeide\njava\ncode\n");
    expect(r.cubeIde).toBe(true);
    expect(r.details).toContain("stm32cubeide_wa");
  });
  it("detects stlink server/gdbserver holders", () => {
    expect(detectConflicts("stlink-server\n").cubeIde).toBe(true);
    expect(detectConflicts("ST-Link_gdbserver\n").cubeIde).toBe(true);
  });
  it("clean tree reports no conflict", () => {
    const r = detectConflicts("init\ncode\nnode\npython3\n");
    expect(r.cubeIde).toBe(false);
    expect(r.details).toEqual([]);
  });
  it("message tells the user what to do (JP)", () => {
    expect(CUBEIDE_RUNNING_MESSAGE).toContain("CubeIDEを完全終了");
    expect(CUBEIDE_RUNNING_MESSAGE).toContain("DEV_CONNECT_ERR");
  });
});

describe("findOwnPollPids (flash-time self-probe reclaim)", () => {
  const MARKER = "/home/u/.vscode/extensions/goodbye-cubeide.stm32-ext-0.8.2/scripts";
  const fit = (pid: number): string =>
    `${pid} python3 ${MARKER}/live_poll.py --resolution /tmp/x/live-resolution.json --out /tmp/x/live.csv --hz 10`;
  it("fits: matches own live_poll.py lines carrying our scripts-dir marker", () => {
    const ps = `  PID ARGS\n    1 init\n ${fit(101)}\n ${fit(202)}\n`;
    expect(findOwnPollPids(ps, MARKER)).toEqual([101, 202]);
  });
  it("excludes: foreign python without our marker is never matched", () => {
    const ps = [
      "  301 python3 /other/install/scripts/live_poll.py --out /tmp/y/live.csv",
      "  302 python3 -m http.server",
      `  303 ${MARKER}/elf_resolve.py firmware.elf --json`,
      `  304 ${MARKER}/live_poll_helper.py --out /tmp/z`,
      "  305 stm32cubeide_wa",
      "  306 stlink-server",
      ` ${fit(407)}`,
      "",
    ].join("\n");
    expect(findOwnPollPids(ps, MARKER)).toEqual([407]);
  });
  it("excludes: unparsable lines and our own process pid", () => {
    const ps = [
      `no-pid-here python3 ${MARKER}/live_poll.py --out /tmp/w/live.csv`,
      `  ${process.pid} python3 ${MARKER}/live_poll.py --out /tmp/self/live.csv`,
      `  509 python3 ${MARKER}/live_poll.py --out /tmp/w/live.csv`,
    ].join("\n");
    expect(findOwnPollPids(ps, MARKER)).toEqual([509]);
  });
});
