#!/usr/bin/env bash
# Per-module LOC caps for the @bentway package (mirrors the kernel pattern at
# packages/kernel/scripts/check-file-sizes.sh — 1b.5).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$(dirname "$SCRIPT_DIR")/src"

if [ ! -d "$SRC_DIR" ]; then
  echo "check-file-sizes: src/ absent — nothing to check."
  exit 0
fi

DEFAULT_CAP=500

cap_for() {
  case "$1" in
    # turn-loop.mjs (core only): 939 LOC, a KNOWN decomposition candidate kept
    # whole through the 1b/1c carves so the goldens stay byte-identical. The
    # pattern is inert in the other 4 packages.
    */turn-loop.mjs) echo 950 ;;
    *) echo "$DEFAULT_CAP" ;;
  esac
}

fail=0
while IFS= read -r -d '' f; do
  lines=$(wc -l < "$f" | tr -d ' ')
  cap=$(cap_for "$f")
  if [ "$lines" -gt "$cap" ]; then
    echo "FAIL: ${f#"$SRC_DIR"/} is $lines lines (cap $cap)"
    fail=1
  fi
done < <(find "$SRC_DIR" -type f -name '*.mjs' -print0)

if [ "$fail" -ne 0 ]; then
  echo "check-file-sizes: bentway module(s) exceed their cap." >&2
  exit 1
fi

count=$(find "$SRC_DIR" -type f -name '*.mjs' | wc -l | tr -d ' ')
echo "check-file-sizes: $count module(s) within caps."
