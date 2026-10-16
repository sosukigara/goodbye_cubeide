"""pytest: the one-shot probe worker (mock only, no hardware).

Run with: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest tests/test_probe_op.py -q

Every op round-trips through the real stdin/stdout wire as a subprocess,
always with "mock": true: no pyocd import, no probe enumeration, no bus
touch beyond the in-process MockProbe. Real-probe paths are exercised by
hand against hardware, never here.
"""
import json
import os
import re
import subprocess
import sys

import pytest

sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))

HERE = os.path.dirname(os.path.abspath(__file__))
WORKER = os.path.join(os.path.dirname(HERE), "scripts", "probe_op.py")
FIXTURE = os.path.join(HERE, "fixtures", "mock-resolution.json")


def run_op(payload=None, raw=None):
    """One wire round-trip: (exit code, stdout JSON, stderr text)."""
    body = raw if raw is not None else json.dumps(payload)
    p = subprocess.run([sys.executable, WORKER], input=body,
                       capture_output=True, text=True, timeout=60)
    return p.returncode, json.loads(p.stdout), p.stderr


def base_req(op, **kw):
    req = {"op": op, "elf": "x", "target": "stm32g474retx",
           "mock": True, "resolution": FIXTURE}
    req.update(kw)
    return req


def test_import_has_no_side_effects():
    p = subprocess.run(
        [sys.executable, "-c",
         "import sys; sys.path.insert(0,'scripts'); import probe_op"],
        capture_output=True, text=True, timeout=60,
        cwd=os.path.join(HERE, os.pardir))
    assert p.returncode == 0
    assert p.stdout == "" and p.stderr == ""


def test_resolve_ok():
    code, out, _ = run_op(base_req("resolve", name="sys.u32"))
    assert code == 0
    assert out["ok"] is True
    assert out["symbol"] == {"name": "sys.u32", "address": "0x20000000",
                             "size": 4, "type": "uint32_t",
                             "kind": "scalar", "signed": False}


def test_resolve_unknown_name_refused():
    code, out, _ = run_op(base_req("resolve", name="nope.missing"))
    assert code == 2
    assert out == {"ok": False, "op": "resolve", "stage": "resolve",
                   "error": out["error"]}
    assert "refused:" in out["error"]
    assert "(not in ELF resolution)" in out["error"]


def test_resolve_missing_elf_and_resolution():
    code, out, _ = run_op({"op": "resolve", "mock": True, "name": "sys.u32"})
    assert code == 2
    assert out["ok"] is False
    assert out["stage"] == "resolve"


def test_get_u32_hex_width():
    code, out, _ = run_op(base_req("get", name="sys.u32"))
    assert code == 0
    assert out["ok"] is True
    assert out["size"] == 4
    assert re.fullmatch(r"0x[0-9a-f]{8}", out["value"])


def test_get_bool_hex_width():
    code, out, _ = run_op(base_req("get", name="sys.flag"))
    assert code == 0
    assert re.fullmatch(r"0x[0-9a-f]{2}", out["value"])


def test_get_stale_symbol_refused():
    code, out, _ = run_op(base_req("get", name="sys.gone"))
    assert code == 2
    assert out["ok"] is False
    assert out["stage"] == "resolve"
    assert "(not in ELF resolution)" in out["error"]


def test_poll_samples_count_times_names():
    code, out, _ = run_op(base_req(
        "poll", names=["sys.u32", "sys.flag"], count=3, interval_ms=0))
    assert code == 0
    assert out["ok"] is True
    assert out["count"] == 3 and out["intervalMs"] == 0
    assert [(s["tick"], s["name"]) for s in out["samples"]] == [
        (0, "sys.u32"), (0, "sys.flag"),
        (1, "sys.u32"), (1, "sys.flag"),
        (2, "sys.u32"), (2, "sys.flag"),
    ]
    for s in out["samples"]:
        width = 8 if s["size"] == 4 else 2
        assert re.fullmatch(rf"0x[0-9a-f]{{{width}}}", s["value"])


def test_poll_resolves_every_name_before_touching_the_bus():
    """A typo must fail as a resolve error, not halfway through the run."""
    code, out, _ = run_op(base_req(
        "poll", names=["sys.u32", "sys.gone"], count=2, interval_ms=0))
    assert code == 2
    assert out["stage"] == "resolve"
    assert "(not in ELF resolution)" in out["error"]
    assert "samples" not in out


def test_poll_rejects_bad_count_and_interval():
    for key, value in (("count", 0), ("count", 10001), ("interval_ms", -1),
                       ("interval_ms", 60001)):
        code, out, _ = run_op(base_req("poll", names=["sys.u32"], **{key: value}))
        assert code == 2, (key, value)
        assert out["stage"] == "preflight"
        assert key in out["error"]


def test_poll_needs_a_non_empty_name_list():
    for names in (None, [], ["ok", ""]):
        code, out, _ = run_op(base_req("poll", names=names))
        assert code == 2, names
        assert out["stage"] == "preflight"


def test_merge_symbols_union_is_name_keyed_and_base_wins():
    """Both elf_resolve modes are near-disjoint; the union must keep both."""
    import probe_op

    base = {"symbols": [
        {"name": "only.base", "address": "0x20000000", "size": 4},
        {"name": "shared", "address": "0x20000004", "size": 4},
    ]}
    extra = {"symbols": [
        {"name": "shared", "address": "0x20000099", "size": 4},
        {"name": "only.catalog", "address": "0x20000008", "size": 4},
    ]}
    merged = probe_op._merge_symbols(base, extra)
    assert [s["name"] for s in merged] == ["only.base", "shared", "only.catalog"]
    assert {s["name"]: s["address"] for s in merged}["shared"] == "0x20000004"


def _set_req(name, address, size, value):
    return base_req("set", name=name, address=address, size=size,
                    base=address, symbolSize=size, value=value)


def test_set_roundtrip_readback():
    code, out, _ = run_op(_set_req("sys.u32", "0x20000000", 4, "0x12345678"))
    assert code == 0
    assert out["ok"] is True
    assert out["op"] == "set"
    assert out["value"] == "0x12345678"
    assert out["readback"] == "0x12345678"
    assert "note" not in out


def test_set_bool_text():
    code, out, _ = run_op(_set_req("sys.flag", "0x20000004", 1, "true"))
    assert code == 0
    assert out["readback"] == "0x01"


def test_set_bad_value_text():
    code, out, _ = run_op(_set_req("sys.u32", "0x20000000", 4, "not-an-int"))
    assert code == 2
    assert out["ok"] is False
    assert out["stage"] == "op"


def test_set_unknown_name_refused():
    code, out, _ = run_op(_set_req("sys.gone", "0x20000000", 4, "1"))
    assert code == 2
    assert out["stage"] == "resolve"


def test_list_passthrough_with_skipped(tmp_path):
    res = {"symbols": [
        {"name": "a", "address": "0x20000000", "size": 4},
        {"name": "b", "address": "0x20000004"},
        {"name": "c", "size": 1},
        "not-a-dict",
    ]}
    path = str(tmp_path / "res.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(res, f)
    code, out, _ = run_op({"op": "list", "mock": True, "resolution": path})
    assert code == 0
    assert out["count"] == 1
    assert out["skipped"] == 3
    assert out["symbols"] == [{"name": "a", "address": "0x20000000",
                               "size": 4}]


def test_list_fixture_counts_three():
    code, out, _ = run_op({"op": "list", "mock": True,
                           "resolution": FIXTURE})
    assert code == 0
    assert out["count"] == 3
    assert out["skipped"] == 0
    assert {s["name"] for s in out["symbols"]} == {
        "sys.u32", "sys.flag", "motor.speed"}


def test_info_always_exit_zero():
    code, out, _ = run_op({"op": "info", "mock": True})
    assert code == 0
    assert out["ok"] is True
    assert set(out["checks"]) == {"pyocd", "probe", "elf"}
    for check in out["checks"].values():
        assert isinstance(check["ok"], bool)
        assert isinstance(check["detail"], str)


def test_malformed_non_json_stdin():
    p = subprocess.run([sys.executable, WORKER], input="{nope",
                       capture_output=True, text=True, timeout=60)
    assert p.returncode == 2
    assert p.returncode != 1
    out = json.loads(p.stdout)
    assert out["ok"] is False
    assert out["stage"] == "preflight"


def test_missing_op():
    code, out, _ = run_op({"mock": True})
    assert code == 2
    assert out["ok"] is False
    assert out["stage"] == "preflight"


def test_unknown_op():
    code, out, _ = run_op({"op": "teleport", "mock": True})
    assert code == 2
    assert out["ok"] is False
    assert out["stage"] == "preflight"


def test_wrong_types_rejected():
    code, out, _ = run_op(_set_req("sys.u32", "0x20000000", "4", "1"))
    assert code == 2
    assert out["ok"] is False
    assert out["stage"] == "preflight"
    code, out, _ = run_op(_set_req("sys.u32", "0x20000000", 4, {"n": 1}))
    assert code == 2
    assert out["ok"] is False


def test_resolve_uses_60s_timeout_not_dap_default():
    with open(WORKER, encoding="utf-8") as f:
        src = f.read()
    assert "RESOLVE_TIMEOUT = 60" in src
    assert "timeout=RESOLVE_TIMEOUT" in src
    assert "timeout=300" not in src
