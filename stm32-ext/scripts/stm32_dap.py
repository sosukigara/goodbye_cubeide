#!/usr/bin/env python3
"""Minimal Debug Adapter Protocol server for STM32 via pyOCD (spike).

Lets the native VSCode Run & Debug UI inspect firmware globals while the
existing webview live UI keeps running alongside it:

- transport: DAP (Content-Length framed JSON) on stdio, stdlib only
- probe: pyOCD (primary) or --mock (deterministic MockProbe from live_poll)
- symbols: elf_resolve.py --all-members --json (same file the live UI uses)
- reads: plain AHB-AP accesses, no halt required (like live_poll)
- writes: live_write.apply_write (same read-modify-write + readback)

Handled requests: initialize, attach, configurationDone, threads,
stackTrace, scopes, variables, setVariable, pause, continue, disconnect.
Everything else gets a protocol-level "not supported" error.

Usage:
  stm32_dap.py --elf firmware.elf [--target stm32g474retx] [--mock]
      [--resolution prebuilt-resolution.json]

  --mock: no hardware. Variables read/write against MockProbe memory.
  --resolution: skip elf_resolve and load this JSON file (same schema).
"""

import json
import os
import struct
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import live_write  # noqa: E402
from live_poll import MockProbe  # noqa: E402

WRITE_WIDTHS = (1, 2, 4, 8)


def err(message):
    print(f"stm32_dap: {message}", file=sys.stderr, flush=True)


def read_message(stream):
    """One DAP message from a binary stream, or None on EOF."""
    headers = {}
    while True:
        line = stream.readline()
        if not line:
            return None
        line = line.strip()
        if not line:
            break
        if b":" in line:
            key, _, value = line.partition(b":")
            headers[key.strip().lower()] = value.strip()
    try:
        length = int(headers.get(b"content-length", b"0"))
    except ValueError:
        return None
    if length <= 0:
        return None
    body = b""
    while len(body) < length:
        chunk = stream.read(length - len(body))
        if not chunk:
            return None
        body += chunk
    return json.loads(body.decode("utf-8"))


def write_message(stream, payload):
    body = json.dumps(payload).encode("utf-8")
    stream.write(b"Content-Length: %d\r\n\r\n" % len(body))
    stream.write(body)
    stream.flush()


def decode_value(raw, meta):
    """Raw integer + leaf meta -> display string (host decoder conventions)."""
    size = int(meta.get("size", 4) or 4)
    kind = str(meta.get("kind", "scalar") or "scalar")
    if kind == "bool":
        return "true" if raw != 0 else "false"
    if kind == "enum":
        for e in meta.get("enumerators", []) or []:
            if int(e.get("value", -1)) == raw:
                return str(e.get("name"))
        return f"{raw} (unknown)"
    if kind == "float":
        try:
            if size == 8:
                (f,) = struct.unpack("<d", struct.pack("<Q", raw & 0xFFFFFFFFFFFFFFFF))
            else:
                (f,) = struct.unpack("<f", struct.pack("<I", raw & 0xFFFFFFFF))
        except struct.error:
            return f"0x{raw:x} (型不明)"
        return f"{f:.6g}"
    if kind == "string":
        data = raw.to_bytes(size, "little", signed=False)
        text = data.split(b"\x00", 1)[0].decode("utf-8", errors="replace")
        return text if text != "" else "(空)"
    if kind == "bitfield":
        width = int(meta.get("bitSize", size * 8) or size * 8)
        at = int(meta.get("bitOffset", 0) or 0)
        return str((raw >> at) & ((1 << width) - 1))
    if kind == "scalar" and bool(meta.get("signed", False)):
        bits = size * 8
        raw -= (1 << bits) if raw >= (1 << (bits - 1)) else 0
        return str(raw)
    if kind == "scalar":
        return str(raw)
    return f"0x{raw:x} (型不明)"


def parse_set_value(text, meta, size):
    """User-typed text -> unsigned member integer, or (None, reason)."""
    raw = str(text).strip()
    kind = str(meta.get("kind", "scalar") or "scalar")
    limit = 1 << (size * 8)
    if kind == "bool":
        low = raw.lower()
        if low in ("true", "1", "yes", "on"):
            return 1, ""
        if low in ("false", "0", "no", "off"):
            return 0, ""
        return None, f"bool wants true/false, got {raw!r}"
    if kind == "enum":
        for e in meta.get("enumerators", []) or []:
            if str(e.get("name")) == raw:
                return int(e.get("value", 0)), ""
    if kind == "float":
        try:
            f = float(raw)
        except ValueError:
            return None, f"not a number: {raw!r}"
        packed = struct.pack("<d", f) if size == 8 else struct.pack("<f", f)
        return int.from_bytes(packed, "little"), ""
    try:
        v = int(raw, 0)
    except ValueError:
        return None, f"not an integer: {raw!r}"
    if kind == "scalar" and bool(meta.get("signed", False)) and v < 0:
        v += limit
    if not 0 <= v < limit:
        return None, f"{raw!r} does not fit in {size} bytes"
    return v, ""


def load_resolution(elf, resolution_path):
    """Resolution object: {"symbols": [...], "tree": {...} | None}."""
    if resolution_path:
        with open(resolution_path, encoding="utf-8") as f:
            return json.load(f)
    script = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                           "elf_resolve.py")
    p = subprocess.run(
        [sys.executable, script, elf, "--all-members", "--json"],
        capture_output=True, text=True, timeout=300)
    if p.returncode != 0:
        raise RuntimeError(f"elf_resolve failed: {(p.stderr or p.stdout).strip()[-300:]}")
    return json.loads(p.stdout)


def last_segment(path):
    return path.split(".")[-1] if path else path


class MockTarget:
    """MockProbe with the halt/resume/register surface the adapter needs."""

    def __init__(self):
        self.probe = MockProbe()
        self.halted = False

    def read32(self, addr):
        return self.probe.read32(addr)

    def write32(self, addr, val):
        self.probe.write32(addr, val)

    def halt(self):
        self.halted = True

    def resume(self):
        self.halted = False

    def is_halted(self):
        return self.halted

    def read_core_register(self, _name):
        return 0x08000100


class Target:
    """Thin wrapper: pyOCD target or mock, one call surface."""

    def __init__(self, probe, mock):
        self.probe = probe
        self.mock = mock
        self.backend = probe if mock else getattr(probe, "_target", probe)

    def read_member(self, address, size):
        return live_write.read_member(self.backend, address, size)

    def halt(self):
        if self.mock:
            self.probe.halt()
        else:
            self.backend.halt()

    def resume(self):
        if self.mock:
            self.probe.resume()
        else:
            self.backend.resume()

    def read_pc(self):
        if self.mock:
            return self.backend.read_core_register("pc")
        reader = getattr(self.backend, "read_core_register", None)
        if reader is None:
            reader = getattr(self.backend, "readCoreRegister", None)
        if reader is None:
            return 0
        try:
            return int(reader("pc"))
        except Exception:  # noqa: BLE001 - a decaying link must not kill DAP
            return 0

    def close(self):
        try:
            if self.mock:
                self.probe.probe.close()
            else:
                self.probe.close()
        except Exception:  # noqa: BLE001 - best-effort close
            pass


class Adapter:
    def __init__(self, stdin, stdout, args):
        self.stdin = stdin
        self.stdout = stdout
        self.args = args
        self.seq = 0
        self.target = None
        self.index = {}
        self.tree = None
        self.refs = {}
        self.next_ref = 1
        self.running = True

    def send(self, payload):
        payload["seq"] = self.next_seq()
        write_message(self.stdout, payload)

    def next_seq(self):
        self.seq += 1
        return self.seq

    def respond(self, req, success, body=None, message=None):
        payload = {
            "type": "response",
            "request_seq": int(req.get("seq", 0)),
            "command": str(req.get("command", "")),
            "success": bool(success),
        }
        if body is not None:
            payload["body"] = body
        if message is not None:
            payload["message"] = message
        self.send(payload)

    def event(self, name, body=None):
        payload = {"type": "event", "event": name}
        if body is not None:
            payload["body"] = body
        self.send(payload)

    def new_ref(self, entries):
        ref = self.next_ref
        self.next_ref += 1
        self.refs[ref] = entries
        return ref

    def node_children(self, node):
        """Tree node -> child entries (groups keep their node for descent)."""
        out = []
        for child in node.get("children", []) or []:
            path = str(child.get("path", "") or "")
            grand = child.get("children", []) or []
            if grand:
                out.append({"display": last_segment(path) or path,
                            "full": path, "group": True, "node": child})
            else:
                meta = self.index.get(path)
                if meta is None:
                    continue
                out.append({"display": last_segment(path) or path,
                            "full": path, "group": False, "meta": meta})
        return out

    def top_entries(self):
        if isinstance(self.tree, dict):
            return self.node_children(self.tree)
        return [{"display": name, "full": name, "group": False, "meta": meta}
                for name, meta in sorted(self.index.items())]

    def entry_value(self, entry):
        meta = entry["meta"]
        raw = self.target.read_member(int(str(meta["address"]), 0),
                                      int(meta.get("size", 4) or 4))
        return decode_value(raw, meta)

    def find_leaf(self, ref, name):
        for entry in self.refs.get(ref, []):
            if entry.get("group", False):
                continue
            if entry["display"] == name or entry["full"] == name:
                return entry
        return None

    def do_initialize(self, req):
        self.respond(req, True, {
            "supportsConfigurationDoneRequest": True,
            "supportsSetVariable": True,
            "supportsReadMemoryRequest": False,
            "supportsDisassembleRequest": False,
            "supportsRestartRequest": False,
        })
        self.event("initialized", {})

    def do_attach(self, req):
        args = req.get("arguments", {}) or {}
        elf = args.get("elf") or self.args.elf
        if not elf:
            self.respond(req, False, message="no ELF: set 'elf' in launch.json")
            return
        target_arg = args.get("target") or self.args.target
        try:
            res = load_resolution(elf, self.args.resolution)
        except Exception as e:  # noqa: BLE001 - report, stay alive
            self.respond(req, False, message=str(e))
            return
        self.index = {s["name"]: s for s in res.get("symbols", [])
                      if isinstance(s, dict) and s.get("name")}
        self.tree = res.get("tree")
        try:
            if self.args.mock:
                probe = MockTarget()
                mock = True
            else:
                from live_poll import PyocdProbe, connect_with_retry  # noqa: PLC0415
                probe = connect_with_retry(
                    lambda: PyocdProbe(target_override=target_arg))
                mock = False
        except Exception as e:  # noqa: BLE001 - probe errors are user-facing
            self.respond(req, False, message=str(e))
            return
        new_target = Target(probe, mock)
        if self.target is not None:
            old = self.target
            try:
                old.resume()
            except Exception:  # noqa: BLE001 - best-effort resume
                pass
            old.close()
        self.target = new_target
        self.refs = {}
        self.next_ref = 1
        self.respond(req, True)
        self.event("continued", {"threadId": 1, "allThreadsContinued": True})

    def need_target(self, req):
        if self.target is None:
            self.respond(req, False, message="not attached")
            return False
        return True

    def do_threads(self, req):
        self.respond(req, True, {"threads": [{"id": 1, "name": "Cortex-M"}]})

    def do_stack_trace(self, req):
        if not self.need_target(req):
            return
        pc = self.target.read_pc()
        self.respond(req, True, {
            "stackFrames": [{
                "id": 1001,
                "name": f"0x{pc:08x}",
                "line": 0,
                "column": 0,
            }],
            "totalFrames": 1,
        })

    def do_scopes(self, req):
        if not self.need_target(req):
            return
        ref = self.new_ref(self.top_entries())
        self.respond(req, True, {"scopes": [{
            "name": "Globals",
            "variablesReference": ref,
            "expensive": False,
        }]})

    def entry_json(self, entry):
        if entry.get("group", False):
            kids = self.node_children(entry["node"])
            return {
                "name": entry["display"],
                "value": f"{len(kids)}件",
                "type": "struct",
                "variablesReference": self.new_ref(kids),
                "namedVariables": len(kids),
                "evaluateName": entry["full"],
            }
        try:
            value = self.entry_value(entry)
        except Exception as e:  # noqa: BLE001 - one bad leaf must not fail all
            value = f"(read error: {e})"
        meta = entry["meta"]
        return {
            "name": entry["display"],
            "value": value,
            "type": str(meta.get("type", "") or meta.get("kind", "")),
            "variablesReference": 0,
            "evaluateName": entry["full"],
            "memoryReference": str(meta.get("address", "")),
        }

    def do_variables(self, req):
        if not self.need_target(req):
            return
        args = req.get("arguments", {}) or {}
        entries = self.refs.get(int(args.get("variablesReference", 0)), [])
        self.respond(req, True,
                     {"variables": [self.entry_json(e) for e in entries]})

    def do_set_variable(self, req):
        if not self.need_target(req):
            return
        args = req.get("arguments", {}) or {}
        entry = self.find_leaf(int(args.get("variablesReference", 0)),
                               str(args.get("name", "")))
        if entry is None:
            self.respond(req, False, message="not a writable leaf")
            return
        meta = entry["meta"]
        size = int(meta.get("size", 4) or 4)
        if size not in WRITE_WIDTHS:
            self.respond(req, False,
                         message=f"width {size} not writable (1/2/4/8 only)")
            return
        value, problem = parse_set_value(str(args.get("value", "")), meta,
                                         size)
        if value is None:
            self.respond(req, False, message=problem)
            return
        address = int(str(meta["address"]), 0)
        try:
            result = live_write.apply_write(
                self.target.probe,
                {"id": "dap", "address": address, "size": size,
                 "value": value})
        except Exception as e:  # noqa: BLE001 - report, stay alive
            self.respond(req, False, message=str(e))
            return
        err(f"[dap-write] WRITE {entry['full']}@0x{address:08x} "
            f"size={size} value={args.get('value', '')} "
            f"readback={result.get('readback', '?')}")
        self.event("output", {"category": "stdout",
                              "output": f"[dap] {entry['full']} = "
                                        f"{self.entry_json(entry)['value']}\n"})
        self.respond(req, True, {"value": self.entry_json(entry)["value"],
                                 "type": str(meta.get("type", "") or "")})

    def do_pause(self, req):
        if not self.need_target(req):
            return
        try:
            self.target.halt()
        except Exception as e:  # noqa: BLE001 - report, stay alive
            self.respond(req, False, message=str(e))
            return
        self.respond(req, True)
        self.event("stopped", {"reason": "pause", "threadId": 1,
                               "allThreadsStopped": True})

    def do_continue(self, req):
        if not self.need_target(req):
            return
        try:
            self.target.resume()
        except Exception as e:  # noqa: BLE001 - report, stay alive
            self.respond(req, False, message=str(e))
            return
        self.respond(req, True, {"allThreadsContinued": True})
        self.event("continued", {"threadId": 1,
                                 "allThreadsContinued": True})

    def close_target(self):
        """Best-effort resume + close, no DAP I/O (safe on EOF)."""
        if self.target is not None:
            try:
                self.target.resume()
            except Exception:  # noqa: BLE001 - best-effort resume
                pass
            self.target.close()
            self.target = None

    def do_disconnect(self, req):
        self.close_target()
        self.respond(req, True)
        self.running = False

    def dispatch(self, msg):
        if not isinstance(msg, dict) or msg.get("type") != "request":
            return
        command = str(msg.get("command", ""))
        handler = {
            "initialize": self.do_initialize,
            "attach": self.do_attach,
            "configurationDone": lambda r: self.respond(r, True),
            "threads": self.do_threads,
            "stackTrace": self.do_stack_trace,
            "scopes": self.do_scopes,
            "variables": self.do_variables,
            "setVariable": self.do_set_variable,
            "pause": self.do_pause,
            "continue": self.do_continue,
            "disconnect": self.do_disconnect,
        }.get(command)
        if handler is None:
            self.respond(msg, False, message=f"unsupported: {command}")
            return
        try:
            handler(msg)
        except Exception as e:  # noqa: BLE001 - never die on a request
            err(f"request {command} failed: {e}")
            self.respond(msg, False, message=str(e))


def main(argv=None):
    import argparse  # noqa: PLC0415
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--elf", default=None)
    ap.add_argument("--target", default=None)
    ap.add_argument("--mock", action="store_true")
    ap.add_argument("--resolution", default=None)
    args = ap.parse_args(argv)
    adapter = Adapter(sys.stdin.buffer, sys.stdout.buffer, args)
    err("stm32_dap ready (mock=%s)" % args.mock)
    while adapter.running:
        try:
            msg = read_message(sys.stdin.buffer)
        except Exception as e:  # noqa: BLE001 - a torn pipe ends the session
            err(f"framing error, exiting: {e}")
            break
        if msg is None:
            break
        adapter.dispatch(msg)
    adapter.close_target()
    return 0


if __name__ == "__main__":
    sys.exit(main())
