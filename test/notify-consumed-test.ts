/** Run: node --experimental-test-module-mocks test/notify-consumed-test.ts */
import assert from "node:assert/strict";
import { mock } from "node:test";
import * as cli from "../src/cli.ts";
import * as run from "../src/run.ts";
import * as output from "../src/output.ts";

let id = 0;
const states = new Map<string, { exited: boolean; exit_status: number | null }>();
const key = (args: string[], paneId: string) => JSON.stringify([args[1] ?? process.env.ZELLIJ_SESSION_NAME ?? "", paneId.replace(/^terminal_/, "")]);
let evidenceHook: (() => Promise<void>) | undefined;
mock.module("../src/cli.ts", { namedExports: {
  ...cli,
  resolveSession: async (session?: string) => session ? ["--session", session] : [],
  paneExitState: async (args: string[], paneId: string) => states.get(key(args, paneId)) ?? null,
  listPanes: async (args: string[]) => [...states].filter(([k]) => JSON.parse(k)[0] === (args[1] ?? process.env.ZELLIJ_SESSION_NAME ?? ""))
    .map(([k, state]) => ({ id: Number(JSON.parse(k)[1]), title: "test", ...state })),
} });
mock.module("../src/run.ts", { namedExports: {
  ...run,
  createCommandPane: async () => ({ paneId: `terminal_${++id}`, tabId: 1 }),
} });
mock.module("../src/output.ts", { namedExports: {
  ...output,
  dumpPane: async (_paneId: string, _full: boolean, maxLines: number) => {
    if (maxLines === 15 && evidenceHook) await evidenceHook();
    return { text: "command complete", truncated: false, compressed: 1 };
  },
} });
const { registerTools } = await import("../src/tools.ts");
const tools = new Map<string, any>();
const messages: any[] = [];
registerTools({ registerTool: (tool: any) => tools.set(tool.name, tool), sendMessage: (message: any) => messages.push(message) } as any);
const call = (name: string, params: any) => tools.get(name).execute("test", params, undefined, undefined, { cwd: process.cwd() });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function start(session = "test", exited = true) {
  await call("zellij_run", { command: "echo done", wait: "none", notify_on_exit: true, session });
  const paneId = `terminal_${id}`;
  states.set(key(["--session", session], paneId), { exited, exit_status: exited ? 0 : null });
  return paneId;
}

for (const tool of ["zellij_dump", "zellij_list"]) {
  const before = messages.length;
  const paneId = await start();
  await call(tool, { pane_id: paneId, session: "test" });
  await sleep(1700);
  assert.equal(messages.length, before, `${tool}: consumed completion must not notify again`);
}

// Reading a running pane must not swallow its later completion.
const running = await start("test", false);
await call("zellij_dump", { pane_id: running, session: "test" });
await call("zellij_list", { session: "test" });
states.set(key(["--session", "test"], running), { exited: true, exit_status: 0 });
const beforeRunning = messages.length;
await sleep(1700);
assert.equal(messages.length, beforeRunning + 1);

// Consumption while the watcher is collecting evidence must still win.
let entered!: () => void;
let release!: () => void;
const collecting = new Promise<void>((resolve) => { entered = resolve; });
const blocked = new Promise<void>((resolve) => { release = resolve; });
evidenceHook = async () => { entered(); await blocked; };
const racing = await start();
await collecting;
const beforeRace = messages.length;
await call("zellij_dump", { pane_id: racing, session: "test" });
release();
await sleep(20);
evidenceHook = undefined;
assert.equal(messages.length, beforeRace, "consumed during evidence collection must not notify again");

// A different session can reuse a pane ID without consuming this watch.
const isolated = await start("watched");
states.set(key(["--session", "other"], isolated), { exited: true, exit_status: 0 });
const beforeIsolated = messages.length;
await call("zellij_dump", { pane_id: isolated, session: "other" });
await call("zellij_list", { session: "other" });
await sleep(1700);
assert.equal(messages.length, beforeIsolated + 1);
// Explicit and implicit references to the current session consume the same watch.
const currentSession = process.env.ZELLIJ_SESSION_NAME;
process.env.ZELLIJ_SESSION_NAME = "test";
const current = await start();
const beforeCurrent = messages.length;
await call("zellij_dump", { pane_id: current });
await sleep(1700);
assert.equal(messages.length, beforeCurrent);
if (currentSession === undefined) delete process.env.ZELLIJ_SESSION_NAME;
else process.env.ZELLIJ_SESSION_NAME = currentSession;
console.log("PASS: consumed dump/list, running panes, evidence race, and session isolation");
