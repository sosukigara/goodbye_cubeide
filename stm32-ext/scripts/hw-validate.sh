#!/usr/bin/env bash
# hw-validate.sh — one-command HARDWARE validation for stm32-ext (todo6).
#
# WHO RUNS THIS: the USER, with a G474RE board + ST-LINK attached via USB.
# Agents cannot plug hardware, so every real-device step in the plan is
# USER-PENDING until this script is executed on a real host. Never claim
# hardware results without running this.
#
# WHAT IT DOES (real flash verify + 5-min 10Hz live + drop-rate assert):
#   1. Checks prerequisites: STM32_Programmer_CLI, pyocd, arm-none-eabi-*, ninja.
#   2. Regenerates build-ext/ from the live unit_omni3 tree and rebuilds.
#   3. Resolves ELF debug base (fails cleanly on stripped ELF).
#   4. Flashes with verify: STM32_Programmer_CLI -c port=SWD -w <elf> -v -rst
#      (asks for confirmation unless --yes; NEVER flashes without it).
#   5. Polls 10Hz x 300s via pyOCD (no-halt, double-read guard), asserts
#      drop-rate < 1% and CSV schema `timestamp,address,name,value`.
#
# USAGE:
#   ./scripts/hw-validate.sh [--fw <unit_omni3 dir>] [--yes] [--skip-flash]
#     --fw: firmware project dir (default: the read-only reference tree —
#           used READ-ONLY as parser input; nothing is ever written there).
#     --yes: skip the pre-flash confirmation prompt (CI only).
#     --skip-flash: live-only run (board already flashed with the same ELF).
#
# EXIT CODES: 0 all green; 1 prereq/build/resolve failure; 2 flash failure;
#   3 probe/live failure; 4 drop-budget or CSV-schema failure.
set -u
FW_DEFAULT="/home/so/robocon_ubuntu/NHK2026/nhk-2026-b-ros-android-controller/main/unit_omni3"
FW="$FW_DEFAULT"
YES=0
SKIP_FLASH=0
while [ $# -gt 0 ]; do
  case "$1" in
    --fw) [ $# -ge 2 ] || { echo "hw-validate: --fw needs a directory" >&2; exit 1; }; FW="$2"; shift 2 ;;
    --yes) YES=1; shift ;;
    --skip-flash) SKIP_FLASH=1; shift ;;
    -h|--help) sed -n '1,25p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

HERE="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$HERE/build-ext"
RES_JSON="/tmp/stm32ext-hw-resolve.json"
CSV_OUT="/tmp/stm32ext-hw-live.csv"
fail() { echo "hw-validate: $*" >&2; exit "${2:-1}"; }

echo "== [1/5] prerequisites =="
for t in STM32_Programmer_CLI pyocd arm-none-eabi-gcc arm-none-eabi-nm arm-none-eabi-readelf ninja python3; do
  command -v "$t" >/dev/null 2>&1 || fail "missing tool: $t (see CLI_INSTALL_GUIDE / pip install --user pyocd)" 1
  echo "  ok: $t"
done

echo "== [2/5] build from live tree (read-only FW input) =="
test -f "$FW/.cproject" || fail "no .cproject in $FW" 1
node "$HERE/out/build/cli.js" --cproject "$FW/.cproject" --project-root "$FW" --out-dir "$OUT" \
  || fail "ninja generation failed" 1
ninja -C "$OUT" || fail "build failed" 1
ELF="$OUT/$(basename "$FW").elf"
test -f "$ELF" || ELF="$OUT/unit_omni3.elf"
test -f "$ELF" || fail "no ELF produced in $OUT" 1
echo "  elf: $ELF"

echo "== [3/5] ELF resolve =="
python3 "$HERE/scripts/elf_resolve.py" "$ELF" --json > "$RES_JSON" \
  || fail "elf_resolve failed (stripped? rebuild Debug -g3)" 1
python3 -c "import json;r=json.load(open('$RES_JSON'));print('  base:',r['base'],'size:',r['size'],'symbols:',len(r['symbols']),'unresolved:',r['unresolved'])"

if [ "$SKIP_FLASH" -eq 0 ]; then
  echo "== [4/5] FLASH + verify (destructive — needs confirmation) =="
  echo "  command: STM32_Programmer_CLI -c port=SWD -w $ELF -v -rst"
  if [ "$YES" -eq 0 ]; then
    printf "  Type YES to flash the attached board: "
    read -r ans
    [ "$ans" = "YES" ] || fail "flash aborted by user (confirmless write forbidden)" 2
  fi
  STM32_Programmer_CLI -c port=SWD -w "$ELF" -v -rst \
    || fail "flash+verify FAILED (check ST-LINK, udev rules, SWD wiring)" 2
  echo "  flash+verify OK"
else
  echo "== [4/5] flash SKIPPED (--skip-flash) =="
fi

echo "== [5/5] live 10Hz x 300s + drop-rate assert =="
python3 "$HERE/scripts/live_poll.py" --resolution "$RES_JSON" --out "$CSV_OUT" \
  --hz 10 --seconds 300
rc=$?
[ "$rc" -eq 4 ] && fail "drop budget exceeded (>=1%, tears included) — see sidecar line above" 4
[ "$rc" -ne 0 ] && fail "live poll failed (probe disconnected? exit=$rc)" 3
head -1 "$CSV_OUT" | grep -qx 'timestamp,address,name,value' \
  || fail "CSV schema mismatch (expected header: timestamp,address,name,value)" 4
# Row floor: 10Hz x 300s x <symbols> samples expected; <99% means silent data
# loss the budget check could otherwise miss (e.g. empty watch edge cases).
python3 - "$RES_JSON" "$CSV_OUT" <<'EOF' || exit 4
import csv, json, sys
res = json.load(open(sys.argv[1]))
want = len(res.get("symbols", [])) * 10 * 300 * 0.99
with open(sys.argv[2], newline="") as f:
    rows = sum(1 for _ in f) - 1
print(f"  csv rows: {rows} (floor: {want:.0f})")
sys.exit(0 if rows >= want else 1)
EOF
[ "$?" -eq 0 ] || fail "CSV row floor not met (silent data loss?)" 4
echo "  schema OK, row floor OK"
echo "  USER: confirm drop-rate line above shows <1% (script exits nonzero otherwise)"
echo "hw-validate: ALL GREEN"
