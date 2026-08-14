/**
 * Test /zellij-pi. Must run INSIDE a zellij pane (zellij sets ZELLIJ=0 there),
 * so `zellij action new-pane` targets the live session.
 * Run:  node --experimental-strip-types test/command-test.ts
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { default as ext } from "../src/index.ts";

const pexec = promisify(execFile);

const commands = new Map<string, { handler: Function; description?: string }>();
const fakePi: any = {
  registerTool: () => {},
  registerCommand: (name: string, def: any) => commands.set(name, def),
  exec: async (bin: string, args: string[], opts?: any) => {
    try {
      const { stdout, stderr } = await pexec(bin, args, { cwd: opts?.cwd });
      return { stdout: String(stdout), stderr: String(stderr), code: 0, killed: false };
    } catch (e: any) {
      return { stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? ""), code: e.code ?? 1, killed: false };
    }
  },
};

ext(fakePi);
const cmd = commands.get("zellij-pi");
if (!cmd) {
  console.log("FAIL  command not registered");
  process.exit(1);
}
if (!process.env.ZELLIJ) {
  console.log("SKIP  must run inside a zellij pane (ZELLIJ env unset)");
  process.exit(0);
}

let failures = 0;
const notifies: { level: string; msg: string }[] = [];
function fakeCtx(over: Record<string, unknown> = {}) {
  return {
    cwd: "/home/elrond",
    ui: {
      notify: (msg: string, level: string) => notifies.push({ level, msg }),
      select: async (_t: string, opts: string[]) => over.select ?? opts[0],
      input: async () => over.input ?? "zp-cmd-test",
      confirm: async () => over.confirm ?? true,
    },
    ...over,
  };
}
function check(name: string, cond: boolean, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}
async function listPanes() {
  const { execFileSync } = await import("node:child_process");
  return JSON.parse(execFileSync("zellij", ["action", "list-panes", "--json"], { encoding: "utf8" }));
}
async function closePane(id: number | string) {
  const { execFileSync } = await import("node:child_process");
  try {
    execFileSync("zellij", ["action", "close-pane", "--pane-id", String(id)], { stdio: "ignore" });
  } catch {}
}

// --- case 1: --cwd opens a new pane named pi with the given cwd -----------------
notifies.length = 0;
await cmd.handler("--cwd /tmp", fakeCtx());
check("cwd: notified success", notifies.some((n) => n.level === "info" && n.msg.includes("/tmp")), JSON.stringify(notifies));
let panes = await listPanes();
const cwdPane = panes.find((p: any) => p.title === "pi" && p.pane_cwd === "/tmp");
check("cwd: pi pane created with cwd /tmp", !!cwdPane, JSON.stringify((panes as any[]).map((p) => [p.id, p.title, p.pane_cwd])));
if (cwdPane) await closePane(cwdPane.id);

// --- case 2: --tab --workspace <new> creates workspace + opens a tab ------------
notifies.length = 0;
await cmd.handler("--tab --workspace zp-cmd-test", fakeCtx());
check("workspace: notified success", notifies.some((n) => n.level === "info" && n.msg.includes("zp-cmd-test")), JSON.stringify(notifies));
const { existsSync, readdirSync } = await import("node:fs");
const os = await import("node:os");
const path = await import("node:path");
const link = path.join(os.homedir(), "opt", "zp-cmd-test");
const real = path.join(os.homedir(), "WORK", "opt", "zp-cmd-test");
check("workspace: symlink created", existsSync(link) && existsSync(real), `${link} -> ${real}`);
check("workspace: jj repo initialized", existsSync(path.join(real, ".jj")) || readdirSync(real).includes(".jj"), "");
panes = await listPanes();
const wsPane = panes.find((p: any) => p.title === "pi" && p.pane_cwd?.includes("zp-cmd-test"));
check("workspace: pi pane in tab with workspace cwd", !!wsPane, JSON.stringify((panes as any[]).map((p) => [p.id, p.title, p.pane_cwd])));
if (wsPane) await closePane(wsPane.id);

// --- case 3: --workspace (no name) picks an existing workspace ------------------
notifies.length = 0;
await cmd.handler("--workspace", fakeCtx({ select: "pi-worktree (git)" }));
check("workspace pick: existing chosen", notifies.some((n) => n.level === "info" && n.msg.includes("pi-worktree")), JSON.stringify(notifies));
panes = await listPanes();
const pickPane = panes.find((p: any) => p.title === "pi" && p.pane_cwd?.includes("pi-worktree"));
if (pickPane) await closePane(pickPane.id);

// --- case 4: --workspace (no name) + create new --------------------------------
notifies.length = 0;
await cmd.handler("--workspace", fakeCtx({ select: "＋ create new workspace", input: "zp-cmd-test" }));
check("workspace create: reuses existing dir", notifies.some((n) => n.msg.includes("zp-cmd-test")), "");
panes = await listPanes();
const createPane = panes.find((p: any) => p.title === "pi" && p.pane_cwd?.includes("zp-cmd-test"));
if (createPane) await closePane(createPane.id);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
