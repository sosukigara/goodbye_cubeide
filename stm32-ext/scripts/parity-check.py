#!/usr/bin/env python3
r"""Parity check: build-ext/*.elf vs CubeIDE Debug/*.elf (todo3, G12).

Compares Berkeley section sizes (text/data/bss within +-tol %) and
defined-symbol sets (name -> type:size via `nm -S --defined-only`,
addresses ignored). stdlib only.

Usage:
  parity-check.py <ref.elf> <new.elf> [--tol 1.0] [--max-diff 20]
    [--ignore REGEX] [--prefix PREFIX]

  --ignore REGEX: skip symbols matching REGEX (repeatable). Default ignores
    `^wm4\.`: GCC -g3 debug-macro merge symbols whose content hashes
    fingerprint the exact compiler build (CubeIDE-patched GCC 14.3.rel1 vs
    stock arm-none-eabi), not firmware content. They always differ across
    toolchain builds and would otherwise drown the real signal.

Exit 0 + "PARITY PASS" on success, exit 1 + "PARITY FAIL" otherwise.
"""
import re
import subprocess
import sys


def run(cmd):
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError(f"command failed ({p.returncode}): {' '.join(cmd)}\n{p.stderr}")
    return p.stdout


def berkeley_sizes(elf, prefix):
    out = run([f"{prefix}size", "-B", elf])
    lines = out.strip().splitlines()
    if len(lines) < 2:
        raise RuntimeError(f"size output too short for {elf}:\n{out}")
    nums = lines[1].split()
    return {"text": int(nums[0]), "data": int(nums[1]), "bss": int(nums[2])}


def defined_symbols(elf, prefix):
    out = run([f"{prefix}nm", "-S", "--defined-only", elf])
    syms = {}
    for line in out.splitlines():
        parts = line.split()
        # forms: [addr] size type name | [addr] type name
        if len(parts) == 4:
            _addr, size, typ, name = parts
            syms[name] = f"{typ}:{size}"
        elif len(parts) == 3:
            _addr, typ, name = parts
            syms.setdefault(name, f"{typ}:?")
    return syms


def main(argv):
    if len(argv) < 3:
        print(__doc__)
        return 2
    ref, new = argv[1], argv[2]
    tol = 1.0
    max_diff = 20
    prefix = "arm-none-eabi-"
    ignores = [r"^wm4\."]
    i = 3
    while i < len(argv):
        if argv[i] == "--tol" and i + 1 < len(argv):
            tol = float(argv[i + 1])
            i += 2
        elif argv[i] == "--max-diff" and i + 1 < len(argv):
            max_diff = int(argv[i + 1])
            i += 2
        elif argv[i] == "--ignore" and i + 1 < len(argv):
            ignores.append(argv[i + 1])
            i += 2
        elif argv[i] == "--no-default-ignore":
            ignores = [p for p in ignores if p != r"^wm4\."]
            i += 1
        elif argv[i] == "--prefix" and i + 1 < len(argv):
            prefix = argv[i + 1]
            i += 2
        else:
            print(f"unknown arg: {argv[i]}")
            return 2

    ok = True
    ref_sz = berkeley_sizes(ref, prefix)
    new_sz = berkeley_sizes(new, prefix)
    for sec in ("text", "data", "bss"):
        r, n = ref_sz[sec], new_sz[sec]
        pct = 0.0 if r == 0 and n == 0 else (100.0 if r == 0 else abs(n - r) / r * 100)
        status = "ok" if pct <= tol else "DIFF"
        if pct > tol:
            ok = False
        print(f"section {sec}: ref={r} new={n} diff={pct:.3f}% [{status}] (tol=+-{tol}%)")

    ref_sym = defined_symbols(ref, prefix)
    new_sym = defined_symbols(new, prefix)
    if ignores:
        ign = [re.compile(p) for p in ignores]
        ref_sym = {n: s for n, s in ref_sym.items() if not any(p.search(n) for p in ign)}
        new_sym = {n: s for n, s in new_sym.items() if not any(p.search(n) for p in ign)}
        print(f"ignored patterns: {ignores}")
    missing = sorted(set(ref_sym) - set(new_sym))
    extra = sorted(set(new_sym) - set(ref_sym))
    changed = sorted(n for n in set(ref_sym) & set(new_sym) if ref_sym[n] != new_sym[n])
    print(f"symbols: ref={len(ref_sym)} new={len(new_sym)} "
          f"missing={len(missing)} extra={len(extra)} changed={len(changed)}")
    for n in missing[:max_diff]:
        print(f"  missing: {n} ({ref_sym[n]})")
    for n in extra[:max_diff]:
        print(f"  extra: {n} ({new_sym[n]})")
    for n in changed[:max_diff]:
        print(f"  changed: {n} ref={ref_sym[n]} new={new_sym[n]}")
    if missing or extra or changed:
        ok = False

    print("PARITY PASS" if ok else "PARITY FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
