#!/usr/bin/env bash
#
# SubstrateNet Cursor hook: on conversation completion, kick a fast,
# transcript-only update of every registered project.
#
# Install (user-level):
#   mkdir -p ~/.cursor/hooks
#   cp templates/cursor-hooks/subnet-update.sh ~/.cursor/hooks/
#   chmod +x ~/.cursor/hooks/subnet-update.sh
#   # merge templates/cursor-hooks/hooks.json into ~/.cursor/hooks.json
#
# Notes:
#   - Runs detached so it never blocks the agent from finishing.
#   - `subnet update` holds a lock, so overlapping fires are serialized.
#   - Requires `subnet` on PATH (npm link / global install).

set -euo pipefail

# Drain stdin (hook input JSON); we don't need it for an all-projects refresh.
cat >/dev/null 2>&1 || true

LOG="${HOME}/.substrate-net/hook-update.log"
mkdir -p "${HOME}/.substrate-net" 2>/dev/null || true

if command -v subnet >/dev/null 2>&1; then
  # Detach so conversation completion is never delayed by indexing.
  nohup subnet update --fast --yes >>"${LOG}" 2>&1 &
fi

# `stop` hooks take no special output; exit 0 to allow completion.
echo '{}'
exit 0
