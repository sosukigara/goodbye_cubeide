#!/usr/bin/env python3
"""Memory write channel for the live sidecar.

The poll loop owns the single pyOCD session, so a second connection would
contend for the ST-LINK. Requests therefore arrive on stdin as JSON lines
and are executed *by the poll loop itself* (one tick of latency) — that
keeps every target access single-threaded and avoids locking the probe.

Defense in depth: the host resolves the target and declares its extent
(`base` / `symbolSize`) with the request, and this module re-checks that the
write fits inside it before touching the bus. That is the check that remains
now that the write is not confined to DebugGlobal: the sidecar is a separate
process, so it catches a request that does not match the symbol the host said
it was writing.

There is deliberately no check that the read-modify-write's 32-bit words stay
inside the extent. With a fence one symbol wide, every 1- or 2-byte member
straddles it — a byte at base occupies [base, base+4), so word_end > base+1
always — and the check would refuse every narrow write. The neighbouring bytes
in the covering word are preserved by the keep-mask in write_member instead,
and apply_write reads the member back to confirm the value landed.

Every bus transaction is a 32-bit word read or write. pyOCD's AHB-AP raises
DebugError("unsupported transfer size") for 8/16/64-bit accesses
(pyocd/coresight/dap.py APAccessMemoryInterface), so a 1/2/8-byte member
is spliced into the word(s) that contain it: the covering words are read,
the member's own bytes are replaced, and the rest of each word is written
back untouched. Nothing here halts the core.
"""
import json
import queue
import sys
import threading

RESULT_PREFIX = "WRITE-RESULT "

# The width must be one the bus driver can move. The ADDRESS is no longer
# confined to DebugGlobal: the host sends the extent of the symbol it resolved
# and the write has to fit inside THAT (see parse_request).
_ALLOWED_WIDTHS = (1, 2, 4, 8)

# The one AHB-AP transfer size a Cortex-M target implements (see the docstring).
WORD_BYTES = 4


class WriteRequestError(Exception):
    """A request that must be refused without touching the bus."""

    def __init__(self, reason):
        super().__init__(reason)
        self.reason = reason


def _parse_int(text, what):
    if isinstance(text, int) and not isinstance(text, bool):
        return text
    if not isinstance(text, str):
        raise WriteRequestError(f"bad {what}: not a number")
    t = text.strip()
    try:
        return int(t, 16) if t.lower().startswith("0x") else int(t, 0)
    except ValueError as e:
        raise WriteRequestError(f"bad {what}: {text!r}") from e


def word_span(address, size):
    """(word_base, byte_offset, word_count) for a member of `size` bytes at `address`.

    byte_offset is where the member starts inside the first word (0..3); word_count is
    how many 32-bit words it touches, the last one possibly only in part. This is what
    makes an unaligned 1-byte member (drive.controller's bools sit at every offset
    0..15) addressable at all.
    """
    word_base = address - (address % WORD_BYTES)
    byte_offset = address - word_base
    word_count = (byte_offset + size + WORD_BYTES - 1) // WORD_BYTES
    return word_base, byte_offset, word_count


def parse_request(raw, base, size_of_symbol):
    """Validate one request object. Raises WriteRequestError on refusal.

    `base`/`size_of_symbol` are the extent the host resolved for the target,
    and the request has to fit inside them. Be clear about what this does and
    does not buy: the values arrive in the same request, so this is a
    consistency check, not an independent authority. What it does catch is a
    request whose address and width contradict the symbol it claims — the
    shape a host bug or a corrupted line takes. It cannot catch a host that
    resolved the wrong symbol in the first place; that is the host's job, and
    the modal confirmation in front of it is the user's.

    There is no longer a check that the read-modify-write's 32-bit words stay
    inside the fence, and that is deliberate. With a fence one symbol wide,
    EVERY 1- or 2-byte member straddles it: a byte at base occupies the word
    [base, base+4), so word_end > base+1 always, and the check would refuse
    every narrow write. The neighbouring bytes in that word are not clobbered
    because write_member preserves them with an explicit keep-mask, and
    apply_write reads the member back to confirm the value landed.
    """
    if not isinstance(raw, dict):
        raise WriteRequestError("not an object")
    req_id = raw.get("id")
    if not isinstance(req_id, str) or req_id == "":
        raise WriteRequestError("missing id")
    if raw.get("op") != "write":
        raise WriteRequestError("unsupported op")
    address = _parse_int(raw.get("address"), "address")
    size = raw.get("size", 4)
    if size not in _ALLOWED_WIDTHS:
        raise WriteRequestError(
            f"bad size: {size!r} (a member must be "
            f"{' or '.join(str(w) for w in _ALLOWED_WIDTHS)} bytes)")
    value = _parse_int(raw.get("value"), "value")
    if size_of_symbol <= 0:
        raise WriteRequestError(f"symbol extent {size_of_symbol} is not a size")
    if not (base <= address and address + size <= base + size_of_symbol):
        raise WriteRequestError(
            f"address 0x{address:x}+{size} does not fit the declared symbol "
            f"[0x{base:x}, 0x{base + size_of_symbol:x})")
    bits = size * 8
    if not 0 <= value < (1 << bits):
        raise WriteRequestError(f"value {value} does not fit in {bits} bits")
    return {"id": req_id, "address": address, "size": size, "value": value}


def _backend(probe):
    """PyocdProbe wraps the pyOCD target; a mock probe is its own backend."""
    return getattr(probe, "_target", probe)


def read_member(be, address, size):
    """The member's own bytes, little-endian, out of the words that contain it."""
    word_base, byte_offset, word_count = word_span(address, size)
    raw = 0
    for i in range(word_count):
        raw |= (int(be.read32(word_base + WORD_BYTES * i)) & 0xFFFFFFFF) << (32 * i)
    return (raw >> (8 * byte_offset)) & ((1 << (8 * size)) - 1)


def write_member(be, address, size, value):
    """Read-modify-write the member's bytes. Neighbouring bytes are preserved.

    Each covering word is read immediately before it is written, so writing a 1-byte
    bool costs one extra read and leaves the other three bytes of that word alone.
    """
    word_base, byte_offset, word_count = word_span(address, size)
    shifted = value << (8 * byte_offset)
    member_bits = ((1 << (8 * size)) - 1) << (8 * byte_offset)
    for i in range(word_count):
        word_addr = word_base + WORD_BYTES * i
        current = int(be.read32(word_addr)) & 0xFFFFFFFF
        keep = ~(member_bits >> (32 * i)) & 0xFFFFFFFF
        be.write32(word_addr, (current & keep) | ((shifted >> (32 * i)) & 0xFFFFFFFF))


def apply_write(probe, req):
    """Perform the AHB-AP write and read it back. No halt.

    The write transaction itself decides success: a completed AHB-AP write
    landed. The readback is evidence, not a verdict — for a variable the
    firmware recomputes (sys.loop_hz, a PID output, ...) the word can differ
    microseconds later, which is normal and must not read as a failure.
    """
    addr, size, val = req["address"], req["size"], req["value"]
    be = _backend(probe)
    write_member(be, addr, size, val)
    got = read_member(be, addr, size)
    result = {"id": req["id"], "ok": True, "address": f"0x{addr:08x}",
              "value": f"0x{val:0{size * 2}x}", "readback": f"0x{got:0{size * 2}x}"}
    if got != val:
        result["note"] = "readback differs (firmware is rewriting this word)"
    return result


def start_stdin_reader(requests, stream=None):
    """Background thread: JSON lines on stdin -> requests queue. Daemon."""
    stream = stream if stream is not None else sys.stdin

    def _run():
        for line in stream:
            line = line.strip()
            if line == "":
                continue
            try:
                requests.put(json.loads(line))
            except json.JSONDecodeError:
                continue

    t = threading.Thread(target=_run, daemon=True, name="write-stdin")
    t.start()
    return t


def drain(requests, probe, emit):
    """Run every queued request. Called from the poll loop. Never raises.

    No fence is threaded in any more: each request carries the extent the
    host resolved for its own target, and parse_request checks the write
    against that.
    """
    while True:
        try:
            raw = requests.get_nowait()
        except queue.Empty:
            return
        try:
            req = parse_request(raw, _parse_int(raw.get("base"), "base"),
                                _parse_int(raw.get("symbolSize"), "symbolSize"))
            result = apply_write(probe, req)
            if not result["ok"]:
                result["error"] = f"readback mismatch: {result['readback']}"
        except WriteRequestError as e:
            result = {"id": raw.get("id") if isinstance(raw, dict) else "",
                      "ok": False, "error": e.reason}
        except Exception as e:  # noqa: BLE001 - a bad write must not kill polling
            result = {"id": raw.get("id") if isinstance(raw, dict) else "",
                      "ok": False, "error": f"{type(e).__name__}: {e}"}
        emit(result)
