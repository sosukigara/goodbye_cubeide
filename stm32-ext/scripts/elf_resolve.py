#!/usr/bin/env python3
r"""ELF/DWARF type-tree resolver for the Live monitor.

Resolves `debug` (volatile DebugGlobal, see unit_omni3/Core/Inc/debug.hpp)
base address + size from a build-ext .elf, per build (re-resolve every
build; addresses shift when the struct layout changes), plus the *whole*
type tree of that struct so the sidebar can browse nested / anonymous
groups and decode each leaf from its DWARF type.

Strategy (in order):
  1. pyelftools (if importable): symbol table for `debug` + a DWARF DIE walk
     that produces the full type tree.
  2. Fallback: `arm-none-eabi-nm -S` for base+size, plus
     `arm-none-eabi-readelf --debug-dump=info` parsed into the very same
     DIE model, so the fallback output is structurally identical.

Stripped ELF (no .debug_info / no symtab) is NOT silently accepted:
exits 2 with an explicit message demanding a Debug -g3 rebuild.

Usage:
  elf_resolve.py <firmware.elf> [--prefix arm-none-eabi-] [--json]
      [--member sys.loop_hz]  (repeatable; default: a curated watch list)
      [--all-members]         (every leaf of DebugGlobal, declaration order)

Output (--json, one object on stdout):
  {"elf": path, "base": "0x200000b4", "size": 976, "end": "0x20000484",
   "has_debug_info": true, "backend": "pyelftools|nm+readelf",
   "symbols": [{"name": "sys.loop_hz", "address": "0x200000b4", "offset": 0,
                "size": 4, "type": "uint32_t", "kind": "scalar",
                "signed": false}, ...],
   "tree": {"name": "debug", "path": "", "address": "0x200000b4", "size": 976,
            "type": "DebugGlobal", "kind": "struct", "children": [...]},
   "index": {"sys.loop_hz": {"size": 4, "kind": "scalar", "signed": false,
                             "type": "uint32_t"}, ...},
   "unresolved": ["name", ...]}

Three `size` meanings coexist; do not conflate them:
  * top-level `size`              -> byte span of the DebugGlobal window
  * `tree` container node `size`  -> byte span of that struct / array
  * `symbols[].size`, tree leaf `size`, `index[].size` -> member width, bytes

Only stdlib + optional pyelftools. Never touches firmware sources.
"""
import json
import math
import re
import subprocess
import sys

# Curated default watch list: stable, high-signal DebugGlobal leaves.
# (The full struct has 324 leaves; --all-members lists every one of them,
# and `tree` always describes the whole struct either way.)
DEFAULT_MEMBERS = [
    "sys.loop_hz",
    "sys.loop_period_us",
    "sys.uptime_ms",
    "comm.tn3_tx_count",
    "comm.tn3_rx_count",
    "drive.motor_timeout",
    "drive.drive_mode",
    "nav.odom_source_active",
    "nav.robot_yaw_deg",
    "periph.max_output_current_a",
]

STRIP_ERROR = (
    "ELF has no debug info (stripped or built without -g). "
    "Rebuild the Debug configuration with -g3 (todo3 enforces -g3+-Og) "
    "and re-resolve: ninja -C build-ext"
)

MISSING_DEBUG = ("symbol `debug` not found; is this a firmware ELF with "
                 "debug.hpp linked in?")

STRUCT_NAME = "DebugGlobal"

# DW_AT_encoding is a numeric constant, never a string (spec 1.2).
DW_ATE_BOOLEAN = 0x02
DW_ATE_FLOAT = 0x04
DW_ATE_SIGNED = 0x05
DW_ATE_SIGNED_CHAR = 0x06

DW_OP_PLUS_UCONST = 0x23


def _is_signed_encoding(enc):
    """True for DW_ATE_signed (0x05) and DW_ATE_signed_char (0x06).

    `int8_t` is a DW_TAG_typedef onto `signed char`, which is encoding 0x06
    and not 0x05, so testing only for 0x05 renders every int8_t as 0..255.
    """
    return enc in (DW_ATE_SIGNED, DW_ATE_SIGNED_CHAR)

WRAPPER_TAGS = (
    "DW_TAG_typedef",
    "DW_TAG_const_type",
    "DW_TAG_volatile_type",
    "DW_TAG_restrict_type",
    "DW_TAG_atomic_type",
    "DW_TAG_immutable_type",
)
CONTAINER_TAGS = ("DW_TAG_structure_type", "DW_TAG_union_type")
INTERESTING_TAGS = (
    "DW_TAG_member",
    "DW_TAG_structure_type",
    "DW_TAG_union_type",
    "DW_TAG_array_type",
    "DW_TAG_subrange_type",
    "DW_TAG_enumerator",
)


class StripError(RuntimeError):
    """No usable DWARF. Reported, never guessed around."""


class MissingDebug(RuntimeError):
    """Symbol table is there but the `debug` object is not."""


def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True)


# ---------------------------------------------------------------------------
# nm / readelf probes (fallback backend + strip check)
# ---------------------------------------------------------------------------


def nm_symbols(elf, prefix):
    """Return (symtab dict name->(addr,size,type), has_symtab)."""
    p = run([f"{prefix}nm", "-S", elf])
    if p.returncode != 0:
        # No symtab at all (fully stripped): nm errors out.
        return {}, False
    syms = {}
    for line in p.stdout.splitlines():
        parts = line.split()
        if len(parts) == 4:
            addr, size, typ, name = parts
            try:
                syms[name] = (int(addr, 16), int(size, 16), typ)
            except ValueError:
                continue
        elif len(parts) == 3:
            addr, typ, name = parts
            try:
                syms[name] = (int(addr, 16), 0, typ)
            except ValueError:
                continue
    return syms, True


def has_debug_info(elf, prefix):
    p = run([f"{prefix}readelf", "-S", elf])
    if p.returncode != 0:
        return False
    return ".debug_info" in p.stdout


# ---------------------------------------------------------------------------
# Backend-independent DIE model
#
# Nodes are plain dicts, so the pyelftools adapter and the readelf text
# parser produce identical trees and the walker below is written once:
#   tag, name, type, loc, byte_size, encoding, bit_size, data_bit_offset,
#   bit_offset, upper_bound, count, const_value, children
# `type` is always a CU-global .debug_info offset (ref_addr form included).
# ---------------------------------------------------------------------------


class DwarfModel:
    """A resolved DIE graph: one root node plus a lazy offset -> node lookup.

    The lookup is lazy on purpose. `uint32_t` and every other base type is a
    top-level DIE of the compile unit, not a descendant of DebugGlobal, so a
    pure tree walk cannot build a complete offset map up front.
    """

    def __init__(self, root, lookup):
        self.root = root
        self._lookup = lookup

    def resolve(self, ref):
        if ref is None or not isinstance(ref, int):
            return None
        return self._lookup(ref)


def peel(model, node, limit=16):
    """Descend through typedef/qualifier wrappers to the real type DIE.

    Required for size/signedness: `uint32_t` is a DW_TAG_typedef whose own
    DW_AT_byte_size is 0 in this firmware.
    """
    seen = 0
    while (node is not None and node.get("tag") in WRAPPER_TAGS
           and seen < limit):
        node = model.resolve(node.get("type"))
        seen += 1
    return node


def _int(node, key):
    v = node.get(key)
    return int(v) if isinstance(v, int) and not isinstance(v, bool) else 0


def _leaf_size(node):
    return _int(node, "byte_size") if node is not None else 0


def _subrange_count(node):
    if node.get("count") is not None:
        return max(0, _int(node, "count"))
    if node.get("upper_bound") is not None:
        return max(0, _int(node, "upper_bound") + 1)
    return 0


def _array_dims(model, array_node):
    dims = [_subrange_count(c) for c in array_node.get("children") or []
            if c.get("tag") == "DW_TAG_subrange_type"]
    if dims:
        return dims
    # Some producers hang the bound straight off the array DIE.
    if (array_node.get("count") is not None
            or array_node.get("upper_bound") is not None):
        return [_subrange_count(array_node)]
    return [0]


def _display_type(model, declared):
    """C type name of a member's declared type; a typedef keeps its name."""
    if declared is None:
        return "?"
    if declared.get("tag") == "DW_TAG_typedef" and declared.get("name"):
        return declared["name"]
    core = peel(model, declared)
    if core is None:
        return declared.get("name") or "?"
    tag = core.get("tag")
    if tag == "DW_TAG_array_type":
        elem = _display_type(model, model.resolve(core.get("type")))
        return elem + "".join("[%d]" % d for d in _array_dims(model, core))
    if tag == "DW_TAG_pointer_type":
        inner = _display_type(model, model.resolve(core.get("type")))
        return f"{inner} *"
    if tag == "DW_TAG_enumeration_type":
        return "enum %s" % (core.get("name") or "<anonymous>")
    if tag in CONTAINER_TAGS:
        if core.get("name"):
            return core["name"]
        if tag == "DW_TAG_union_type":
            return "union <anonymous>"
        return "struct <anonymous>"
    return core.get("name") or tag or "?"


def _is_char_array_element(node):
    """True only for plain `char`; int8_t/uint8_t share its encodings."""
    return (node is not None and node.get("tag") == "DW_TAG_base_type"
            and node.get("name") == "char")


def _enumerators(model, enum_node):
    out = []
    for child in enum_node.get("children") or []:
        if child.get("tag") != "DW_TAG_enumerator":
            continue
        name = child.get("name")
        if name is None:
            continue
        out.append({"name": name, "value": _int(child, "const_value")})
    return out


def classify_member(model, member):
    """Type facts of one DW_TAG_member.

    Returns display name, byte width, signedness, kind, and for containers
    the node to recurse into. Size/signedness always come from the
    DW_TAG_base_type at the END of the typedef chain.
    """
    declared = model.resolve(member.get("type"))
    core = peel(model, declared)
    info = {
        "type": _display_type(model, declared),
        "size": 0,
        "signed": False,
        "kind": "scalar",
        "enumerators": None,
        "length": None,
        "container": None,
    }
    if core is None:
        return info
    tag = core.get("tag")

    if tag in CONTAINER_TAGS:
        info["kind"] = "struct"
        info["size"] = _leaf_size(core)
        info["container"] = core
        return info

    if tag == "DW_TAG_array_type":
        count = 1
        for d in _array_dims(model, core):
            count *= d
        elem = peel(model, model.resolve(core.get("type")))
        if _is_char_array_element(elem):
            # NUL-terminated text is a value: poll it as a string leaf.
            info["kind"] = "string"
            info["size"] = count
            info["length"] = count
            return info
        # Other arrays are containers (spec 3.1): browsable, never polled.
        info["kind"] = "array"
        info["size"] = count * _leaf_size(elem)
        info["length"] = count
        info["container"] = core
        return info

    if tag == "DW_TAG_enumeration_type":
        base = peel(model, model.resolve(core.get("type")))
        enc = core.get("encoding")
        if enc is None:
            enc = base.get("encoding") if base is not None else None
        info["kind"] = "enum"
        info["size"] = _leaf_size(core) or _leaf_size(base)
        info["signed"] = _is_signed_encoding(enc)
        info["enumerators"] = _enumerators(model, core)
        return info

    if tag == "DW_TAG_base_type":
        enc = core.get("encoding")
        info["size"] = _leaf_size(core)
        if enc == DW_ATE_BOOLEAN or core.get("name") in ("bool", "_Bool"):
            info["kind"] = "bool"
        elif enc == DW_ATE_FLOAT:
            info["kind"] = "float"
            info["signed"] = True
        else:
            info["kind"] = "scalar"
            info["signed"] = _is_signed_encoding(enc)
        return info

    # Pointer / subroutine / anything else addressable: an opaque scalar of
    # its own width rather than a silently dropped member.
    info["size"] = _leaf_size(core)
    info["signed"] = _is_signed_encoding(core.get("encoding"))
    return info


def _member_offset(member):
    loc = member.get("loc")
    if isinstance(loc, int) and not isinstance(loc, bool):
        return loc
    return None


def _bitfield_of(member):
    """(bit_size, absolute_bit_offset) for a bitfield member, else None.

    Defensive: this firmware has zero bitfields, but the two encodings differ
    enough to matter. DWARF3+ `DW_AT_data_bit_offset` counts bits from the
    start of the *struct* and arrives with NO `DW_AT_data_member_location` at
    all; the older `DW_AT_bit_offset` counts bits from the start of the
    storage unit and does come with a location. Both are normalized here to
    bits from the start of the struct, and `visit` re-anchors the read window
    on the field so the reported width always covers it.
    """
    if member.get("bit_size") is None:
        return None
    bits = _int(member, "bit_size")
    if member.get("data_bit_offset") is not None:
        off = _int(member, "data_bit_offset")
    elif member.get("bit_offset") is not None:
        off = _int(member, "bit_offset") + 8 * (_member_offset(member) or 0)
    else:
        off = 8 * (_member_offset(member) or 0)
    return bits, off


def _leaf_entry(path, offset, entry):
    leaf = {
        "name": path,
        "address": entry["address"],
        "offset": offset,
        "size": entry["size"],
        "type": entry["type"],
        "kind": entry["kind"],
        "signed": bool(entry.get("signed")),
    }
    if entry.get("length") is not None:
        leaf["length"] = entry["length"]
    if entry.get("enumerators"):
        leaf["enumerators"] = entry["enumerators"]
    if entry.get("bit_size") is not None:
        leaf["bit_size"] = entry["bit_size"]
        leaf["bit_offset"] = entry["bit_offset"]
    return leaf


def build_tree(model, base, root_name="debug"):
    """Walk the whole struct. Returns (tree node, leaves in declaration order).

    A DW_TAG_member with no DW_AT_name (anonymous struct/union member) gets a
    synthesized path segment: its 0-based index among the parent's
    DW_TAG_member children, so the name is stable across runs. Rule:
    <parent path>.<decl index>.<field>. Such a member is never dropped; it
    gets a tree node like any other.
    """
    leaves = []

    def visit(node, path, off_abs):
        children = []
        members = [c for c in node.get("children") or []
                   if c.get("tag") == "DW_TAG_member"]
        for index, member in enumerate(members):
            segment = member.get("name")
            if segment is None:
                segment = str(index)
            bits = _bitfield_of(member)
            loc = _member_offset(member)
            if loc is None and bits is not None:
                # DWARF3+ bitfield: the location lives inside the bit offset.
                loc = bits[1] // 8
            if loc is None:
                continue  # static/external member: not addressable in RAM
            if bits is not None:
                # Re-anchor the window on the field itself so the reported
                # width always covers every bit of it.
                loc = bits[1] // 8
            child_off = off_abs + loc
            child_path = f"{path}.{segment}" if path else segment
            info = classify_member(model, member)
            entry = {
                "name": segment,
                "path": child_path,
                "type": info["type"],
                "kind": info["kind"],
                "size": info["size"],
                "signed": info["signed"],
                "address": f"0x{base + child_off:08x}",
                "offset": child_off,
            }
            if info["length"] is not None:
                entry["length"] = info["length"]
            if bits is not None:
                bit_size, abs_bits = bits
                within = abs_bits % 8
                entry["kind"] = "bitfield"
                entry["size"] = max(1, math.ceil((within + bit_size) / 8))
                entry["bit_size"] = bit_size
                entry["bit_offset"] = within
            if info["enumerators"]:
                entry["enumerators"] = info["enumerators"]
            if info["container"] is not None:
                entry["children"] = visit(info["container"], child_path,
                                          child_off)
            else:
                entry["children"] = []
                leaves.append(_leaf_entry(child_path, child_off, entry))
            children.append(entry)
        return children

    root = model.root
    tree = {
        "name": root_name,
        "path": "",
        "address": f"0x{base:08x}",
        "offset": 0,
        "size": _leaf_size(root),
        "type": _display_type(model, root) or STRUCT_NAME,
        "kind": "struct",
        "children": visit(root, "", 0),
    }
    return tree, leaves


# ---------------------------------------------------------------------------
# pyelftools adapter
# ---------------------------------------------------------------------------


def _die_name(die):
    try:
        a = die.attributes.get("DW_AT_name")
        if a is None:
            return None
        v = a.value
        return v.decode("utf-8", "replace") if isinstance(v, bytes) else str(v)
    except Exception:
        return None


def _member_loc(die):
    try:
        a = die.attributes.get("DW_AT_data_member_location")
        if a is None:
            return None
        v = a.value
        if isinstance(v, bool):
            return None
        if isinstance(v, int):
            return v
        if not hasattr(v, "__iter__"):
            return None
        # DW_OP_plus_uconst arrives either as a raw block (DW_FORM_block*,
        # pyelftools hands back a byte list) or as decoded op objects,
        # depending on version and producer. Opcode 0x23, then ULEB128.
        ops = list(v)
        if not ops:
            return None
        if hasattr(ops[0], "opcode_name"):
            for op in ops:
                if op.opcode_name == "DW_OP_plus_uconst":
                    return op.args[0] if op.args else 0
            return 0
        if ops[0] != DW_OP_PLUS_UCONST:
            return 0
        result, shift = 0, 0
        for byte in ops[1:]:
            result |= (byte & 0x7F) << shift
            shift += 7
            if not byte & 0x80:
                break
        return result
    except Exception:
        return None


def _int_attr(die, name):
    try:
        a = die.attributes.get(name)
        if a is None:
            return None
        v = a.value
        if isinstance(v, bool):
            return int(v)
        return v if isinstance(v, int) else None
    except Exception:
        return None


def _py_node(die):
    node = {
        "tag": die.tag,
        "name": _die_name(die),
        "loc": _member_loc(die),
        "byte_size": _int_attr(die, "DW_AT_byte_size"),
        "encoding": _int_attr(die, "DW_AT_encoding"),
        "bit_size": _int_attr(die, "DW_AT_bit_size"),
        "data_bit_offset": _int_attr(die, "DW_AT_data_bit_offset"),
        "bit_offset": _int_attr(die, "DW_AT_bit_offset"),
        "upper_bound": _int_attr(die, "DW_AT_upper_bound"),
        "count": _int_attr(die, "DW_AT_count"),
        "const_value": _int_attr(die, "DW_AT_const_value"),
        "type": None,
        "children": [],
    }
    a = die.attributes.get("DW_AT_type")
    if a is not None and isinstance(a.value, int):
        # ref4 / ref_udata are CU-relative, ref_addr is already absolute.
        node["type"] = (a.value if a.form == "DW_FORM_ref_addr"
                        else die.cu.cu_offset + a.value)
    return node


def _py_convert(die, by_off):
    key = die.offset
    cached = by_off.get(key)
    if cached is not None:
        return cached
    node = _py_node(die)
    by_off[key] = node
    # Only the walkable tags belong in `children`; everything else is still
    # converted so a later DW_AT_type ref resolves from the same cache.
    walkable = []
    for child in die.iter_children():
        child_node = _py_convert(child, by_off)
        if child.tag in INTERESTING_TAGS:
            walkable.append(child_node)
    node["children"] = walkable
    return node


def pyelftools_model(elffile, struct_name=STRUCT_NAME):
    """Build a DwarfModel for `struct_name`, or None when it is absent."""
    dwarf = elffile.get_dwarf_info()
    root_die = None
    for cu in dwarf.iter_CUs():
        for die in cu.iter_DIEs():
            if die.tag == "DW_TAG_structure_type" \
                    and _die_name(die) == struct_name:
                root_die = die
                break
        if root_die is not None:
            break
    if root_die is None:
        return None
    by_off = {}
    cu = root_die.cu

    def lookup(ref):
        node = by_off.get(ref)
        if node is not None:
            return node
        try:
            return _py_convert(cu.get_DIE_from_refaddr(ref), by_off)
        except Exception:
            return None

    return DwarfModel(_py_convert(root_die, by_off), lookup)


def pyelftools_backend(elf, struct_name=STRUCT_NAME):
    """Try pyelftools; return a dict, or None when unavailable/failed.

    `{"stripped": True}` / `{"missing": True}` are definitive negatives from
    the symbol table and suppress the nm fallback (no half-guesses).
    """
    try:
        from elftools.elf.elffile import ELFFile
    except ImportError:
        return None
    try:
        with open(elf, "rb") as f:
            elffile = ELFFile(f)
            symtab = elffile.get_section_by_name(".symtab")
            if symtab is None:
                return {"stripped": True}
            base = size = None
            for sym in symtab.iter_symbols():
                if sym.name == "debug":
                    base = sym["st_value"]
                    size = sym["st_size"]
                    break
            if base is None:
                return {"stripped": False, "missing": True}
            has_di = elffile.get_section_by_name(".debug_info") is not None
            model = pyelftools_model(elffile, struct_name) if has_di else None
            return {
                "stripped": False, "base": base, "size": size,
                "has_debug_info": has_di, "model": model,
                "backend": "pyelftools",
            }
    except Exception:
        return None


# ---------------------------------------------------------------------------
# `readelf --debug-dump=info` text adapter (fallback backend)
# ---------------------------------------------------------------------------

_DIE_RE = re.compile(
    r"^\s*<(\d+)><([0-9a-f]+)>:\s*Abbrev Number:\s*(\d+)"
    r"(?:\s*\((DW_TAG_\w+)\))?")
_ATTR_RE = re.compile(r"DW_AT_(\w+)\s*:\s*(.*)$")
_NAME_RE = re.compile(r"^(?:\([^)]*\):\s*)?(.*\S)\s*$")
_REF_RE = re.compile(r"^<0x([0-9a-f]+)>")
_UPCONST_RE = re.compile(r"DW_OP_plus_uconst:\s*(\S+)")
_LEADING_INT_RE = re.compile(r"^(-?0x[0-9a-fA-F]+|-?\d+)")
_INT_ATTRS = ("byte_size", "encoding", "bit_size", "data_bit_offset",
              "bit_offset", "upper_bound", "count", "const_value")


def _parse_int(text):
    """readelf prints `5\\t(signed)` / `0x10` / `DW_OP_plus_uconst: 4`."""
    text = text.strip()
    m = _UPCONST_RE.search(text)
    if m:
        text = m.group(1).strip()
    m = _LEADING_INT_RE.match(text)
    if not m:
        return None
    token = m.group(1)
    return int(token, 16) if "x" in token else int(token, 10)


def readelf_die_model(elf, prefix, struct_name=STRUCT_NAME):
    """Parse `readelf --debug-dump=info` into the same node model."""
    p = run([f"{prefix}readelf", "--debug-dump=info", elf])
    if p.returncode != 0:
        return None
    nodes = []
    current = None
    for raw in p.stdout.splitlines():
        m = _DIE_RE.match(raw)
        if m:
            depth, off, tag = int(m.group(1)), int(m.group(2), 16), m.group(4)
            if tag is None:
                current = None  # null DIE: ends the sibling chain
                continue
            current = {
                "depth": depth, "off": off, "tag": tag, "name": None,
                "type": None, "loc": None, "byte_size": None,
                "encoding": None, "bit_size": None, "data_bit_offset": None,
                "bit_offset": None, "upper_bound": None, "count": None,
                "const_value": None, "children": [],
            }
            nodes.append(current)
            continue
        if current is None:
            continue
        m = _ATTR_RE.search(raw)
        if not m:
            continue
        key, value = m.group(1), m.group(2)
        if key == "name" and current["name"] is None:
            nm = _NAME_RE.match(value)
            if nm:
                current["name"] = nm.group(1)
        elif key == "type" and current["type"] is None:
            rm = _REF_RE.match(value.strip())
            if rm:
                current["type"] = int(rm.group(1), 16)
        elif key == "data_member_location" and current["loc"] is None:
            parsed = _parse_int(value)
            current["loc"] = 0 if parsed is None else parsed
        elif key in _INT_ATTRS and current[key] is None:
            current[key] = _parse_int(value)

    if not nodes:
        return None
    by_off = {n["off"]: n for n in nodes}
    root = None
    for n in nodes:
        if n["tag"] == "DW_TAG_structure_type" and n["name"] == struct_name:
            root = n
            break
    if root is None:
        return None
    stack = []
    for n in nodes:
        while stack and stack[-1]["depth"] >= n["depth"]:
            stack.pop()
        if stack and n["tag"] in INTERESTING_TAGS:
            stack[-1]["children"].append(n)
        stack.append(n)
    for n in nodes:
        n.pop("depth", None)
        n.pop("off", None)
    return DwarfModel(root, by_off.get)


# ---------------------------------------------------------------------------
# Resolution
# ---------------------------------------------------------------------------


def resolve(elf, prefix="arm-none-eabi-", struct_name=STRUCT_NAME):
    """Resolve the DebugGlobal window and its whole type tree.

    Returns {"elf", "base", "size", "end", "has_debug_info", "backend",
    "tree", "leaves"}. `leaves` is every leaf in declaration order; the CLI
    filters it down to the requested members. Raises StripError or
    MissingDebug for the two conditions that must be reported explicitly.
    """
    result = pyelftools_backend(elf, struct_name)
    if result is not None and not result.get("stripped") \
            and not result.get("missing"):
        base, size = result["base"], result["size"]
        has_di, backend = result["has_debug_info"], result["backend"]
        if not has_di:
            # --strip-debug keeps .symtab but drops DWARF: member offsets are
            # unknowable, so this is the same explicit -g3 error as stripped.
            raise StripError(STRIP_ERROR)
        model = result.get("model")
    elif result is not None and result.get("stripped"):
        raise StripError(STRIP_ERROR)
    elif result is not None and result.get("missing"):
        raise MissingDebug(MISSING_DEBUG)
    else:
        # pyelftools absent/failed -> nm + readelf wrap. P0-14: this branch
        # must produce a complete result on its own, never a NameError.
        backend = "nm+readelf"
        syms, has_sym = nm_symbols(elf, prefix)
        has_di = has_debug_info(elf, prefix)
        if not has_sym and not has_di:
            raise StripError(STRIP_ERROR)
        if "debug" not in syms:
            raise MissingDebug(MISSING_DEBUG)
        base, size, _typ = syms["debug"]
        if not has_di:
            raise StripError(STRIP_ERROR)
        try:
            model = readelf_die_model(elf, prefix, struct_name)
        except Exception:
            model = None

    tree, leaves = (None, [])
    if model is not None:
        tree, leaves = build_tree(model, base)
    if not size and tree is not None:
        size = tree["size"]
    return {
        "elf": elf,
        "base": f"0x{base:08x}",
        "size": int(size),
        "end": f"0x{base + int(size):08x}",
        "has_debug_info": has_di,
        "backend": backend,
        "tree": tree,
        "leaves": leaves,
    }


def index_of(leaves):
    """leaf dot-path -> LeafMeta, the per-row shape the webview needs."""
    index = {}
    for leaf in leaves:
        meta = {
            "size": leaf["size"],
            "kind": leaf["kind"],
            "signed": leaf["signed"],
            "type": leaf["type"],
        }
        if leaf.get("length") is not None:
            meta["length"] = leaf["length"]
        if leaf.get("enumerators"):
            meta["enumerators"] = leaf["enumerators"]
        if leaf.get("bit_size") is not None:
            meta["bit_size"] = leaf["bit_size"]
            meta["bit_offset"] = leaf["bit_offset"]
        index[leaf["name"]] = meta
    return index


def _main(argv):
    prefix = "arm-none-eabi-"
    want_all = False
    extra = []
    positional = []
    i = 1
    while i < len(argv):
        a = argv[i]
        if a.startswith("--prefix"):
            prefix = a.split("=", 1)[1] if "=" in a else argv[i + 1]
            i += 2 if "=" not in a else 1
        elif a == "--json":
            i += 1
        elif a == "--member" and i + 1 < len(argv):
            extra.append(argv[i + 1])
            i += 2
        elif a == "--all-members":
            want_all = True
            i += 1
        elif a.startswith("--"):
            print(f"unknown arg: {a}", file=sys.stderr)
            return 2
        else:
            positional.append(a)
            i += 1
    if not positional:
        print(__doc__)
        return 2
    elf = positional[0]

    try:
        res = resolve(elf, prefix)
    except (StripError, MissingDebug) as exc:
        print(f"elf_resolve: {exc}\nelf={elf}", file=sys.stderr)
        return 2

    by_name = {leaf["name"]: leaf for leaf in res["leaves"]}
    if want_all:
        want = list(by_name) + [m for m in extra if m not in by_name]
    elif extra:
        want = extra
    else:
        want = list(DEFAULT_MEMBERS)

    symbols = []
    unresolved = []
    for m in want:
        leaf = by_name.get(m)
        if leaf is None:
            unresolved.append(m)
        else:
            symbols.append(leaf)

    print(json.dumps({
        "elf": res["elf"],
        "base": res["base"],
        "end": res["end"],
        "size": res["size"],
        "has_debug_info": res["has_debug_info"],
        "backend": res["backend"],
        "symbols": symbols,
        "tree": res["tree"],
        "index": index_of(res["leaves"]),
        "unresolved": unresolved,
    }, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv))
