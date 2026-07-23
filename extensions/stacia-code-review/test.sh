#!/usr/bin/env bash
# Run the stacia-code-review extension's test suites (vitest + the Python helper
# tests). Single entrypoint used by BOTH the git pre-commit hook and CI, so
# testing is gated the same way `summon lint` is. Installs node test deps if
# missing; the Python tests use the stdlib runner (no pytest required).
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d node_modules ]; then
  echo "› installing extension test deps (npm ci)…"
  npm ci --no-audit --no-fund
fi

echo "› vitest"
npm test

echo "› python helper tests"
python3 helper/test_code_review_workdir.py
