import { randomUUID } from "node:crypto";
import { open, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { listPanes, paneExitState, runZellij } from "./cli.ts";

export type RunLocation = {
  paneId?: string;
  tabId: number | null;
  exitStatus: number | null;
  paneClosed: boolean;
};

type PaneOptions = {
  sessionArgs: string[];
  targetTab: boolean;
  name?: string;
  cwd: string;
  closeOnExit?: boolean;
  signal?: AbortSignal;
};

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
class CleanupError extends Error {}

async function findMarkedPane(before: Set<number>, marker: string, sessionArgs: string[]) {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const pane = (await listPanes(sessionArgs)).find((candidate) => !before.has(candidate.id) && candidate.title === marker);
      if (pane) return pane;
    } catch {}
    await delay(100);
  }
  return undefined;
}

async function findMarkedTab(marker: string, sessionArgs: string[]): Promise<number | null> {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const tabId = (await listPanes(sessionArgs)).find((pane) => pane.tab_name === marker)?.tab_id;
      if (tabId !== undefined && tabId !== null) return tabId;
    } catch {}
    await delay(100);
  }
  return null;
}

async function createdPaneId(before: Set<number>, stdout: string, marker: string, sessionArgs: string[]): Promise<string> {
  const id = stdout.trim();
  if (/^terminal_\d+$/.test(id)) return id;
  const pane = await findMarkedPane(before, marker, sessionArgs);
  if (!pane) throw new Error(`new-pane returned no pane id: ${stdout}`);
  return `terminal_${pane.id}`;
}

async function closePane(sessionArgs: string[], paneId: string): Promise<boolean> {
  try {
    await runZellij([...sessionArgs, "action", "close-pane", "--pane-id", paneId], { timeoutMs: 5_000 });
  } catch {}
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      if (!(await listPanes(sessionArgs)).some((pane) => `terminal_${pane.id}` === paneId)) return true;
    } catch {}
    await delay(100);
  }
  return false;
}

async function closeTab(sessionArgs: string[], tabId: number): Promise<boolean> {
  try {
    await runZellij([...sessionArgs, "action", "close-tab", "--tab-id", String(tabId)], { timeoutMs: 5_000 });
  } catch {}
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      if (!(await listPanes(sessionArgs)).some((pane) => pane.tab_id === tabId)) return true;
    } catch {}
    await delay(100);
  }
  return false;
}

async function launchPane(
  command: string[],
  options: PaneOptions,
  beforeIds: Set<number>,
  tabId?: number,
): Promise<string> {
  const marker = `pi-run-${randomUUID()}`;
  const args = [...options.sessionArgs, "action", "new-pane", "--name", marker];
  if (tabId === undefined) args.push("--floating");
  if (options.sessionArgs.length === 0) args.push("--no-focus");
  if (tabId === undefined && options.sessionArgs.length === 0) args.push("--near-current-pane");
  else if (tabId !== undefined) args.push("--tab-id", String(tabId));
  args.push("--cwd", options.cwd);
  if (options.closeOnExit) args.push("--close-on-exit");
  args.push("--", ...command);

  if (options.signal?.aborted) throw new Error("aborted");
  const created = await runZellij(args, { timeoutMs: 30_000 });
  if (created.killed || created.code !== 0) {
    const orphan = await findMarkedPane(beforeIds, marker, options.sessionArgs);
    if (orphan && !(await closePane(options.sessionArgs, `terminal_${orphan.id}`))) {
      throw new CleanupError(`new-pane failed and cleanup failed for terminal_${orphan.id}: ${created.stderr || created.stdout}`);
    }
    throw new Error(`new-pane failed: ${created.stderr || created.stdout}`);
  }

  let paneId: string;
  try {
    paneId = await createdPaneId(beforeIds, created.stdout, marker, options.sessionArgs);
  } catch (error) {
    const orphan = await findMarkedPane(beforeIds, marker, options.sessionArgs);
    if (orphan && !(await closePane(options.sessionArgs, `terminal_${orphan.id}`))) {
      throw new CleanupError(`new-pane returned no pane id and cleanup failed for terminal_${orphan.id}`);
    }
    throw error;
  }
  if (options.signal?.aborted) {
    if (!(await closePane(options.sessionArgs, paneId))) {
      throw new CleanupError(`Command was cancelled during setup but cleanup failed for ${paneId}`);
    }
    throw new Error("aborted");
  }
  const renamed = await runZellij(
    [...options.sessionArgs, "action", "rename-pane", "--pane-id", paneId, tabId === undefined ? options.name ?? "pi-run" : "pi-run"],
    { timeoutMs: 5_000 },
  );
  if ((renamed.killed || renamed.code !== 0) && !(await paneExitState(options.sessionArgs, paneId))?.removed) {
    if (!(await closePane(options.sessionArgs, paneId))) {
      throw new CleanupError(`rename-pane failed and cleanup failed for ${paneId}: ${renamed.stderr || renamed.stdout}`);
    }
    throw new Error(`rename-pane failed for ${paneId}: ${renamed.stderr || renamed.stdout}`);
  }
  return paneId;
}

export async function createCommandPane(command: string[], options: PaneOptions): Promise<{ paneId: string; tabId: number | null }> {
  if (options.signal?.aborted) throw new Error("aborted");
  const before = await listPanes(options.sessionArgs);
  const beforeIds = new Set(before.map((pane) => pane.id));
  if (options.signal?.aborted) throw new Error("aborted");

  if (!options.targetTab) {
    const paneId = await launchPane(command, options, beforeIds);
    if (options.signal?.aborted) {
      if (!(await closePane(options.sessionArgs, paneId))) {
        throw new CleanupError(`Command was cancelled during setup but cleanup failed for ${paneId}`);
      }
      throw new Error("aborted");
    }
    return { paneId, tabId: null };
  }

  const tabMarker = `pi-run-${randomUUID()}`;
  const createdTab = await runZellij([...options.sessionArgs, "action", "new-tab", "--name", tabMarker], { timeoutMs: 30_000 });
  const rawTabId = createdTab.stdout.trim();
  let tabId = /^\d+$/.test(rawTabId) ? Number(rawTabId) : null;
  if (tabId === null) tabId = await findMarkedTab(tabMarker, options.sessionArgs);
  if (createdTab.killed || createdTab.code !== 0 || tabId === null) {
    if (tabId !== null && !(await closeTab(options.sessionArgs, tabId))) {
      throw new CleanupError(`new-tab failed and cleanup failed for tab ${tabId}: ${createdTab.stderr || createdTab.stdout}`);
    }
    throw new Error(`new-tab failed: ${createdTab.stderr || createdTab.stdout}`);
  }

  try {
    if (options.signal?.aborted) throw new Error("aborted");
    const renamed = await runZellij(
      [...options.sessionArgs, "action", "rename-tab", "--tab-id", String(tabId), options.name ?? "pi-run"],
      { timeoutMs: 5_000 },
    );
    if (renamed.killed || renamed.code !== 0) throw new Error(`rename-tab failed: ${renamed.stderr || renamed.stdout}`);
    if (options.signal?.aborted) throw new Error("aborted");

    const tabPanes = await listPanes(options.sessionArgs);
    const initialPane = tabPanes.find((pane) => pane.tab_id === tabId);
    const commandBeforeIds = new Set(tabPanes.map((pane) => pane.id));
    const paneId = await launchPane(command, options, commandBeforeIds, tabId);
    if (options.signal?.aborted) throw new Error("aborted");
    if (initialPane && initialPane.id !== Number(paneId.replace("terminal_", ""))) {
      if (!(await closePane(options.sessionArgs, `terminal_${initialPane.id}`))) {
        throw new Error(`failed to close scaffold pane terminal_${initialPane.id}`);
      }
    }
    if (options.signal?.aborted) throw new Error("aborted");
    return { paneId, tabId };
  } catch (error) {
    const cleaned = await closeTab(options.sessionArgs, tabId);
    const message = error instanceof Error ? error.message : String(error);
    if (!cleaned) throw new CleanupError(`${message}; cleanup failed for tab ${tabId}`);
    throw new Error(message);
  }
}

export function createZellijBashOperations(
  options: Omit<PaneOptions, "cwd" | "closeOnExit" | "signal"> & { closeOnExit: boolean },
  location: RunLocation,
): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      const dir = await mkdtemp(join(tmpdir(), "pi-zellij-run-"));
      const commandPath = join(dir, "command.sh");
      const wrapperPath = join(dir, "run.sh");
      const logPath = join(dir, "output.log");
      const statusPath = join(dir, "status");
      const environment = Object.entries(env ?? {})
        .filter((entry): entry is [string, string] => entry[1] !== undefined)
        .map(([key, value]) => quote(`${key}=${value}`))
        .join(" ");

      await writeFile(commandPath, command);
      await writeFile(logPath, "");
      await writeFile(
        wrapperPath,
        `#!/bin/bash\nset -o pipefail\nenv -i ${environment} /bin/sh ${quote(commandPath)} 2>&1 | tee ${quote(logPath)}\nstatus=\${PIPESTATUS[0]}\nprintf '%s\\n' "$status" > ${quote(statusPath)}\nexit "$status"\n`,
        { mode: 0o700 },
      );

      const log = await open(logPath, "r");
      let offset = 0;
      const drain = async () => {
        const size = (await log.stat()).size;
        while (offset < size) {
          const chunk = Buffer.alloc(Math.min(64 * 1024, size - offset));
          const { bytesRead } = await log.read(chunk, 0, chunk.length, offset);
          if (!bytesRead) break;
          offset += bytesRead;
          onData(chunk.subarray(0, bytesRead));
        }
      };

      let retainDir = false;
      try {
        const created = await createCommandPane(["bash", wrapperPath], {
          ...options,
          cwd,
          signal,
        });
        location.paneId = created.paneId;
        location.tabId = created.tabId;
        const deadline = timeout === undefined ? Infinity : Date.now() + timeout * 1000;

        while (true) {
          await drain();
          if (signal?.aborted) {
            location.paneClosed = await closePane(options.sessionArgs, created.paneId);
            await drain();
            if (!location.paneClosed) {
              retainDir = true;
              throw new CleanupError(`Command aborted but ${created.paneId} could not be terminated; files retained at ${dir}`);
            }
            throw new Error("aborted");
          }
          if (Date.now() >= deadline) {
            location.paneClosed = await closePane(options.sessionArgs, created.paneId);
            await drain();
            if (!location.paneClosed) {
              retainDir = true;
              throw new CleanupError(`Command timed out but ${created.paneId} could not be terminated; files retained at ${dir}`);
            }
            throw new Error(`timeout:${timeout}`);
          }
          const state = await paneExitState(options.sessionArgs, created.paneId);
          if (state?.exited) {
            await drain();
            const recorded = Number.parseInt((await readFile(statusPath, "utf8").catch(() => "")).trim(), 10);
            location.exitStatus = Number.isNaN(recorded) ? state.exit_status : recorded;
            if (options.closeOnExit) {
              location.paneClosed = state.removed || await closePane(options.sessionArgs, created.paneId);
              if (!location.paneClosed) throw new Error(`Command exited but ${created.paneId} could not be closed`);
            }
            return { exitCode: location.exitStatus };
          }
          await delay(100);
        }
      } catch (error) {
        if (error instanceof CleanupError) {
          retainDir = true;
          const message = error.message.includes("files retained at") ? error.message : `${error.message}; files retained at ${dir}`;
          throw new CleanupError(message);
        }
        throw error;
      } finally {
        await log.close();
        if (!retainDir) await rm(dir, { recursive: true, force: true });
      }
    },
  };
}
