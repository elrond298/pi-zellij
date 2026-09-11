/**
 * Slash commands: reveal zellij_run panes, or open a new Pi pane/tab with an
 * optional workspace under ~/.worktrees.
 */
import * as fs from "node:fs";
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
      "Flags: --fork (fork this Pi session into the new pane), --cwd <dir> (default: current dir), --workspace [project/]name (a workspace under ~/.worktrees/<project>/<name>; a git repo creates a git worktree, a jj repo adds a jj workspace, otherwise mkdir + jj/git init).",
    handler: async (args: string, ctx) => {
      if (!process.env.ZELLIJ) {
        ctx.ui.notify("/zellij-pi only works inside a zellij session", "error");
        return;
      }
      const a = parseZpArgs(args);
      let forkSessionFile: string | undefined;
      if (a.fork) {
        const sessionFile = ctx.sessionManager.getSessionFile();
        if (!sessionFile) {
          ctx.ui.notify("Cannot --fork: this Pi session is not persisted (--no-session)", "error");
          return;
        }
        // pi only writes the file once an assistant message exists, so a brand-new
        // session has nothing to fork yet — open it fresh instead of a dead pane.
        if (fs.existsSync(sessionFile)) forkSessionFile = sessionFile;
        else ctx.ui.notify("Nothing to fork yet — this session has no saved history; opening a fresh one", "warning");
      }
      let dir = a.cwd ? (path.isAbsolute(a.cwd) ? a.cwd : path.resolve(ctx.cwd, a.cwd)) : ctx.cwd;
      if (a.workspaceSet) {
        const ws = await resolveWorkspace(a.workspace, ctx, pi);
        if (!ws) return; // user cancelled
        dir = ws;
      }
      const target = a.tab ? "new-tab" : "new-pane";
      const piArgs = ["pi", ...(forkSessionFile ? ["--fork", forkSessionFile] : [])];
      const res = await runZellij(["action", target, "--cwd", dir, "--name", "pi", "--", ...piArgs]);
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

      const paneIds = new Set([...historicalPaneIds, ...currentSessionRunPanes]);
      const panes = (await listPanes([]))
        .filter((pane) => paneIds.has(`terminal_${pane.id}`))
        .sort((a, b) => Number(a.exited) - Number(b.exited) || b.id - a.id);
      if (panes.length === 0) {
        ctx.ui.notify("No zellij_run panes available in this Pi session", "info");
        return;
      }

      const items: SelectItem[] = panes.map((pane) => ({
        value: `terminal_${pane.id}`,
        label: `terminal_${pane.id}`,
        description: `${pane.exited ? `exited${pane.exit_status === null ? "" : ` (${pane.exit_status})`}` : "running"}  ${pane.title || pane.pane_command || ""}`,
      }));
      const paneId = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
        const container = new Container();
        const listHost = new Container();
        const defaultHint = "↑↓ navigate • enter show • x close • esc cancel";
        const hint = new Text(theme.fg("dim", defaultHint), 1, 0);
        let list: SelectList;
        let confirmPaneId: string | null = null;
        let closing = false;

        const rebuildList = (selectedIndex = 0) => {
          list = new SelectList(items, Math.min(items.length, 10), {
            selectedPrefix: (text) => theme.fg("accent", text),
            selectedText: (text) => theme.fg("accent", text),
            description: (text) => theme.fg("muted", text),
            scrollInfo: (text) => theme.fg("dim", text),
            noMatch: (text) => theme.fg("warning", text),
          });
          list.setSelectedIndex(selectedIndex);
          list.onSelect = (item) => done(item.value);
          list.onCancel = () => done(null);
          listHost.clear();
          listHost.addChild(list);
        };

        const resetHint = () => {
          confirmPaneId = null;
          hint.setText(theme.fg("dim", defaultHint));
          tui.requestRender();
        };

        const closePane = async (id: string) => {
          if (closing) return;
          closing = true;
          hint.setText(theme.fg("dim", `Closing ${id}…`));
          tui.requestRender();
          const result = await runZellij(["action", "close-pane", "--pane-id", id]);
          closing = false;
          if (result.killed || result.code !== 0) {
            ctx.ui.notify(`Failed to close ${id}: ${result.stderr || result.stdout || `exit ${result.code}`}`, "error");
            resetHint();
            return;
          }

          currentSessionRunPanes.delete(id);
          const removedIndex = items.findIndex((item) => item.value === id);
          if (removedIndex >= 0) items.splice(removedIndex, 1);
          if (items.length === 0) {
            done(null);
            return;
          }
          rebuildList(Math.min(removedIndex, items.length - 1));
          resetHint();
        };

        rebuildList();
        container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
        container.addChild(new Text(theme.fg("accent", theme.bold("zellij_run panes")), 1, 0));
        container.addChild(listHost);
        container.addChild(hint);
        container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
        return {
          render: (width: number) => container.render(width),
          invalidate: () => container.invalidate(),
          handleInput: (data: string) => {
            if (closing) return;
            if (confirmPaneId) {
              if (data === "y" || data === "Y" || data === "\r") void closePane(confirmPaneId);
              else if (data === "n" || data === "N" || data === "\x1b" || data === "\x03") resetHint();
              return;
            }
            if (data === "x") {
              const item = list.getSelectedItem();
              if (!item) return;
              const pane = panes.find((candidate) => `terminal_${candidate.id}` === item.value);
              if (pane && !pane.exited) {
                confirmPaneId = item.value;
                hint.setText(theme.fg("warning", `Close running pane ${item.value}? y confirm • n cancel`));
                tui.requestRender();
              } else {
                void closePane(item.value);
              }
              return;
            }
            list.handleInput(data);
            tui.requestRender();
          },
        };
      });
      if (!paneId) return;

      const result = await runZellij(["action", "focus-pane-id", paneId]);
      if (result.killed || result.code !== 0) {
        ctx.ui.notify(`Failed to focus ${paneId}: ${result.stderr || result.stdout || `exit ${result.code}`}`, "error");
      }
      return;
    },
  });
}
