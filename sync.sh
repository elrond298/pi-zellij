#!/usr/bin/env bash
# Sync the zellij skill and pi extension to their install locations.
# Run after committing changes:  ./sync.sh
set -euo pipefail
REPO="$(cd "$(dirname "$0")" && pwd)"

# 1. Skill → ~/.agents/skills/zellij (auto-discovered by pi)
SKILL_DEST="$HOME/.agents/skills/zellij"
mkdir -p "$SKILL_DEST"
cp "$REPO/SKILL.md" "$SKILL_DEST/"
cp -r "$REPO/references" "$REPO/scripts" "$SKILL_DEST/"
echo "skill → $SKILL_DEST"

# 2. Extension → pi (installed as package; re-register idempotently)
pi install "$REPO/extension" >/dev/null
echo "extension → pi (registered: $(pi list | grep -c zellij) entry)"

echo "done."
