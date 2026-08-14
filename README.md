# pi-zellij

Reliable zellij control for pi: a skill (reference + helper scripts) and a pi extension (custom tools).

## Layout

extension/src/index.ts    # pi extension — 7 tools + /zellij-pi (see below)
extension/skills/zellij/  # skill bundled in the package: SKILL.md + references/ + scripts/
extension/test/harness.ts # tool tests against a live zellij session
install.sh                # register the package with pi (extension + bundled skill)
```

## Install

```bash
./install.sh
```

The package registers the extension (7 tools + `/zellij-pi`) **and** the bundled zellij skill (`pi.skills` in `extension/package.json`); the skill is discovered from this repo directly, so edits take effect without re-installing.

## Extension tools

| Tool | Purpose | Reliability notes |
|---|---|---|
| `zellij_run` | Run a shell command in a new pane **or tab** (`target`), wait for it | Real exit code (sh -c), 1 s poll instead of sleep-guessing, timeout returns partial results; `wait=none` returns the pane id instantly for interactive apps |
| `zellij_dump` | Read pane output (viewport / full scrollback) | ANSI stripped, tail kept when line-capped, blank-run and duplicate lines collapsed |
| `zellij_send` | Paste text, named keys, or raw bytes into a pane | Bracketed paste multi-line safe; `raw` accepts `\xNN` escape sequences |
| `zellij_wait` | Wait for a pattern in pane output, or `for: "exit"` for the process to exit | Subscribe-based, scrollback pre-check, kills subscriber, timeout; failed waits are self-diagnosing — pane exit returns early with the exit state, timeouts carry last output as evidence |
| `zellij_wait_idle` | Wait for a pane to stop changing (`settle` s of silence), then read its output | "Wait for stability" primitive; also returns early if the pane exits; timeouts carry last output |
| `zellij_list` | List panes/tabs/sessions with id, command, exit status | Pane ids canonicalized to `terminal_N`; internal retry on the server's intermittent empty responses |
| `zellij_close` | Close a pane (last pane of a tab closes the tab) | — |

All tools auto-resolve the session: explicit `session` (auto-created headless if missing) → current session when running inside zellij → default `pi` session.

## Slash command

`/zellij-pi` (works inside a zellij session) opens a new pi in a new pane (or tab with `--tab`):
- `--cwd <dir>` (or a positional `<dir>`) — open pi in that directory instead of the current one; relative paths resolve against the current cwd
- `--workspace [project/]name` — a workspace under `~/.worktrees/<project>/<name>` (the pi-worktree convention); without a name, pick interactively from existing workspaces or create one
- Creating a workspace mirrors pi-worktree's behavior: a git repo creates a `git worktree add -b <name>` worktree (attaches if the branch exists), a jj repo adds a `jj workspace add` workspace, and a bare directory (no repo at the current cwd) falls back to `mkdir` + `jj git init`/`git init`. A bare name uses the repo at the current cwd as the project; pass `project/name` explicitly for another project

## Test

```bash
cd extension && node --experimental-strip-types test/harness.ts        # tools, live session (fresh per run)
cd extension && node --experimental-strip-types test/command-test.ts   # /zellij-pi — run INSIDE a zellij pane
```
## Repo workflow

jj-managed (colocated git). Commit, then `./install.sh`:
```bash
jj commit -m "message" <paths>
./install.sh
```
