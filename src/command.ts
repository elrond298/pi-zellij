/**
 * Slash commands: reveal zellij_run panes, or open a new Pi pane/tab with an
 * optional workspace under ~/.worktrees.
 */
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { listPanes, runZellij } from "./cli.ts";
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

export function registerZellijPs(pi: ExtensionAPI) {
  pi.registerCommand("zellij-ps", {
    description: "List panes created by zellij_run in this Pi session and bring one to the foreground",
    handler: async (_args: string, ctx) => {
      if (!process.env.ZELLIJ) {
        ctx.ui.notify("/zellij-ps only works inside a zellij session", "error");
        return;
      }

      const paneIds = new Set<string>();
      for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "zellij_run") continue;
        const details = entry.message.details as { pane_id?: unknown; session?: unknown } | undefined;
        if (typeof details?.pane_id === "string" && details.session == null) paneIds.add(details.pane_id);
      }

      const panes = (await listPanes([]))
        .filter((pane) => paneIds.has(`terminal_${pane.id}`))
        .sort((a, b) => Number(a.exited) - Number(b.exited) || b.id - a.id);
      if (panes.length === 0) {
        ctx.ui.notify("No zellij_run panes available in this Pi session", "info");
        return;
      }

      const choices = panes.map((pane) => {
        const state = pane.exited ? `exited${pane.exit_status === null ? "" : ` (${pane.exit_status})`}` : "running";
        return `terminal_${pane.id}  ${state}  ${pane.title || pane.pane_command || ""}`;
      });
      const choice = await ctx.ui.select("zellij_run panes", choices);
      if (!choice) return;

      const paneId = choice.split(/\s/, 1)[0];
      const result = await runZellij(["action", "focus-pane-id", paneId]);
      if (result.killed || result.code !== 0) {
        ctx.ui.notify(`Failed to focus ${paneId}: ${result.stderr || result.stdout || `exit ${result.code}`}`, "error");
      }
    },
  });
}
