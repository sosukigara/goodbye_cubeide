"""pytest: DebugGlobal-only write channel (sidecar side, no hardware).

Run with: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest tests/test_live_write.py -q

The AHB-AP only moves 32-bit words (pyOCD raises DebugError for 8/16/64-bit
transfers), so every request is served by a word read-modify-write. FakeTarget
deliberately offers no sub-word accessors: a test that passes here is proof the
channel never asked the bus for one.
"""
import io
import json
import os
import queue
import sys
import time

import pytest

sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))
import live_write  # noqa: E402

BASE = 0x20001000
END = 0x20002000


class FakeTarget:
    """AHB-AP stand-in: dict-backed words, and it records any halt."""

    def __init__(self):
        self.mem = {}
        self.halted = False
        self.writes = 0
        self.calls = []

    def _check(self):
        if self.halted:
            raise AssertionError("target was halted")

    def read32(self, addr):
        self._check()
        self.calls.append(("read32", addr))
        return self.mem.get(addr, 0)

    def write32(self, addr, val):
        self._check()
        self.writes += 1
        self.calls.append(("write32", addr))
        self.mem[addr] = val & 0xFFFFFFFF


class FakeProbe:
    def __init__(self):
        self._target = FakeTarget()


def req(**kw):
    base = {"id": "r1", "op": "write", "address": "0x20001100",
            "size": 4, "value": "1287"}
    base.update(kw)
    return base


def write_one(probe, **kw):
    """Drain a single request. -> result dict"""
    out = []
    q = queue.Queue()
    q.put(req(**kw))
    live_write.drain(q, probe, BASE, END, out.append)
    return out[0]


def seed(probe, addr, value):
    probe._target.mem[addr] = value & 0xFFFFFFFF


def test_write_reaches_memory_and_reads_back():
    probe = FakeProbe()
    out = []
    live_write.drain(queue.Queue(), probe, BASE, END, out.append)
    # nothing queued: no traffic
    assert out == []

    q = queue.Queue()
    q.put(req())
    live_write.drain(q, probe, BASE, END, out.append)
    assert probe._target.mem[0x20001100] == 1287
    assert out[0]["ok"] is True
    assert out[0]["readback"] == "0x00000507"
    assert "note" not in out[0]


def test_a_word_the_firmware_rewrites_is_a_success_not_a_failure():
    """The write transaction decides success. A live variable (a loop rate,
    a PID output) is recomputed microseconds later, so a differing readback
    is normal and must never be reported as a failed write."""
    class Rewriting(FakeProbe):
        class _t(FakeTarget):
            def read32(self, addr):
                self._check()
                return 0x2DD          # firmware already moved on

        def __init__(self):
            self._target = self._t()

    probe = Rewriting()
    out = []
    q = queue.Queue()
    q.put(req(value="805306368"))
    live_write.drain(q, probe, BASE, END, out.append)
    assert out[0]["ok"] is True
    assert out[0]["value"] == "0x30000000"
    assert out[0]["readback"] == "0x000002dd"
    assert "note" in out[0]


def test_write_never_halts_the_core():
    probe = FakeProbe()
    q = queue.Queue()
    q.put(req())
    live_write.drain(q, probe, BASE, END, lambda _r: None)
    assert probe._target.halted is False


@pytest.mark.parametrize("bad", [
    {"address": "0x20000000"},   # below DebugGlobal
    {"address": "0x20001fff"},   # last byte of a 4-byte word runs past the end
    {"address": "0xdeadbeef"},
    {"op": "read"},              # only writes are routable
    {"size": 3},                 # no 24-bit member
    {"value": "not-a-number"},
    {"id": ""},
])
def test_out_of_range_and_malformed_requests_are_refused(bad):
    probe = FakeProbe()
    out = []
    q = queue.Queue()
    q.put(req(**bad))
    live_write.drain(q, probe, BASE, END, out.append)
    assert out[0]["ok"] is False
    assert out[0]["error"]
    assert probe._target.writes == 0


def test_value_too_wide_for_the_symbol_is_refused():
    probe = FakeProbe()
    out = []
    q = queue.Queue()
    q.put(req(value="0x1FFFFFFFF"))
    live_write.drain(q, probe, BASE, END, out.append)
    assert out[0]["ok"] is False
    assert probe._target.writes == 0


def test_a_failing_write_does_not_stop_later_requests():
    class Boom(FakeProbe):
        class _t(FakeTarget):
            def write32(self, addr, val):
                raise RuntimeError("AHB-AP fault")

        def __init__(self):
            self._target = self._t()

    probe = Boom()
    out = []
    q = queue.Queue()
    q.put(req(id="a"))
    q.put({"garbage": True})
    q.put(req(id="b"))
    live_write.drain(q, probe, BASE, END, out.append)
    assert [r["id"] for r in out] == ["a", None, "b"]


def test_stdin_reader_feeds_the_queue():
    q = queue.Queue()
    stream = io.StringIO('{"id":"x","op":"write","address":"0x20001100","size":4,"value":"1"}\n'
                         "not json\n"
                         "\n")
    live_write.start_stdin_reader(q, stream)
    deadline = time.monotonic() + 2
    while q.empty() and time.monotonic() < deadline:
        time.sleep(0.01)
    assert q.get_nowait()["id"] == "x"


def test_result_line_is_machine_readable():
    """The host parses this exact prefix out of the sidecar's stdout."""
    line = f"{live_write.RESULT_PREFIX}" + json.dumps({"id": "r1", "ok": True})
    assert line.startswith("WRITE-RESULT ")
    assert json.loads(line[len(live_write.RESULT_PREFIX):])["ok"] is True


# ------------------------------------------------------- sub-word writes (D12)

def test_a_one_byte_write_at_the_start_of_a_word_keeps_the_other_three_bytes():
    probe = FakeProbe()
    seed(probe, 0x20001100, 0xAABBCCDD)
    result = write_one(probe, size=1, value="0x11")
    assert result["ok"] is True
    assert result["value"] == "0x11"
    assert result["readback"] == "0x11"      # the member's bytes, not the word
    assert probe._target.mem[0x20001100] == 0xAABBCC11
    assert probe._target.writes == 1


@pytest.mark.parametrize("offset, expect", [
    (0, 0xAABBCC11), (1, 0xAABB11DD), (2, 0xAA11CCDD), (3, 0x11BBCCDD)])
def test_a_one_byte_write_at_any_offset_keeps_its_neighbours(offset, expect):
    """drive.controller's sixteen bools sit at byte offsets 0..15 of their words."""
    probe = FakeProbe()
    seed(probe, 0x20001100, 0xAABBCCDD)
    result = write_one(probe, address=f"0x{0x20001100 + offset:x}", size=1, value="0x11")
    assert result["ok"] is True
    assert result["readback"] == "0x11"
    assert probe._target.mem[0x20001100] == expect


def test_a_two_byte_write_at_an_unaligned_address_keeps_its_neighbours():
    probe = FakeProbe()
    seed(probe, 0x20001100, 0xAABBCCDD)
    result = write_one(probe, address="0x20001101", size=2, value="0x1234")
    assert result["ok"] is True
    assert result["readback"] == "0x1234"
    assert probe._target.mem[0x20001100] == 0xAA1234DD
    assert probe._target.writes == 1


def test_an_eight_byte_write_spans_exactly_two_words():
    probe = FakeProbe()
    seed(probe, 0x20001100, 0x00000000)
    seed(probe, 0x20001104, 0xFFFFFFFF)
    result = write_one(probe, size=8, value="0x0105E2B6A4F00D2C")
    assert result["ok"] is True
    assert result["value"] == "0x0105e2b6a4f00d2c"
    assert result["readback"] == "0x0105e2b6a4f00d2c"
    assert probe._target.mem[0x20001100] == 0xA4F00D2C
    assert probe._target.mem[0x20001104] == 0x0105E2B6
    assert probe._target.writes == 2
    assert set(probe._target.mem) == {0x20001100, 0x20001104}


def test_an_unaligned_eight_byte_write_spans_three_words_and_keeps_the_outer_bytes():
    probe = FakeProbe()
    seed(probe, 0x20001100, 0xAAAAAAAA)
    seed(probe, 0x20001104, 0x00000000)
    seed(probe, 0x20001108, 0xBBBBBBBB)
    result = write_one(probe, address="0x20001101", size=8, value="0x0706050403020100")
    assert result["ok"] is True
    assert result["readback"] == "0x0706050403020100"
    assert probe._target.mem[0x20001100] == 0x020100AA
    assert probe._target.mem[0x20001104] == 0x06050403
    assert probe._target.mem[0x20001108] == 0xBBBBBB07
    assert probe._target.writes == 3


def test_each_word_is_read_immediately_before_it_is_written():
    """A read-modify-write that read the whole member once would lose a concurrent
    firmware update to the rest of the word."""
    probe = FakeProbe()
    seed(probe, 0x20001100, 0x00000000)
    write_one(probe, size=8, value="0x0000000200000001")
    assert probe._target.calls == [
        ("read32", 0x20001100), ("write32", 0x20001100),
        ("read32", 0x20001104), ("write32", 0x20001104),
        ("read32", 0x20001100), ("read32", 0x20001104),      # the readback
    ]


def test_a_write_that_needs_a_word_outside_the_fence_is_refused_before_the_bus():
    """An unaligned DebugGlobal start: the member is inside, its word is not."""
    probe = FakeProbe()
    out = []
    q = queue.Queue()
    q.put(req(address="0x20001801", size=1, value="0x1"))
    live_write.drain(q, probe, 0x20001801, 0x20001900, out.append)   # base not word-aligned
    assert out[0]["ok"] is False
    assert "0x20001800" in out[0]["error"]      # the word that would have been written
    assert probe._target.writes == 0
    assert probe._target.calls == []


def test_word_span_covers_every_member_shape():
    assert live_write.word_span(0x20001100, 1) == (0x20001100, 0, 1)
    assert live_write.word_span(0x20001101, 1) == (0x20001100, 1, 1)
    assert live_write.word_span(0x20001103, 2) == (0x20001100, 3, 2)
    assert live_write.word_span(0x20001100, 4) == (0x20001100, 0, 1)
    assert live_write.word_span(0x20001100, 8) == (0x20001100, 0, 2)
    assert live_write.word_span(0x20001101, 8) == (0x20001100, 1, 3)


# The host seeds the write prompt with the DECODED value and encodes it back to
# an integer before sending (src/live/poller.ts encodeWriteValue). These are the
# exact values that encoder produces for the real leaf kinds, pinned here so the
# two halves of the contract cannot drift apart silently. Before the encoder,
# 'true' was always refused and a whole-number float was stored as an integer.
ENCODER_OUTPUT = [
    ("uint32 1288", 4, 1288),
    ("int -1 as two's complement", 4, 4294967295),
    ("float 1.0f", 4, 1065353216),
    ("float -1.5f", 4, 3217031168),
    ("float 0.5f", 4, 1056964608),
    ("double 1.0", 8, 4607182418800017408),
    ("bool true", 1, 1),
    ("bool false", 1, 0),
    ("char[4] 'RUN'", 4, 5133650),
    ("enum MODE_FOLLOW", 4, 2),
]


@pytest.mark.parametrize("label,size,value", ENCODER_OUTPUT)
def test_encoder_output_is_accepted_and_fits_its_width(label, size, value):
    req = live_write.parse_request(
        {"id": "w1", "op": "write", "address": BASE + 4, "size": size,
         "value": str(value)},
        BASE, END)
    assert req["value"] == value, label
    assert 0 <= req["value"] < (1 << (size * 8)), label


def test_bool_and_float_land_as_the_bits_the_user_asked_for():
    """The regression in one test: 'true' used to be refused outright, and 1.0f
    used to be stored as the integer 1 (reading back as 1.4e-45).

    The float is written one byte into the same 32-bit word as the bool, so
    this also proves the read-modify-write preserves its neighbour's byte.
    """
    target = FakeTarget()
    for addr, size, value in ((BASE + 4, 1, 1), (BASE + 5, 4, 1065353216)):
        parsed = live_write.parse_request(
            {"id": "w", "op": "write", "address": addr, "size": size,
             "value": str(value)}, BASE, END)
        live_write.write_member(target, parsed["address"], parsed["size"],
                                parsed["value"])
    w0 = target.read32(BASE + 4)
    w1 = target.read32(BASE + 8)
    assert w0 & 0xFF == 1                               # the bool's own byte
    # The float spans two words (it starts one byte in), so rebuild its four
    # bytes little-endian rather than reading one word.
    fbits = ((w0 >> 8) & 0xFF) | (((w0 >> 16) & 0xFF) << 8) \
        | (((w0 >> 24) & 0xFF) << 16) | ((w1 & 0xFF) << 24)
    assert fbits == 1065353216                          # 1.0f, not the integer 1
    assert fbits != 1                                   # the exact failure
