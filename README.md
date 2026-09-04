# pi-zellij

Reliable [zellij](https://zellij.dev) control for [pi](https://github.com/earendil-works/pi-coding-agent): **one extension** (7 tools + 2 slash commands) and **one skill**, bundled in a single package.

Requirements: pi, zellij ≥ 0.40.

## What's inside

| Piece | Location | What it does |
|---|---|---|
| **Extension** | `src/` | 7 custom tools that wrap `zellij action`/`subscribe` with reliability built in (real exit codes, timeouts, no sleep-guessing), plus `/zellij-ps` and `/zellij-pi` |
| **Skill** | `skills/zellij/` | Teaches pi to drive zellij through subprocess calls — no socket or library. Loads whenever pi needs to run something in a pane, read pane output, or manage panes/sessions |
| Tests | `test/` | Live-session tests for the tools and slash commands |
| Package manifest | `package.json` | The pi package structure — `pi.extensions` / `pi.skills` point at the extension and skill |

## Installation

```bash
git clone <repo-url> pi-zellij
cd pi-zellij
pi install .
```

Idempotent — re-run after pulling updates. The skill is discovered from this repo directly, so editing `skills/zellij/` takes effect without re-installing; extension code changes need `pi install .` again.

## Extension

### Tools

| Tool | Purpose | Reliability notes |
|---|---|---|
| `zellij_run` | Run a shell command in a new floating pane **or tab** (`target`) | Default panes start in the invoking Pi tab's floating layer without changing client focus; waited runs stream output through Pi's bash result path; `wait=none` returns immediately; `session` explicitly targets or creates a session |
| `zellij_dump` | Read pane output (viewport / full scrollback) | ANSI stripped, tail kept when line-capped, blank-run and duplicate lines collapsed |
| `zellij_send` | Paste text, named keys, or raw bytes into a pane | Bracketed paste multi-line safe; `raw` accepts `\xNN` escape sequences |
| `zellij_wait` | Wait for a pattern in pane output, or `for: "exit"` for the process to exit | Subscribe-based, scrollback pre-check, kills subscriber, timeout; failed waits are self-diagnosing — pane exit returns early with the exit state, timeouts carry last output as evidence |
| `zellij_wait_idle` | Wait for a pane to stop changing (`settle` s of silence), then read its output | "Wait for stability" primitive; also returns early if the pane exits; timeouts carry last output |
| `zellij_list` | List panes/tabs/sessions with id, command, exit status | Pane ids canonicalized to `terminal_N`; internal retry on the server's intermittent empty responses |
| `zellij_close` | Close a pane (last pane of a tab closes the tab) | — |

All tools auto-resolve the session: explicit `session` (auto-created headless if missing) → current session when running inside zellij → default `pi` session.

Pi keeps its built-in `bash` tool. The model chooses `bash` for short, noninteractive commands and `zellij_run` for long-running, interactive, or user-visible work; the extension does not intercept or reroute bash automatically.

### Background floating panes

For the default `target="pane"`, `zellij_run` starts the command as a native Zellij floating pane:

```bash
zellij action new-pane --name <temporary-marker> --floating --no-focus --cwd <dir> -- <command>
```

The procedure is:

1. Snapshot the existing pane IDs, create the pane with a unique temporary title, then resolve and rename its returned pane ID.
2. `--floating` places it in the invoking Pi tab's floating layer; `--no-focus` leaves the user's current pane and tab focused.
3. If the floating layer is closed, it stays closed, so the command runs out of sight. If the layer is already open, the new pane is visible but still does not take focus.
4. Register the pane immediately so `/zellij-ps` can list it while its tool call is still running.
5. For waited runs, execute through a wrapper that tees output to Pi and records the real exit status. `wait="none"` returns the pane ID immediately.
6. Reveal it later with `/zellij-ps` (or Zellij's floating-pane toggle); the process already owns a PTY and is ready for interaction.

When `session` explicitly targets another Zellij session, `zellij_run` omits `--no-focus`: Zellij can otherwise route cross-session pane creation incorrectly. `target="tab"` uses the separate explicit new-tab flow.

### Slash commands

`/zellij-ps` opens a picker for panes created by `zellij_run` in the current Pi session, including panes from tool calls that are still running:
- `↑` / `↓` — select a pane
- `Enter` — reveal and focus the selected floating pane
- `x` — close the selected pane; running panes require inline confirmation, while exited panes close immediately
- `Esc` — close the picker

After a pane closes, only the picker list is updated; the surrounding Pi interface is not reopened or globally refreshed.

`/zellij-pi` (inside a zellij session) opens a new pi in a new pane, or tab with `--tab`:
- `--cwd <dir>` or a positional `<dir>` — open pi there; relative paths resolve against the current cwd
- `--workspace [project/]name` — a workspace under `~/.worktrees/<project>/<name>` (the pi-worktree convention); without a name, pick interactively from existing workspaces or create one. Workspace creation mirrors pi-worktree: `git worktree add -b <name>` for git repos, `jj workspace add` for jj repos, `mkdir` + init for bare directories. A bare name uses the repo at the current cwd as the project; pass `project/name` explicitly for another project

## Skill

The bundled `zellij` skill is a CLI reference for controlling zellij from a shell:

- **Session targeting** — `zellij action ...` inside a session, `--session NAME` outside or cross-session
- **Core workflow** — blocking `new-pane --block-until-exit -- cmd` for one-shot commands, `paste`/`send-keys` for interactive ones, exit-code capture via `list-panes --json`
- **Which read command?** — a decision table: `dump-screen` for "what's on screen now", `subscribe` for streaming and pattern waits
- **Reference** — `references/cli-actions.md` (full command patterns and gotchas) and `scripts/wait-for-pattern.sh` (block until a pattern appears)

## Development

```bash
npm install                                             # once, for a fresh clone
node --experimental-strip-types test/harness.ts        # tools, live session (fresh per run)
node --experimental-strip-types test/wait-test.ts       # idle deduplication (no live session needed)
node --experimental-strip-types test/run-test.ts        # streamed run lifecycle + explicit sessions
node --experimental-strip-types test/command-test.ts    # slash commands — run INSIDE a zellij pane
```

The repo is jj-managed (colocated git). Commit, then re-install:

```bash
jj commit -m "message" <paths>
pi install .
```
