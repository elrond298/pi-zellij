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
| `zellij_run` | Run a shell command in a new pane **or tab** (`target`), wait for it | Real exit code (sh -c), 1 s poll instead of sleep-guessing, timeout returns partial results; `wait=none` returns the pane id instantly for interactive apps |
| `zellij_dump` | Read pane output (viewport / full scrollback) | ANSI stripped, tail kept when line-capped |
| `zellij_send` | Paste text, named keys, or raw bytes into a pane | Bracketed paste multi-line safe; `raw` accepts `\xNN` escape sequences |
| `zellij_wait` | Wait for a pattern in pane output, or `for: "exit"` for the process to exit | Subscribe-based, scrollback pre-check, kills subscriber, timeout; `exit` mode for TUIs |
| `zellij_list` | List panes/tabs/sessions with id, command, exit status | Pane ids canonicalized to `terminal_N` |
| `zellij_close` | Close a pane (last pane of a tab closes the tab) | — |

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
