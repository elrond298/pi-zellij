/**
 * zellij CLI plumbing: run CLI commands, resolve the target session,
 * list and query panes.
 */
import { spawn } from "node:child_process";
import * as path from "node:path";
import { findRepo } from "./workspace.ts";

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
  killed: boolean;
}

/** Run a zellij CLI command, capturing output. Kills the child on timeout or abort. */
/** Run a zellij CLI command, capturing output. Kills the child on timeout or abort. */
export function runZellij(
  args: string[],
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("zellij", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    // Bounded default: no short CLI call should hang the caller past its own timeout.
    const timeoutMs = opts.timeoutMs ?? 15_000;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const timer = timeoutMs
      ? setTimeout(() => {
          child.kill("SIGKILL");
          finish(() => resolve({ stdout, stderr, code: null, killed: true }));
        }, timeoutMs)
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
/** Active (non-exited) zellij session names. */
export async function listSessions(): Promise<string[]> {
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
 * - otherwise: a persistent session named after the project (nearest git/jj
 *   repo root basename, else cwd basename), auto-created headless
 */
export async function resolveSession(explicit?: string, cwd = process.cwd()): Promise<string[]> {
  if (explicit) {
    const sessions = await listSessions();
    if (!sessions.includes(explicit)) {
      await runZellij(["attach", "--create-background", explicit]);
    }
    return ["--session", explicit];
  }
  if (process.env.ZELLIJ) return [];
  // ponytail: projects sharing a basename share a session; qualify with the parent dir if that ever hurts
  const repo = await findRepo(cwd);
  const name = repo ? path.basename(repo.root) : path.basename(cwd);
  const sessions = await listSessions();
  if (!sessions.includes(name)) {
    await runZellij(["attach", "--create-background", name]);
  }
  return ["--session", name];
}

/** Normalize a pane id like "terminal_3" or "3". */
/** Normalize a pane id like "terminal_3" or "3". */
export function normalizePaneId(paneId?: string): string {
  if (paneId) return paneId;
  if (process.env.ZELLIJ_PANE_ID) return process.env.ZELLIJ_PANE_ID;
  throw new Error("pane_id is required when not running inside a zellij pane");
}

export interface PaneInfo {
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

export async function listPanes(sessionArgs: string[]): Promise<PaneInfo[]> {
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

export function findPane(panes: PaneInfo[], paneId: string): PaneInfo {
  const numeric = paneId.replace(/^terminal_/, "");
  const found = panes.find((p) => String(p.id) === numeric);
  if (!found) throw new Error(`pane ${paneId} not found`);
  return found;
}

/** Snapshot of a pane's process state, or null if the session is transiently unreachable. */
/** Snapshot of a pane's process state, or null if the session is transiently unreachable. */
export async function paneExitState(
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

