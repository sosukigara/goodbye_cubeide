"""Audit-round1 DAP resource-leak regressions (ST-LINK is exclusive).

Defect 1: EOF on stdin must release the probe (best-effort resume + close).
Defect 2: a second attach must close the previous probe session, but a
failed re-attach must leave the existing session intact.
"""
import io
import json
import os
import sys
import types

import pytest

SCRIPTS = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        "..", "scripts")
sys.path.insert(0, os.path.normpath(SCRIPTS))

import stm32_dap as dap  # noqa: E402

RESOLUTION = {
    "symbols": [
        {"name": "sys.count", "address": "0x20000004", "offset": 4,
         "size": 4, "type": "uint32_t", "kind": "scalar", "signed": False},
    ],
    "tree": {"name": "root", "path": "", "children": [
        {"name": "sys", "path": "sys", "children": [
            {"name": "count", "path": "sys.count", "children": []}]}]},
}


def frame(payload):
    body = json.dumps(payload).encode()
    return b"Content-Length: %d\r\n\r\n" % len(body) + body


def mock_args(resolution):
    return types.SimpleNamespace(elf=None, target=None, mock=True,
                                 resolution=str(resolution))


def attach_req(seq):
    return {"type": "request", "seq": seq, "command": "attach",
            "arguments": {"elf": "/tmp/fake.elf"}}


def test_eof_on_stdin_closes_probe(tmp_path, monkeypatch):
    """main()'s loop: one attach message then EOF must resume+close."""
    res = tmp_path / "resolution.json"
    res.write_text(json.dumps(RESOLUTION), encoding="utf-8")
    closes, resumes = [], []
    orig_close, orig_resume = dap.Target.close, dap.Target.resume
    monkeypatch.setattr(dap.Target, "close",
                        lambda self: (closes.append(1), orig_close(self)))
    monkeypatch.setattr(dap.Target, "resume",
                        lambda self: (resumes.append(1), orig_resume(self)))
    monkeypatch.setattr(sys, "stdin",
                        types.SimpleNamespace(buffer=io.BytesIO(
                            frame(attach_req(1)))))
    monkeypatch.setattr(sys, "stdout",
                        types.SimpleNamespace(buffer=io.BytesIO()))
    assert dap.main(["--mock", "--resolution", str(res)]) == 0
    assert resumes == [1], "EOF leaked a halted target without resume()"
    assert closes == [1], "EOF on stdin did not close() the probe"


def test_reattach_closes_previous_target(tmp_path):
    """Attach twice: the FIRST target must be closed, not leaked."""
    res = tmp_path / "resolution.json"
    res.write_text(json.dumps(RESOLUTION), encoding="utf-8")
    adapter = dap.Adapter(io.BytesIO(), io.BytesIO(), mock_args(res))
    adapter.dispatch(attach_req(1))
    first = adapter.target
    assert first is not None
    closed = []
    orig_close = first.close

    def recording_close():
        closed.append(1)
        return orig_close()
    first.close = recording_close
    adapter.dispatch(attach_req(2))
    assert closed == [1], "re-attach leaked the previous probe session"
    assert adapter.target is not first


def test_failed_reattach_keeps_existing_session(tmp_path, monkeypatch):
    """Ordering: if the NEW probe fails, the old session stays intact."""
    res = tmp_path / "resolution.json"
    res.write_text(json.dumps(RESOLUTION), encoding="utf-8")
    adapter = dap.Adapter(io.BytesIO(), io.BytesIO(), mock_args(res))
    adapter.dispatch(attach_req(1))
    first = adapter.target
    assert first is not None
    closed = []
    orig_close = first.close

    def recording_close():
        closed.append(1)
        return orig_close()
    first.close = recording_close

    def boom():
        raise RuntimeError("probe busy")
    monkeypatch.setattr(dap, "MockTarget", boom)
    req = attach_req(2)
    adapter.dispatch(req)
    assert closed == [], "failed re-attach tore down the live session"
    assert adapter.target is first
    responses = adapter.stdout.getvalue().decode()
    assert '"success": false' in responses
