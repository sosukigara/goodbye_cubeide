"""DAP round-trip against scripts/stm32_dap.py with --mock (no hardware).

Drives the adapter over stdio with Content-Length framing and asserts the
spike contract: initialize -> attach -> threads -> pause -> stackTrace ->
scopes -> hierarchical variables -> setVariable (readback) ->
continue -> disconnect.
"""
import json
import os
import select
import subprocess
import sys

import pytest

SCRIPTS = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       "..", "scripts")
DAP = os.path.join(SCRIPTS, "stm32_dap.py")

RESOLUTION = {
    "elf": "/tmp/fake.elf",
    "base": "0x20000000",
    "size": 16,
    "end": "0x20000010",
    "has_debug_info": True,
    "backend": "pyelftools",
    "symbols": [
        {"name": "drive.kp", "address": "0x20000000", "offset": 0,
         "size": 4, "type": "float", "kind": "float", "signed": True},
        {"name": "sys.count", "address": "0x20000004", "offset": 4,
         "size": 4, "type": "uint32_t", "kind": "scalar", "signed": False},
        {"name": "sys.armed", "address": "0x20000008", "offset": 8,
         "size": 1, "type": "bool", "kind": "bool", "signed": False},
    ],
    "tree": {"name": "root", "path": "", "children": [
        {"name": "drive", "path": "drive", "children": [
            {"name": "kp", "path": "drive.kp", "children": []}]},
        {"name": "sys", "path": "sys", "children": [
            {"name": "count", "path": "sys.count", "children": []},
            {"name": "armed", "path": "sys.armed", "children": []}]}]},
}


class DapClient:
    """Minimal blocking DAP client with a hard timeout per message."""

    def __init__(self, proc):
        self.proc = proc
        self.seq = 0

    def send(self, command, arguments=None):
        self.seq += 1
        payload = {"type": "request", "seq": self.seq, "command": command}
        if arguments is not None:
            payload["arguments"] = arguments
        body = json.dumps(payload).encode()
        self.proc.stdin.write(b"Content-Length: %d\r\n\r\n" % len(body))
        self.proc.stdin.write(body)
        self.proc.stdin.flush()
        return self.seq

    def _read_exactly(self, n, timeout=15):
        out = b""
        while len(out) < n:
            ready, _, _ = select.select([self.proc.stdout], [], [], timeout)
            assert ready, "timed out waiting for adapter output"
            chunk = os.read(self.proc.stdout.fileno(), n - len(out))
            assert chunk, "adapter closed stdout"
            out += chunk
        return out

    def _read_message(self, timeout=15):
        raw = b""
        while b"\r\n\r\n" not in raw:
            ready, _, _ = select.select([self.proc.stdout], [], [], timeout)
            assert ready, "timed out waiting for adapter header"
            chunk = os.read(self.proc.stdout.fileno(), 1)
            assert chunk, "adapter closed stdout"
            raw += chunk
        head, _, rest = raw.partition(b"\r\n\r\n")
        length = 0
        for line in head.split(b"\r\n"):
            if line.lower().startswith(b"content-length:"):
                length = int(line.split(b":", 1)[1].strip())
        body = rest
        if len(body) < length:
            body += self._read_exactly(length - len(body), timeout)
        return json.loads(body.decode())

    def request(self, command, arguments=None, timeout=15):
        seq = self.send(command, arguments)
        deadline = timeout
        while True:
            msg = self._read_message(deadline)
            if (msg.get("type") == "response"
                    and msg.get("request_seq") == seq
                    and msg.get("command") == command):
                return msg
            # events interleave; keep waiting for our response


@pytest.fixture()
def adapter(tmp_path):
    res = tmp_path / "resolution.json"
    res.write_text(json.dumps(RESOLUTION), encoding="utf-8")
    proc = subprocess.Popen(
        [sys.executable, DAP, "--mock", "--resolution", str(res)],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, cwd=SCRIPTS)
    client = DapClient(proc)
    yield client
    try:
        client.request("disconnect", {}, timeout=10)
    except Exception:  # noqa: BLE001 - teardown is best-effort
        pass
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()


def test_initialize_attach_threads(adapter):
    init = adapter.request("initialize", {"adapterID": "stm32-dap"})
    assert init["success"] is True
    assert init["body"]["supportsSetVariable"] is True
    attach = adapter.request("attach", {"elf": "/tmp/fake.elf"})
    assert attach["success"] is True, attach.get("message")
    threads = adapter.request("threads")
    assert threads["success"] is True
    assert threads["body"]["threads"] == [{"id": 1, "name": "Cortex-M"}]


def test_pause_stack_scopes_hierarchy_and_write(adapter):
    adapter.request("initialize", {"adapterID": "stm32-dap"})
    adapter.request("attach", {"elf": "/tmp/fake.elf"})
    assert adapter.request("pause")["success"] is True
    frames = adapter.request("stackTrace", {"threadId": 1})
    assert frames["success"] is True
    assert frames["body"]["totalFrames"] == 1
    assert frames["body"]["stackFrames"][0]["name"] == "0x08000100"
    scopes = adapter.request("scopes", {"frameId": 1001})
    assert scopes["success"] is True
    (g,) = scopes["body"]["scopes"]
    assert g["name"] == "Globals"
    top = adapter.request("variables",
                          {"variablesReference": g["variablesReference"]})
    assert top["success"] is True
    by_name = {v["name"]: v for v in top["body"]["variables"]}
    assert set(by_name) == {"drive", "sys"}
    assert by_name["drive"]["variablesReference"] != 0
    assert by_name["drive"]["value"] == "1件"
    leaves = adapter.request(
        "variables",
        {"variablesReference": by_name["sys"]["variablesReference"]})
    kids = {v["name"]: v for v in leaves["body"]["variables"]}
    assert set(kids) == {"count", "armed"}
    assert kids["armed"]["value"] in ("true", "false")
    written = adapter.request("setVariable", {
        "variablesReference": by_name["sys"]["variablesReference"],
        "name": "count",
        "value": "42",
    })
    assert written["success"] is True, written.get("message")
    assert written["body"]["value"] == "42"
    again = adapter.request(
        "variables",
        {"variablesReference": by_name["sys"]["variablesReference"]})
    assert {v["name"]: v for v in again["body"]["variables"]}["count"]["value"] == "42"
    assert adapter.request("continue", {"threadId": 1})["success"] is True


def test_set_variable_rejects_garbage(adapter):
    adapter.request("initialize", {"adapterID": "stm32-dap"})
    adapter.request("attach", {"elf": "/tmp/fake.elf"})
    scopes = adapter.request("scopes", {"frameId": 1001})
    (g,) = scopes["body"]["scopes"]
    leaves = adapter.request(
        "variables",
        {"variablesReference": g["variablesReference"]})
    sys_ref = {v["name"]: v for v in leaves["body"]["variables"]}["sys"][
        "variablesReference"]
    bad = adapter.request("setVariable", {
        "variablesReference": sys_ref, "name": "count", "value": "nope"})
    assert bad["success"] is False
    group = adapter.request("setVariable", {
        "variablesReference": g["variablesReference"],
        "name": "sys", "value": "1"})
    assert group["success"] is False
