"""pytest: the live poll sidecar (no hardware).

Covers what the sidecar promises to the host: per-member read widths, the block-read
restriction (D5), the fixed 4-column CSV, a flush per tick (D7), a real second read for
members wider than one word, an explicit verdict on members with no declared size, and a
USB attach failure that names itself and exits with its own code.

Everything here is hardware-free: a byte-addressed fake probe stands in for the AHB-AP
(32-bit transfers only, like the real one), and the clock is injected so a "run" is a
fixed number of ticks.
"""
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))
import live_poll  # noqa: E402

BASE = 0x200000B4


# --------------------------------------------------------------------------- fakes

class ByteProbe:
    """Byte-addressed memory: read32(addr) is the 4 bytes at addr, little-endian.

    Deliberately derived from nothing wider, and deliberately offering no
    read8/read16/read64: pyOCD's AHB-AP raises DebugError("unsupported transfer size")
    for those, so a sidecar that called them would die on the first 1-byte member. A test
    that passes against this probe proves the sidecar issues 32-bit transfers only.
    """

    def __init__(self, mem=None):
        self.mem = dict(mem or {})
        self.calls = []
        self.blocks = 0

    def _raw(self, addr, n):
        return bytes(self.mem.get(addr + i, 0) for i in range(n))

    def read32(self, addr):
        self.calls.append(addr)
        return int.from_bytes(self._raw(addr, 4), "little")

    def read_block(self, base_addr, word_count):
        self.blocks += 1
        return [int.from_bytes(self._raw(base_addr + i * 4, 4), "little")
                for i in range(word_count)]

    def close(self):
        pass


class CountingWideProbe(ByteProbe):
    """The 8-byte member changes between the two reads of the same tick: a real tear."""

    def __init__(self, **kw):
        super().__init__(**kw)
        self.wide_reads = 0

    def read32(self, addr):
        if addr == BASE:
            self.wide_reads += 1
            return self.wide_reads | (0xA5A5 << 16)
        return super().read32(addr)


class FakeClock:
    """time.monotonic that only moves when the poll loop sleeps."""

    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t

    def sleep(self, seconds):
        self.t += seconds


class FakeFile:
    """Records the writes and the flushes, so buffering is observable."""

    def __init__(self):
        self.chunks = []
        self.flushes = 0
        self.closed = False

    def write(self, text):
        self.chunks.append(text)
        return len(text)

    def flush(self):
        self.flushes += 1

    def seek(self, *a):
        pass

    def truncate(self, *a):
        pass

    def close(self):
        self.closed = True

    @property
    def text(self):
        return "".join(self.chunks)

    def rows(self):
        return [r for r in self.text.split("\n") if r]


class USBError(Exception):
    """Stands in for usb.core.USBError — the sidecar matches the class by name."""


@pytest.fixture(autouse=True)
def no_stdin_reader(monkeypatch):
    """The write channel is live_write.py's subject, not this file's.

    Without this, main() starts a daemon thread on the real stdin, which raises inside
    pytest's capture and shows up as an unhandled thread exception.
    """
    monkeypatch.setattr(live_poll.live_write, "start_stdin_reader", lambda *_a, **_k: None)


# ------------------------------------------------------------------------ helpers

def memory(*specs):
    """(address, value, width) triples -> a byte-addressed map for ByteProbe."""
    mem = {}
    for addr, value, width in specs:
        for i, byte in enumerate(int(value).to_bytes(width, "little")):
            mem[addr + i] = byte
    return mem


def watch(*specs):
    """-> normalized watch list from (name, addr, size) triples."""
    entries = [{"name": n, "address": f"0x{a:08x}", "size": s} for n, a, s in specs]
    got, _ = live_poll.normalize_watch(entries)
    return got


def run(probe, entries, ticks=3, hz=10, out="ignored.csv"):
    """Run the poll loop for a fixed number of ticks. -> (tracker, guard, fakefile)"""
    clock = FakeClock()
    fake = FakeFile()
    counter = [0]

    def stamp():
        counter[0] += 1
        return f"2026-01-01T00:00:{counter[0] - 1:02d}.000"

    tracker, guard = live_poll.poll_loop(
        probe, entries, out, hz=hz, seconds=ticks * (1.0 / hz), clock=clock,
        sleeper=clock.sleep, stamp=stamp,
        open_stream=lambda *a, **k: fake)
    return tracker, guard, fake


def values_of(fake, name):
    return [r.split(",")[3] for r in fake.rows()[1:] if r.split(",")[2] == name]


def write_resolution(tmp_path, symbols, base=BASE, size=256):
    path = tmp_path / "res.json"
    path.write_text(json.dumps({
        "elf": "build-ext/unit_omni3.elf", "base": f"0x{base:08x}", "size": size,
        "end": f"0x{base + size:08x}", "has_debug_info": True,
        "backend": "pyelftools", "symbols": symbols, "unresolved": [],
    }), encoding="utf-8")
    return str(path)


# ------------------------------------------------------- per-member width and CSV

def test_each_member_is_logged_at_its_own_width():
    """1/2/4/8 bytes -> 2/4/8/16 lowercase hex digits, zero-padded."""
    probe = ByteProbe(memory((BASE + 0, 0x01, 1), (BASE + 4, 0x1234, 2),
                             (BASE + 8, 0x00000508, 4),
                             (BASE + 12, 0x105E2B6A4, 8)))
    entries = watch(("a.b1", BASE + 0, 1), ("a.b2", BASE + 4, 2),
                    ("a.w4", BASE + 8, 4), ("a.w8", BASE + 12, 8))
    _, _, fake = run(probe, entries)
    assert values_of(fake, "a.b1") == ["0x01"] * 3
    assert values_of(fake, "a.b2") == ["0x1234"] * 3
    assert values_of(fake, "a.w4") == ["0x00000508"] * 3
    assert values_of(fake, "a.w8") == ["0x0000000105e2b6a4"] * 3


def test_the_hex_is_lowercase_even_when_the_value_is_not():
    entries = watch(("sys.loop_hz", BASE, 4))
    _, _, fake = run(ByteProbe(memory((BASE, 0xDEADBEEF, 4))), entries)
    assert values_of(fake, "sys.loop_hz") == ["0xdeadbeef"] * 3


def test_a_one_byte_member_is_not_polluted_by_its_neighbouring_bytes():
    """The old 32-bit mask turned drive.controller's sixteen bools into 0xff000001."""
    probe = ByteProbe(memory((BASE, 0x01, 1), (BASE + 1, 0xFF, 1), (BASE + 2, 0xFF, 1)))
    entries = watch(("drive.emergency.0.req_active", BASE, 1))
    _, _, fake = run(probe, entries)
    assert values_of(fake, "drive.emergency.0.req_active") == ["0x01"] * 3


def test_a_wide_member_is_assembled_from_word_reads_little_endian():
    """12 bytes (an array of three floats) = three word reads, low word first."""
    probe = ByteProbe(memory((BASE, 0x00112233, 4), (BASE + 4, 0x00DDEEFF, 4),
                             (BASE + 8, 0x00AABBCC, 4)))
    entries = watch(("periph.dji_current.target_current_a", BASE, 12))
    _, _, fake = run(probe, entries)
    assert values_of(fake, "periph.dji_current.target_current_a") == ["0x00aabbcc00ddeeff00112233"] * 3
    assert probe.calls[:3] == [BASE, BASE + 4, BASE + 8]


def test_the_read_plan_only_ever_asks_for_32_bit_transfers():
    """pyOCD's AHB-AP refuses 8/16/64-bit transfers, so the plan must not want them.

    The plan is per ADDRESS as well as per size: the ST-LINK driver also asserts
    that a word transfer is word aligned
    (pyocd/probe/stlink/stlink.py read_mem32), so the words start at the
    member's word boundary below it and run until its last byte is covered.
    """
    for size in range(1, live_poll.MAX_MEMBER_SIZE + 1):
        for addr in (BASE, BASE + 1, BASE + 2, BASE + 3):
            steps = live_poll.read_plan(addr, size)
            assert set(steps) == {live_poll.AP_TRANSFER_BYTES}
            head = addr % 4
            assert len(steps) == (head + size + 3) // 4
    assert live_poll.read_plan(BASE, 1) == (4,)
    assert live_poll.read_plan(BASE, 4) == (4,)
    assert live_poll.read_plan(BASE, 8) == (4, 4)
    # The same member one byte further on needs a second word.
    assert live_poll.read_plan(BASE + 1, 4) == (4, 4)
    assert live_poll.read_plan(BASE + 3, 1) == (4,)


def test_the_header_and_every_row_keep_the_four_column_contract():
    entries = watch(("a.one", BASE, 1), ("a.two", BASE + 4, 4))
    _, _, fake = run(ByteProbe(memory((BASE, 1, 1), (BASE + 4, 2, 4))), entries)
    rows = fake.rows()
    assert rows[0] == "timestamp,address,name,value"
    for row in rows[1:]:
        assert len(row.split(",")) == 4
    assert [r.split(",")[2] for r in rows[1:]] == ["a.one", "a.two"] * 3


def test_a_name_with_a_comma_is_refused_before_it_can_break_a_row():
    """The host drops a row whose field count is not 4, without a word."""
    got, skipped = live_poll.normalize_watch(
        [{"name": "bad,name", "address": f"0x{BASE:08x}", "size": 4}])
    assert got == []
    assert "comma" in skipped[0][1]


# ------------------------------------------------------------ block-read restriction

def test_leaves_sharing_words_are_served_by_one_block_and_each_gets_its_own_bytes():
    """Measured on the real probe: a block transfer costs about an eighth per
    word, so the unit that matters is the group of words covering the leaves,
    not whether a single leaf happens to be 4-byte aligned. Reading 25 one-byte
    leaves individually cost 14.0 ms per tick and missed a 10 ms budget 100% of
    the time; as one 7-word block the same leaves cost 0.8 ms.

    Narrow AND unaligned leaves are therefore served from a block too, sliced
    out of the words that cover them.
    """
    probe = ByteProbe(memory((BASE, 0x00000508, 4),        # 4B aligned leaf
                             (BASE + 4, 0x01, 1), (BASE + 5, 0xFF, 1), (BASE + 6, 0xFF, 1),
                             (BASE + 8, 0x0000DEAD, 4),     # 4B aligned leaf
                             (BASE + 13, 0x0000BEEF, 4)))  # 4B UNALIGNED leaf
    entries = watch(("w.a", BASE, 4), ("b.flag", BASE + 4, 1),
                    ("w.b", BASE + 8, 4), ("w.unaligned", BASE + 13, 4))
    _, _, fake = run(probe, entries, ticks=2)

    assert values_of(fake, "w.a") == ["0x00000508"] * 2
    assert values_of(fake, "w.b") == ["0x0000dead"] * 2
    # The word the block returns for BASE+4 is 0xffffff01; the member is 1 byte.
    assert values_of(fake, "b.flag") == ["0x01"] * 2
    # An unaligned 4-byte member spans two words, both of which the block read
    # covers, so it is served from the block as well.
    assert values_of(fake, "w.unaligned") == ["0x0000beef"] * 2

    assert probe.blocks == 2  # one per tick for the whole group, not one per leaf
    # Only the members that span more than one word are re-read for the tear
    # guard; the rest arrive whole in a single covering word.
    assert probe.calls[:1] == [BASE + 12]


def test_a_failed_block_read_falls_back_to_individual_reads_and_keeps_polling():
    class NoBlock(ByteProbe):
        def read_block(self, base_addr, word_count):
            raise OSError("transfer fault")

    entries = watch(("w.a", BASE, 4), ("w.b", BASE + 8, 4), ("b.flag", BASE + 12, 1))
    _, _, fake = run(NoBlock(memory((BASE, 0x11, 4), (BASE + 8, 0x22, 4),
                                    (BASE + 12, 0x01, 1))), entries)
    assert values_of(fake, "w.a") == ["0x00000011"] * 3
    assert values_of(fake, "b.flag") == ["0x01"] * 3


def test_nothing_is_block_read_when_a_lone_leaf_is_cheaper_alone():
    """One leaf on its own is a single read32; a block call would be overhead."""
    probe = ByteProbe(memory((BASE, 0x01, 1),))
    entries = watch(("a", BASE, 1))
    run(probe, entries, ticks=1)
    assert probe.blocks == 0
    assert probe.calls == [BASE]


# ------------------------------------------------------------------ flush per tick

def test_the_file_is_flushed_once_per_tick():
    """D7: without it the rows sit in an 8KB buffer and the host sees 145-row bunches."""
    entries = watch(("a.one", BASE, 1), ("a.two", BASE + 4, 4))
    tracker, _, fake = run(ByteProbe(memory((BASE, 1, 1), (BASE + 4, 2, 4))), entries,
                           ticks=4)
    assert tracker.expected == 4
    # 4 ticks + 1 for the header, which has to be visible before the first tick.
    assert fake.flushes == tracker.expected + 1


def test_the_rows_of_a_tick_are_in_the_file_before_the_next_one():
    """A reader tailing the file must never see a tick that has not been flushed."""
    seen = []
    clock = FakeClock()
    fake = FakeFile()
    entries = watch(("a.one", BASE, 1))

    def stamp():
        return f"t{len(seen) + 1}"

    original_sleep = clock.sleep

    def sleep(seconds):
        seen.append(fake.text.count("\n"))  # lines already on disk
        original_sleep(seconds)

    live_poll.poll_loop(ByteProbe(), entries, "x.csv", hz=10, seconds=0.3, clock=clock,
                        sleeper=sleep, stamp=stamp, open_stream=lambda *a, **k: fake)
    # header + the row of the tick that just finished, then one more per later tick.
    assert seen == [2, 3, 4]


# ------------------------------------------------------------------- tear accounting

def test_a_wide_member_is_really_read_twice_and_accepted_when_it_holds_still():
    entries = watch(("ctrl.time_ns", BASE, 8))
    tracker, guard, fake = run(ByteProbe(memory((BASE, 0x01, 4))), entries)
    assert guard.double_reads == tracker.expected > 0
    assert guard.tears == 0
    assert len(values_of(fake, "ctrl.time_ns")) == tracker.expected


def test_a_wide_member_that_changes_mid_read_is_a_tear_and_is_dropped():
    entries = watch(("ctrl.time_ns", BASE, 8))
    tracker, guard, fake = run(CountingWideProbe(), entries)
    assert guard.double_reads == tracker.expected
    assert guard.tears == tracker.expected
    assert guard.accepted == 0
    assert values_of(fake, "ctrl.time_ns") == []          # dropped, not logged
    assert fake.rows() == ["timestamp,address,name,value"]


def test_tears_break_the_drop_budget_even_when_every_tick_was_collected():
    entries = watch(("ctrl.time_ns", BASE, 8))
    tracker, guard, _ = run(CountingWideProbe(), entries)
    assert tracker.dropped == 0                            # every tick fit its slot
    ok, detail = live_poll.check_budgets(tracker, guard, len(entries))
    assert ok is False
    assert f"tears={tracker.expected} of {tracker.expected} double-reads" in detail
    assert "sample_fail=100.0000%" in detail


def test_a_narrow_member_is_read_once_and_never_double_counted():
    """One AHB-AP transfer cannot tear, so there is nothing to re-read."""
    entries = watch(("b.flag", BASE, 1), ("h.half", BASE + 4, 2), ("w.word", BASE + 8, 4))
    tracker, guard, _ = run(ByteProbe(memory((BASE, 1, 1))), entries)
    assert guard.double_reads == 0
    assert guard.tears == 0
    assert guard.accepted == tracker.expected * len(entries)
    assert live_poll.check_budgets(tracker, guard, len(entries))[0] is True


def test_the_guard_cannot_pass_by_comparing_a_value_with_itself():
    """check() is fed two reads, and must reject a mismatch it is shown."""
    guard = live_poll.DoubleReadGuard()
    assert guard.check(0x1122334455667788, 0x1122334455667788) is True
    assert guard.check(0x1122334455667788, 0x1122334455667789) is False
    assert (guard.double_reads, guard.tears, guard.accepted) == (2, 1, 1)


# ------------------------------------------------------------------ size-less members

@pytest.mark.parametrize("bad", [None, 0, -1, 99, "wide", True, 3.5])
def test_a_member_with_no_usable_size_is_named_and_left_out(bad):
    entry = {"name": "sys.loop_hz", "address": f"0x{BASE:08x}"}
    if bad is not None:
        entry["size"] = bad
    got, skipped = live_poll.normalize_watch([entry])
    assert got == []                       # never silently defaulted to 4
    assert [n for n, _ in skipped] == ["sys.loop_hz"]
    assert "size" in skipped[0][1]


def test_a_size_less_member_is_named_in_the_startup_log(tmp_path, capsys):
    res = write_resolution(tmp_path, [
        {"name": "sys.loop_hz", "address": f"0x{BASE:08x}", "size": 4},
        {"name": "sys.unknown", "address": f"0x{BASE + 8:08x}"}])
    got, skipped = live_poll.load_watchlist(res)
    assert [w["name"] for w in got] == ["sys.loop_hz"]
    assert "sys.unknown" in [n for n, _ in skipped]
    live_poll.report_skipped(skipped)
    assert "sys.unknown" in capsys.readouterr().err


def test_a_resolution_file_with_nothing_pollable_stops_with_its_own_code(tmp_path, capsys):
    res = write_resolution(tmp_path, [{"name": "sys.unknown", "address": f"0x{BASE:08x}"}])
    out = tmp_path / "live.csv"
    code = live_poll.main(["--resolution", res, "--out", str(out), "--mock",
                           "--hz", "10", "--seconds", "0.05"])
    assert code == live_poll.EXIT_NO_WATCH == 6
    assert "sys.unknown" in capsys.readouterr().err
    assert not out.exists()


def test_a_symbol_outside_the_resolved_window_is_reported_not_polled(tmp_path):
    res = write_resolution(tmp_path, [
        {"name": "in.range", "address": f"0x{BASE:08x}", "size": 4},
        {"name": "stale.one", "address": "0x30000000", "size": 4}])
    got, skipped = live_poll.load_watchlist(res)
    assert [w["name"] for w in got] == ["in.range"]
    assert "outside" in dict(skipped)["stale.one"]
    # The skip names the symbol size and hints the ELF is stale.
    assert "stale" in dict(skipped)["stale.one"].lower()
    assert "4" in dict(skipped)["stale.one"]


def test_csv_rotation_limit_scales_with_hz_and_watch_length():
    """155 leaves @ 100Hz log 15500 rows/s, so the 100k floor alone rotates
    every ~6.45s. The dynamic limit keeps a ~120s window, capped at 5M."""
    assert live_poll.CSV_MAX_ROWS == 100000  # floor constant, kept for tests
    assert live_poll.csv_rotation_limit(100, 155) == 100 * 155 * 120
    assert live_poll.csv_rotation_limit(100, 10) == max(100000, 100 * 10 * 120)
    assert live_poll.csv_rotation_limit(10, 1) == 100000  # floor wins
    assert live_poll.csv_rotation_limit(200, 10000) == 5_000_000  # cap wins


def test_csv_does_not_rotate_every_few_seconds_at_155_leaves_100hz(capsys):
    """With the old fixed 100k limit, 155 rows/tick @ 100Hz rotated after ~6.5
    ticks; the dynamic limit must hold a full short run without rotating."""
    entries = watch(*[(f"w.{i}", BASE + i * 4, 4) for i in range(155)])
    probe = ByteProbe()
    run(probe, entries, ticks=10, hz=100)
    assert "rotated" not in capsys.readouterr().out


def test_an_extra_without_a_size_is_refused_with_the_working_form(tmp_path, capsys):
    res = write_resolution(tmp_path, [{"name": "sys.loop_hz", "address": f"0x{BASE:08x}",
                                        "size": 4}])
    out = tmp_path / "live.csv"
    assert live_poll.main(["--resolution", res, "--out", str(out), "--mock",
                           "--hz", "10", "--seconds", "0.05",
                           "--extra", "tuner.kp=0x20000100"]) == live_poll.EXIT_OK
    text = capsys.readouterr().err
    assert "never guessed" in text
    assert "--extra tuner.kp=0x20000100:<bytes>" in text
    assert "tuner.kp" not in out.read_text(encoding="utf-8")

    assert live_poll.main(["--resolution", res, "--out", str(out), "--mock",
                           "--hz", "10", "--seconds", "0.05",
                           "--extra", "tuner.kp=0x20000100:2"]) == live_poll.EXIT_OK
    assert "tuner.kp,0x" in out.read_text(encoding="utf-8")


def test_an_extra_with_a_size_bypasses_the_window_filter(tmp_path):
    res = write_resolution(tmp_path, [{"name": "sys.loop_hz", "address": f"0x{BASE:08x}",
                                        "size": 4}])
    out = tmp_path / "live.csv"
    assert live_poll.main(["--resolution", res, "--out", str(out), "--mock",
                           "--hz", "50", "--seconds", "0.06",
                           "--extra", "tuner.kp=0x30000100:2"]) == live_poll.EXIT_OK
    rows = [r for r in out.read_text(encoding="utf-8").splitlines() if "tuner.kp" in r]
    assert rows and all(r.split(",")[1] == "0x30000100" for r in rows)
    assert all(len(r.split(",")) == 4 for r in rows)
    # The DebugGlobal fence itself is untouched.
    assert [w["name"] for w in live_poll.load_watchlist(res)[0]] == ["sys.loop_hz"]


# --------------------------------------------------------------------- USB attach

def test_a_usb_error_on_attach_is_retried_with_growing_backoff():
    attempts = []
    slept = []

    def factory():
        attempts.append(len(attempts) + 1)
        raise USBError("[Errno 110] Operation timed out")

    with pytest.raises(live_poll.AttachError) as caught:
        live_poll.connect_with_retry(factory, retries=4, backoff=1.0,
                                     sleep=slept.append, log=lambda _m: None)
    assert attempts == [1, 2, 3, 4]
    assert slept == [1.0, 2.0, 4.0]
    assert "Errno 110" in str(caught.value)
    assert "replug the ST-LINK" in str(caught.value)


def test_the_backoff_is_capped_so_a_wedged_probe_cannot_stall_forever():
    slept = []
    with pytest.raises(live_poll.AttachError):
        live_poll.connect_with_retry(
            lambda: (_ for _ in ()).throw(USBError("boom")), retries=8, backoff=1.0,
            sleep=slept.append, log=lambda _m: None)
    assert max(slept) == live_poll.ATTACH_BACKOFF_MAX_S
    assert sum(slept) < 60


def test_a_non_usb_attach_failure_is_not_retried():
    attempts = []

    def factory():
        attempts.append(1)
        raise RuntimeError("pyocd is not installed")

    with pytest.raises(RuntimeError) as caught:
        live_poll.connect_with_retry(factory, sleep=lambda _s: None, log=lambda _m: None)
    assert attempts == [1]
    assert "pyocd is not installed" in str(caught.value)


def test_a_usb_timeout_ends_the_run_with_its_own_exit_code(tmp_path, capsys, monkeypatch):
    res = write_resolution(tmp_path, [{"name": "sys.loop_hz", "address": f"0x{BASE:08x}",
                                        "size": 4}])
    attempts = []

    def factory(*_a, **_kw):
        attempts.append(1)
        raise USBError("[Errno 110] Operation timed out")

    monkeypatch.setattr(live_poll, "PyocdProbe", factory)
    monkeypatch.setattr(live_poll, "ATTACH_BACKOFF_S", 0.0)
    code = live_poll.main(["--resolution", res, "--out", str(tmp_path / "live.csv"),
                           "--hz", "10", "--seconds", "0.05"])
    assert code == live_poll.EXIT_USB == 5
    assert len(attempts) == live_poll.ATTACH_RETRIES
    text = capsys.readouterr().err
    assert "USB error while attaching the ST-LINK" in text
    assert "Errno 110" in text
    assert "Nothing was written to the target" in text
    assert "replug the ST-LINK" in text


def test_a_usb_timeout_that_clears_on_the_retry_still_polls(tmp_path, monkeypatch):
    res = write_resolution(tmp_path, [{"name": "sys.loop_hz", "address": f"0x{BASE:08x}",
                                        "size": 4}])
    attempts = []

    def factory(*_a, **_kw):
        attempts.append(1)
        if len(attempts) == 1:
            raise USBError("[Errno 110] Operation timed out")
        return ByteProbe(memory((BASE, 0x508, 4)))

    monkeypatch.setattr(live_poll, "PyocdProbe", factory)
    monkeypatch.setattr(live_poll, "ATTACH_BACKOFF_S", 0.0)
    out = tmp_path / "live.csv"
    assert live_poll.main(["--resolution", res, "--out", str(out),
                           "--hz", "20", "--seconds", "0.06"]) == live_poll.EXIT_OK
    assert len(attempts) == 2
    assert "0x00000508" in out.read_text(encoding="utf-8")


def test_a_missing_probe_still_reports_its_own_code(tmp_path, capsys, monkeypatch):
    res = write_resolution(tmp_path, [{"name": "sys.loop_hz", "address": f"0x{BASE:08x}",
                                        "size": 4}])
    monkeypatch.setattr(live_poll, "PyocdProbe",
                        lambda *_a, **_kw: (_ for _ in ()).throw(
                            RuntimeError("no debug probe found")))
    assert live_poll.main(["--resolution", res, "--out", str(tmp_path / "live.csv"),
                           "--hz", "10", "--seconds", "0.05"]) == live_poll.EXIT_NO_PROBE
    assert "no debug probe found" in capsys.readouterr().err


# ----------------------------------------------------------------------- mock run

def test_mock_runs_end_to_end_and_keeps_the_csv_contract(tmp_path, capsys):
    """The hardware-free path CI depends on: header, widths, rows, exit code."""
    res = write_resolution(tmp_path, [
        {"name": "sys.loop_hz", "address": f"0x{BASE:08x}", "size": 4, "type": "uint32_t"},
        {"name": "drive.motor_timeout", "address": f"0x{BASE + 4:08x}", "size": 1,
         "type": "bool"},
        {"name": "nav.robot_yaw_deg", "address": f"0x{BASE + 8:08x}", "size": 4,
         "type": "float"},
        {"name": "ctrl.time_ns", "address": f"0x{BASE + 16:08x}", "size": 8,
         "type": "uint64_t"}])
    out = tmp_path / "live.csv"
    assert live_poll.main(["--resolution", res, "--out", str(out), "--mock",
                           "--hz", "20", "--seconds", "0.16"]) == live_poll.EXIT_OK
    rows = out.read_text(encoding="utf-8").splitlines()
    assert rows[0] == "timestamp,address,name,value"
    for row in rows[1:]:
        assert len(row.split(",")) == 4
    widths = {r.split(",")[2]: len(r.split(",")[3]) - 2 for r in rows[1:]}
    assert widths == {"sys.loop_hz": 8, "drive.motor_timeout": 2,
                      "nav.robot_yaw_deg": 8, "ctrl.time_ns": 16}
    # One row per member per tick, and the run really produced more than one tick.
    assert len(rows) > 1 and (len(rows) - 1) % 4 == 0
    assert "mock done" in capsys.readouterr().out


def test_mock_reports_a_torn_run_as_a_budget_failure(tmp_path, capsys):
    """--mock-tear-every perturbs every Nth word read; a wide member then really tears."""
    res = write_resolution(tmp_path, [
        {"name": "ctrl.time_ns", "address": f"0x{BASE:08x}", "size": 8}])
    out = tmp_path / "live.csv"
    code = live_poll.main(["--resolution", res, "--out", str(out), "--mock",
                           "--mock-tear-every", "3", "--hz", "20", "--seconds", "0.16"])
    assert code == live_poll.EXIT_BUDGET == 4
    assert "tears=" in capsys.readouterr().out
    assert out.read_text(encoding="utf-8").splitlines() == ["timestamp,address,name,value"]


def test_no_probe_attached_fails_fast_instead_of_waiting_forever(monkeypatch, tmp_path, capsys):
    """An unplugged ST-LINK is the most common reason a session cannot start.

    `ConnectHelper.session_with_chosen_probe` prints "Waiting for a debug probe
    to be connected..." and blocks indefinitely, so EXIT_NO_PROBE was
    unreachable and the user watched a dead session for as long as they
    waited. The probe list is enumerated non-blocking first, so an empty list is
    a definite answer and turns into this exit code plus an actionable message.
    """
    # ponytail: in-test importorskip (same reason-giving skip style as
    # test_elf_resolve.py's skipif guards) — pyocd is hardware tooling, not a
    # test dependency, so missing pyocd skips instead of failing.
    helpers = pytest.importorskip("pyocd.core.helpers", reason="pyocd not installed (hardware tooling)")

    class EmptyConnectHelper:
        def __init__(self):
            self.opened = False

        @staticmethod
        def get_all_connected_probes(blocking=True, print_wait_message=True):
            assert blocking is False, "enumeration must not block; that is the hang"
            return []

        def session_with_chosen_probe(self, **kwargs):
            raise AssertionError("must not open a session when no probe is attached")

    monkeypatch.setattr(helpers, "ConnectHelper", EmptyConnectHelper)
    res = write_resolution(tmp_path, [
        {"name": "sys.loop_hz", "address": f"0x{BASE:08x}", "size": 4}])
    out = tmp_path / "live.csv"
    code = live_poll.main(["--resolution", res, "--out", str(out),
                           "--hz", "10", "--seconds", "1"])
    assert code == live_poll.EXIT_NO_PROBE == 3
    err = capsys.readouterr().err
    assert "ST-LINK が見つかりません" in err
    assert not out.exists(), "nothing may be logged when no probe answered"


def test_a_present_probe_still_takes_the_session_path(monkeypatch, tmp_path):
    """The enumeration must not break the working case: a non-empty list goes on
    to open a session exactly as before."""
    # ponytail: same skip guard as above — both tests need pyocd's helpers.
    helpers = pytest.importorskip("pyocd.core.helpers", reason="pyocd not installed (hardware tooling)")

    class OneConnectHelper:
        opened = False

        @staticmethod
        def get_all_connected_probes(blocking=True, print_wait_message=True):
            return ["fake-probe"]

        @staticmethod
        def session_with_chosen_probe(**kwargs):
            raise RuntimeError("reached the session path")

    monkeypatch.setattr(helpers, "ConnectHelper", OneConnectHelper)
    res = write_resolution(tmp_path, [
        {"name": "sys.loop_hz", "address": f"0x{BASE:08x}", "size": 4}])
    with pytest.raises(RuntimeError, match="reached the session path"):
        live_poll.PyocdProbe(target_override="stm32g474retx")
