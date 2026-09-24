---
name: zellij
description: Control zellij programmatically — run a command in a new pane, send keys or paste input, read pane output (dump-screen snapshot, subscribe stream), open and close panes/tabs, and wait for output or command exit. Use when asked to run something in a zellij pane, check what is on a pane's screen, stream or capture pane output, or manage panes and sessions from the CLI.
compatibility: zellij >= 0.40
---

# Zellij

Control zellij entirely through subprocess calls — `zellij action <subcommand>`, `zellij subscribe`, `zellij attach`. No socket or library. Structured output is available as JSON on stdout.

## Scope: your side and the human's side

You drive panes with the `zellij_*` tools (or the raw CLI below). The human has controls you do not: `/zellij-ps` reveals, focuses, and closes your panes; `/zellij-pi` opens another pi; Zellij's native floating-pane keys do the same from the keyboard. Never try to invoke or emulate those — when the human should look at a pane, name `/zellij-ps` in your reply and let them press the keys.

## When to use

Prefer Pi's `bash` tool for short-lived noninteractive commands. Choose `zellij_run` when a command may be interactive or long-running, needs a PTY, or should remain available in Zellij; the tools stay separate and nothing reroutes `bash` automatically.

New panes start hidden: they land in the invoking Pi tab's floating layer without changing the human's focus, and a closed floating layer stays closed. The human reveals them with `/zellij-ps`. `target=tab` opens a tab instead.

Pass `session` only to deliberately land work in a DIFFERENT session than the one you run in. Leave it unset otherwise: it targets the session you run in (or, when outside Zellij, an auto-created session named after the project), and results report which session was actually used. Never pass a name just because a tool description mentions one. Parameter defaults live in each tool's own description; this file is about choosing and composing them.

## Which verb?

| Need | Tool / command |
|---|---|
| Run one-shot, get output and exit code | `zellij_run` (waited) |
| Run out of sight; read or interact later | `zellij_run` with `wait="none"` |
| Fire-and-forget; get signaled when it exits | `zellij_run` with `wait="none"` + `notify_on_exit=true` — keep working; exit status and last output arrive as a follow-up message that wakes you. Skip it when you already learned the exit from `zellij_wait`/`zellij_close` — you are never told twice |
| Drive an interactive app (TUI, REPL) | `zellij_run` `wait="none"` → `zellij_send` → `zellij_wait` (`for="exit"` for TUIs) or `zellij_wait_idle`. Send and the follow-up wait combine into one call: `zellij_send` with `wait_for="pattern"|"idle"|"exit"` — pattern matches only output new since the send, so a prompt already on screen never false-matches |
| "What is on the screen right now?" | `zellij_dump` (viewport) |
| Capture final result after completion | `zellij_dump` with `full=true` |
| Tell me when X appears | `zellij_wait` (`for="output"`) |
| Give me all output as it happens | `subscribe --pane-id X` (raw CLI) |
| Who is running / did it exit? | `zellij_list` |
| Poll periodically while it runs | `dump-screen` in a loop (prefer `zellij_wait` / `zellij_wait_idle`) |
| Clean up | `zellij_close` |

Raw-CLI equivalents: `dump-screen --pane-id X` is the point-in-time snapshot, `--full` adds scrollback, `subscribe` is the stream, and `./scripts/wait-for-pattern.sh X "pattern"` blocks until a pattern appears. `dump-screen` and `subscribe` strip ANSI by default; add `--ansi` to keep styling.

## Shared-pane rules

Your panes are shared objects. Assume the human may have touched one since your last read.

- **Re-read before acting on an earlier dump.** The human can reveal, type into, or resize a pane at any time; `zellij_dump` again before you interpret state or send input.
- **A human close is terminal, not a hang.** Closing a pane — theirs, or `x` in `/zellij-ps` — unblocks your pending `zellij_wait` as `exited` with `removed_from_layout`. Treat it as the result; don't retry the same pane, re-run in a fresh one if the work is still needed.
- **Never close a pane you did not create.** The human's shells, editors, and `/zellij-pi` panes are theirs. Always pass an explicit `pane_id` to `zellij_close` — omitting it closes the pane you are running in.
- **`close_on_exit` is for unattended panes only.** Leave it off when you have told the human to watch the pane.
- **Don't drive the human's view.** Do not reveal, focus, or hide panes on their behalf; that is `/zellij-ps`'s job.
- **Hand off explicitly.** When you leave something running, end your message with how to reach it: `/zellij-ps` lists, reveals, and closes your panes — name the command and what the pane is running.
- **If the human says they interacted with a pane, read it first** (`zellij_dump`) before continuing the task.

## Session targeting (critical)

| Where the agent runs | Command form |
|---|---|
| **Inside** a zellij session (e.g. agent runs in a zellij pane) | `zellij action ...` — targets the current session |
| **Outside** any session, or targeting another one | `zellij --session NAME action ...` |

Check sessions: `zellij list-sessions`. Create a headless one: `zellij attach --create-background NAME`.

When the `zellij_*` tools are available, use them instead of the raw CLI recipes below; the remaining sections are a reference for manual use and implementation work.

## Blocking panes (preferred over polling)

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

## Background and interactive panes

The native background-pane sequence:

```bash
PANE_ID=$(zellij action new-pane --floating --no-focus --name worker --cwd "$PWD" -- command)
# later: reveal all floating panes, or use /zellij-ps to focus this pane
zellij action show-floating-panes
```

`--floating` puts the pane in the current tab's floating layer, while `--no-focus` preserves the human's focused pane and tab. A closed floating layer remains closed, so the pane runs out of sight; if that layer was already open, the pane is visible but unfocused. Do not add `--near-current-pane`: closing such a pane can move the client to another tab. For explicit cross-session targeting, omit `--no-focus` because it can misroute pane creation.

Driving one interactively:

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

## Reference

- [Full CLI command reference and patterns](references/cli-actions.md) — query/mutate/observe/block commands, waiting for exit, gotchas.
- Helper: `./scripts/wait-for-pattern.sh <pane-id> <pattern> [timeout-seconds] [session]` — blocks until the pattern appears in the pane's output (subscribe + filter), exits 1 on timeout.
