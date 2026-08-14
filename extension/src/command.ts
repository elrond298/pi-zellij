/**
 * /zellij-pi slash command: open a new pi in a new pane/tab, optionally in a
 * workspace under ~/.worktrees (git worktree / jj workspace / fresh init).
 */
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runZellij } from "./cli.ts";
import { parseZpArgs, resolveWorkspace } from "./workspace.ts";

export function registerZellijPi(pi: ExtensionAPI) {
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
      let dir = a.cwd ? (path.isAbsolute(a.cwd) ? a.cwd : path.resolve(ctx.cwd, a.cwd)) : ctx.cwd;
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
