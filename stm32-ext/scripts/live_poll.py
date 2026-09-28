#!/usr/bin/env python3
r"""Live SWD polling sidecar (todo5b).

Primary path: pyOCD, 100 Hz default (up to 200 Hz), NO HALT (reads via the AHB-AP while the core
keeps running — halt-by-default reads are forbidden by the plan).

Per-member width: every watched leaf carries its byte size from elf_resolve.py and is read at
that width. An AHB-AP transfer is 32 bits wide and nothing else — pyOCD raises DebugError
("unsupported transfer size") for read8/read16/read64 on a Cortex-M target — so a 1-byte bool and
a 12-byte array are assembled from as many word reads as they need, keeping only their own bytes.
A value is logged as `0x` plus lowercase hex zero-padded to exactly size*2 digits, so a 1-byte
bool is `0x01` and a 64-bit counter is 16 digits wide. There is no global --width: one watchlist
mixes 1/2/4/8-byte members, and a width that was not declared is reported, never guessed.

Block reads: probe.read_block is read_memory_block32, a 32-bit-word API that carries no per-leaf
width, so it is used ONLY for leaves that are 4 bytes wide AND 4-byte aligned. Every other leaf is
read individually. In the real firmware most of the 324 DebugGlobal leaves are 1 or 2 bytes wide
(142 one-byte, 9 two-byte, measured off the DWARF), and taking those from a 32-bit block read
hands them their neighbours' bytes (the measured symptom: drive.controller's sixteen bools all
read as 0xff000001).

Tear guard: one word read is a single AHB-AP transfer and cannot observe a half-updated value, so
members of 4 bytes or less are accepted after one read. A wider member is assembled from several
transfers and IS therefore read a second time: a mismatch means the firmware changed the bytes
mid-read, and that sample is dropped and counted as a tear. The counters come from real reads; no
value is ever compared with itself.

Drop-rate logging: expected_ticks vs. collected samples over the run; hardware acceptance is <1%
drops over 5 min @10Hz (G12). Ticks that overrun their slot and torn samples both count against
that budget.

CSV schema (fixed, asserted by tests):
  timestamp,address,name,value
Four columns, always: the host parser silently discards any row whose field count is not 4. The
file is flushed every tick, so the host sees rows as they are produced instead of in ~8KB bunches
(measured: up to 145 rows / 145ms of invisible lag).

Attach: a USB timeout on the first connect (observed once in 11 attempts, cause still unknown) is
retried with bounded backoff and, if it persists, reported with an actionable message and a
distinct exit code. Nothing is ever written to the target from here.

Usage:
  live_poll.py --resolution <elf_resolve.json> --out live.csv
      [--hz 100] [--seconds 300] [--mock] [--ensure-pyocd]
      [--target stm32g474retx] [--extra name=0xaddr:SIZE]

  --mock: no hardware. A MockProbe serves deterministic words so CI and the pytest suite can
      verify the read plan, the tear guard, the per-width CSV and the drop budget.
  --extra: extra watch symbol as name=0xaddr:SIZE (repeatable); bypasses the DebugGlobal range
      filter for user-picked variables (e.g. tuner globals). SIZE is mandatory: the width decides
      how many bytes are read and how many hex digits are logged, so it is never assumed.
  --ensure-pyocd: install pyocd into a temporary venv (PEP 668 safe), record the
      result on stdout, then continue (mock if still unavailable). The extension
      normally does this itself on first run, so this is the manual fallback.

Only stdlib + optional pyocd. Never halts the target. The one exception to read-only is the
stdin write channel (live_write.py): JSON requests fenced inside the resolved DebugGlobal range,
issued by the host only after a modal confirmation, and re-checked here before the bus is touched.
"""
import argparse
import csv
import json
import os
import queue
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import live_write  # noqa: E402

CSV_HEADER = ["timestamp", "address", "name", "value"]

PYOCD_INSTALL_CMD = "auto-install pyocd (venv, PEP 668 safe)"

# Exit codes. Every failure is non-zero, but the host (and the log) are better served by
# knowing which failure it was than by "1".
EXIT_OK = 0
EXIT_NO_PROBE = 3      # no ST-LINK found, or pyocd missing
EXIT_BUDGET = 4        # the run finished but the <1% drop budget was blown
EXIT_USB = 5           # USB transport failure while attaching
EXIT_NO_WATCH = 6      # nothing pollable in the resolution file

# An AHB-AP transfer is 32 bits = 4 bytes, and that is the only size pyOCD issues for a
# Cortex-M target (see the docstring). Every read in this file is a multiple of these 4 bytes.
AP_TRANSFER_BYTES = 4

# Widest member this sidecar will poll. A value that needs more transfers than this cannot be
# made consistent by a second read, so the honest answer is to name it and leave it out.
MAX_MEMBER_SIZE = 16

# read_memory_block32 is used only for 4-byte-aligned 4-byte leaves, and only while the whole
# window still fits in one transfer batch.
MAX_BLOCK_SPAN = 4096

# Attach retry. Bounded, so a wedged ST-LINK surfaces as an error instead of an endless wait.
ATTACH_RETRIES = 3
ATTACH_BACKOFF_S = 1.0
ATTACH_BACKOFF_MAX_S = 8.0

USB_ERROR_HINT = (
    "the ST-LINK did not answer on the USB bus. Nothing was written to the target. "
    "Close anything else that may hold the probe (STM32CubeProgrammer, OpenOCD, "
    "arm-none-eabi-gdb, a second stm32-ext window), unplug and replug the ST-LINK, and "
    "start Live again. If it keeps happening, check the USB cable and the udev rule for "
    "the ST-LINK V2 (id 0483:3748).")


def err(message):
    """Diagnostics go to stderr; stdout stays machine-parseable."""
    print(f"live_poll: {message}", file=sys.stderr, flush=True)


def ensure_pyocd():
    """Install pyocd into a venv under the system temp dir; return (ok, detail).

    `pip install --user` is what this used to run, and it is refused outright on
    any current Debian/Ubuntu: /usr/lib/python3.*/EXTERNALLY-MANAGED makes pip
    exit with PEP 668, so the documented recovery from "pyocd is not installed"
    failed on exactly the machines that needed it. A venv has no such marker.

    The success signal is the INSTALL's exit code, never the venv's: creating a
    venv is a setup step, and an earlier version returned on it — reporting
    pyocd installed while the module was still missing, which its own smoke
    test passed on because the smoke asserted the return value and not the
    import.
    """
    import subprocess
    import tempfile
    venv_dir = os.path.join(tempfile.gettempdir(), "stm32ext-pyocd-venv")
    venv_python = os.path.join(venv_dir, "bin", "python")
    detail = "no install was attempted"
    cmd = [sys.executable, "-m", "pip", "install", "pyocd"]
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    except Exception as e:  # noqa: BLE001 - record, don't crash
        detail = f"{' '.join(cmd)} -> FAIL: {e}"
    else:
        if p.returncode == 0:
            return True, f"{' '.join(cmd)} -> OK"
        tail = (p.stdout + p.stderr).strip().splitlines()
        detail = (f"{' '.join(cmd)} -> FAIL: "
                  f"{tail[-1] if tail else f'exit={p.returncode}'}")
    # Creating the venv is a setup step, NOT a success. Returning on it would
    # report pyocd as installed while the module is still missing, which is
    # exactly how the first version of this function passed its own smoke test.
    try:
        v = subprocess.run([sys.executable, "-m", "venv", venv_dir],
                           capture_output=True, text=True, timeout=600)
    except Exception as e:  # noqa: BLE001
        return False, f"{PYOCD_INSTALL_CMD} -> FAIL: venv: {e}"
    if v.returncode != 0:
        return False, f"{PYOCD_INSTALL_CMD} -> FAIL: {detail}; venv: {v.stderr.strip()[-200:]}"
    cmd = [venv_python, "-m", "pip", "install", "pyocd"]
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
    except Exception as e:  # noqa: BLE001
        return False, f"{PYOCD_INSTALL_CMD} -> FAIL: venv python: {e}"
    if p.returncode == 0:
        return True, f"{' '.join(cmd)} -> OK"
    tail = (p.stdout + p.stderr).strip().splitlines()
    return False, (f"{PYOCD_INSTALL_CMD} -> FAIL: {detail}; then "
                   f"{tail[-1] if tail else f'exit={p.returncode}'}")


def is_usb_error(exc):
    """True for usb.core.USBError and anything raised from it.

    Matched by class name so the module keeps working (and stays testable) without importing
    libusb: pyOCD re-exports the same class, and every ST-LINK transport failure arrives as
    USBError regardless of which pyOCD layer noticed it.
    """
    return any(cls.__name__ == "USBError" for cls in type(exc).__mro__)


class AttachError(RuntimeError):
    """A USB transport failure that survived every attach attempt."""


def connect_with_retry(factory, retries=None, backoff=None, sleep=None, log=None):
    """Attach the probe, retrying only USB transport failures.

    Returns the probe. Raises AttachError when the USB bus kept failing, and lets any other
    exception through unchanged (a missing pyOCD or "no probe found" is not something a
    retry fixes). Defaults are resolved per call, not at import time.
    """
    retries = ATTACH_RETRIES if retries is None else retries
    backoff = ATTACH_BACKOFF_S if backoff is None else backoff
    sleep = time.sleep if sleep is None else sleep
    log = err if log is None else log
    attempts = max(retries, 1)
    last = None
    for attempt in range(1, attempts + 1):
        try:
            return factory()
        except Exception as e:  # noqa: BLE001 - classify, then decide
            if not is_usb_error(e):
                raise
            last = e
            if attempt >= attempts:
                break
            delay = min(backoff * (2 ** (attempt - 1)), ATTACH_BACKOFF_MAX_S)
            log(f"USB error while attaching ({e}); attempt {attempt}/{attempts} failed, "
                f"retrying in {delay:.1f}s")
            sleep(delay)
    raise AttachError(
        f"USB error while attaching the ST-LINK: {attempts} attempts failed "
        f"(last error: {last}) — {USB_ERROR_HINT}") from last


class DoubleReadGuard:
    """Tear guard: a sample is only logged if it is provably not torn.

    `accept` is the single-transfer path (a word or less: one AHB-AP read cannot observe a
    half-written value). `check` is the wide path: the member is read a second time and a
    mismatch is a real tear, dropped from the CSV and counted against the budget.
    """

    def __init__(self):
        self.tears = 0
        self.accepted = 0
        self.double_reads = 0

    def accept(self, count=1):
        """Record `count` samples read in one atomic transfer (cannot tear)."""
        self.accepted += count
        return True

    def check(self, first, second):
        """True if the sample is clean (the two real reads agree)."""
        self.double_reads += 1
        if first == second:
            self.accepted += 1
            return True
        self.tears += 1
        return False


class DropTracker:
    """Expected-tick vs collected-sample accounting for G12 <1% drops."""

    def __init__(self, hz):
        self.hz = hz
        self.expected = 0
        self.collected = 0
        self.dropped = 0

    def tick(self, got):
        self.expected += 1
        if got:
            self.collected += 1
        else:
            self.dropped += 1

    @property
    def drop_rate(self):
        return (self.dropped / self.expected) if self.expected else 0.0

    def summary(self):
        return (f"ticks={self.expected} collected={self.collected} "
                f"dropped={self.dropped} drop_rate={self.drop_rate:.4%} "
                f"(budget: <1% required)")


def effective_fail_rate(tracker, guard, watch_len):
    """Sample-level budget: torn samples vanish from the CSV, so they must
    count against the <1% budget too — otherwise a header-only all-tear run
    reports drop_rate=0% and passes. Returns 1 - accepted/expected_samples."""
    expected_samples = tracker.expected * max(watch_len, 1)
    if not expected_samples:
        return 0.0
    return 1.0 - guard.accepted / expected_samples


def check_budgets(tracker, guard, watch_len):
    """Return (ok, detail). Both the tick-overrun rate AND the sample-level
    rate (tears folded in) must be <1%."""
    eff = effective_fail_rate(tracker, guard, watch_len)
    detail = (f"{tracker.summary()}, tears={guard.tears} of "
              f"{guard.double_reads} double-reads, sample_fail={eff:.4%}")
    if tracker.drop_rate >= 0.01 or eff >= 0.01:
        return False, detail
    return True, detail


def read_plan(addr, size):
    """The AHB-AP word reads needed to read a `size`-byte member at `addr`.

    Every transfer is a word AND word aligned: pyOCD's AHB-AP raises
    DebugError("unsupported transfer size") for any narrower size, and the
    ST-LINK driver asserts the transfer is word aligned
    (pyocd/probe/stlink/stlink.py read_mem32: "address and size must be word
    aligned"). So the plan starts at the member's word boundary BELOW it and
    runs until the member's last byte is covered.

    One covering word means the whole member arrives in a single transfer and
    cannot tear; two or more can, which is exactly the tear-guard split.
    """
    if size < 1:
        raise ValueError(f"member size must be >= 1, got {size}")
    head = addr % AP_TRANSFER_BYTES
    words = (head + size + AP_TRANSFER_BYTES - 1) // AP_TRANSFER_BYTES
    return (AP_TRANSFER_BYTES,) * words


def member_from_words(words, index, head, size):
    """Assemble one member out of the words starting at `words[index]`.

    `head` is how many bytes of the first word belong to whatever came before
    this member. A member wider than one word spans several, and both read
    paths must assemble it identically: the block path taking only the first
    word is what made an 8-byte member look torn on every single tick.
    """
    need = (head + size + AP_TRANSFER_BYTES - 1) // AP_TRANSFER_BYTES
    raw = 0
    for i in range(need):
        raw |= (int(words[index + i]) & 0xFFFFFFFF) << (32 * i)
    return (raw >> (8 * head)) & ((1 << (8 * size)) - 1)


def read_member(probe, addr, size):
    """Read a `size`-byte member as covering 32-bit words.

    The words start at `addr`'s word boundary below it and the member's own
    bytes are sliced out of the little-endian stream they form. Reading from the
    member's own address is what this replaced: it worked only because the fake
    probe in the tests has no alignment rule, and the first run against a real
    ST-LINK died on `AssertionError: address and size must be word aligned`
    for every 1-byte member that does not sit on a word boundary.
    """
    base = addr - (addr % AP_TRANSFER_BYTES)
    head = addr - base
    need = read_plan(addr, size)
    words = [probe.read32(base + i * AP_TRANSFER_BYTES) for i in range(len(need))]
    return member_from_words(words, 0, head, size)


def format_value(value, size):
    """`0x` + lowercase hex, zero-padded to exactly size*2 digits.

    The host accepts a row only if it has 4 fields and checks nothing else, so the digit count
    is the only thing that distinguishes a 1-byte `0x01` from a 4-byte `0x00000001`.
    """
    return f"0x{int(value) & ((1 << (size * 8)) - 1):0{size * 2}x}"


class MockProbe:
    """Hardware-free probe: stable words, optional tear injection.

    The memory model is a deterministic function of the address, so a value does not drift
    between reads. With tear_every=N, every Nth word read is perturbed by one bit: a member
    wider than 4 bytes (read twice) then genuinely disagrees with itself and the guard counts a
    real tear, while a narrow member is read once and simply carries the perturbed bit — which
    is the point of the tear-guard split.

    The surface is deliberately only what the AHB-AP can do: read32, write32 and
    read_block. The real probe cannot issue anything narrower (see the module docstring),
    so a mock that pretended otherwise would let a broken sidecar pass CI.
    """

    def __init__(self, tear_every=0):
        self.reads = 0
        self.tear_every = tear_every
        self.mem = {}
        self.halted = False

    def read32(self, addr):
        self.reads += 1
        if addr in self.mem:
            return self.mem[addr]
        val = (addr * 0x9E3779B1) & 0xFFFFFFFF
        if self.tear_every and self.reads % self.tear_every == 0:
            val ^= 0x00000001
        return val

    def write32(self, addr, val):
        self.mem[addr] = val & 0xFFFFFFFF

    def read_block(self, base_addr, word_count):
        return [self.read32(base_addr + i * 4) for i in range(word_count)]

    def close(self):
        pass


class PyocdProbe:
    """Real probe via pyOCD. Reads are plain AHB-AP accesses: no halt.

    Deliberately exposes read32 and read_block only. pyOCD's AHB-AP
    (pyocd/coresight/dap.py APAccessMemoryInterface.read_memory) raises
    DebugError("unsupported transfer size") for 8/16/64-bit transfers, so a narrow member has to
    be sliced out of a word read here rather than read at its own width by the driver.
    """

    def __init__(self, target_override=None):
        try:
            from pyocd.core.helpers import ConnectHelper  # noqa: PLC0415
        except ImportError as e:
            raise RuntimeError(
                "pyocd is not installed. The extension installs this on first run "
                "— reload the window to retry, or run "
                "`python3 scripts/live_poll.py --ensure-pyocd`.") from e
        # Enumerate BEFORE opening a session. `session_with_chosen_probe` prints
        # "Waiting for a debug probe to be connected..." and blocks forever when
        # nothing is plugged in, so the EXIT_NO_PROBE path was unreachable for
        # the most common real cause (an unplugged ST-LINK, a powered-off
        # board): the user watched a dead session for as long as they waited.
        # `blocking=False` is the whole point: the blocking default is exactly
        # the hang this replaces, and it is passed to the session call below
        # as well, so neither step can wait forever.
        try:
            found = list(ConnectHelper.get_all_connected_probes(
                blocking=False, print_wait_message=False))
        except Exception as e:  # noqa: BLE001 - a failed enumeration must not be
            # swallowed silently: say so, then let the session attempt report
            # whatever is actually wrong. Silently falling through is how an
            # undetected probe became an invisible hang.
            found = None
            self._probe_enum_error = e
            err(f"live_poll: probe 列挙に失敗しました ({e}); "
                f"セッション試行へ進みます")
        if found is not None and not found:
            raise RuntimeError(
                "ST-LINK が見つかりません。USB ケーブルの接続と "
                "拡張ボードの電源を確認してください "
                "(pyOCD は接続されるまで無限に待機します)")
        self._session = ConnectHelper.session_with_chosen_probe(
            blocking=False, target_override=target_override)
        if self._session is None:
            raise RuntimeError("no debug probe found (pyOCD found no ST-LINK/J-LINK). "
                               "Check USB/ST-LINK, then retry.")
        self._session.open()
        self._board = self._session.board
        self._target = self._board.target
        # A post-flash core is often left halted (connect-under-reset + -rst):
        # values would read stale forever. Resume once so live data flows;
        # reads themselves remain plain no-halt AHB-AP accesses.
        self.resumed = False
        try:
            if self._target.is_halted():
                self._target.resume()
                self.resumed = True
        except Exception:  # noqa: BLE001 - resume is best-effort
            pass

    def read32(self, addr):
        return self._target.read32(addr)

    def read_block(self, base_addr, word_count):
        """One USB transaction for a contiguous word range (10x fewer
        round-trips than per-symbol reads: the 50Hz CPU fix).

        32-bit words only, no per-leaf width: callers must restrict this to 4-byte-aligned
        4-byte members (D5)."""
        return self._target.read_memory_block32(base_addr, word_count)

    def close(self):
        try:
            self._session.close()
        except Exception:  # noqa: BLE001, S110 - best-effort close
            pass


def member_size(raw):
    """The declared byte width of a watch entry, or None when unusable.

    A missing, zero, negative, non-numeric or absurd width returns None and is reported to the
    user. It is never defaulted to 4: the width decides how many bytes are read and how many hex
    digits are logged, so a silent default corrupts the value with no visible sign.
    """
    if raw is None or isinstance(raw, bool):
        return None
    if isinstance(raw, str):
        try:
            raw = int(raw.strip(), 0)
        except ValueError:
            return None
    if not isinstance(raw, int):
        return None
    return raw if 1 <= raw <= MAX_MEMBER_SIZE else None


def normalize_watch(entries, context="resolution file"):
    """-> (watch, skipped).

    Each watch entry gets address/name/size (address also as an int for the read plan).
    `skipped` is a list of (name, reason), so the caller can name every symbol it is not
    polling instead of quietly polling less than the user asked for.
    """
    watch, skipped = [], []
    for e in entries:
        name = str(e.get("name", "")).strip()
        try:
            addr = int(str(e["address"]), 0)
        except (KeyError, TypeError, ValueError):
            skipped.append((name or "<unnamed>",
                            f"{context}: unreadable address {e.get('address')!r}"))
            continue
        if "," in name or "\n" in name or "\r" in name:
            skipped.append((name, f"{context}: name contains a comma or newline, which "
                                  f"would give the row more than 4 CSV fields"))
            continue
        size = member_size(e.get("size"))
        if size is None:
            skipped.append((name, f"{context}: no usable size ({e.get('size')!r}); each "
                                  f"member is read and logged at its own declared width, "
                                  f"so it is never guessed. Re-run scripts/elf_resolve.py "
                                  f"against the current ELF, or add it as "
                                  f"--extra {name or 'NAME'}=0x{addr:08x}:<bytes>"))
            continue
        watch.append({"address": f"0x{addr:08x}", "name": name,
                      "addr": addr, "size": size})
    return watch, skipped


def report_skipped(skipped, limit=8):
    """Name every symbol that is not being polled, and why."""
    if not skipped:
        return
    err(f"{len(skipped)} watch symbol(s) will NOT be polled:")
    for name, reason in skipped[:limit]:
        err(f"  {name}: {reason}")
    if len(skipped) > limit:
        err(f"  ... and {len(skipped) - limit} more")


def parse_extra(item):
    """`name=0xaddr:SIZE` -> (entry, None), or (None, reason).

    SIZE is mandatory. The old `name=0xaddr` form cannot be honoured any more: it carries no
    width, and this sidecar will not invent one.
    """
    name, sep, rest = item.partition("=")
    name = name.strip()
    if not sep or not name:
        return None, "no name (want name=0xaddr:SIZE)"
    addr_text, _, size_text = rest.partition(":")
    try:
        addr = int(addr_text.strip(), 0)
    except ValueError:
        return None, f"bad address {addr_text.strip()!r} (want name=0xaddr:SIZE)"
    if not size_text.strip():
        return None, (f"no byte size given; the member is read and logged at exactly that "
                      f"width, so it is never guessed — use --extra {name}="
                      f"0x{addr:08x}:<bytes> (1/2/4/8 for a scalar, more for an array)")
    return {"name": name, "address": f"0x{addr:08x}", "size": size_text.strip()}, None


def load_watchlist(resolution_path):
    """The in-range leaves of the resolved DebugGlobal, plus what was dropped.

    The range filter is the write channel's fence and the only thing keeping a stale
    resolution file from reading outside the struct, so it stays.
    """
    with open(resolution_path, encoding="utf-8") as f:
        res = json.load(f)
    base = int(res["base"], 16)
    end = base + int(res["size"])
    entries, skipped = [], []
    for s in res.get("symbols", []):
        name = str(s.get("name", "")).strip()
        try:
            addr = int(str(s["address"]), 0)
        except (KeyError, TypeError, ValueError):
            skipped.append((name or "<unnamed>",
                            f"unreadable address {s.get('address')!r}"))
            continue
        if not base <= addr < end:
            skipped.append((name or "<unnamed>",
                            f"address 0x{addr:08x} is outside the resolved DebugGlobal "
                            f"window [0x{base:08x}, 0x{end:08x}); re-run "
                            f"scripts/elf_resolve.py against the current ELF"))
            continue
        entries.append(s)
    watch, more = normalize_watch(entries)
    return watch, skipped + more


# Rows per CSV file before rotation (100k rows ~= 3min at 100Hz x 10 syms).
# Rotation keeps the workspace file watcher + tail cheap; the extension tail
# already handles truncation (size < offset -> restart from top).
CSV_MAX_ROWS = 100000


def default_stamp():
    return (time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())
            + f".{int((time.time() % 1) * 1000):03d}")


def poll_loop(probe, watch, out_path, hz=10, seconds=300, clock=None, sleeper=None,
              stamp=None, write_queue=None, emit_write=None,
              open_stream=None):
    """Run the poll loop. Returns (tracker, guard). Test-injectable clock."""
    clock = clock or time.monotonic
    sleeper = sleeper or time.sleep
    stamp = stamp or default_stamp
    open_stream = open_stream or open
    guard = DoubleReadGuard()
    tracker = DropTracker(hz)
    period = 1.0 / hz
    deadline = clock() + seconds

    # Read plan, once: how wide each member is, which words cover it, and whether the
    # member arrives in a single transfer (so a second read could prove nothing).
    for w in watch:
        w["steps"] = read_plan(w["addr"], w["size"])
        w["atomic"] = len(w["steps"]) == 1
        w["base"] = w["addr"] - (w["addr"] % AP_TRANSFER_BYTES)
        w["head"] = w["addr"] - w["base"]

    # Block-read plan, measured on the real probe (ST-LINK/V2, target STM32G474):
    #   1 word via read32        0.562 ms
    #   8 words as 8 read32      4.509 ms
    #   6 words as one block     0.825 ms
    #   52 words as one block    3.774 ms
    # A block transfer costs about an eighth per word, because it batches the DAP
    # transfers instead of re-establishing one per word. So the unit that matters
    # is not "is this leaf 4-byte aligned" but "how many words cover this group of
    # leaves": twenty-five one-byte bools read individually cost 14.0 ms per tick
    # and missed a 10 ms budget 100% of the time, while the same twenty-five leaves
    # cost 0.8 ms as one 6-word block.
    groups = []
    for w in sorted(watch, key=lambda x: (x["base"], x["addr"])):
        need = w["base"] + len(w["steps"]) * AP_TRANSFER_BYTES
        if groups and need - groups[-1]["base"] <= MAX_BLOCK_SPAN:
            groups[-1]["members"].append(w)
            groups[-1]["end"] = max(groups[-1]["end"], need)
        else:
            groups.append({"base": w["base"], "end": need, "members": [w]})
    # One leaf alone is cheaper as a single read32 than as a block call.
    block_groups = [g for g in groups if len(g["members"]) > 1 and hasattr(probe, "read_block")]
    served = {id(w) for g in block_groups for w in g["members"]}
    group_of = {}
    for g in block_groups:
        for w in g["members"]:
            group_of[id(w)] = g
    individual = sum(1 for w in watch if id(w) not in served)
    reread = sum(1 for w in watch if not w["atomic"])
    addrs = [w["addr"] for w in watch]
    span = f"{max(addrs) - min(addrs)}B" if addrs else "0B"
    if block_groups:
        words = sum((g["end"] - g["base"]) // AP_TRANSFER_BYTES for g in block_groups)
        print(f"live_poll: {len(watch)} leaves @ {hz}Hz, span {span}: {len(block_groups)} "
              f"block transaction(s) covering {len(watch) - individual} leaves "
              f"({words} words), {individual} read individually, {reread} re-read for tears")
    else:
        print(f"live_poll: {len(watch)} leaves @ {hz}Hz, span {span}: per-member reads "
              f"(no group worth a block), {reread} re-read for tears")

    f = open_stream(out_path, "w", newline="", encoding="utf-8")
    try:
        # lineterminator="\n": acceptance is `head -1 | grep -x timestamp,...`
        writer = csv.writer(f, lineterminator="\n")
        writer.writerow(CSV_HEADER)
        rows_in_file = 0
        # The host tails this file: the header has to be visible before the first tick.
        f.flush()
        while clock() < deadline:
            tick_start = clock()
            if write_queue is not None:
                # Writes run here, not on the stdin thread, so every access to
                # the pyOCD target stays on this one thread. Each request
                # carries the extent the host resolved for its own target;
                # there is no shared DebugGlobal fence to pass in.
                live_write.drain(write_queue, probe, emit_write or (lambda _r: None))
            # One block transfer per group of leaves, then each member's own bytes
            # are sliced out of the words that covered it.
            cache = {}
            for g in block_groups:
                n = (g["end"] - g["base"]) // AP_TRANSFER_BYTES
                try:
                    cache[id(g)] = probe.read_block(g["base"], n)
                except Exception as e:  # noqa: BLE001 - keep polling individually
                    err(f"block read failed at 0x{g['base']:08x} ({e}); "
                        f"falling back to individual reads for that group")
                    cache[id(g)] = None
            for w in watch:
                group = group_of.get(id(w))
                words = cache.get(id(group)) if group is not None else None
                if words is not None:
                    value = member_from_words(
                        words, (w["base"] - group["base"]) // AP_TRANSFER_BYTES,
                        w["head"], w["size"])
                else:
                    value = read_member(probe, w["addr"], w["size"])
                if w["atomic"]:
                    # One covering word: the value cannot be half-updated, so a second
                    # read would prove nothing and double the bus traffic.
                    guard.accept()
                elif not guard.check(value, read_member(probe, w["addr"], w["size"])):
                    continue  # the firmware changed it mid-read: dropped and counted
                writer.writerow([stamp(), w["address"], w["name"],
                                 format_value(value, w["size"])])
                rows_in_file += 1
            if rows_in_file >= CSV_MAX_ROWS:
                f.flush()
                f.seek(0)
                f.truncate()
                writer.writerow(CSV_HEADER)
                rows_in_file = 0
                print("live_poll: CSV rotated at 100k rows (watcher/tail stay cheap)")
            # Without this the rows sit in an 8KB buffer and the host sees them in bunches
            # of up to 145 rows / 145ms.
            f.flush()
            elapsed = clock() - tick_start
            # A tick counts as collected iff the full scan fit in its slot;
            # overruns still logged rows but count as drops for the G12 budget.
            tracker.tick(got=elapsed < period)
            if elapsed < period:
                sleeper(period - elapsed)
    finally:
        f.close()
    return tracker, guard


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--resolution", required=True,
                    help="elf_resolve.py --json output file")
    ap.add_argument("--out", required=True, help="CSV output path")
    ap.add_argument("--hz", type=float, default=100)
    ap.add_argument("--seconds", type=float, default=300)
    ap.add_argument("--mock", action="store_true")
    ap.add_argument("--mock-tear-every", type=int, default=0)
    ap.add_argument("--ensure-pyocd", action="store_true")
    ap.add_argument("--target", default=None)
    ap.add_argument("--extra", action="append", default=[],
                    help="extra watch symbol as name=0xaddr:SIZE (repeatable); "
                         "bypasses the DebugGlobal range filter for user-picked "
                         "variables (e.g. tuner globals). SIZE is required.")
    args = ap.parse_args(argv)

    if args.ensure_pyocd:
        ok, detail = ensure_pyocd()
        print(detail)
        sys.stdout.flush()
        if not ok:
            print("pyocd install failed; continuing with --mock only if given.")

    watch, skipped = load_watchlist(args.resolution)
    write_queue = queue.Queue()
    live_write.start_stdin_reader(write_queue)

    def emit_write(result):
        print(live_write.RESULT_PREFIX + json.dumps(result), flush=True)

    print("write channel: stdin JSON -> any resolved symbol "
          "(extent travels with each request)")
    extra_entries = []
    for item in args.extra:
        entry, error = parse_extra(item)
        if error:
            err(f"--extra {item!r} ignored: {error}")
            skipped.append((item, error))
            continue
        extra_entries.append(entry)
    extra_watch, extra_skipped = normalize_watch(extra_entries, context="--extra")
    skipped.extend(extra_skipped)
    report_skipped(skipped)
    watch.extend(extra_watch)
    for w in extra_watch:
        print(f"live_poll: extra watch {w['name']} @ {w['address']} ({w['size']} bytes)")
    if not watch:
        err(f"nothing pollable: all {len(skipped)} requested symbol(s) were rejected; "
            f"re-run scripts/elf_resolve.py against the current ELF")
        return EXIT_NO_WATCH

    if args.mock:
        probe = MockProbe(tear_every=args.mock_tear_every)
    else:
        try:
            probe = connect_with_retry(lambda: PyocdProbe(target_override=args.target))
        except AttachError as e:
            err(str(e))
            return EXIT_USB
        except RuntimeError as e:
            err(str(e))
            return EXIT_NO_PROBE
        if getattr(probe, "resumed", False):
            print("live_poll: target was halted (e.g. post-flash); resumed for live reads")

    def run_once(p):
        return poll_loop(p, watch, args.out, hz=args.hz, seconds=args.seconds,
                         write_queue=write_queue, emit_write=emit_write)

    try:
        try:
            tracker, guard = run_once(probe)
        except Exception as e:  # noqa: BLE001 - reconnect once
            if args.mock:
                raise
            err(f"transport error ({e}); re-attaching once...")
            probe.close()
            try:
                probe = connect_with_retry(
                    lambda: PyocdProbe(target_override=args.target))
            except AttachError as usb:
                err(str(usb))
                return EXIT_USB
            except RuntimeError as no_probe:
                err(str(no_probe))
                return EXIT_NO_PROBE
            tracker, guard = run_once(probe)
        ok, detail = check_budgets(tracker, guard, len(watch))
        print(f"{'mock done' if args.mock else 'done'}: {detail}")
        if not ok:
            err("drop budget exceeded (>=1% of ticks or samples, tears included)")
            return EXIT_BUDGET
        return EXIT_OK
    finally:
        probe.close()


if __name__ == "__main__":
    sys.exit(main())
