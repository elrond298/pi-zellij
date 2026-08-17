---
name: zellij
description: Control zellij programmatically — run a command in a new pane, send keys or paste input, read pane output (dump-screen snapshot, subscribe stream), open and close panes/tabs, and wait for output or command exit. Use when asked to run something in a zellij pane, check what is on a pane's screen, stream or capture pane output, or manage panes and sessions from the CLI.
compatibility: zellij >= 0.40
---

# Zellij

Control zellij entirely through subprocess calls — `zellij action <subcommand>`, `zellij subscribe`, `zellij attach`. No socket or library. Structured output is available as JSON on stdout.

## Session targeting (critical)

| Where the agent runs | Command form |
|---|---|
| **Inside** a zellij session (e.g. agent runs in a zellij pane) | `zellij action ...` — targets the current session |
| **Outside** any session, or targeting another one | `zellij --session NAME action ...` |

Check sessions: `zellij list-sessions`. Create a headless one: `zellij attach --create-background NAME`.

## Core workflow

Prefer the `bash` tool for short-lived commands unless the user explicitly asks for zellij. Use zellij when a command may be interactive or long-running, or when its output is useful to or should remain visible to the user.

## Run a command and wait — blocking (preferred in agent loops)

Don't poll exit status or guess how long a command takes — a blocking flag makes the `new-pane` call itself return only when the command finishes:

```bash
PANE_ID=$(zellij action new-pane --name build --block-until-exit -- cargo build)
zellij action dump-screen --pane-id "$PANE_ID" --full   # final output is already there
```

- `--block-until-exit`: unblocks when the command exits, any status.
- `--block-until-exit-success` / `--block-until-exit-failure`: unblock only on that outcome. On the wrong outcome the pane stays open. The docs' Enter-to-retry does not work via `send-keys` on 0.44 — the reliable agent-side retry is `close-pane` (unblocks the call) then re-run in a fresh pane.
- `--blocking`: waits until the command finishes **and** the pane is closed — for review-then-continue flows.
- Also available on `new-tab` and `zellij run` (`zellij run --blocking -- cmd`).

Without a blocking flag (pane must stay alive), wait by polling `exited` in short sleeps — e.g. `for _ in $(seq 1 24); do ...; sleep 5; done` (~120 s cap) — never a single `sleep 120` then dump. See [references/cli-actions.md](references/cli-actions.md).

## Run a long-running command in a pane (interactive)

```bash
# 1. Create a pane (prints the pane id, e.g. terminal_3)
PANE_ID=$(zellij action new-pane --name worker)

# 2. Send input — paste (bracketed mode, multi-line safe) + Enter
zellij action paste --pane-id "$PANE_ID" "cargo build --release"
zellij action send-keys --pane-id "$PANE_ID" "Enter"

# 3. Read output — snapshot, or stream
zellij action dump-screen --pane-id "$PANE_ID" --full   # point-in-time, incl. scrollback
zellij subscribe --pane-id "$PANE_ID" --format json      # real-time NDJSON stream

# 4. Close
zellij action close-pane --pane-id "$PANE_ID"
```

`new-pane -- <cmd>` runs the command as the pane's process, bypassing the shell (no `$VAR`, globs, pipes).

**Exit codes are only reliable at pane creation** — `new-pane -- <cmd>` records the real `exit_status` in `list-panes --json`. Commands sent interactively via paste/send-keys never get an exit code (pane stays `exit_status: null`). For interactive commands, echo the code into output: `cmd; echo EXIT:$?`. See [references/cli-actions.md](references/cli-actions.md).

## Which read command?

| Need | Command |
|---|---|
| "What is on the screen right now?" | `action dump-screen --pane-id X` |
| Capture final result after completion | `action dump-screen --pane-id X --full` (after blocking pane unblocks) |
| Give me all output as it happens | `subscribe --pane-id X` |
| Tell me when X appears | `./scripts/wait-for-pattern.sh X "pattern"` |
| Periodic polling (every N s) | `dump-screen` in a loop with `sleep` |

`dump-screen` and `subscribe` strip ANSI by default; add `--ansi` to keep styling.

## Reference

- [Full CLI command reference and patterns](references/cli-actions.md) — query/mutate/observe/block commands, waiting for exit, gotchas.
- Helper: `./scripts/wait-for-pattern.sh <pane-id> <pattern> [timeout-seconds] [session]` — blocks until the pattern appears in the pane's output (subscribe + filter), exits 1 on timeout.
