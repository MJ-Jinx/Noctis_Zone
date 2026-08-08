#!/bin/bash
# Compiles all 8 Compact PSMs to compiled/. Shared by package.json's
# `compile` script and vitest.config.ts's globalSetup, so the same
# Windows-compact.exe safety check and contract list only live in one
# place.
set -e

if ! compact --version 2>&1 | grep -qE '^compact [0-9]'; then
  echo 'ERROR: `compact` does not resolve to the real Midnight Compact CLI.' >&2
  echo 'On Windows, the native `compact` on PATH is system32\compact.exe (a file-compression tool), not the Compact compiler.' >&2
  echo 'Run this via WSL, where the real CLI is installed (see midnight-tooling:install-cli), or fix PATH ordering so the real `compact` resolves first.' >&2
  exit 1
fi

for f in bonding_curve eligibility_gate treasury creator_escrow vesting lp_escrow cto_governance staking_pool; do
  compact compile --skip-zk "$f.compact" "compiled/$f"
done
