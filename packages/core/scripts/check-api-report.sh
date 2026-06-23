#!/usr/bin/env bash
# @bentway/core has 7 export subpaths (one per package.json `exports` entry),
# so 7 api-extractor configs. The gate runs all 7; any drift fails.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PKG_DIR"

if [ ! -d dist ]; then
  echo "check-api-report: dist/ absent — run 'pnpm build' first." >&2
  exit 1
fi

for sub in turn-loop transcript tool-exec events usage normalize-stop-reason normalize-retryable; do
  ../../node_modules/.bin/api-extractor run --config "api-extractor.${sub}.json"
done
echo "check-api-report: public API matches committed snapshot (7 entry points)."
