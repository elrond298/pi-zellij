/**
 * /zellij-pi workspace resolution: ~/.worktrees/<project>/<name> convention,
 * git worktree add / jj workspace add creation, and arg parsing.
 */
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export interface ZpArgs {
  tab: boolean;
  cwd?: string;
  workspace?: string;
  workspaceSet: boolean;
}

/** Quote-aware tokenizer: --cwd "dir with spaces" stays one token. */
/** Quote-aware tokenizer: --cwd "dir with spaces" stays one token. */
export function tokenize(args: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(args))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

export function parseZpArgs(args: string): ZpArgs {
  const out: ZpArgs = { tab: false, workspaceSet: false };
  const toks = tokenize(args);
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

/** Existing workspaces: ~/.worktrees/<project>/<ws> directories. */
/** Existing workspaces: ~/.worktrees/<project>/<ws> directories. */
export async function listWorkspaces(root: string): Promise<{ name: string; vcs: string }[]> {
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
/** Nearest enclosing jj or git repo, walking up from start. */
export async function findRepo(start: string): Promise<{ root: string; vcs: "jj" | "git" } | null> {
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
/**
 * Resolve a workspace under ~/.worktrees/<project>/<ws>, following the
 * pi-worktree convention (default root ~/.worktrees/<main-worktree-name>/<branch>).
 * "project/ws" may be given explicitly; a bare name uses the repo at ctx.cwd
 * (or the cwd basename when not in a repo). Creation: git repo → `git worktree
 * add -b <ws>` (attaches if the branch exists), jj repo → `jj workspace add`,
 * no repo → plain mkdir + jj/git init. Returns the workspace dir or null.
 */
export async function resolveWorkspace(
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
    name = await ctx.ui.input("New workspace (project/name):", "e.g. pi-zellij/experiment");
    if (!name?.trim()) return null;
    name = name.trim();
  }
  const parts = name.split("/").filter(Boolean);
  if (parts.some((p) => p === "." || p === "..")) {
    ctx.ui.notify("Workspace names must not contain . or .. path segments", "error");
    return null;
  }
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
    // don't leave a bare dir that the next invocation would accept as a workspace
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    ctx.ui.notify(`${bin} init failed in ${dir}: ${res.stderr}`, "error");
    return null;
  }
  ctx.ui.notify(`Workspace ready: ${dir} (${vcs})`, "info");
  return dir;
}

