import { describe, expect, it } from "vitest";
import { mergeSuggestions, scanSourceVars } from "../src/live/varscan.js";

const SRC = `#include "x.hpp"
// comment line
int g_counter = 0;
static volatile uint32_t s_ticks;
float k gains[4] = {1};
void loop() {
  int local = 1;
  g_counter += local;
}
int proto(int x);
struct S { int m; };
S s_instance;
#define MAX 10
`;

describe("source variable scan", () => {
  it("finds file-scope globals, skips locals/functions/macros", () => {
    const names = scanSourceVars("Core/Src/code.cpp", SRC).map((v) => v.name);
    expect(names).toContain("g_counter");
    expect(names).toContain("s_ticks");
    expect(names).toContain("s_instance");
    expect(names).not.toContain("local");
    expect(names).not.toContain("loop");
    expect(names).not.toContain("proto");
    expect(names).not.toContain("MAX");
    expect(names).not.toContain("m");
  });
  it("mergeSuggestions dedupes resolved names first", () => {
    const merged = mergeSuggestions(
      ["sys.loop_hz"],
      [
        { name: "sys.loop_hz", file: "a.cpp", line: 1 },
        { name: "my_gain", file: "code.cpp", line: 10 },
        { name: "my_gain", file: "code.cpp", line: 20 },
      ],
    );
    expect(merged.map((m) => m.name)).toEqual(["sys.loop_hz", "my_gain"]);
    expect(merged[1]?.detail).toContain("code.cpp:10");
  });
});
