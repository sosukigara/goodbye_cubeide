"""todo5a/5b pytest: real-ELF symbol resolution + mock-probe polling.

Run with: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest tests/test_elf_resolve.py -q
Hardware is NOT required: polling is verified via --mock. The integration
wave (todo6) runs the same sidecar against a real ST-LINK.

Added with the DWARF type tree (spec S1):
  * every leaf of DebugGlobal resolves, with a real width and signedness
  * the nested `tree` is walked, not a flat list (spec D9)
  * typedef chains are followed down to DW_TAG_base_type
  * the nm+readelf fallback backend must not raise (P0-14)
  * enum / bitfield / anonymous-member paths, which the real firmware does
    not contain, are covered by a synthetic DWARF fixture built here.
"""
import csv
import json
import os
import shutil
import subprocess
import sys

import pytest

EXT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ELF = os.path.join(EXT, "build-ext", "unit_omni3.elf")
RESOLVE = os.path.join(EXT, "scripts", "elf_resolve.py")
POLL = os.path.join(EXT, "scripts", "live_poll.py")

# Ground truth measured from build-ext/unit_omni3.elf (spec 1.2): DebugGlobal
# is 976 B with 338 leaves (324 scalar + 14 array-element leaves: 8 floats
# and 3x2 fdcan struct fields), 29 nested structs (26 + 3 fdcan elements)
# and 3 arrays.
EXPECTED_LEAVES = 338
EXPECTED_STRUCT_NODES = 29
EXPECTED_ARRAY_NODES = 3

# The tests below assert against the REAL project firmware, which only exists
# after a build (`ninja -C build-ext`). A fresh clone has no build-ext/, so
# without this they all fail on a missing file — a red suite that says nothing
# about the resolver and reads as "the repo is broken". Skipping keeps the
# signal honest: the DWARF fixture tests (which compile their own ELF) still
# run everywhere, and the firmware tests run the moment someone builds.
needs_firmware_elf = pytest.mark.skipif(
    not os.path.exists(ELF),
    reason=f"real firmware ELF missing: {ELF} (build the project first)",
)


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def resolve(elf=ELF, args=()):
    """Run the resolver and return the parsed JSON (fails the test on error)."""
    p = run([sys.executable, RESOLVE, elf, "--json", *args])
    assert p.returncode == 0, p.stderr
    return json.loads(p.stdout)


def walk(tree):
    """Yield every node below `tree`, containers and leaves alike."""
    for child in tree.get("children", []):
        yield child
        yield from walk(child)


def containers(tree):
    return [n for n in walk(tree) if n["kind"] in ("struct", "array")]


def leaves(tree):
    return [n for n in walk(tree) if n["kind"] not in ("struct", "array")]


def leaf_by_name(res, name):
    return next(s for s in res["symbols"] if s["name"] == name)


def depth(node):
    if not node.get("children"):
        return 1
    return 1 + max(depth(c) for c in node["children"])


# ---------------------------------------------------------------------------
# real firmware ELF
# ---------------------------------------------------------------------------

@needs_firmware_elf
def test_debug_symbol_resolves_in_sram():
    assert os.path.exists(ELF), f"real firmware ELF missing: {ELF}"
    p = run([sys.executable, RESOLVE, ELF, "--json"])
    assert p.returncode == 0, p.stderr
    res = json.loads(p.stdout)
    base = int(res["base"], 16)
    assert 0x20000000 <= base < 0x20040000, res["base"]
    assert res["size"] > 0
    assert res["has_debug_info"] is True
    names = {s["name"] for s in res["symbols"]}
    assert "sys.loop_hz" in names
    assert "drive.drive_mode" in names


@needs_firmware_elf
def test_offsets_monotonic_within_debugglobal():
    p = run([sys.executable, RESOLVE, ELF, "--json"])
    assert p.returncode == 0, p.stderr
    res = json.loads(p.stdout)
    base, size = int(res["base"], 16), res["size"]
    for s in res["symbols"]:
        assert 0 <= s["offset"] < size, s
        assert int(s["address"], 16) == base + s["offset"], s


@needs_firmware_elf
def test_stripped_elf_demands_g3(tmp_path):
    stripped = str(tmp_path / "stripped.elf")
    p = run(["arm-none-eabi-objcopy", "--strip-debug", ELF, stripped])
    assert p.returncode == 0, p.stderr
    p = run([sys.executable, RESOLVE, stripped, "--json"])
    assert p.returncode == 2
    assert "-g3" in p.stderr


@needs_firmware_elf
def test_mock_poll_csv_schema_and_rows(tmp_path):
    resolution = str(tmp_path / "resolution.json")
    out = str(tmp_path / "live.csv")
    p = run([sys.executable, RESOLVE, ELF, "--json"])
    assert p.returncode == 0, p.stderr
    with open(resolution, "w", encoding="utf-8") as f:
        f.write(p.stdout)
    p = run([sys.executable, POLL, "--resolution", resolution, "--out", out,
             "--hz", "50", "--seconds", "1", "--mock"])
    assert p.returncode == 0, p.stderr + p.stdout
    with open(out, "rb") as f:
        first = f.readline().rstrip(b"\r\n")
    assert first == b"timestamp,address,name,value"
    with open(out, encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    assert len(rows) > 0
    assert set(rows[0].keys()) == {"timestamp", "address", "name", "value"}
    assert rows[0]["name"] == "sys.loop_hz"


# ---------------------------------------------------------------------------
# --all-members: the whole type, not a curated list
# ---------------------------------------------------------------------------

@needs_firmware_elf
def test_all_members_resolves_every_leaf_with_empty_unresolved():
    res = resolve(args=["--all-members"])
    assert res["unresolved"] == []
    assert len(res["symbols"]) == EXPECTED_LEAVES
    assert len(res["index"]) == EXPECTED_LEAVES
    assert len({s["name"] for s in res["symbols"]}) == EXPECTED_LEAVES
    for s in res["symbols"]:
        assert s["size"] > 0, s           # every leaf has a real read width
        assert s["kind"] != "struct", s   # only leaves are pollable (D4/D11)
        assert s["kind"] != "array", s
        assert s["type"] != "?", s         # every type name was resolved


@needs_firmware_elf
def test_tree_is_nested_and_covers_the_whole_struct():
    res = resolve(args=["--all-members"])
    tree = res["tree"]
    assert tree["kind"] == "struct"
    assert tree["name"] == "debug"
    assert tree["path"] == ""
    # top-level `size` is the window span; tree root `size` is the struct span
    assert tree["size"] == res["size"] == 976
    nodes = containers(tree)
    structs = [n for n in nodes if n["kind"] == "struct"]
    arrays = [n for n in nodes if n["kind"] == "array"]
    assert len(structs) == EXPECTED_STRUCT_NODES
    assert len(arrays) == EXPECTED_ARRAY_NODES
    assert len(nodes) == EXPECTED_STRUCT_NODES + EXPECTED_ARRAY_NODES == 32
    # nested children (D9), not a flat node list with parent ids
    assert depth(tree) >= 3
    assert all("parent" not in n for n in nodes)
    # every container recursed into, and every tree leaf is a pollable symbol
    assert len(leaves(tree)) == EXPECTED_LEAVES
    assert {n["path"] for n in leaves(tree)} == {s["name"] for s in res["symbols"]}


@needs_firmware_elf
def test_tree_leaf_paths_address_the_same_bytes_as_symbols():
    res = resolve(args=["--all-members"])
    base = int(res["base"], 16)
    by_name = {s["name"]: s for s in res["symbols"]}
    for node in leaves(res["tree"]):
        sym = by_name[node["path"]]
        assert node["offset"] == sym["offset"], node
        assert node["size"] == sym["size"], node
        assert node["address"] == sym["address"], node
        assert int(sym["address"], 16) == base + sym["offset"]


@needs_firmware_elf
def test_leaf_size_follows_the_typedef_chain_to_the_base_type():
    index = resolve(args=["--all-members"])["index"]
    # `uint32_t` is a DW_TAG_typedef whose own DW_AT_byte_size is 0, so a
    # resolver that stops at the typedef reports width 0 for 58 leaves.
    assert index["sys.loop_hz"] == {
        "size": 4, "kind": "scalar", "signed": False, "type": "uint32_t"}
    assert index["comm.link.w5500_version"]["size"] == 1   # uint8_t
    assert index["sys.initialized"]["size"] == 1          # bool
    assert index["drive.drive_mode"] == {
        "size": 4, "kind": "scalar", "signed": True, "type": "int"}
    assert index["nav.robot_yaw_deg"]["size"] == 4        # float
    assert not [n for n, m in index.items() if m["size"] == 0], index


@needs_firmware_elf
def test_signedness_uses_the_numeric_encoding_constant():
    index = resolve(args=["--all-members"])["index"]
    # DW_ATE_signed (0x05)
    assert index["drive.drive_mode"]["signed"] is True
    assert index["nav.robot_yaw_deg"]["signed"] is True
    # DW_ATE_unsigned (0x07) and DW_ATE_boolean (0x02)
    assert index["sys.loop_hz"]["signed"] is False
    assert index["comm.link.w5500_version"]["signed"] is False
    assert index["sys.initialized"]["signed"] is False
    assert index["sys.initialized"]["kind"] == "bool"
    assert index["nav.robot_yaw_deg"]["kind"] == "float"
    # a substring test for "signed" would flip all of these
    for name, meta in index.items():
        if meta["type"] == "uint32_t":
            assert meta["signed"] is False, name


@needs_firmware_elf
def test_drive_controller_is_sixteen_independent_one_byte_bools():
    res = resolve(args=["--all-members"])
    ctl = [s for s in res["symbols"]
           if s["name"].startswith("drive.controller.")]
    assert len(ctl) == 16
    assert [s["size"] for s in ctl] == [1] * 16
    assert {s["kind"] for s in ctl} == {"bool"}
    node = next(n for n in containers(res["tree"])
                if n["path"] == "drive.controller")
    assert node["kind"] == "struct"
    assert node["type"] == "Controller"   # the DWARF type name is shown too
    assert node["size"] == 16
    assert len(node["children"]) == 16
    # byte offsets advance one at a time: independent bools, not a bitfield
    relative = sorted(c["offset"] - node["offset"] for c in node["children"])
    assert relative == list(range(16))
    assert all("bit_size" not in c for c in node["children"])


@needs_firmware_elf
def test_arrays_report_element_count_and_are_not_pollable():
    res = resolve(args=["--all-members"])
    arrays = {n["path"]: n for n in containers(res["tree"])
              if n["kind"] == "array"}
    assert set(arrays) == {
        "periph.fdcan",
        "periph.dji_current.target_current_a",
        "periph.dji_current.now_current_a",
    }
    assert arrays["periph.fdcan"]["length"] == 3
    assert arrays["periph.fdcan"]["size"] == 24        # 3 x 8 byte element
    assert arrays["periph.dji_current.target_current_a"]["length"] == 4
    assert arrays["periph.dji_current.target_current_a"]["size"] == 16
    assert arrays["periph.dji_current.target_current_a"]["type"] == "float[4]"
    # D4/D11: an array is browsable but is not a poll row
    for path in arrays:
        assert path not in res["index"]
    # the byte span it claims must fit the struct that holds it
    for node in containers(res["tree"]):
        for child in node["children"]:
            if child["kind"] == "array":
                span = child["offset"] - node["offset"]
                assert span + child["size"] <= node["size"], child


@needs_firmware_elf
def test_curated_default_watchlist_still_works():
    res = resolve()
    assert res["unresolved"] == []
    assert len(res["symbols"]) == 10
    assert [s["name"] for s in res["symbols"]][:2] == [
        "sys.loop_hz", "sys.loop_period_us"]
    # the curated list now carries real widths instead of 0
    assert leaf_by_name(res, "sys.loop_hz")["size"] == 4
    assert leaf_by_name(res, "drive.motor_timeout")["size"] == 1
    # the tree still describes everything, watchlist or not
    assert len(leaves(res["tree"])) == EXPECTED_LEAVES
    assert len(res["index"]) == EXPECTED_LEAVES


@needs_firmware_elf
def test_explicit_member_selection_and_unknown_names():
    res = resolve(args=["--member", "sys.loop_hz", "--member", "no.such.leaf"])
    assert [s["name"] for s in res["symbols"]] == ["sys.loop_hz"]
    assert res["unresolved"] == ["no.such.leaf"]


# ---------------------------------------------------------------------------
# P0-14: the nm+readelf fallback must not raise, and must agree
# ---------------------------------------------------------------------------

def _blocked_pyelftools(directory):
    """A directory whose `elftools` cannot be imported."""
    shim = directory / "shim"
    shim.mkdir(exist_ok=True)
    (shim / "elftools.py").write_text(
        'raise ImportError("pyelftools disabled for the fallback test")\n',
        encoding="utf-8")
    return str(shim)


@needs_firmware_elf
def test_fallback_backend_resolves_without_pyelftools(tmp_path):
    p = run([sys.executable, RESOLVE, ELF, "--all-members", "--json"],
            env={**os.environ,
                 "PYTHONPATH": _blocked_pyelftools(tmp_path)})
    assert p.returncode == 0, p.stderr
    fallback = json.loads(p.stdout)
    assert fallback["backend"] == "nm+readelf"
    assert fallback["unresolved"] == []
    assert len(fallback["symbols"]) == EXPECTED_LEAVES

    reference = resolve(args=["--all-members"])
    assert fallback["symbols"] == reference["symbols"]
    assert fallback["tree"] == reference["tree"]
    assert fallback["index"] == reference["index"]


@needs_firmware_elf
def test_fallback_backend_reports_stripped_elf_too(tmp_path):
    stripped = str(tmp_path / "stripped.elf")
    p = run(["arm-none-eabi-objcopy", "--strip-debug", ELF, stripped])
    assert p.returncode == 0, p.stderr
    p = run([sys.executable, RESOLVE, stripped, "--json"],
            env={**os.environ,
                 "PYTHONPATH": _blocked_pyelftools(tmp_path)})
    assert p.returncode == 2
    assert "-g3" in p.stderr


# ---------------------------------------------------------------------------
# synthetic DWARF fixture
#
# The real firmware has zero bitfields and zero enum leaves under DebugGlobal
# (spec 1.2), so those paths can only be covered by a purpose-built ELF. The
# same fixture carries genuinely anonymous struct members, which this GCC
# never emits for unit_omni3.
# ---------------------------------------------------------------------------

FIXTURE_C = r"""
#include <stdint.h>
#include <stdbool.h>

typedef enum { MODE_IDLE = 0, MODE_FOLLOW = 2, MODE_STOP = -1 } DriveMode;

struct DebugGlobal {
  uint32_t counter;      /* typedef chain -> DW_TAG_base_type, width 4 */
  int32_t  delta;        /* signed base type reached through a typedef */
  int8_t   s8;
  uint8_t  u8;
  int16_t  s16;
  float    f32;
  bool     flag;         /* DW_ATE_boolean, one byte */
  char     label[12];    /* char array -> string leaf */
  uint8_t  hist[4];      /* plain array -> array container node */
  DriveMode mode;        /* enum leaf with enumerators */
  struct {                /* anonymous member: no DW_AT_name at all */
    uint16_t req_active;
    uint8_t  level;
  };
  struct {                /* second anonymous member: order must decide */
    uint32_t ticks;
    int16_t  bias;
  };
  struct {                /* bitfields, DWARF3+ encoding */
    unsigned a : 3;
    unsigned b : 5;
    unsigned c : 1;
  } bits;
  int32_t wide_bits : 9;  /* signed bitfield wider than one byte */
  struct {                /* named member holding another anonymous struct */
    struct { uint32_t deep; } inner;
  } nested;
};

volatile struct DebugGlobal debug;
"""

GCC = shutil.which("arm-none-eabi-gcc")


def _build_fixture(directory, dwarf, source=FIXTURE_C):
    src = directory / "fixture.c"
    obj = directory / f"fixture{dwarf}.o"
    elf = directory / f"fixture{dwarf}.elf"
    src.write_text(source, encoding="utf-8")
    p = run([GCC, "-mcpu=cortex-m4", "-mthumb", f"-gdwarf-{dwarf}", "-O0",
             "-std=gnu11", "-c", str(src), "-o", str(obj)])
    assert p.returncode == 0, p.stderr
    p = run([GCC, "-mcpu=cortex-m4", "-mthumb", "-nostdlib", "-Wl,-e,0",
             "-o", str(elf), str(obj)])
    assert p.returncode == 0, p.stderr
    return str(elf)


@pytest.fixture(scope="session")
def fixture_elf(tmp_path_factory):
    """Synthetic DWARF5 ELF: enum, bitfields, anonymous members, char array."""
    if GCC is None:
        pytest.skip("arm-none-eabi-gcc not available for the DWARF fixture")
    return _build_fixture(tmp_path_factory.mktemp("dwarf5"), 5)


@pytest.fixture(scope="session")
def fixture_elf_dwarf2(tmp_path_factory):
    """Same source at -gdwarf-2: the older DW_AT_bit_offset encoding."""
    if GCC is None:
        pytest.skip("arm-none-eabi-gcc not available for the DWARF fixture")
    return _build_fixture(tmp_path_factory.mktemp("dwarf2"), 2)


def test_fixture_enum_leaf_lists_its_enumerators(fixture_elf):
    res = resolve(fixture_elf, args=["--all-members"])
    mode = leaf_by_name(res, "mode")
    assert mode["kind"] == "enum"
    assert mode["signed"] is True
    assert mode["size"] == 1        # ARM defaults to -fshort-enums here
    assert mode["enumerators"] == [
        {"name": "MODE_IDLE", "value": 0},
        {"name": "MODE_FOLLOW", "value": 2},
        {"name": "MODE_STOP", "value": -1},   # a negative value survives
    ]
    assert res["index"]["mode"]["enumerators"] == mode["enumerators"]


def test_fixture_bitfields_resolve_with_the_dwarf3_encoding(fixture_elf):
    res = resolve(fixture_elf, args=["--all-members"])
    assert res["unresolved"] == []
    by_name = {s["name"]: s for s in res["symbols"]}
    for name, bit_size, byte_off, bit_off in [
            ("bits.a", 3, 48, 0), ("bits.b", 5, 48, 3), ("bits.c", 1, 49, 0),
            ("wide_bits", 9, 52, 0)]:
        leaf = by_name[name]
        assert leaf["kind"] == "bitfield", leaf
        assert leaf["bit_size"] == bit_size, leaf
        assert leaf["offset"] == byte_off, leaf
        assert leaf["bit_offset"] == bit_off, leaf
    # the read window must cover every bit of the field
    assert by_name["wide_bits"]["size"] == 2
    assert by_name["bits.a"]["size"] == 1
    assert by_name["wide_bits"]["signed"] is True   # int32_t bitfield
    for name in ("bits.a", "bits.b", "bits.c", "wide_bits"):
        assert res["index"][name]["bit_size"] > 0


def test_fixture_bitfields_resolve_with_the_dwarf2_encoding(fixture_elf_dwarf2):
    """DW_AT_bit_offset counts from the storage unit, so it needs re-anchoring."""
    res = resolve(fixture_elf_dwarf2, args=["--all-members"])
    assert res["unresolved"] == []
    by_name = {s["name"]: s for s in res["symbols"]}
    assert by_name["bits.a"]["kind"] == "bitfield"
    assert by_name["bits.a"]["bit_size"] == 3
    # bit_offset 29 inside a 4 byte unit that starts at byte 48 lands on byte
    # 51 bit 5. Treating DW_AT_bit_offset as an absolute bit offset would
    # report byte 3 instead, i.e. the wrong field entirely.
    assert by_name["bits.a"]["offset"] == 51
    assert by_name["bits.a"]["bit_offset"] == 5
    assert by_name["bits.b"]["offset"] == 51
    assert by_name["bits.b"]["bit_offset"] == 0
    assert by_name["bits.c"]["offset"] == 50
    assert by_name["bits.c"]["bit_offset"] == 7
    assert by_name["wide_bits"]["offset"] == 54
    assert by_name["wide_bits"]["bit_offset"] == 7
    assert by_name["wide_bits"]["size"] == 2


def test_fixture_anonymous_members_get_stable_synthesized_names(fixture_elf):
    res = resolve(fixture_elf, args=["--all-members"])
    names = [s["name"] for s in res["symbols"]]
    assert "10.req_active" in names, names
    assert "10.level" in names
    assert "11.ticks" in names
    assert "11.bias" in names
    # a synthesized segment is a bare declaration index, never a blank
    assert not [n for n in names if n.startswith(".") or n.endswith(".")]
    # the anonymous members are tree nodes too; nothing was dropped
    nodes = {n["path"]: n for n in containers(res["tree"])}
    assert nodes["10"]["kind"] == "struct"
    assert nodes["10"]["type"] == "struct <anonymous>"
    assert len(nodes["10"]["children"]) == 2
    assert nodes["11"]["size"] == 8
    # two anonymous levels under a named member
    assert "nested.inner.deep" in names
    assert nodes["nested.inner"]["type"] == "struct <anonymous>"
    # declaration order decides the segment, and it is stable across runs
    again = resolve(fixture_elf, args=["--all-members"])
    assert [s["name"] for s in again["symbols"]] == names


def test_fixture_char_array_is_a_string_leaf_and_plain_array_is_not(fixture_elf):
    res = resolve(fixture_elf, args=["--all-members"])
    label = leaf_by_name(res, "label")
    assert label["kind"] == "string"
    assert label["length"] == 12
    assert label["size"] == 12
    assert label["type"] == "char[12]"
    hist = next(n for n in containers(res["tree"]) if n["path"] == "hist")
    assert hist["kind"] == "array"
    assert hist["length"] == 4
    assert hist["size"] == 4
    assert "hist" not in res["index"]


def test_fixture_typedef_widths_and_signedness(fixture_elf):
    index = resolve(fixture_elf, args=["--all-members"])["index"]
    assert index["counter"] == {"size": 4, "kind": "scalar",
                                "signed": False, "type": "uint32_t"}
    assert index["delta"] == {"size": 4, "kind": "scalar",
                              "signed": True, "type": "int32_t"}
    assert index["s8"] == {"size": 1, "kind": "scalar",
                           "signed": True, "type": "int8_t"}
    assert index["u8"] == {"size": 1, "kind": "scalar",
                           "signed": False, "type": "uint8_t"}
    assert index["s16"] == {"size": 2, "kind": "scalar",
                            "signed": True, "type": "int16_t"}
    assert index["f32"] == {"size": 4, "kind": "float",
                            "signed": True, "type": "float"}
    assert index["flag"] == {"size": 1, "kind": "bool",
                             "signed": False, "type": "_Bool"}


def test_fixture_fallback_backend_agrees_with_pyelftools(fixture_elf, tmp_path):
    p = run([sys.executable, RESOLVE, fixture_elf, "--all-members", "--json"],
            env={**os.environ, "PYTHONPATH": _blocked_pyelftools(tmp_path)})
    assert p.returncode == 0, p.stderr
    fallback = json.loads(p.stdout)
    assert fallback["backend"] == "nm+readelf"
    reference = resolve(fixture_elf, args=["--all-members"])
    assert fallback["symbols"] == reference["symbols"]
    assert fallback["tree"] == reference["tree"]


# ---------------------------------------------------------------------------
# name-agnostic tree root: the struct is whatever the `debug` global's
# DW_AT_type points at, not the hardcoded STRUCT_NAME ("DebugGlobal").
# Covers a real project whose global struct is named `Debug` (unit_swerve):
# the symbol resolves (base+size) while the type tree came back null.
# ---------------------------------------------------------------------------

FIXTURE_C_RENAMED = r"""
#include <stdint.h>
#include <stdbool.h>

struct Telemetry {
  uint32_t counter;
  int16_t  delta;
  bool     flag;
  struct {
    uint8_t level;
    uint8_t mode;
  } sub;
};

volatile struct Telemetry debug;
"""


@pytest.fixture(scope="session")
def renamed_elf(tmp_path_factory):
    """Same shape as the firmware, but the struct is NOT named DebugGlobal."""
    if GCC is None:
        pytest.skip("arm-none-eabi-gcc not available for the DWARF fixture")
    return _build_fixture(tmp_path_factory.mktemp("renamed"), 5,
                           FIXTURE_C_RENAMED)


def test_renamed_struct_resolves_tree_from_debug_variable(renamed_elf):
    res = resolve(renamed_elf, args=["--all-members"])
    assert res["tree"] is not None
    assert res["tree"]["type"] == "Telemetry"
    names = [s["name"] for s in res["symbols"]]
    assert "counter" in names
    assert "sub.level" in names
    assert res["unresolved"] == []


def test_renamed_struct_fallback_backend_agrees(renamed_elf, tmp_path):
    p = run([sys.executable, RESOLVE, renamed_elf, "--all-members", "--json"],
            env={**os.environ, "PYTHONPATH": _blocked_pyelftools(tmp_path)})
    assert p.returncode == 0, p.stderr
    fallback = json.loads(p.stdout)
    assert fallback["backend"] == "nm+readelf"
    assert fallback["tree"] is not None
    assert fallback["tree"]["type"] == "Telemetry"
    reference = resolve(renamed_elf, args=["--all-members"])
    assert fallback["symbols"] == reference["symbols"]
    assert fallback["tree"] == reference["tree"]


def _load_resolver_module():
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "elf_resolve", os.path.join(EXT, "scripts", "elf_resolve.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_debug_variable_selection_ignores_member_and_type_dies():
    mod = _load_resolver_module()
    telemetry, decoy = {"off": 1}, {"off": 2}
    nodes = [
        {"tag": "DW_TAG_structure_type", "name": "Outer",
         "type": None, "children": []},
        # a member named `debug`: its parent is a struct, not a global
        {"tag": "DW_TAG_member", "name": "debug", "type": 90,
         "children": []},
        # a type (typedef) named `debug`: not a variable either
        {"tag": "DW_TAG_typedef", "name": "debug", "type": 91,
         "children": []},
        # the one true global: variable DIE pointing at the real struct
        {"tag": "DW_TAG_variable", "name": "debug", "type": 1,
         "children": []},
        {"tag": "DW_TAG_structure_type", "name": "Telemetry",
         "type": None, "children": [],
         "off": 1, "byte_size": 8},
        # stale-name decoy: must lose to the variable's own type
        {"tag": "DW_TAG_structure_type", "name": "DebugGlobal",
         "type": None, "children": [],
         "off": 2, "byte_size": 4},
    ]
    by_off = {1: nodes[4], 2: nodes[5], 90: None, 91: None}
    root, actual = mod._variable_root(nodes, by_off.get)
    assert root is not None
    assert root["name"] == "Telemetry"
    assert actual == "Telemetry"


# ---------------------------------------------------------------------------
# --catalog: every writable RAM variable becomes a browsable root, not just
# the one named `debug`. The fixture carries a renamed struct plus extra RAM
# variables in different sections (.data, .noinit) so the catalog path is
# actually exercised without copying a multi-MB firmware ELF into the repo.
# ---------------------------------------------------------------------------

FIXTURE_C_CATALOG = r"""
#include <stdint.h>
#include <stdbool.h>

struct TelemetryCatalog {
  uint32_t counter;
  int16_t  delta;
  struct { uint8_t level; uint8_t mode; } sub;
};

volatile struct TelemetryCatalog debug;   /* .bss */
uint32_t extra_ticks = 0x12345678;        /* .data: initialized */
__attribute__((section(".noinit"))) uint8_t noinit_blob[8];  /* RAM bank */
"""


@pytest.fixture(scope="session")
def catalog_elf(tmp_path_factory):
    """Renamed struct plus extra RAM variables outside .bss."""
    if GCC is None:
        pytest.skip("arm-none-eabi-gcc not available for the DWARF fixture")
    return _build_fixture(tmp_path_factory.mktemp("catalog"), 5,
                           FIXTURE_C_CATALOG)


def test_catalog_lists_every_ram_variable_with_display(catalog_elf):
    res = resolve(catalog_elf, args=["--all-members", "--catalog"])
    assert isinstance(res["catalog_skipped"], int)
    names = {r["name"] for r in res["roots"]}
    assert "debug" in names
    assert "extra_ticks" in names
    assert "noinit_blob" in names
    for root in res["roots"]:
        assert {"name", "path", "address", "size", "type", "kind"} <= set(root)
        assert root["path"] == root["name"]
        assert root["address"].startswith("0x")
        assert root["size"] > 0
        assert isinstance(root["display"], str) and root["display"]
    dbg = next(r for r in res["roots"] if r["name"] == "debug")
    assert dbg["kind"] == "struct"
    assert dbg["display"] == "debug"
    assert {c["path"] for c in dbg["children"]} >= {
        "debug.counter", "debug.delta", "debug.sub"}
    scalar = next(r for r in res["roots"] if r["name"] == "extra_ticks")
    assert scalar["kind"] == "scalar"
    assert scalar.get("children", []) == []
    assert scalar["size"] == 4
    assert "debug.counter" in res["index"]
    assert "debug.sub.level" in res["index"]
    assert "extra_ticks" in res["index"]
    assert "noinit_blob" in res["index"]


def test_catalog_is_additive_and_absent_without_flag(catalog_elf):
    plain = resolve(catalog_elf, args=["--all-members"])
    assert "roots" not in plain
    assert "catalog_skipped" not in plain
    cat = resolve(catalog_elf, args=["--all-members", "--catalog"])
    assert cat["tree"] == plain["tree"]
    assert cat["base"] == plain["base"] and cat["size"] == plain["size"]
    for name, meta in plain["index"].items():
        assert cat["index"][name] == meta
    for sym in plain["symbols"]:
        assert sym in cat["symbols"]


def test_catalog_fallback_backend_agrees(catalog_elf, tmp_path):
    p = run([sys.executable, RESOLVE, catalog_elf, "--all-members",
             "--catalog", "--json"],
            env={**os.environ, "PYTHONPATH": _blocked_pyelftools(tmp_path)})
    assert p.returncode == 0, p.stderr
    fallback = json.loads(p.stdout)
    assert fallback["backend"] == "nm+readelf"
    reference = resolve(catalog_elf, args=["--all-members", "--catalog"])
    assert fallback["roots"] == reference["roots"]
    assert fallback["symbols"] == reference["symbols"]
    assert fallback["index"] == reference["index"]
    assert fallback["catalog_skipped"] == reference["catalog_skipped"]


# ---------------------------------------------------------------------------
# catalog-only: DWARF present but no `debug` symbol at all. The resolver must
# exit 0 with a usable catalog (roots/flats/index) and an explicit zero
# window, instead of failing with exit 2. Without --catalog the old
# MissingDebug exit-2 behaviour is kept.
# ---------------------------------------------------------------------------

FIXTURE_C_NO_DEBUG = r"""
#include <stdint.h>
uint32_t extra_ticks = 0x12345678;
__attribute__((section(".noinit"))) uint8_t noinit_blob[8];
"""


@pytest.fixture(scope="session")
def no_debug_elf(tmp_path_factory):
    """DWARF ELF with RAM variables but no `debug` symbol."""
    if GCC is None:
        pytest.skip("arm-none-eabi-gcc not available for the DWARF fixture")
    return _build_fixture(tmp_path_factory.mktemp("nodebug"), 5,
                           FIXTURE_C_NO_DEBUG)


def test_no_debug_symbol_yields_catalog_only_body(no_debug_elf):
    res = resolve(no_debug_elf, args=["--all-members", "--catalog"])
    assert res["tree"] is None
    assert res["size"] == 0
    assert res["base"] == "0x00000000"
    assert res["end"] == "0x00000000"
    assert res["has_debug_info"] is True
    assert isinstance(res["catalog_skipped"], int)
    names = {r["name"] for r in res["roots"]}
    assert "extra_ticks" in names
    assert "noinit_blob" in names
    assert len(res["symbols"]) > 0
    assert {s["name"] for s in res["symbols"]} == set(res["index"])
    assert res["unresolved"] == []


def test_no_debug_without_catalog_still_exit_2(no_debug_elf):
    p = run([sys.executable, RESOLVE, no_debug_elf, "--all-members", "--json"])
    assert p.returncode == 2
    assert "debug" in p.stderr


def test_no_debug_fallback_backend_agrees(no_debug_elf, tmp_path):
    p = run([sys.executable, RESOLVE, no_debug_elf, "--all-members",
             "--catalog", "--json"],
            env={**os.environ, "PYTHONPATH": _blocked_pyelftools(tmp_path)})
    assert p.returncode == 0, p.stderr
    fallback = json.loads(p.stdout)
    assert fallback["backend"] == "nm+readelf"
    assert fallback["tree"] is None
    assert fallback["size"] == 0
    assert fallback["base"] == "0x00000000"
    reference = resolve(no_debug_elf, args=["--all-members", "--catalog"])
    assert fallback["roots"] == reference["roots"]
    assert fallback["symbols"] == reference["symbols"]
    assert fallback["index"] == reference["index"]


def test_debug_global_shape_unchanged(catalog_elf):
    res = resolve(catalog_elf, args=["--all-members", "--catalog"])
    assert res["tree"] is not None
    assert res["tree"]["type"] == "TelemetryCatalog"
    assert res["size"] > 0
    assert res["base"] != "0x00000000"


# ---------------------------------------------------------------------------
# array elements as watchable leaves: DW_TAG_array_type children are
# subranges, never members, so the member walker alone dropped every array.
# ---------------------------------------------------------------------------

FIXTURE_C_ARRAYS = r"""
#include <stdint.h>
#include <stdbool.h>

typedef enum { MODE_IDLE = 0, MODE_FOLLOW = 2, MODE_STOP = -1 } DriveMode;

struct Pose { float x; float y; };
struct Inner { char tag[8]; uint32_t id; };
struct Bits { unsigned a : 3; unsigned b : 5; };

struct DebugGlobal {
  float v[3];
  char name[16];
  struct Pose poses[3];
  float grid[2][3];
  struct Inner items[2];
  struct Bits bits_arr[2];
  DriveMode modes[2];
  int zero[0];
  int tail[];
};

volatile struct DebugGlobal debug;
float cal_table[4];
"""


@pytest.fixture(scope="session")
def array_elf(tmp_path_factory):
    """Struct + global arrays: floats, strings, structs, multidim, bits."""
    if GCC is None:
        pytest.skip("arm-none-eabi-gcc not available for the DWARF fixture")
    return _build_fixture(tmp_path_factory.mktemp("arrays"), 5,
                           FIXTURE_C_ARRAYS)


def _node_by_path(res, path):
    return next(n for n in walk(res["tree"]) if n["path"] == path)


def test_array_float_leaves_with_correct_addresses(array_elf):
    res = resolve(array_elf, args=["--all-members"])
    base = int(res["base"], 16)
    node = _node_by_path(res, "v")
    assert node["kind"] == "array"
    assert node["length"] == 3
    assert node["size"] == 12
    assert len(node["children"]) == 3
    assert "v" not in res["index"]
    for i in range(3):
        leaf = leaf_by_name(res, f"v[{i}]")
        assert leaf["kind"] == "float"
        assert leaf["type"] == "float"
        assert leaf["size"] == 4
        assert leaf["signed"] is True
        assert int(leaf["address"], 16) == base + node["offset"] + 4 * i
        assert leaf["offset"] == node["offset"] + 4 * i
        assert res["index"][f"v[{i}]"]["kind"] == "float"


def test_array_char_stays_a_single_string_leaf(array_elf):
    res = resolve(array_elf, args=["--all-members"])
    label = leaf_by_name(res, "name")
    assert label["kind"] == "string"
    assert label["length"] == 16
    assert label["size"] == 16
    assert label["type"] == "char[16]"
    assert not [s["name"] for s in res["symbols"]
                if s["name"].startswith("name[")]


def test_array_of_structs_recurses_into_members(array_elf):
    res = resolve(array_elf, args=["--all-members"])
    base = int(res["base"], 16)
    node = _node_by_path(res, "poses")
    assert node["kind"] == "array"
    assert len(node["children"]) == 3
    for i in range(3):
        elem = _node_by_path(res, f"poses[{i}]")
        assert elem["kind"] == "struct"
        assert elem["type"] == "Pose"
        for field, off in (("x", 0), ("y", 4)):
            leaf = leaf_by_name(res, f"poses[{i}].{field}")
            assert leaf["kind"] == "float"
            assert leaf["size"] == 4
            assert leaf["offset"] == node["offset"] + 8 * i + off
            assert int(leaf["address"], 16) == base + leaf["offset"]
    assert "poses" not in res["index"]


def test_array_multidim_nests_outer_first(array_elf):
    res = resolve(array_elf, args=["--all-members"])
    base = int(res["base"], 16)
    node = _node_by_path(res, "grid")
    assert node["kind"] == "array"
    assert node["length"] == 6
    assert node["size"] == 24
    assert len(node["children"]) == 2
    names = [s["name"] for s in res["symbols"] if s["name"].startswith("grid")]
    assert names == [f"grid[{i}][{j}]" for i in range(2) for j in range(3)]
    for i in range(2):
        row = _node_by_path(res, f"grid[{i}]")
        assert row["kind"] == "array"
        assert len(row["children"]) == 3
        for j in range(3):
            leaf = leaf_by_name(res, f"grid[{i}][{j}]")
            assert leaf["kind"] == "float"
            assert leaf["size"] == 4
            assert leaf["offset"] == node["offset"] + 12 * i + 4 * j
            assert int(leaf["address"], 16) == base + leaf["offset"]


def test_array_nested_char_and_bitfield_struct_arrays(array_elf):
    res = resolve(array_elf, args=["--all-members"])
    by_name = {s["name"]: s for s in res["symbols"]}
    # char array inside a struct array stays a string leaf per element
    for i in range(2):
        tag = by_name[f"items[{i}].tag"]
        assert tag["kind"] == "string"
        assert tag["size"] == 8
        assert tag["length"] == 8
        assert by_name[f"items[{i}].id"]["kind"] == "scalar"
    assert not [n for n in by_name if n.startswith("items[") and ".tag[" in n]
    # bitfield struct array keeps the re-anchored read window per element
    elem0 = _node_by_path(res, "bits_arr[0]")
    elem1 = _node_by_path(res, "bits_arr[1]")
    assert elem1["offset"] - elem0["offset"] == elem0["size"]
    for i in range(2):
        for field, bit_size in (("a", 3), ("b", 5)):
            leaf = by_name[f"bits_arr[{i}].{field}"]
            assert leaf["kind"] == "bitfield", leaf
            assert leaf["bit_size"] == bit_size, leaf
            assert leaf["offset"] == elem0["offset"] + elem0["size"] * i
            assert res["index"][leaf["name"]]["bit_size"] == bit_size


def test_array_enum_elements_carry_enumerators(array_elf):
    res = resolve(array_elf, args=["--all-members"])
    for i in range(2):
        leaf = leaf_by_name(res, f"modes[{i}]")
        assert leaf["kind"] == "enum"
        assert leaf["type"] == "DriveMode"
        assert leaf["enumerators"] == [
            {"name": "MODE_IDLE", "value": 0},
            {"name": "MODE_FOLLOW", "value": 2},
            {"name": "MODE_STOP", "value": -1},
        ]
        assert res["index"][leaf["name"]]["enumerators"] == leaf["enumerators"]


def test_array_zero_length_produces_no_leaves(array_elf):
    res = resolve(array_elf, args=["--all-members"])
    for path in ("zero", "tail"):
        node = _node_by_path(res, path)
        assert node["kind"] == "array"
        assert node["children"] == []
    assert not [s["name"] for s in res["symbols"]
                if s["name"].startswith("zero[") or s["name"].startswith("tail[")]


def test_array_node_is_group_while_elements_carry_element_kind(array_elf):
    res = resolve(array_elf, args=["--all-members"])
    node = _node_by_path(res, "v")
    assert node["kind"] == "array"
    assert {c["kind"] for c in node["children"]} == {"float"}
    assert {c["path"] for c in node["children"]} == {
        "v[0]", "v[1]", "v[2]"}
    assert all(c["name"] == f"[{i}]" for i, c in enumerate(node["children"]))
    grid = _node_by_path(res, "grid")
    assert grid["kind"] == "array"
    assert grid["children"][0]["kind"] == "array"


def test_array_catalog_global_has_element_leaves(array_elf):
    res = resolve(array_elf, args=["--all-members", "--catalog"])
    cal = next(r for r in res["roots"] if r["name"] == "cal_table")
    assert cal["kind"] == "array"
    assert len(cal["children"]) == 4
    names = [s["name"] for s in res["symbols"] if "cal_table" in s["name"]]
    assert names == ["cal_table"] + [f"cal_table[{i}]" for i in range(4)]
    for i in range(4):
        assert res["index"][f"cal_table[{i}]"]["kind"] == "float"
        assert res["index"][f"cal_table[{i}]"]["size"] == 4


def test_array_fallback_backend_agrees(array_elf, tmp_path):
    p = run([sys.executable, RESOLVE, array_elf, "--all-members", "--json"],
            env={**os.environ, "PYTHONPATH": _blocked_pyelftools(tmp_path)})
    assert p.returncode == 0, p.stderr
    fallback = json.loads(p.stdout)
    assert fallback["backend"] == "nm+readelf"
    reference = resolve(array_elf, args=["--all-members"])
    assert fallback["symbols"] == reference["symbols"]
    assert fallback["tree"] == reference["tree"]
    assert fallback["index"] == reference["index"]
