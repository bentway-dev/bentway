#!/usr/bin/env bash
# Public-API gate via @microsoft/api-extractor. Runs against dist/*.d.mts
# (produced by `prepare: tsc`) and diffs the live extraction against the
# committed snapshot under etc/*.api.md. Drift = FAIL.
#
# Regenerate the snapshot after an intentional API change:
#   (cd packages/<pkg> && pnpm dlx @microsoft/api-extractor run --local)
# Then commit the updated etc/*.api.md. The gate's job is to make that
# regeneration a CONSCIOUS step, not a silent drift.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PKG_DIR"

if [ ! -d dist ]; then
  echo "check-api-report: dist/ absent — run 'pnpm build' first." >&2
  exit 1
fi

../../node_modules/.bin/api-extractor run
echo "check-api-report: public API matches committed snapshot."
