/**
 * zellij — reliable programmatic control of zellij for pi.
 *
 * Tools encode the reliability lessons from the zellij skill:
 * - exit codes only from panes created with a command (zellij_run wraps cmd in sh -c)
 * - wait via blocking/polling, never a hard sleep (zellij_run polls exit_status at 1s)
 * - "tell me when X appears" via subscribe, not polling (zellij_wait)
 * - bracketed paste for multi-line input (zellij_send)
 * - every wait has a timeout; timeouts return partial results, never hang
 *
 * Install:  pi install /path/to/extension
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
  killed: boolean;
}

/** Run a zellij CLI command, capturing output. Kills the child on timeout or abort. */
function runZellij(
  args: string[],
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("zellij", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGKILL");
          finish(() => resolve({ stdout, stderr, code: null, killed: true }));
        }, opts.timeoutMs)
      : undefined;

    const onAbort = () => {
      child.kill("SIGKILL");
      finish(() => resolve({ stdout, stderr, code: null, killed: true }));
    };
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      finish(() => reject(err));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      finish(() => resolve({ stdout, stderr, code, killed: false }));
    });
  });
}

/** Active (non-exited) zellij session names. */
async function listSessions(): Promise<string[]> {
  const { stdout, code } = await runZellij(["list-sessions"]);
  if (code !== 0) return [];
  const clean = stdout.replace(/\x1b\[[0-9;]*m/g, ""); // strip ANSI colors (zellij colors output even when piped)
  return clean
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !l.includes("EXITED")) // tombstones: "(EXITED - attach to resurrect)"
    .map((l) => l.split(" ")[0])
    .filter((s) => s && s !== "No" && !s.startsWith("No active"));
}

/**
 * Resolve which session commands should target:
 * - explicit session: auto-create it headless if it does not exist
 * - inside zellij (ZELLIJ env set): current session, no --session flag
 * - otherwise: a persistent default session named "pi"
 */
async function resolveSession(explicit?: string): Promise<string[]> {
  if (explicit) {
    const sessions = await listSessions();
    if (!sessions.includes(explicit)) {
      await runZellij(["attach", "--create-background", explicit]);
    }
    return ["--session", explicit];
  }
  if (process.env.ZELLIJ) return [];
  const sessions = await listSessions();
  if (!sessions.includes("pi")) {
    await runZellij(["attach", "--create-background", "pi"]);
  }
  return ["--session", "pi"];
}

/** Normalize a pane id like "terminal_3" or "3". */
function normalizePaneId(paneId?: string): string {
  if (paneId) return paneId;
  if (process.env.ZELLIJ_PANE_ID) return process.env.ZELLIJ_PANE_ID;
  throw new Error("pane_id is required when not running inside a zellij pane");
}

interface PaneInfo {
  id: number;
  title: string;
  pane_command: string | null;
  pane_cwd: string | null;
  exited: boolean;
  exit_status: number | null;
  is_focused: boolean;
  is_floating: boolean;
  tab_id: number | null;
  tab_name: string | null;
}

async function listPanes(sessionArgs: string[]): Promise<PaneInfo[]> {
  // The zellij server intermittently answers a CLI call with empty stdout (exit 0),
  // typically right after a killed `zellij subscribe`. Retry so waits don't crash on it.
  let stdout = "";
  let code: number | null = -1;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await runZellij([...sessionArgs, "action", "list-panes", "--json"]);
    stdout = res.stdout;
    code = res.code;
    if (code === 0 && stdout.trim()) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  if (code !== 0) throw new Error(`list-panes failed: ${stdout} ${code}`);
  let parsed: Array<Record<string, unknown>>;
  try {
    parsed = JSON.parse(stdout) as Array<Record<string, unknown>>;
  } catch {
    throw new Error(`list-panes returned no JSON (3 attempts): ${stdout.slice(0, 200)}`);
  }
  return parsed
    .filter((p) => p.is_plugin !== true)
    .map((p) => ({
      id: p.id as number,
      title: (p.title as string) ?? "",
      pane_command: (p.pane_command as string | null) ?? null,
      pane_cwd: (p.pane_cwd as string | null) ?? null,
      exited: p.exited === true,
      exit_status: (p.exit_status as number | null) ?? null,
      is_focused: p.is_focused === true,
      is_floating: p.is_floating === true,
      tab_id: (p.tab_id as number | null) ?? null,
      tab_name: (p.tab_name as string | null) ?? null,
    }));
}

function findPane(panes: PaneInfo[], paneId: string): PaneInfo {
  const numeric = paneId.replace(/^terminal_/, "");
  const found = panes.find((p) => String(p.id) === numeric);
  if (!found) throw new Error(`pane ${paneId} not found`);
  return found;
}

/** Snapshot of a pane's process state, or null if the session is transiently unreachable. */
async function paneExitState(
  sessionArgs: string[],
  paneId: string,
): Promise<{ exited: boolean; removed: boolean; exit_status: number | null } | null> {
  let panes;
  try {
    panes = await listPanes(sessionArgs);
  } catch {
    return null; // transient failure — unknown, let the caller keep waiting
  }
  try {
    const pane = findPane(panes, paneId);
    return { exited: pane.exited, removed: false, exit_status: pane.exit_status };
  } catch {
    // Pane gone from the layout (interactive shells are removed on exit) = exited.
    return { exited: true, removed: true, exit_status: null };
  }
}

type WaitOutcome = {
  status: "matched" | "idle" | "timeout" | "exited";
  line?: string;
  elapsedMs: number;
  exit_status: number | null;
  removed: boolean;
};

/**
 * Subscribe to a pane's output; resolve on first matching line, on the pane
 * reaching a terminal state (process exited / pane closed), or on timeout.
 * The caller gets the terminal state so a failed match is immediately diagnosable.
 */
async function waitForPattern(
  paneId: string,
  pattern: string,
  regex: boolean,
  timeoutMs: number,
  sessionArgs: string[],
  signal?: AbortSignal,
): Promise<WaitOutcome> {
  return new Promise((resolve) => {
    const child = spawn("zellij", [...sessionArgs, "subscribe", "--pane-id", paneId], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buf = "";
    let done = false;

    const finish = (outcome: WaitOutcome) => {
      if (done) return;
      done = true;
      clearInterval(watchdog);
      child.kill("SIGKILL");
      resolve(outcome);
    };

    const start = Date.now();
    const timer = setTimeout(
      () => finish({ status: "timeout", elapsedMs: Date.now() - start, exit_status: null, removed: false }),
      timeoutMs,
    );
    const onAbort = () =>
      finish({ status: "timeout", elapsedMs: Date.now() - start, exit_status: null, removed: false });
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });

    // Terminal-state watchdog: if the pane's process exits while we wait for output,
    // return that state instead of burning the full timeout.
    const watchdog = setInterval(async () => {
      if (done) return;
      const st = await paneExitState(sessionArgs, paneId);
      if (st?.exited) {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        finish({
          status: "exited",
          elapsedMs: Date.now() - start,
          exit_status: st.exit_status,
          removed: st.removed,
        });
      }
    }, 500);

    child.stdout.on("data", (d) => {
      buf += d;
      let line: string;
      while ((line = buf.split("\n", 1)[0], buf.includes("\n"))) {
        buf = buf.slice(line.length + 1);
        const hit = regex ? new RegExp(pattern).test(line) : line.includes(pattern);
        if (hit) {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          finish({ status: "matched", line: line.trim(), elapsedMs: Date.now() - start, exit_status: null, removed: false });
          return;
        }
      }
    });
    child.on("error", () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      finish({ status: "timeout", elapsedMs: Date.now() - start, exit_status: null, removed: false });
    });
    child.on("close", async () => {
      // subscriber exited (e.g. pane closed) — flush remaining buffer
      if (!done && buf.trim()) {
        const hit = regex ? new RegExp(pattern).test(buf) : buf.includes(pattern);
        if (hit) finish({ status: "matched", line: buf.trim(), elapsedMs: Date.now() - start, exit_status: null, removed: false });
      }
      if (!done) {
        const st = await paneExitState(sessionArgs, paneId);
        if (st?.exited) {
          finish({ status: "exited", elapsedMs: Date.now() - start, exit_status: st.exit_status, removed: st.removed });
        } else {
          finish({ status: "timeout", elapsedMs: Date.now() - start, exit_status: null, removed: false });
        }
      }
    });
  });
}

/**
 * Subscribe to a pane's output and resolve once the pane has produced no new
 * output for `settleMs` ("wait for stability"), or when its process exits,
 * or on timeout.
 */
async function waitForIdle(
  paneId: string,
  settleMs: number,
  timeoutMs: number,
  sessionArgs: string[],
  signal?: AbortSignal,
): Promise<WaitOutcome> {
  return new Promise((resolve) => {
    const child = spawn("zellij", [...sessionArgs, "subscribe", "--pane-id", paneId], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let done = false;
    let lastChange = Date.now();

    const finish = (outcome: WaitOutcome) => {
      if (done) return;
      done = true;
      clearInterval(watchdog);
      child.kill("SIGKILL");
      resolve(outcome);
    };

    const start = Date.now();
    const timer = setTimeout(
      () => finish({ status: "timeout", elapsedMs: Date.now() - start, exit_status: null, removed: false }),
      timeoutMs,
    );
    const onAbort = () =>
      finish({ status: "timeout", elapsedMs: Date.now() - start, exit_status: null, removed: false });
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });

    const watchdog = setInterval(async () => {
      if (done) return;
      const st = await paneExitState(sessionArgs, paneId);
      if (st?.exited) {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        finish({
          status: "exited",
          elapsedMs: Date.now() - start,
          exit_status: st.exit_status,
          removed: st.removed,
        });
        return;
      }
      if (Date.now() - lastChange >= settleMs) {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        finish({ status: "idle", elapsedMs: Date.now() - start, exit_status: null, removed: false });
      }
    }, 200);

    child.stdout.on("data", (d) => {
      if (!done && d.length) lastChange = Date.now();
    });
    child.on("error", () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      finish({ status: "timeout", elapsedMs: Date.now() - start, exit_status: null, removed: false });
    });
    child.on("close", () => {
      if (!done) finish({ status: "timeout", elapsedMs: Date.now() - start, exit_status: null, removed: false });
    });
  });
}
// ---------------------------------------------------------------------------
// /zellij-pi command helpers: workspace resolution under ~/opt
// ---------------------------------------------------------------------------

interface ZpArgs {
  tab: boolean;
  cwd?: string;
  workspace?: string;
  workspaceSet: boolean;
}

function parseZpArgs(args: string): ZpArgs {
  const out: ZpArgs = { tab: false, workspaceSet: false };
  const toks = args.split(/\s+/).filter(Boolean);
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t === "--tab") out.tab = true;
    else if (t === "--cwd") out.cwd = toks[++i];
    else if (t.startsWith("--cwd=")) out.cwd = t.slice("--cwd=".length);
    else if (t === "--workspace") {
      out.workspaceSet = true;
      const next = toks[i + 1];
      if (next && !next.startsWith("--")) out.workspace = toks[++i];
    } else if (t.startsWith("--workspace=")) {
      out.workspaceSet = true;
      out.workspace = t.slice("--workspace=".length);
    } else if (!t.startsWith("-")) {
      out.cwd = t; // positional = cwd
    }
  }
  return out;
}

/** Existing workspaces: ~/opt entries whose target holds a .git or .jj dir. */
/** Existing workspaces: ~/.worktrees/<project>/<ws> directories. */
async function listWorkspaces(root: string): Promise<{ name: string; vcs: string }[]> {
  const out: { name: string; vcs: string }[] = [];
  let projects: fs.Dirent[] = [];
  try {
    projects = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    let workspaces: fs.Dirent[] = [];
    try {
      workspaces = await fs.promises.readdir(path.join(root, p.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const w of workspaces) {
      if (!w.isDirectory()) continue;
      const dir = path.join(root, p.name, w.name);
      const vcs = fs.existsSync(path.join(dir, ".jj")) ? "jj" : fs.existsSync(path.join(dir, ".git")) ? "git" : "none";
      out.push({ name: `${p.name}/${w.name}`, vcs });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Nearest enclosing jj or git repo, walking up from start. */
async function findRepo(start: string): Promise<{ root: string; vcs: "jj" | "git" } | null> {
  let dir = start;
  for (;;) {
    if (fs.existsSync(path.join(dir, ".jj"))) return { root: dir, vcs: "jj" };
    if (fs.existsSync(path.join(dir, ".git"))) return { root: dir, vcs: "git" };
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Resolve a workspace under ~/.worktrees/<project>/<ws>, following the
 * pi-worktree convention (default root ~/.worktrees/<main-worktree-name>/<branch>).
 * "project/ws" may be given explicitly; a bare name uses the repo at ctx.cwd
 * (or the cwd basename when not in a repo). Creation: git repo → `git worktree
 * add -b <ws>` (attaches if the branch exists), jj repo → `jj workspace add`,
 * no repo → plain mkdir + jj/git init. Returns the workspace dir or null.
 */
async function resolveWorkspace(
  name: string | undefined,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
): Promise<string | null> {
  const root = path.join(os.homedir(), ".worktrees");
  if (!name) {
    const existing = await listWorkspaces(root);
    const pick = await ctx.ui.select(
      "Workspace (under ~/.worktrees):",
      [...existing.map((w) => `${w.name} (${w.vcs})`), "＋ create new workspace"],
    );
    if (!pick) return null;
    if (pick !== "＋ create new workspace") return path.join(root, ...pick.split(" ")[0].split("/"));
    name = await ctx.ui.input("New workspace (project/name):", "e.g. zellij-skill/experiment");
    if (!name?.trim()) return null;
    name = name.trim();
  }
  const parts = name.split("/").filter(Boolean);
  if (parts.length < 2) {
    const repo = await findRepo(ctx.cwd);
    const base = path.basename(ctx.cwd);
    parts.unshift(repo ? path.basename(repo.root) : base === path.basename(os.homedir()) ? "workspaces" : base);
  }
  const dir = path.join(root, ...parts);
  if (fs.existsSync(dir)) {
    ctx.ui.notify(`Workspace: ${dir}`, "info");
    return dir;
  }

  const repo = await findRepo(ctx.cwd);
  if (repo) {
    const ok = await ctx.ui.confirm(
      "Create workspace",
      `${dir} does not exist. Create a ${repo.vcs} worktree there from ${repo.root} and open pi?`,
    );
    if (!ok) return null;
    await fs.promises.mkdir(path.dirname(dir), { recursive: true });
    let res =
      repo.vcs === "jj"
        ? await pi.exec("jj", ["workspace", "add", dir], { cwd: repo.root })
        : await pi.exec("git", ["worktree", "add", dir, "-b", parts[parts.length - 1]], { cwd: repo.root });
    if (res.code !== 0 && repo.vcs === "git") {
      // branch already exists — attach instead of creating a new one
      res = await pi.exec("git", ["worktree", "add", dir], { cwd: repo.root });
    }
    if (res.code !== 0) {
      ctx.ui.notify(`workspace add failed: ${res.stderr}`, "error");
      return null;
    }
    ctx.ui.notify(`Workspace ready: ${dir} (${repo.vcs})`, "info");
    return dir;
  }

  const ok = await ctx.ui.confirm(
    "Create workspace",
    `${dir} does not exist. Create it (with a jj or git repo) and open pi there?`,
  );
  if (!ok) return null;
  const vcs = await ctx.ui.select("Version control:", ["jj (recommended)", "git"]);
  if (!vcs) return null;
  await fs.promises.mkdir(dir, { recursive: true });
  const bin = vcs.startsWith("jj") ? "jj" : "git";
  // `jj git init` works on both old and new jj; plain `jj init` was removed in newer versions.
  const initArgs = vcs.startsWith("jj") ? ["git", "init"] : ["init"];
  const res = await pi.exec(bin, initArgs, { cwd: dir });
  if (res.code !== 0) {
    ctx.ui.notify(`${bin} init failed in ${dir}: ${res.stderr}`, "error");
    return null;
  }
  ctx.ui.notify(`Workspace ready: ${dir} (${vcs})`, "info");
  return dir;
}

function capOutput(text: string, maxLines: number, keepTail: boolean): { text: string; truncated: boolean; compressed: number } {
  const out: string[] = [];
  let compressed = 0;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    const last = out[out.length - 1];
    if (line === "" ? last === "" : line === last) {
      compressed++;
      continue;
    }
    out.push(line);
  }
  if (out.length <= maxLines) return { text: out.join("\n"), truncated: false, compressed };
  const slice = keepTail ? out.slice(-maxLines) : out.slice(0, maxLines);
  return { text: slice.join("\n"), truncated: true, compressed };
}

function showLine(line: string): string {
  return line.length > 200 ? line.slice(0, 200) + "... [line truncated]" : line;
}

/** Marker lines appended after capped/compressed output. */
function capNote(o: { truncated: boolean; compressed: number }): string {
  return (o.truncated ? "\n... [truncated]" : "") +
    (o.compressed ? `\n... [${o.compressed} blank/duplicate line${o.compressed === 1 ? "" : "s"} collapsed]` : "");
}



// ---------------------------------------------------------------------------
// extension
// ---------------------------------------------------------------------------

export default function zellijExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "zellij_run",
    label: "Zellij: Run Command",
    description:
      "Run a shell command in a new zellij pane (or tab, with target=tab) and wait for it to finish. Returns the pane id, real exit code, and final output. Use for long-running commands, builds, tests, servers — anything where the duration is unknown. Never combine with sleep; the tool waits internally. " +
      "The command runs via sh -c, so pipes, globs, and $VARS work. On timeout returns partial results (pane keeps running) so the caller can zellij_wait or zellij_dump later. Captured output keeps the tail when capped; trailing whitespace stripped, blank-line runs and consecutive duplicate lines collapsed.",

    promptSnippet: "Run a command in a zellij pane or tab and wait for it (returns exit code + output)",
    promptGuidelines: [
      "Use zellij_run for any command that should run in a terminal pane with visible output — do not emulate long-running processes with bash sleep loops.",
      "For interactive apps (TUIs, REPLs, editors), spawn with zellij_run wait=none (target=tab puts it in its own tab) and drive it with zellij_send / zellij_wait / zellij_close.",
      "Never fall back to raw `zellij action new-pane` or `zellij run` + manual waiting: zellij_run waits internally and returns the real exit code and output.",
    ],
    parameters: Type.Object({
      command: Type.String({ description: "Command to run (shell syntax allowed; wrapped in sh -c)" }),
      wait: Type.Optional(
        Type.String({
          description: "exit (default): wait until the command exits, any status. exit-success / exit-failure: wait until that outcome, otherwise return immediately with the actual status. none: create the pane and return at once.",
          enum: ["exit", "exit-success", "exit-failure", "none"],
          default: "exit",
        }),
      ),
      capture: Type.Optional(
        Type.Boolean({ description: "Capture final pane output (default true; ignored when wait=none)", default: true }),
      ),
      name: Type.Optional(Type.String({ description: "Optional pane (or tab, when target=tab) name" })),
      target: Type.Optional(
        Type.String({
          description: "Where to run the command: a new pane (default) or a new tab. For a tab, a tab is created and the command runs in its first pane.",
          enum: ["pane", "tab"],
          default: "pane",
        }),
      ),
      cwd: Type.Optional(Type.String({ description: "Working directory for the new pane or tab" })),
      session: Type.Optional(Type.String({ description: "Zellij session name. Default: current session when running inside zellij, else a session named 'pi' (auto-created)." })),
      timeout: Type.Optional(
        Type.Number({ description: "Max seconds to wait (default 600). On expiry returns partial results.", default: 600 }),
      ),
      max_lines: Type.Optional(Type.Number({ description: "Cap on returned output lines (default 500)", default: 500 })),
      tail: Type.Optional(
        Type.Boolean({ description: "When output exceeds max_lines, return the last lines instead of the first (default true)", default: true }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const sessionArgs = await resolveSession(params.session);
      const inTab = params.target === "tab";
      const timeoutMs = (params.timeout ?? 600) * 1000;
      // Verified on zellij 0.44: new-tab with an instant command races pane registration —
      // the command runs, but zellij then keeps a zombie interactive shell and the exit is
      // never recorded (a sleep of even 0.05s avoids it). The prelude keeps the command
      // alive across that window. new-pane does not race, so the prelude is tabs-only.
      const command = inTab ? `sleep 0.2; ${params.command}` : params.command;
      const tabName = inTab && !params.name ? `pi-run-${Date.now()}` : params.name;

      const createArgs = [...sessionArgs, "action", inTab ? "new-tab" : "new-pane"];
      if (tabName) createArgs.push("--name", tabName);
      if (params.cwd) createArgs.push("--cwd", params.cwd);
      createArgs.push("--", "sh", "-c", command);

      let created = await runZellij(createArgs, { timeoutMs: 30_000, signal });
      // The server intermittently answers with empty stdout (exit 0), typically right
      // after a killed subscriber — retry creation once before giving up.
      if (!created.stdout.trim() && !created.killed) {
        await new Promise((r) => setTimeout(r, 300));
        created = await runZellij(createArgs, { timeoutMs: 30_000, signal });
      }
      if (created.killed) {
        throw new Error(`new-${inTab ? "tab" : "pane"} timed out after 30s`);
      }
      const createdId = created.stdout.trim();
      let paneId: string;
      let tabId: number | null = null;
      let pane: PaneInfo | undefined;
      let waited = 0;

      if (!inTab) {
        if (!createdId.startsWith("terminal_")) {
          throw new Error(`new-pane failed: ${created.stdout} ${created.stderr}`);
        }
        paneId = createdId;
      } else {
        // new-tab prints a bare tab id; resolve it to the command pane's id
        tabId = Number(createdId);
        if (!Number.isInteger(tabId)) {
          throw new Error(`new-tab failed: ${created.stdout} ${created.stderr}`);
        }
        const panes = await listPanes(sessionArgs);
        const tabPane = panes.find((p) => p.tab_id === tabId);
        if (!tabPane) throw new Error(`new-tab created tab ${tabId} but no pane was found in it`);
        paneId = `terminal_${tabPane.id}`;
      }

      if (params.wait !== "none") {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const panes = await listPanes(sessionArgs);
          pane = findPane(panes, paneId);
          if (pane.exited) break;
          if (signal?.aborted) break;
          await new Promise((r) => setTimeout(r, 1000));
          waited += 1;
        }
      }

      const where = inTab ? `tab ${tabId}` : `pane ${paneId}`;

      if (params.wait === "none") {
        return {
          content: [{ type: "text", text: `Started in ${where}.` }],
          details: { pane_id: paneId, tab_id: tabId, waited: false },
        };
      }


      const timedOut = !pane?.exited;
      // Evidence on failure: on timeout, still capture output so far (tail kept).
      const output = params.capture !== false
        ? await dumpPane(paneId, true, params.max_lines ?? 500, params.tail !== false, sessionArgs, signal)
        : null;

      let condition = "exit";
      if (params.wait === "exit-success" && pane?.exit_status === 0) condition = "exit-success (met)";
      if (params.wait === "exit-failure" && pane?.exit_status !== 0 && pane?.exited) condition = "exit-failure (met)";
      if (pane?.exited && params.wait === "exit-success" && pane.exit_status !== 0)
        condition = `exit-success NOT met — command exited ${pane.exit_status}`;
      if (pane?.exited && params.wait === "exit-failure" && pane.exit_status === 0)
        condition = "exit-failure NOT met — command exited 0";

      const text = timedOut
        ? `${inTab ? "Tab" : "Pane"} ${inTab ? tabId : paneId} still running after ${params.timeout ?? 600}s (timeout). Pane keeps running. Output so far:\n${output?.text ?? "(capture disabled)"}` +
          capNote(output ?? { truncated: false, compressed: 0 })
        : `Command finished: exit status ${pane?.exit_status} (${condition}), waited ${waited}s in ${where}.` +
          (output?.text ? `\n\n--- output (${paneId}) ---\n${output.text}` + capNote(output) : "");


      return {
        content: [{ type: "text", text }],
        details: {
          pane_id: paneId,
          tab_id: tabId,
          waited_seconds: waited,
          timed_out: timedOut,
          exited: pane?.exited ?? false,
          exit_status: pane?.exit_status ?? null,
          output_captured: output?.text ?? null,
        },
      };
    },
  });

  pi.registerTool({
    name: "zellij_dump",
    label: "Zellij: Dump Screen",
    description:
      "Read a zellij pane's current output (viewport, or full scrollback with full=true). ANSI stripped; trailing whitespace stripped, blank-line runs and consecutive duplicate lines collapsed. " +
      "Use to check what is on a pane's screen right now, or to capture final output after a command finished. " +

      "When the output exceeds max_lines, the tail (last lines) is returned by default — for terminal output the tail is what matters.",
    promptSnippet: "Read the current or full output of a zellij pane (tail kept when capped)",
    promptGuidelines: [
      "Use zellij_dump — never the raw `zellij action dump-screen` CLI — when reading pane output; it handles session targeting, ANSI stripping, and line capping (tail by default).",
    ],
    parameters: Type.Object({
      pane_id: Type.Optional(Type.String({ description: "Pane id (e.g. terminal_3 or 3). Default: the pane this agent runs in." })),
      full: Type.Optional(Type.Boolean({ description: "Include full scrollback (default true)", default: true })),
      max_lines: Type.Optional(Type.Number({ description: "Cap on returned lines (default 500); the tail is kept when capped", default: 500 })),
      tail: Type.Optional(
        Type.Boolean({ description: "When output exceeds max_lines, return the last lines instead of the first (default true)", default: true }),
      ),
      session: Type.Optional(Type.String({ description: "Zellij session name (default: current session when running inside zellij, else a session named 'pi', auto-created)" })),
    }),
    async execute(_toolCallId, params, signal) {
      const sessionArgs = await resolveSession(params.session);
      const paneId = normalizePaneId(params.pane_id);
      const output = await dumpPane(paneId, params.full !== false, params.max_lines ?? 500, params.tail !== false, sessionArgs, signal);
      return {
        content: [{ type: "text", text: output.text + capNote(output) }],
        details: { pane_id: paneId, truncated: output.truncated, compressed_lines: output.compressed, lines: output.text.split("\n").length },

      };
    },
  });

  pi.registerTool({
    name: "zellij_send",
    label: "Zellij: Send Input",
    description:
      "Send input to a zellij pane: paste text (bracketed paste — multi-line safe) and/or named keys. " +
      "Use for interactive commands, answering prompts, or driving a REPL in a pane.",
    promptSnippet: "Send text or keys to a zellij pane (paste + Enter)",
    promptGuidelines: [
      "Use zellij_send — never raw `zellij action paste` / `zellij action send-keys` — for pane input; it combines text + keys and handles session targeting.",
    ],
    parameters: Type.Object({
      pane_id: Type.Optional(Type.String({ description: "Pane id (e.g. terminal_3 or 3). Default: the pane this agent runs in." })),
      text: Type.Optional(Type.String({ description: "Text to paste into the pane (multi-line safe)" })),
      raw: Type.Optional(
        Type.String({
          description:
            "Raw byte sequence to write (zellij action write), with \\xNN escapes — e.g. \"\\x1b[3~\" for Delete or \"\\x1b[1;5C\" for Ctrl+Right. Use when named keys cannot express the sequence. Mutually exclusive with text.",
        }),
      ),
      keys: Type.Optional(
        Type.Array(Type.String({ description: "Named keys to send after text, e.g. [\"Enter\"], [\"Ctrl c\"], [\"Escape\"]" })),
      ),
      press_enter: Type.Optional(
        Type.Boolean({ description: "Send Enter after the text (default true when text is given)", default: true }),
      ),
      session: Type.Optional(Type.String({ description: "Zellij session name (default: current session when running inside zellij, else a session named 'pi', auto-created)" })),
    }),
    async execute(_toolCallId, params, signal) {
      const sessionArgs = await resolveSession(params.session);
      const paneId = normalizePaneId(params.pane_id);
      const keys = [...(params.keys ?? [])];
      if (params.text && params.press_enter !== false) keys.unshift("Enter");

      if (params.text) {
        await runZellij([...sessionArgs, "action", "paste", "--pane-id", paneId, params.text], { signal });
      } else if (params.raw) {
        const bytes = Array.from(
          params.raw.replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))),
        ).map((c) => String(c.charCodeAt(0)));
        await runZellij([...sessionArgs, "action", "write", "--pane-id", paneId, ...bytes], { signal });
      }
      for (const key of keys) {
        await runZellij([...sessionArgs, "action", "send-keys", "--pane-id", paneId, key], { signal });
      }
      const summary = params.text
        ? ` "${params.text.replace(/\n/g, "\\n")}"`
        : params.raw
          ? ` raw "${params.raw}"`
          : "";
      return {
        content: [
          {
            type: "text",
            text: `Sent to ${paneId}:${summary}${keys.length ? ` + keys [${keys.join(", ")}]` : ""}`,
          },
        ],
        details: { pane_id: paneId },
      };
    },
  });

  pi.registerTool({
    name: "zellij_wait",
    label: "Zellij: Wait for Output",
    description:
      "Block until a condition in a zellij pane. for=output (default): a pattern appears in the pane's output (subscribe-based, no polling; also matches output already on screen). " +
      "for=exit: the pane's process exits (exited=true). Prefer exit for interactive apps/TUIs, where rendered output text is unstable and dump-screen cannot be trusted mid-render. " +
      "Failed waits are self-diagnosing: an output-wait returns early with the exit state if the pane exits, and timeouts carry the pane's last output as evidence.",
    promptSnippet: "Wait until a pattern appears in a zellij pane's output, or until the pane's process exits",
    promptGuidelines: [
      "Use zellij_wait — never raw `zellij subscribe | grep` pipelines — to wait for output patterns; it handles the subscriber lifecycle and timeout. For interactive/TUI apps, wait with for=exit instead of matching rendered output. " +
      "A failed zellij_wait already returns the reason (pane exited, or last output on timeout) — never follow it with a raw dump-screen to diagnose.",
    ],
    parameters: Type.Object({
      pane_id: Type.String({ description: "Pane id (e.g. terminal_3 or 3)" }),
      for: Type.Optional(
        Type.String({
          description: "What to wait for: output (default) — the pattern appearing in pane output; exit — the pane's process exiting. For exit, pattern is ignored.",
          enum: ["output", "exit"],
          default: "output",
        }),
      ),
      pattern: Type.Optional(Type.String({ description: "Text to look for (substring match unless regex=true); required when for=output" })),
      regex: Type.Optional(Type.Boolean({ description: "Treat pattern as a regular expression (default false)", default: false })),
      timeout: Type.Optional(Type.Number({ description: "Max seconds to wait (default 300)", default: 300 })),
      session: Type.Optional(Type.String({ description: "Zellij session name (default: current session when running inside zellij, else a session named 'pi', auto-created)" })),
    }),

    async execute(_toolCallId, params, signal) {
      const sessionArgs = await resolveSession(params.session);
      const timeoutMs = (params.timeout ?? 300) * 1000;

      if (params.for === "exit") {
        // Wait for the pane's process to exit (or the pane to disappear — interactive
        // shells are removed from the layout when they exit, which is itself the signal).
        const started = Date.now();
        let pane: PaneInfo | undefined;
        let gone = false;
        while (Date.now() - started < timeoutMs) {
          try {
            const panes = await listPanes(sessionArgs);
            try {
              pane = findPane(panes, params.pane_id);
            } catch {
              gone = true; // pane removed from layout = it exited
              break;
            }
            if (pane.exited) break;
          } catch {
            // transient list-panes failure — keep waiting
          }
          if (signal?.aborted) break;
          await new Promise((r) => setTimeout(r, 500));
        }
        const exited = gone || (pane?.exited ?? false);
        // Evidence on failure: a timed-out exit-wait carries the pane's last output.
        let evidence: string | null = null;
        if (!exited) {
          const ev = await dumpPane(params.pane_id, true, 20, true, sessionArgs, signal);
          evidence = ev.text;
        }
        const text = exited
          ? `Pane ${params.pane_id} exited` + (pane?.exit_status !== null ? ` with status ${pane?.exit_status}` : " (removed from layout)") + ` after ${((Date.now() - started) / 1000).toFixed(1)}s.`
          : `Pane ${params.pane_id} still running after ${params.timeout ?? 300}s (timeout).` +
            (evidence ? `\n\nLast output:\n${evidence}` : "");
        return {
          content: [{ type: "text", text }],
          details: {
            pane_id: params.pane_id,
            exited,
            exit_status: pane?.exit_status ?? null,
            removed_from_layout: gone,
            elapsed_ms: Date.now() - started,
            evidence,
          },
        };
      }

      if (!params.pattern) {
        throw new Error("pattern is required when for=output");
      }
      // Pre-check the full scrollback: subscribe only replays the viewport, so output that
      // appeared before we attached would otherwise be missed.
      const existing = await dumpPane(params.pane_id, true, 5000, true, sessionArgs, signal);
      const rx = params.regex === true ? new RegExp(params.pattern) : null;
      const hit = existing.text.split("\n").find((line) => (rx ? rx.test(line) : line.includes(params.pattern)));
      if (hit) {
        return {
          content: [{ type: "text", text: `Matched in 0.0s (already on screen): ${showLine(hit.trim())}` }],
          details: { pane_id: params.pane_id, matched: true, elapsed_ms: 0, line: hit.trim() },
        };

      }
      const res = await waitForPattern(
        params.pane_id,
        params.pattern,
        params.regex === true,
        timeoutMs,
        sessionArgs,
        signal,
      );
      if (res.status === "exited") {
        // Terminal state reached before the pattern: return it, not a timeout.
        return {
          content: [
            {
              type: "text",
              text:
                `Pattern not found — pane ${params.pane_id} exited` +
                (res.exit_status !== null ? ` with status ${res.exit_status}` : " (removed from layout)") +
                ` after ${(res.elapsedMs / 1000).toFixed(1)}s.`,
            },
          ],
          details: {
            pane_id: params.pane_id,
            matched: false,
            terminal: "exited",
            exit_status: res.exit_status,
            removed_from_layout: res.removed,
            elapsed_ms: res.elapsedMs,
          },
        };
      }
      if (res.status === "timeout") {
        // Evidence on failure: last output lines, so the caller can see why.
        const ev = await dumpPane(params.pane_id, true, 20, true, sessionArgs, signal);
        return {
          content: [
            {
              type: "text",
              text:
                `Pattern not found within ${params.timeout ?? 300}s in pane ${params.pane_id} (pane still running).` +
                `\n\nLast output:\n${ev.text}`,
            },
          ],
          details: { pane_id: params.pane_id, matched: false, elapsed_ms: res.elapsedMs, evidence: ev.text },
        };
      }
      return {
        content: [{ type: "text", text: `Matched in ${(res.elapsedMs / 1000).toFixed(1)}s: ${showLine(res.line ?? "")}` }],
        details: { pane_id: params.pane_id, matched: true, elapsed_ms: res.elapsedMs, line: res.line },

      };
    },
  });

  pi.registerTool({
    name: "zellij_wait_idle",
    label: "Zellij: Wait for Idle",
    description:
      "Block until a zellij pane produces no new output for `settle` seconds (wait for stability), then return the settled output. " +
      "Use after triggering work: a TUI response rendered, a log flood settling, a build quiescing — then read the world once. " +
      "Also returns early if the pane's process exits while waiting. On timeout returns the last output as evidence.",
    promptSnippet: "Wait until a zellij pane stops changing (idle), then read its output",
    promptGuidelines: [
      "Use zellij_wait_idle instead of sleep-polling to let a pane settle: it watches the output stream and returns as soon as the pane is quiet, with the settled output included. Never emulate it with `sleep` loops.",
    ],
    parameters: Type.Object({
      pane_id: Type.String({ description: "Pane id (e.g. terminal_3 or 3)" }),
      settle: Type.Optional(Type.Number({ description: "Seconds of silence that counts as idle (default 2)", default: 2 })),
      timeout: Type.Optional(Type.Number({ description: "Max seconds to wait (default 300)", default: 300 })),
      session: Type.Optional(Type.String({ description: "Zellij session name (default: current session when running inside zellij, else a session named 'pi', auto-created)" })),
    }),
    async execute(_toolCallId, params, signal) {
      const sessionArgs = await resolveSession(params.session);
      const timeoutMs = (params.timeout ?? 300) * 1000;
      const res = await waitForIdle(params.pane_id, (params.settle ?? 2) * 1000, timeoutMs, sessionArgs, signal);
      const ev = await dumpPane(params.pane_id, true, 100, true, sessionArgs, signal);
      if (res.status === "idle") {
        return {
          content: [
            {
              type: "text",
              text:
                `Pane ${params.pane_id} quiet for ${params.settle ?? 2}s (idle after ${(res.elapsedMs / 1000).toFixed(1)}s).` +
                `\n\nCurrent output:\n${ev.text}`,
            },
          ],
          details: { pane_id: params.pane_id, idle: true, elapsed_ms: res.elapsedMs, evidence: ev.text },
        };
      }
      if (res.status === "exited") {
        return {
          content: [
            {
              type: "text",
              text:
                `Pane ${params.pane_id} exited while waiting for idle` +
                (res.exit_status !== null ? ` with status ${res.exit_status}` : " (removed from layout)") +
                ` after ${(res.elapsedMs / 1000).toFixed(1)}s.`,
            },
          ],
          details: {
            pane_id: params.pane_id,
            idle: false,
            terminal: "exited",
            exit_status: res.exit_status,
            removed_from_layout: res.removed,
            elapsed_ms: res.elapsedMs,
          },
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `Pane ${params.pane_id} never went quiet within ${params.timeout ?? 300}s. Last output:\n${ev.text}`,
          },
        ],
        details: { pane_id: params.pane_id, idle: false, timed_out: true, elapsed_ms: res.elapsedMs, evidence: ev.text },
      };
    },
  });

  pi.registerTool({
    name: "zellij_list",
    label: "Zellij: List Panes",
    description:
      "List panes, tabs, or sessions in zellij with id, title, command, cwd, exit status, focus. " +
      "Use to discover pane ids, check whether commands have finished (exited/exit_status), or find which session a pane lives in.",
    promptSnippet: "List zellij panes, tabs, or sessions with their ids and state",
    promptGuidelines: [
      "Use zellij_list — never raw `zellij action list-panes`, `zellij list-tabs`, or `zellij list-sessions` — to inspect state.",
    ],
    parameters: Type.Object({
      resource: Type.Optional(
        Type.String({ description: "What to list: panes (default), tabs, or sessions", enum: ["panes", "tabs", "sessions"], default: "panes" }),
      ),
      session: Type.Optional(Type.String({ description: "Zellij session name (default: current session when running inside zellij, else a session named 'pi', auto-created)" })),
    }),
    async execute(_toolCallId, params, signal) {
      const sessionArgs = await resolveSession(params.session);
      if (params.resource === "sessions") {
        const sessions = await listSessions();
        return {
          content: [{ type: "text", text: sessions.join("\n") || "(no active sessions)" }],
          details: { sessions },
        };
      }
      if (params.resource === "tabs") {
        const { stdout, code } = await runZellij([...sessionArgs, "action", "list-tabs", "--json"], { signal });
        if (code !== 0) throw new Error(`list-tabs failed: ${stdout}`);
        const tabs = JSON.parse(stdout) as Array<Record<string, unknown>>;
        const text = tabs
          .map((t) => `tab ${t.tab_id} "${t.name}" active=${t.active} panes=${t.selectable_tiled_panes_count ?? "?"}`)
          .join("\n");
        return { content: [{ type: "text", text: text || "(no tabs)" }], details: {} };
      }
      const panes = await listPanes(sessionArgs);
      const text = panes
        .map((p) => {
          const id = `terminal_${p.id}`.padEnd(11);
          const state = (p.exited ? "exited" : "running").padEnd(8);
          const status = p.exit_status !== null ? `status=${p.exit_status}`.padEnd(9) : " ".repeat(9);
          const focus = p.is_focused ? " [focused]" : "";
          return `${id} ${state} ${status} "${p.title}" ${p.pane_command ?? ""} ${p.pane_cwd ?? ""}${focus}`;
        })
        .join("\n");

      return {
        content: [{ type: "text", text: text || "(no panes)" }],
        details: { panes: panes.map((p) => ({ ...p, id: `terminal_${p.id}` })) },
      };
    },
  });

  pi.registerTool({
    name: "zellij_close",
    label: "Zellij: Close Pane",
    description:
      "Close a zellij pane (terminates its process). Use for cleanup after a command finished. " +
      "Note: closing the last pane of a tab also closes that tab.",
    promptSnippet: "Close a zellij pane",
    promptGuidelines: [
      "Use zellij_close — never raw `zellij action close-pane` — to clean up panes.",
    ],
    parameters: Type.Object({
      pane_id: Type.Optional(Type.String({ description: "Pane id (e.g. terminal_3 or 3). Default: the pane this agent runs in." })),
      session: Type.Optional(Type.String({ description: "Zellij session name (default: current session when running inside zellij, else a session named 'pi', auto-created)" })),
    }),
    async execute(_toolCallId, params, signal) {
      const sessionArgs = await resolveSession(params.session);
      const paneId = normalizePaneId(params.pane_id);
      const { stdout, code } = await runZellij([...sessionArgs, "action", "close-pane", "--pane-id", paneId], { signal });
      if (code !== 0) throw new Error(`close-pane failed: ${stdout}`);
      return { content: [{ type: "text", text: `Closed pane ${paneId}.` }], details: { pane_id: paneId } };
    },
  });
  // ---------------------------------------------------------------------------
  // /zellij-pi — open a new pi in a new zellij pane/tab, optionally in a workspace
  // ---------------------------------------------------------------------------

  pi.registerCommand("zellij-pi", {
    description:
      "Open a new pi instance in a new zellij pane (or tab with --tab). " +
      "Flags: --cwd <dir> (default: current dir), --workspace [project/]name (a workspace under ~/.worktrees/<project>/<name>; a git repo creates a git worktree, a jj repo adds a jj workspace, otherwise mkdir + jj/git init).",
    handler: async (args: string, ctx) => {
      if (!process.env.ZELLIJ) {
        ctx.ui.notify("/zellij-pi only works inside a zellij session", "error");
        return;
      }
      const a = parseZpArgs(args);
      let dir = a.cwd ?? ctx.cwd;
      if (a.workspaceSet) {
        const ws = await resolveWorkspace(a.workspace, ctx, pi);
        if (!ws) return; // user cancelled
        dir = ws;
      }
      const target = a.tab ? "new-tab" : "new-pane";
      const res = await runZellij(["action", target, "--cwd", dir, "--name", "pi", "--", "pi"]);
      if (res.killed || res.code !== 0) {
        ctx.ui.notify(`Failed to open pi in a new ${target}: ${res.stderr || res.stdout || `exit ${res.code}`}`, "error");
        return;
      }
      ctx.ui.notify(`pi opened in ${target} at ${dir}`, "info");
    },
  });
}

// ---------------------------------------------------------------------------
// shared pane dump (used by zellij_dump and zellij_run capture)
// ---------------------------------------------------------------------------

async function dumpPane(
  paneId: string,
  full: boolean,
  maxLines: number,
  keepTail: boolean,
  sessionArgs: string[],
  signal?: AbortSignal,
): Promise<{ text: string; truncated: boolean }> {
  const args = [...sessionArgs, "action", "dump-screen", "--pane-id", paneId];
  if (full) args.push("--full");
  const { stdout, code } = await runZellij(args, { timeoutMs: 30_000, signal });
  if (code !== 0) throw new Error(`dump-screen failed: ${stdout}`);
  return capOutput(stdout.replace(/\n+$/, ""), maxLines, keepTail);
}
