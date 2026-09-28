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
# is 976 B with 324 scalar leaves, 26 nested structs and 3 arrays.
EXPECTED_LEAVES = 324
EXPECTED_STRUCT_NODES = 26
EXPECTED_ARRAY_NODES = 3


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


def test_offsets_monotonic_within_debugglobal():
    p = run([sys.executable, RESOLVE, ELF, "--json"])
    assert p.returncode == 0, p.stderr
    res = json.loads(p.stdout)
    base, size = int(res["base"], 16), res["size"]
    for s in res["symbols"]:
        assert 0 <= s["offset"] < size, s
        assert int(s["address"], 16) == base + s["offset"], s


def test_stripped_elf_demands_g3(tmp_path):
    stripped = str(tmp_path / "stripped.elf")
    p = run(["arm-none-eabi-objcopy", "--strip-debug", ELF, stripped])
    assert p.returncode == 0, p.stderr
    p = run([sys.executable, RESOLVE, stripped, "--json"])
    assert p.returncode == 2
    assert "-g3" in p.stderr


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
    assert len(nodes) == EXPECTED_STRUCT_NODES + EXPECTED_ARRAY_NODES == 29
    # nested children (D9), not a flat node list with parent ids
    assert depth(tree) >= 3
    assert all("parent" not in n for n in nodes)
    # every container recursed into, and every tree leaf is a pollable symbol
    assert len(leaves(tree)) == EXPECTED_LEAVES
    assert {n["path"] for n in leaves(tree)} == {s["name"] for s in res["symbols"]}


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


def _build_fixture(directory, dwarf):
    src = directory / "fixture.c"
    obj = directory / f"fixture{dwarf}.o"
    elf = directory / f"fixture{dwarf}.elf"
    src.write_text(FIXTURE_C, encoding="utf-8")
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
