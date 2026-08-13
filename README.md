# zellij-skill

Reliable zellij control for pi: a skill (reference + helper scripts) and a pi extension (custom tools).

## Layout

```
SKILL.md                  # skill entry: session targeting, blocking, decision table
references/cli-actions.md # full CLI reference, loaded on demand
scripts/wait-for-pattern.sh  # subscribe-based "wait for output" helper
extension/                # pi extension — 6 tools (see below)
extension/test/harness.ts # tool tests against a live zellij session
sync.sh                   # copy skill → ~/.agents/skills/zellij, re-register extension
```

## Install

```bash
./sync.sh
```

The skill lands in `~/.agents/skills/zellij/` (auto-discovered). The extension is registered with `pi install` (package entry pointing at this repo).

## Extension tools

| Tool | Purpose | Reliability notes |
|---|---|---|
| `zellij_run` | Run a shell command in a new pane, wait for it | Real exit code (sh -c), 1 s poll instead of sleep-guessing, timeout returns partial results |
| `zellij_dump` | Read pane output (viewport / full scrollback) | ANSI stripped, line-capped for context |
| `zellij_send` | Paste text + named keys into a pane | Bracketed paste, multi-line safe |
| `zellij_wait` | Wait until a pattern appears in pane output | Subscribe-based, kills subscriber, timeout |
| `zellij_list` | List panes/tabs with id, command, exit status | JSON → compact text |
| `zellij_close` | Close a pane | — |

All tools auto-resolve the session: explicit `session` (auto-created headless if missing) → current session when running inside zellij → default `pi` session.

## Test

```bash
cd extension && node --experimental-strip-types test/harness.ts
```

Runs all tools against a live session (13 checks: exit codes, wait, timeout, dump, send, close).

## Repo workflow

jj-managed (colocated git). Commit, then `./sync.sh`:
```bash
jj commit -m "message" <paths>
./sync.sh
```
