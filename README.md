# pi-zellij

Reliable [zellij](https://zellij.dev) control for [pi](https://github.com/earendil-works/pi-coding-agent): **one extension** (7 tools + 2 slash commands) and **one skill**, bundled in a single package.

Requirements: pi, zellij ≥ 0.40.

## Who does what

```
     you ────── prompt ──────▶ agent
      │                            │
      │ /zellij-ps · typing        │ zellij_* tools
      │ reveal · type · close      │ run · read · wait · close
      └──────────┐        ┌────────┘
                 ▼        ▼
      ┌────────────────────────────┐
      │      the shared pane       │
      │ process + PTY + scrollback │
      └────────────────────────────┘
```

- **You** talk to Pi in prose, use `/zellij-ps` and `/zellij-pi`, and can touch any pane directly — look at it, type into it, close it.
- **The agent** runs commands in panes with its `zellij_*` tools, reads their output, and waits for them. It has no access to your slash commands.
- **The pane** is the shared object: one real terminal both of you can use, and the handoff channel — the agent leaves work there for you, and what you type there is visible to the agent on its next read.

The docs follow the same lines: this file is what you do; the bundled skill (`skills/zellij/SKILL.md`) is what the agent does. Commands and keystrokes are yours, tool parameters are the agent's.

## Installation

```bash
git clone <repo-url> pi-zellij
cd pi-zellij
pi install .
```

Idempotent — re-run after pulling updates. The skill is discovered from this repo directly, so editing `skills/zellij/` takes effect without re-installing; extension code changes need `pi install .` again.

## You drive

**`/zellij-ps`** — picker for panes the agent created in this Pi session. Panes show up as soon as they are created, including while the agent is still running them.

- `↑` / `↓` — select a pane
- `Enter` — reveal and focus it
- `x` — close it (running panes need inline confirmation; exited panes close immediately)
- `Esc` — close the picker

**`/zellij-pi`** — open another pi in a new pane, or a tab with `--tab`:

- `--fork` — start it as a fork of the current session (`pi --fork <session-file>`): same conversation so far, diverging from here on. Combine with `--cwd`/`--workspace`.
- `--cwd <dir>` or a positional `<dir>` — open pi there; relative paths resolve against the current cwd
- `--workspace [project/]name` — a workspace under `~/.worktrees/<project>/<name>` (the pi-worktree convention); without a name, pick interactively from existing workspaces or create one. Creation mirrors pi-worktree: `git worktree add -b <name>` for git repos, `jj workspace add` for jj repos, `mkdir` + init for bare directories. A bare name uses the repo at the current cwd as the project

Zellij's own floating-pane controls (`show-floating-panes`, the toggle key) reveal these panes too. Both commands require Pi to run inside a zellij session (`$ZELLIJ` set); otherwise they report an error.

## You and the agent share the pane

- **Panes start hidden.** The agent puts a pane in your current tab's floating layer without changing focus; if that layer is closed, the pane stays out of sight. Nothing pops up in your face.
- **Revealing is safe.** `/zellij-ps` → `Enter` (or the native floating toggle) shows the pane without disturbing the running process. If the layer was already open, the pane is visible but unfocused.
- **You can type.** The process owns a real PTY from the start, so it is interactive the moment you reveal it. The agent can read what you typed — but only when it reads, so tell it when you are done.
- **Closing is a signal, not just cleanup.** It kills the process *and* unblocks the agent's pending wait immediately with an exited result, instead of leaving it hanging. A finished pane is not closed automatically, so its scrollback stays readable afterwards.
- **Handoffs need no setup.** Agent → you: "watch it with `/zellij-ps`". You → agent: "I typed the password into the pane, continue".
- **The agent never takes over your screen.** It does not reveal, focus, or hide panes for you.

When the agent targets another zellij session explicitly, that session's native focus behavior applies. `target="tab"` opens a tab instead of a floating pane.

## What to ask for

| You want | Say | What you get |
|---|---|---|
| Result back in Pi | "run the tests" | the agent runs and waits, then reports output and exit status (if your floating layer is closed, you never see a pane) |
| To watch it live | "run it in a pane I can watch" | a pane you reveal with `/zellij-ps` → `Enter` |
| To drive it yourself | "start X in a pane, I'll answer the prompts" | a pane you type into; the agent can read the result afterwards |
| To keep working meanwhile | "start X in the background" | a hidden pane that keeps running while you and the agent do something else |
| To be told when a background job finishes | "run X in the background and tell me when it's done" | the agent starts it detached and is woken with the exit status and last output when it exits — it can keep working (or you can walk away) in the meantime |
| To stop something | "stop it", or `x` in `/zellij-ps` | the pane closes; if the agent was waiting on it, it unblocks right away |

## What the agent can do

| Capability | Tool |
|---|---|
| Run a command in a new pane or tab | `zellij_run` |
| Read pane output (viewport, or full scrollback) | `zellij_dump` |
| Paste text, send keys, or write raw bytes into a pane — optionally blocking until new output matches, the pane goes idle, or it exits | `zellij_send` |
| Wait for a pattern in the output, or for the process to exit | `zellij_wait` |
| Wait for a pane to stop changing, then read it | `zellij_wait_idle` |
| List panes/tabs/sessions with ids, commands, exit status | `zellij_list` |
| Close a pane | `zellij_close` |

The agent chooses between these and Pi's built-in `bash`: `bash` for short, noninteractive commands, a pane for anything interactive, long-running, or worth watching. Nothing reroutes `bash` automatically. Parameters live in each tool's own description (`src/tools.ts`), not here.

## Skill

The bundled `zellij` skill is the agent's manual: session targeting, the tool-choice table, blocking `new-pane --block-until-exit -- cmd` for one-shot commands, `paste`/`send-keys` for interactive ones, and exit-code capture via `list-panes --json`. It doubles as a plain CLI reference if you script zellij yourself: `skills/zellij/SKILL.md`, `skills/zellij/references/cli-actions.md`, `skills/zellij/scripts/wait-for-pattern.sh`.

## Development

```bash
npm install                                             # once, for a fresh clone
node --experimental-strip-types test/harness.ts         # tools, live session (fresh per run)
node --experimental-strip-types test/wait-test.ts       # idle deduplication (no live session needed)
node --experimental-strip-types test/run-test.ts        # streamed run lifecycle + explicit sessions
node --experimental-strip-types test/notify-test.ts      # background exit signals + suppression
node --experimental-strip-types test/send-test.ts       # send + wait (pattern/idle/exit) in one call
node --experimental-strip-types test/command-test.ts    # slash commands — run INSIDE a zellij pane
```

Commit, then re-install:

```bash
git add -A && git commit -m "message"
pi install .
```

Layout: `src/` is the extension (the tool descriptions there are the canonical parameter reference), `skills/zellij/` the skill, `test/` live-session tests, `package.json` the pi package manifest (`pi.extensions` / `pi.skills`).
