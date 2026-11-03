#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIN_MAJOR=22
if ! command -v node >/dev/null 2>&1 || [ "$(node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || echo 0)" -lt "$MIN_MAJOR" ]; then
  echo "Node.js 22+ is required. Install from https://nodejs.org/en/download/ and rerun."
  exit 1
fi
cd "$ROOT"
node scripts/install.mjs "$@"
