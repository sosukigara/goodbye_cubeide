#!/usr/bin/env python3
"""One-shot probe worker for the stm32 CLI (task T1).

Reads ONE JSON document from stdin, executes one op
(`resolve|get|set|list|info|poll`), writes ONE JSON document to stdout.
Human diagnostics go to stderr. Takes NO argv: everything arrives
through the stdin JSON.

All math and bus access is reused, never reimplemented:
- symbol resolution shape: `stm32_dap.load_resolution` (file path) or
  `elf_resolve.py --all-members/--catalog --json` with a 60s timeout
- value text parsing: `stm32_dap.parse_set_value`
- read-modify-write + readback: `live_write.parse_request` / `apply_write`
- attach: `live_poll.connect_with_retry` + `PyocdProbe`, or
  `Target(MockTarget(), True)` for mock
- reads and writes are plain AHB-AP: nothing here halts the core.

Exit codes (live_poll vocabulary; 4 is streaming-only, never emitted):
0 success (info always exits 0), 2 usage/resolve/refused,
3 no-probe or pyocd-missing on ops that need a probe,
5 USB (AttachError), 6 nothing watchable.
"""
import json
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from stm32_dap import Target, MockTarget, parse_set_value, load_resolution
from live_poll import connect_with_retry, PyocdProbe, MockProbe, AttachError
import live_write

EXIT_OK = 0
EXIT_USAGE = 2
EXIT_NO_PROBE = 3
EXIT_USB = 5
EXIT_NO_WATCH = 6

OPS = ("resolve", "get", "set", "list", "info", "poll")
WRITE_WIDTHS = (1, 2, 4, 8)
RESOLVE_TIMEOUT = 60

SETUP_HINT = ("pyocd is not installed; run `stm32 setup` to install it "
              "into the CLI venv")


def err(message):
    print(f"probe_op: {message}", file=sys.stderr, flush=True)


class ResolutionError(Exception):
    """ELF resolution failed (missing file, bad JSON, elf_resolve error)."""


def _to_int(text, what):
    if isinstance(text, bool):
        raise ValueError(f"bad {what}: not a number")
    if isinstance(text, int):
        return text
    if isinstance(text, str):
        return int(text.strip(), 0)
    raise ValueError(f"bad {what}: not a number")


def _fail(op, stage, message, code):
    return {"ok": False, "op": op, "stage": stage, "error": message}, code


def _elf_resolve(elf, mode):
    """One `elf_resolve.py <mode> --json` run, or ResolutionError."""
    script = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                          "elf_resolve.py")
    try:
        p = subprocess.run([sys.executable, script, elf, mode, "--json"],
                           capture_output=True, text=True,
                           timeout=RESOLVE_TIMEOUT)
    except subprocess.TimeoutExpired:
        raise ResolutionError(
            f"elf_resolve timed out after {RESOLVE_TIMEOUT}s (elf={elf})")
    if p.returncode != 0:
        tail = (p.stderr or p.stdout).strip()[-300:]
        raise ResolutionError(f"elf_resolve failed: {tail}")
    try:
        return json.loads(p.stdout)
    except json.JSONDecodeError as e:
        raise ResolutionError(f"elf_resolve returned bad JSON: {e}")


def _merge_symbols(base, extra):
    """Union by name. `base` wins; `extra` only adds names it does not have.

    The two modes are near-disjoint, not nested: measured on unit_omni3,
    `--all-members` yields 338 DebugGlobal leaves and `--catalog` 4291 RAM
    roots, sharing only 10 names. Neither is a superset, so resolving against
    one silently hides most of what the other can address — the asymmetry
    that made `ls` advertise `robot.yaw` while `get` refused it, and hid
    `sys.loop_min_us` from `ls` while `get` could read it. Base-wins keeps
    the DebugGlobal decl order and the exact entries `get` returned before.
    """
    out = {s["name"]: s for s in base.get("symbols", [])
           if isinstance(s, dict) and s.get("name")}
    for s in extra.get("symbols", []):
        if isinstance(s, dict) and s.get("name") and s["name"] not in out:
            out[s["name"]] = s
    return list(out.values())


def load_res(elf, resolution_path):
    """Resolution object, same shape `stm32_dap.load_resolution` returns.

    A non-null `resolution` path skips elf_resolve and loads that JSON
    file. Otherwise `elf_resolve.py` runs twice (`--all-members`,
    `--catalog`) and the two symbol lists are unioned, so one loader
    defines what every op can address.
    """
    if resolution_path:
        try:
            return load_resolution(None, resolution_path)
        except Exception as e:
            raise ResolutionError(
                f"cannot load resolution {resolution_path!r}: {e}")
    if not elf:
        raise ResolutionError("no ELF: pass --elf or STM32_ELF "
                              "(or --resolution <path>)")
    base = _elf_resolve(elf, "--all-members")
    catalog = _elf_resolve(elf, "--catalog")
    merged = dict(base)
    merged["symbols"] = _merge_symbols(base, catalog)
    return merged


def resolve_symbol(res, name):
    """Name -> symbol dict, or (None, refusal reason).

    Refusal wording matches the allowlist: `refused: ... (not in ELF
    resolution)`, so the host can treat it like any other unresolvable
    target.
    """
    by_name = {s["name"]: s for s in res.get("symbols", [])
               if isinstance(s, dict) and s.get("name")}
    meta = by_name.get(name)
    if meta is None:
        return None, f"refused: {name} (not in ELF resolution)"
    size = meta.get("size")
    if isinstance(size, bool) or not isinstance(size, int) \
            or size not in WRITE_WIDTHS:
        return None, (f"refused: {name} has no usable width "
                      f"({size!r}) (not in ELF resolution)")
    try:
        addr = _to_int(meta.get("address"), "address")
    except ValueError:
        return None, (f"refused: unresolvable address for {name} "
                      f"(not in ELF resolution)")
    return {
        "name": name,
        "address": f"0x{addr:08x}",
        "size": size,
        "type": str(meta.get("type", "") or ""),
        "kind": str(meta.get("kind", "scalar") or "scalar"),
        "signed": bool(meta.get("signed", False)),
    }, ""


def attach(target_name, mock):
    if mock:
        return Target(MockTarget(), True)
    return Target(
        connect_with_retry(lambda: PyocdProbe(target_override=target_name)),
        False)


def _attach_or_fail(op, target_name, mock):
    try:
        return attach(target_name, mock), None, 0
    except AttachError as e:
        return None, * _fail(op, "attach", str(e), EXIT_USB)
    except RuntimeError as e:
        return None, * _fail(op, "attach", str(e), EXIT_NO_PROBE)
    except Exception as e:  # noqa: BLE001 - never a traceback on stdout
        return None, * _fail(op, "attach",
                             f"{type(e).__name__}: {e}", EXIT_NO_PROBE)


def do_resolve(req):
    op = "resolve"
    try:
        res = load_res(req.get("elf"), req.get("resolution"))
    except ResolutionError as e:
        return _fail(op, "resolve", str(e), EXIT_USAGE)
    name = req.get("name")
    if not isinstance(name, str) or name == "":
        return _fail(op, "preflight", "missing `name` (string)", EXIT_USAGE)
    sym, problem = resolve_symbol(res, name)
    if sym is None:
        return _fail(op, "resolve", problem, EXIT_USAGE)
    return {"ok": True, "op": op, "symbol": sym}, EXIT_OK


def do_get(req):
    op = "get"
    name = req.get("name")
    if not isinstance(name, str) or name == "":
        return _fail(op, "preflight", "missing `name` (string)", EXIT_USAGE)
    try:
        res = load_res(req.get("elf"), req.get("resolution"))
    except ResolutionError as e:
        return _fail(op, "resolve", str(e), EXIT_USAGE)
    sym, problem = resolve_symbol(res, name)
    if sym is None:
        return _fail(op, "resolve", problem, EXIT_USAGE)
    tgt, payload, code = _attach_or_fail(op, req.get("target"),
                                         bool(req.get("mock")))
    if tgt is None:
        return payload, code
    try:
        addr = int(sym["address"], 0)
        try:
            raw = tgt.read_member(addr, sym["size"])
        except Exception as e:  # noqa: BLE001 - bus error, not a crash
            return _fail(op, "op", f"{type(e).__name__}: {e}",
                         EXIT_NO_WATCH)
        out = {"ok": True, "op": op, **sym,
               "value": f"0x{int(raw):0{sym['size'] * 2}x}"}
        return out, EXIT_OK
    finally:
        tgt.close()


def do_poll(req):
    """N samples of M names over ONE attach.

    The single attach is the point: spawning a worker per sample makes the
    effective period the attach cost (~4s measured), not `interval_ms`. Every
    name is resolved before the bus is touched, so a typo fails fast instead
    of midway through a long run. Read-only, never writes.
    """
    op = "poll"
    names = req.get("names")
    if not isinstance(names, list) or not names or \
            not all(isinstance(n, str) and n for n in names):
        return _fail(op, "preflight",
                     "missing `names` (non-empty list of strings)", EXIT_USAGE)
    try:
        count = _to_int(req.get("count", 10), "count")
        interval_ms = _to_int(req.get("interval_ms", 100), "interval_ms")
    except ValueError as e:
        return _fail(op, "preflight", str(e), EXIT_USAGE)
    if not 1 <= count <= 10000:
        return _fail(op, "preflight", f"count out of range: {count}",
                     EXIT_USAGE)
    if not 0 <= interval_ms <= 60000:
        return _fail(op, "preflight",
                     f"interval_ms out of range: {interval_ms}", EXIT_USAGE)
    try:
        res = load_res(req.get("elf"), req.get("resolution"))
    except ResolutionError as e:
        return _fail(op, "resolve", str(e), EXIT_USAGE)
    syms = []
    for name in names:
        sym, problem = resolve_symbol(res, name)
        if sym is None:
            return _fail(op, "resolve", problem, EXIT_USAGE)
        syms.append(sym)
    tgt, payload, code = _attach_or_fail(op, req.get("target"),
                                         bool(req.get("mock")))
    if tgt is None:
        return payload, code
    samples = []
    try:
        for tick in range(count):
            for sym in syms:
                try:
                    raw = tgt.read_member(int(sym["address"], 0), sym["size"])
                except Exception as e:  # noqa: BLE001 - bus error, not a crash
                    # Partial samples are the useful answer: a monitoring run
                    # that read 40 of 100 points must not throw them away.
                    failed, code = _fail(
                        op, "op", f"{type(e).__name__}: {e} "
                        f"(after {len(samples)} samples)", EXIT_NO_WATCH)
                    failed["samples"] = samples
                    return failed, code
                samples.append({
                    "tick": tick,
                    "name": sym["name"],
                    "address": sym["address"],
                    "size": sym["size"],
                    "type": sym["type"],
                    "kind": sym["kind"],
                    "signed": sym["signed"],
                    "value": f"0x{int(raw):0{sym['size'] * 2}x}",
                })
            if tick + 1 < count and interval_ms > 0:
                time.sleep(interval_ms / 1000.0)
    finally:
        tgt.close()
    return {"ok": True, "op": op, "count": count, "intervalMs": interval_ms,
            "samples": samples}, EXIT_OK


def do_set(req):
    op = "set"
    for key in ("address", "size", "base", "symbolSize", "value"):
        if req.get(key) is None:
            return _fail(op, "preflight", f"missing `{key}`", EXIT_USAGE)
    size = req.get("size")
    if isinstance(size, bool) or not isinstance(size, int):
        return _fail(op, "preflight",
                     f"bad size: {size!r} (want an integer)", EXIT_USAGE)
    if size not in WRITE_WIDTHS:
        return _fail(op, "preflight",
                     f"bad size: {size!r} (a member must be "
                     f"{' or '.join(str(w) for w in WRITE_WIDTHS)} bytes)",
                     EXIT_USAGE)
    try:
        addr = _to_int(req.get("address"), "address")
        base = _to_int(req.get("base"), "base")
        sym_size = _to_int(req.get("symbolSize"), "symbolSize")
    except ValueError as e:
        return _fail(op, "preflight", str(e), EXIT_USAGE)
    value_text = req.get("value")
    if isinstance(value_text, bool) or \
            not isinstance(value_text, (str, int)):
        return _fail(op, "preflight",
                     f"bad value: {value_text!r} (want text)", EXIT_USAGE)
    name = req.get("name")
    meta = {}
    if isinstance(name, str) and name != "" \
            and (req.get("elf") or req.get("resolution")):
        try:
            res = load_res(req.get("elf"), req.get("resolution"))
        except ResolutionError as e:
            return _fail(op, "resolve", str(e), EXIT_USAGE)
        sym, problem = resolve_symbol(res, name)
        if sym is None:
            return _fail(op, "resolve", problem, EXIT_USAGE)
        for s in res.get("symbols", []):
            if isinstance(s, dict) and s.get("name") == name:
                meta = s
                break
    parsed, problem = parse_set_value(str(value_text), meta, size)
    if parsed is None:
        return _fail(op, "op", problem, EXIT_USAGE)
    tgt, payload, code = _attach_or_fail(op, req.get("target"),
                                         bool(req.get("mock")))
    if tgt is None:
        return payload, code
    try:
        try:
            bulk = live_write.parse_request(
                {"id": "probe-op", "op": "write", "address": addr,
                 "size": size, "value": parsed}, base, sym_size)
        except live_write.WriteRequestError as e:
            return _fail(op, "op", e.reason, EXIT_USAGE)
        try:
            result = live_write.apply_write(tgt.probe, bulk)
        except Exception as e:  # noqa: BLE001 - bus error, not a crash
            return _fail(op, "op", f"{type(e).__name__}: {e}",
                         EXIT_NO_WATCH)
        out = {"ok": True, "op": op, **result}
        if isinstance(name, str) and name != "":
            out["name"] = name
        err(f"WRITE {name or '?'}@0x{addr:08x} size={size} "
            f"value={value_text} readback={result.get('readback', '?')}")
        return out, EXIT_OK
    finally:
        tgt.close()


def do_list(req):
    op = "list"
    # Same resolution authority as get/set/poll: listing what cannot be read
    # (or hiding what can) is the bug this shares a loader with.
    try:
        res = load_res(req.get("elf"), req.get("resolution"))
    except ResolutionError as e:
        return _fail(op, "resolve", str(e), EXIT_USAGE)
    symbols = res.get("symbols", [])
    kept = [s for s in symbols
            if isinstance(s, dict) and s.get("address") is not None
            and s.get("size") is not None]
    return {"ok": True, "op": op, "count": len(kept),
            "skipped": len(symbols) - len(kept),
            "symbols": kept}, EXIT_OK


def do_info(req):
    op = "info"
    try:
        import pyocd  # noqa: F401, PLC0415
        pyocd_ok, pyocd_detail = True, "pyocd importable"
    except ImportError:
        pyocd_ok, pyocd_detail = False, f"{SETUP_HINT} (import pyocd failed)"
    if not pyocd_ok:
        probe = {"ok": False,
                 "detail": "probe enumeration skipped (pyocd not installed)"}
    else:
        try:
            from pyocd.core.helpers import ConnectHelper  # noqa: PLC0415
            found = list(ConnectHelper.get_all_connected_probes(
                blocking=False, print_wait_message=False))
            probe = {"ok": bool(found),
                     "detail": f"{len(found)} probe(s) found" if found
                     else "no probe found (ST-LINK/J-LINK); check USB/power"}
        except Exception as e:  # noqa: BLE001 - enumeration must not hang/fail
            probe = {"ok": False, "detail": str(e)[:200]}
    elf = req.get("elf")
    if elf:
        if os.path.exists(str(elf)):
            elf_check = {"ok": True, "detail": f"ELF present: {elf}"}
        else:
            elf_check = {"ok": False, "detail": f"ELF not found: {elf}"}
    else:
        elf_check = {"ok": True, "detail": "skipped (no ELF given)"}
    return {"ok": True, "op": op,
            "checks": {"pyocd": {"ok": pyocd_ok, "detail": pyocd_detail},
                       "probe": probe, "elf": elf_check}}, EXIT_OK


def run(req):
    """One request object -> (response object, exit code). Never raises."""
    if not isinstance(req, dict):
        return _fail(None, "preflight", "request must be a JSON object",
                     EXIT_USAGE)
    op = req.get("op")
    if op == "resolve":
        return do_resolve(req)
    if op == "get":
        return do_get(req)
    if op == "set":
        return do_set(req)
    if op == "list":
        return do_list(req)
    if op == "info":
        return do_info(req)
    if op == "poll":
        return do_poll(req)
    if op is None:
        return _fail(None, "preflight", "missing `op` "
                     f"(want one of {'|'.join(OPS)})", EXIT_USAGE)
    return _fail(op if isinstance(op, str) else None, "preflight",
                 f"unknown op: {op!r} (want one of {'|'.join(OPS)})",
                 EXIT_USAGE)


def main(_argv=None):
    try:
        raw = sys.stdin.read()
    except Exception as e:  # noqa: BLE001 - unreadable stdin is usage, not 1
        payload, code = _fail(None, "preflight", f"cannot read stdin: {e}",
                              EXIT_USAGE)
        print(json.dumps(payload), flush=True)
        return code
    try:
        req = json.loads(raw) if raw.strip() else None
    except json.JSONDecodeError as e:
        payload, code = _fail(None, "preflight",
                              f"stdin is not JSON: {e}", EXIT_USAGE)
        print(json.dumps(payload), flush=True)
        return code
    try:
        payload, code = run(req)
    except Exception as e:  # noqa: BLE001 - never a traceback, never exit 1
        payload, code = _fail(req.get("op") if isinstance(req, dict) else None,
                              "op", f"{type(e).__name__}: {e}", EXIT_USAGE)
    print(json.dumps(payload), flush=True)
    return code


if __name__ == "__main__":
    sys.exit(main())
