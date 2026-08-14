#!/usr/bin/env bash
# Wait until PATTERN appears in a pane's output (subscribe-driven, no polling loop on zellij).
# Exits 0 on match (prints the matched line), 1 on timeout.
# ANSI is stripped by subscribe (default).
# Usage: wait-for-pattern.sh <pane-id> <pattern> [timeout-seconds] [session]
#   pane-id: terminal_3 (or bare 3)
#   session: zellij session name; omit when running inside the session
set -euo pipefail

PANE_ID=${1:?usage: wait-for-pattern.sh <pane-id> <pattern> [timeout-seconds] [session]}
PATTERN=${2:?pattern required}
TIMEOUT=${3:-300}
SESSION=()
if [ -n "${4:-}" ]; then SESSION=(--session "$4"); fi

tmp=$(mktemp)
zellij "${SESSION[@]}" subscribe --pane-id "$PANE_ID" >"$tmp" 2>/dev/null &
SUB_PID=$!
trap 'kill "$SUB_PID" 2>/dev/null || true; rm -f "$tmp"' EXIT

deadline=$(( $(date +%s) + TIMEOUT ))
while :; do
  if grep -m1 -F -- "$PATTERN" <"$tmp"; then
    exit 0
  fi
  [ "$(date +%s)" -lt "$deadline" ] || break
  sleep 0.5
done

echo "pattern not found within ${TIMEOUT}s" >&2
exit 1
