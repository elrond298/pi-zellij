# Zellij CLI Reference

Full reference for `zellij action`, `zellij subscribe`, and session management (v0.40+). All commands target the current session unless `--session NAME` is given.

This is the manual CLI layer — for a human working in a shell, or for a script. Agents should use the `zellij_*` tools instead; see [SKILL.md](../SKILL.md).

## Patterns

### Start hidden, reveal later

A native floating pane can run in the background without changing the user's current focus:

```bash
PANE_ID=$(zellij action new-pane --floating --no-focus --name worker --cwd "$PWD" -- command)
# The floating layer stays closed if it was closed.

zellij action show-floating-panes                       # reveal the layer later
# or focus one known pane directly:
zellij action focus-pane-id "$PANE_ID"
```

This pane has a PTY from the start, so it remains interactive when revealed. If the floating layer was already open, the pane is visible immediately but remains unfocused. Avoid combining `--near-current-pane` with this pattern: closing the pane can move the client to another tab. When targeting another session with `zellij --session NAME`, omit `--no-focus`; it can cause cross-session creation to land in the wrong session.

## Create / close

| Action | Notes |
|---|---|
| `action new-pane [--name N] [--cwd DIR] [--floating] [--direction right\|down] [-- <cmd>...]` | Prints pane id (`terminal_3`). `-- <cmd>` runs cmd as the pane process (no shell). |
| `action new-tab [--name N]` | Prints tab id. |
| `action close-pane [--pane-id X]` | Without `--pane-id`, closes the focused pane. |
| `action close-tab` | Closes the current tab. |
| `action edit <file>` | Opens file in a new pane with `$EDITOR`; prints pane id. |

## Send input

| Action | Notes |
|---|---|
| `action paste --pane-id X "text"` | Bracketed paste mode — fast, multi-line safe. Prefer for commands/scripts. |
| `action send-keys --pane-id X "Enter"` | Named keys: `"Enter"`, `"Ctrl c"`, `"Escape"`, `"F1"`, `"Alt Shift b"`, ... |
| `action write --pane-id X 108 115 10` | Raw bytes as **values** (`108 115 10` = `ls\n`). For text, use `paste`. |

Interactive pattern (works with any shell in the pane, incl. fish):

```bash
PANE_ID=$(zellij action new-pane --name server)
zellij action paste --pane-id "$PANE_ID" "npm run dev"
zellij action send-keys --pane-id "$PANE_ID" "Enter"
```

## Read output

| Action | Notes |
|---|---|
| `action dump-screen [--pane-id X] [--full] [--ansi] [--path FILE]` | Viewport snapshot; `--full` adds scrollback; stdout unless `--path`. |
| `subscribe --pane-id X [--format raw\|json] [--ansi] [--scrollback [N]]` | Current viewport immediately, then NDJSON `pane_update` events (viewport[]/scrollback[]) until pane closes or process is killed. |

```bash
# Stream one pane's output, filtered for a pattern (see scripts/wait-for-pattern.sh)
timeout 300 zellij --session s subscribe --pane-id terminal_3 | grep -m1 "Finished"
```

## Query state

| Action | Output |
|---|---|
| `action list-panes --json` | id (bare number), title, pane_command, pane_cwd, exited, exit_status, focus, geometry, tab_id/name |
| `action list-tabs --json` | tab_id, position, name, active, layout, viewport dimensions |
| `action current-tab-info --json` | Active tab details |
| `action list-clients` | Connected clients + focused panes |
| `action query-tab-names` | Tab names, plain text |
| `action dump-layout` | Session layout as KDL |

## Blocking panes (preferred over polling)

In agent loops, estimating when a command will exit is unreliable — polling wastes time. A blocking flag on `new-pane` (or `new-tab`, `zellij run`) suspends the CLI call until the pane's command reaches the requested state, then returns. No polling loop needed:

```bash
zellij action new-pane --name build --block-until-exit -- cargo build
zellij action dump-screen --pane-id terminal_1 --full   # capture final output
```

| Flag | Unblocks when |
|---|---|
| `--blocking` | Command finished **and** pane closed (Ctrl-c or `close-pane`) — review-then-continue flows |
| `--block-until-exit` | Command exits, any status |
| `--block-until-exit-success` | Command exits 0. On failure the pane stays open; the docs' Enter-to-retry does **not** work via `send-keys` on 0.44 — see caveat below |
| `--block-until-exit-failure` | Command exits non-zero. On success the pane stays open; Enter-to-retry caveat applies |
Retry semantics make multi-step pipelines with human/agent intervention natural:

```bash
# Step 1: tests — retry until they pass
zellij action new-pane --block-until-exit-success --name tests -- cargo test
# Step 2: deploy — wait regardless of outcome
zellij action new-pane --block-until-exit --name deploy -- ./deploy.sh
```

If a step fails, the pane keeps the error on screen. Verified on 0.44: `send-keys "Enter"` does **not** retry an exited pane via CLI, and `write` takes byte values only. The reliable agent-side retry is to close the pane (unblocks the waiting call) and re-run in a fresh pane:

```bash
zellij action close-pane --pane-id terminal_1   # unblocks the --block-until-exit-success call
zellij action new-pane --block-until-exit-success --name tests -- cargo test   # re-run
```

Blocking flags are also available on `new-tab` (for its initial command) and as a `zellij run --blocking -- <cmd>` shorthand.

## Exit codes and waiting for a command to finish

**Exit codes are only reliable for panes created with a command** (`new-pane -- <cmd>`). Verified against zellij 0.44:

| How the command runs | `exited` / `exit_status` |
|---|---|
| `new-pane -- <cmd>` (cmd is the pane's process) | Reliable: `exited: true`, `exit_status: <real code>` (0, 3, 7 all correct) |
| Interactive: `paste`/`send-keys` into a shell pane | **Not captured** — stays `exited: false, exit_status: null` while the shell lives |
| Interactive shell exits (`exit 5`) — default-shell pane | Pane is **removed from the layout**; no status anywhere |
| Interactive shell exits — pane created with `new-pane -- bash -i` | Stays listed; `exit_status` is the *shell's* exit |

To get a command's exit code, run it at pane creation (simplest: `new-pane --block-until-exit[-success|-failure] -- sh -c '...'`). For interactive commands, surface the code in output and match it:

```bash
zellij action paste --pane-id X "my-command; echo EXIT:\$?"
zellij action send-keys --pane-id X "Enter"
./scripts/wait-for-pattern.sh X "EXIT:0"      # or EXIT:[1-9]... for failure
```

Polling a non-blocking pane's exit status only works for panes created with a command (the JSON `id` is a bare number). Prefer a short-sleep poll loop over a single hard `sleep 120; dump-screen` — the command may finish early or run much longer:

```bash
for _ in $(seq 1 24); do               # 24 × 5 s ≈ 120 s max wait
  EXITED=$(zellij --session s action list-panes --json \
    | jq -r '.[] | select(.id == 3) | .exited')
  [ "$EXITED" = "true" ] && break
  sleep 5
done
zellij action dump-screen --pane-id terminal_3 --full   # final output
```

## Gotchas

- **`new-pane -- cmd` bypasses the shell** — no `$VAR`, globs, or pipes. Use `paste` + `send-keys Enter` for shell-level commands.
- **Pane ids**: `new-pane` prints `terminal_3`; `list-panes --json` gives bare `3` (same pane). CLI flags accept both forms.
- **Same-pane writes from concurrent processes interleave** — serialize input to one pane; parallel actions to *different* panes are safe.
- **Chain dependent actions with `&&`** or capture output first; independent actions can run in parallel.
- `hide-floating-panes` / `show-floating-panes` use exit codes (0/1/2) to report state — non-zero is not failure.
- The pane runs whatever shell started it (bash, fish, ...) — `paste` targets that shell.
