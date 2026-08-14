#!/usr/bin/env bash
# Install the pi-zellij package (extension + bundled skill) to pi.
# Run after committing changes:  ./install.sh
# The skill lives inside the package (skills/) and is discovered by pi
# directly from this repo — no separate skill copy. The old standalone copy at
# ~/.agents/skills/zellij is removed so the skill isn't registered twice.
set -euo pipefail
REPO="$(cd "$(dirname "$0")" && pwd)"

# Remove the pre-package layout standalone skill (superseded by skills/).
rm -rf "$HOME/.agents/skills/zellij"

# Extension + bundled skill (installed as package; re-register idempotently)
pi install "$REPO" >/dev/null
echo "pi-zellij → pi (registered: $(pi list | grep -c zellij) entry)"

echo "done."
