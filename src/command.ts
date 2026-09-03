/**
 * Slash commands: reveal zellij_run panes, or open a new Pi pane/tab with an
 * optional workspace under ~/.worktrees.
 */
import * as path from "node:path";
import { DynamicBorder, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import { listPanes, runZellij } from "./cli.ts";
import { currentSessionRunPanes } from "./run.ts";
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
    description: "List, reveal, or close panes created by zellij_run in this Pi session",
    handler: async (_args: string, ctx) => {
      if (!process.env.ZELLIJ) {
        ctx.ui.notify("/zellij-ps only works inside a zellij session", "error");
        return;
      }

      const historicalPaneIds = new Set<string>();
      for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "zellij_run") continue;
        const details = entry.message.details as { pane_id?: unknown; session?: unknown } | undefined;
        if (typeof details?.pane_id === "string" && details.session == null) historicalPaneIds.add(details.pane_id);
      }

      let showedPanes = false;
      while (true) {
        const paneIds = new Set([...historicalPaneIds, ...currentSessionRunPanes]);
        const panes = (await listPanes([]))
          .filter((pane) => paneIds.has(`terminal_${pane.id}`))
          .sort((a, b) => Number(a.exited) - Number(b.exited) || b.id - a.id);
        if (panes.length === 0) {
          if (!showedPanes) ctx.ui.notify("No zellij_run panes available in this Pi session", "info");
          return;
        }
        showedPanes = true;

        const items: SelectItem[] = panes.map((pane) => ({
          value: `terminal_${pane.id}`,
          label: `terminal_${pane.id}`,
          description: `${pane.exited ? `exited${pane.exit_status === null ? "" : ` (${pane.exit_status})`}` : "running"}  ${pane.title || pane.pane_command || ""}`,
        }));
        const action = await ctx.ui.custom<{ paneId: string; close: boolean } | null>((tui, theme, _keybindings, done) => {
          const container = new Container();
          container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
          container.addChild(new Text(theme.fg("accent", theme.bold("zellij_run panes")), 1, 0));
          const list = new SelectList(items, Math.min(items.length, 10), {
            selectedPrefix: (text) => theme.fg("accent", text),
            selectedText: (text) => theme.fg("accent", text),
            description: (text) => theme.fg("muted", text),
            scrollInfo: (text) => theme.fg("dim", text),
            noMatch: (text) => theme.fg("warning", text),
          });
          list.onSelect = (item) => done({ paneId: item.value, close: false });
          list.onCancel = () => done(null);
          container.addChild(list);
          container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter show • x close • esc cancel"), 1, 0));
          container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
          return {
            render: (width: number) => container.render(width),
            invalidate: () => container.invalidate(),
            handleInput: (data: string) => {
              if (data === "x") {
                const item = list.getSelectedItem();
                if (item) done({ paneId: item.value, close: true });
                return;
              }
              list.handleInput(data);
              tui.requestRender();
            },
          };
        });
        if (!action) return;

        const pane = panes.find((candidate) => `terminal_${candidate.id}` === action.paneId);
        if (action.close) {
          if (pane && !pane.exited) {
            const confirmed = await ctx.ui.confirm(`Close running pane ${action.paneId}?`, "Its process will be terminated.");
            if (!confirmed) continue;
          }
          const result = await runZellij(["action", "close-pane", "--pane-id", action.paneId]);
          if (result.killed || result.code !== 0) {
            ctx.ui.notify(`Failed to close ${action.paneId}: ${result.stderr || result.stdout || `exit ${result.code}`}`, "error");
          } else {
            currentSessionRunPanes.delete(action.paneId);
          }
          continue;
        }

        const result = await runZellij(["action", "focus-pane-id", action.paneId]);
        if (result.killed || result.code !== 0) {
          ctx.ui.notify(`Failed to focus ${action.paneId}: ${result.stderr || result.stdout || `exit ${result.code}`}`, "error");
        }
        return;
      }
    },
  });
}
