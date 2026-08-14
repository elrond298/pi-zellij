#!/usr/bin/env bash
# Install the zellij skill and pi extension to their run locations.
# Run after committing changes:  ./install.sh
set -euo pipefail
REPO="$(cd "$(dirname "$0")" && pwd)"

# 1. Skill → ~/.agents/skills/zellij (auto-discovered by pi)
SKILL_DEST="$HOME/.agents/skills/zellij"
mkdir -p "$SKILL_DEST"
cp "$REPO/skill/SKILL.md" "$SKILL_DEST/"
cp -r "$REPO/skill/references" "$REPO/skill/scripts" "$SKILL_DEST/"
echo "skill → $SKILL_DEST"

# 2. Extension → pi (installed as package; re-register idempotently)
pi install "$REPO/extension" >/dev/null
echo "extension → pi (registered: $(pi list | grep -c zellij) entry)"

echo "done."
