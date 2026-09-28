import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EXT_VERSION } from "../src/version.js";

describe("version badge", () => {
  it("EXT_VERSION matches package.json version", () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as { version: string };
    expect(EXT_VERSION).toBe(pkg.version);
  });
});
