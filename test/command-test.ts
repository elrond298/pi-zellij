/**
 * Test slash commands. Must run INSIDE a zellij pane (zellij sets ZELLIJ=0 there),
 * so `zellij action new-pane` targets the live session.
 * Run:  node --experimental-strip-types test/command-test.ts
 */
import { execFile, execFileSync as execFs } from "node:child_process";
import { promisify } from "node:util";
import { default as ext } from "../src/index.ts";

const pexec = promisify(execFile);

const tools = new Map<string, any>();
const commands = new Map<string, { handler: Function; description?: string }>();
const fakePi: any = {
  registerTool: (def: any) => tools.set(def.name, def),
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
const runTool = tools.get("zellij_run");
const cmd = commands.get("zellij-pi");
const psCmd = commands.get("zellij-ps");
if (!runTool || !cmd || !psCmd) {
  console.log("FAIL  commands not registered");
  process.exit(1);
}
if (!process.env.ZELLIJ) {
  console.log("SKIP  must run inside a zellij pane (ZELLIJ env unset)");
  process.exit(0);
}

const HOME = "/home/elrond";
const PROJ = "pi-zellij"; // repo at ctx.cwd (jj colocated)
const WS = "zp-cmd-test";
const wsDir = `${HOME}/.worktrees/${PROJ}/${WS}`;

let failures = 0;
const notifies: { level: string; msg: string }[] = [];
function fakeCtx(over: Record<string, unknown> = {}) {
  return {
    cwd: `${HOME}/opt/${PROJ}`, // inside the pi-zellij repo
    ui: {
      notify: (msg: string, level: string) => notifies.push({ level, msg }),
      select: async (title: string, opts: string[]) =>
        typeof over.select === "function" ? (over.select as Function)(title, opts) : (over.select ?? opts[0]),
      custom: async (factory: Function) => {
        let result: unknown = null;
        let doneCalled = false;
        const component = factory(
          { requestRender() {} },
          { fg: (_color: string, text: string) => text, bold: (text: string) => text },
          {},
          (value: unknown) => { result = value; doneCalled = true; },
        );
        if (typeof over.onCustom === "function") (over.onCustom as Function)();
        const keys = Array.isArray(over.keys) ? over.keys : [over.key ?? "\r"];
        for (const key of keys) {
          if (typeof over.onRender === "function") (over.onRender as Function)(component.render(120));
          component.handleInput(String(key));
          await new Promise((resolve) => setTimeout(resolve, 100));
          if (doneCalled) break;
        }
        return result;
      },
      input: async () => over.input ?? WS,
      confirm: async (title: string, message: string) =>
        typeof over.confirm === "function" ? (over.confirm as Function)(title, message) : (over.confirm ?? true),
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
function jj(args: string[]) {
  try {
    return execFs("jj", args, { cwd: `${HOME}/opt/${PROJ}`, encoding: "utf8" });
  } catch (e: any) {
    return `ERR ${e.stderr ?? ""}`;
  }
}

// --- /zellij-ps shows panes, focuses on enter, closes on x ----------------------
const psContext = (paneIds: string[], over: Record<string, unknown> = {}) =>
  fakeCtx({
    ...over,
    sessionManager: {
      getBranch: () => paneIds.map((paneId) => ({
        type: "message",
        message: { role: "toolResult", toolName: "zellij_run", details: { pane_id: paneId, session: null } },
      })),
    },
  });
const paneExists = async (paneId: string) => (await listPanes()).some((pane: any) => `terminal_${pane.id}` === paneId);

const runningResult = await runTool.execute(
  "ps-command-test",
  { command: "sleep 20", wait: "none", name: "ps-command-test" },
  undefined,
  () => {},
  { cwd: `${HOME}/opt/${PROJ}` },
);
let runningPane = String(runningResult.details.pane_id);
let exitedPane = "";
let secondExitedPane = "";
try {
  let rendered: string[] = [];
  await psCmd.handler("", psContext([], { onRender: (lines: string[]) => { rendered = lines; } }));
  check("zellij-ps: active pane listed before tool result", rendered.some((line) => line.includes(`${runningPane}`) && line.includes("running") && line.includes("ps-command-test")), JSON.stringify(rendered));
  const clients = execFs("zellij", ["action", "list-clients"], { encoding: "utf8" });
  check("zellij-ps: enter focuses pane", clients.includes(runningPane), clients);

  let confirmationRendered = false;
  await psCmd.handler("", psContext([runningPane], {
    keys: ["x", "\x1b", "\x1b"],
    onRender: (lines: string[]) => {
      if (lines.some((line) => line.includes(`Close running pane ${runningPane}?`))) confirmationRendered = true;
    },
  }));
  check("zellij-ps: running close asks confirmation", confirmationRendered && await paneExists(runningPane));

  await psCmd.handler("", psContext([runningPane], { keys: ["x", "y"] }));
  check("zellij-ps: confirmed running pane closed", !await paneExists(runningPane));
  runningPane = "";

  exitedPane = execFs(
    "zellij",
    ["action", "new-pane", "--floating", "--no-focus", "--name", "ps-exited-test", "--", "sh", "-c", "exit 7"],
    { encoding: "utf8" },
  ).trim();
  secondExitedPane = execFs(
    "zellij",
    ["action", "new-pane", "--floating", "--no-focus", "--name", "ps-exited-test-2", "--", "sh", "-c", "exit 8"],
    { encoding: "utf8" },
  ).trim();
  await new Promise((resolve) => setTimeout(resolve, 200));
  let pickerDisplays = 0;
  const pickerFrames: string[][] = [];
  await psCmd.handler("", psContext([exitedPane, secondExitedPane], {
    keys: ["x", "\x1b"],
    onCustom: () => { pickerDisplays++; },
    onRender: (lines: string[]) => { pickerFrames.push(lines); },
  }));
  const firstExists = await paneExists(exitedPane);
  const secondExists = await paneExists(secondExitedPane);
  const exitedRemaining = Number(firstExists) + Number(secondExists);
  const remainingPane = firstExists ? exitedPane : secondExitedPane;
  const closedPane = firstExists ? secondExitedPane : exitedPane;
  const finalFrame = pickerFrames.at(-1) ?? [];
  check("zellij-ps: exited pane closes directly", exitedRemaining === 1);
  check(
    "zellij-ps: picker updates in place after close",
    pickerDisplays === 1 && finalFrame.some((line) => line.includes(remainingPane)) && !finalFrame.some((line) => line.includes(closedPane)),
    `opened ${pickerDisplays} times`,
  );
} finally {
  if (runningPane) await closePane(runningPane);
  if (exitedPane) await closePane(exitedPane);
  if (secondExitedPane) await closePane(secondExitedPane);
}

// --- case 1: --cwd opens a new pane named pi with the given cwd -----------------
notifies.length = 0;
await cmd.handler("--cwd /tmp", fakeCtx());
check("cwd: notified success", notifies.some((n) => n.level === "info" && n.msg.includes("/tmp")), JSON.stringify(notifies));
let panes = await listPanes();
const cwdPane = panes.find((p: any) => p.title === "pi" && p.pane_cwd === "/tmp");
check("cwd: pi pane created with cwd /tmp", !!cwdPane, JSON.stringify((panes as any[]).map((p) => [p.id, p.title, p.pane_cwd])));
if (cwdPane) await closePane(cwdPane.id);

// --- case 2: --tab --workspace <new> creates a jj workspace + opens a tab --------
notifies.length = 0;
await cmd.handler(`--tab --workspace ${WS}`, fakeCtx());
check("workspace: notified success", notifies.some((n) => n.level === "info" && n.msg.includes(wsDir)), JSON.stringify(notifies));
const { existsSync } = await import("node:fs");
check("workspace: dir created", existsSync(wsDir), wsDir);
check("workspace: jj workspace registered", jj(["workspace", "list"]).includes(`.worktrees/${PROJ}/${WS}`), jj(["workspace", "list"]).slice(0, 120));
panes = await listPanes();
const wsPane = panes.find((p: any) => p.title === "pi" && p.pane_cwd?.includes(WS));
check("workspace: pi pane in tab with workspace cwd", !!wsPane, JSON.stringify((panes as any[]).map((p) => [p.id, p.title, p.pane_cwd])));
if (wsPane) await closePane(wsPane.id);

// --- case 3: --workspace (no name) picks an existing workspace -------------------
notifies.length = 0;
await cmd.handler("--workspace", fakeCtx({ select: `${PROJ}/${WS} (jj)` }));
check("workspace pick: existing chosen", notifies.some((n) => n.level === "info" && n.msg.includes(wsDir)), JSON.stringify(notifies));
panes = await listPanes();
const pickPane = panes.find((p: any) => p.title === "pi" && p.pane_cwd?.includes(WS));
if (pickPane) await closePane(pickPane.id);

// --- case 4: --workspace (no name) + create new reuses existing dir --------------
notifies.length = 0;
await cmd.handler("--workspace", fakeCtx({ select: "＋ create new workspace", input: WS }));
check("workspace create: reuses existing dir", notifies.some((n) => n.msg.includes(wsDir)), "");
panes = await listPanes();
const createPane = panes.find((p: any) => p.title === "pi" && p.pane_cwd?.includes(WS));
if (createPane) await closePane(createPane.id);

// --- case 5: explicit project/ws slash syntax ------------------------------------
notifies.length = 0;
await cmd.handler(`--workspace ${PROJ}/${WS}`, fakeCtx());
check("workspace slash: existing resolved", notifies.some((n) => n.level === "info" && n.msg.includes(wsDir)), JSON.stringify(notifies));
panes = await listPanes();
const slashPane = panes.find((p: any) => p.title === "pi" && p.pane_cwd?.includes(WS));
if (slashPane) await closePane(slashPane.id);
// --- case 6a: .. segments are rejected -----------------------------------------
notifies.length = 0;
await cmd.handler("--workspace ../evil", fakeCtx());
check(
  "workspace: .. rejected",
  notifies.some((n) => n.level === "error" && n.msg.includes("..")),
  JSON.stringify(notifies),
);
panes = await listPanes();
if (panes.some((p: any) => p.title === "pi")) {
  check("workspace: no pane opened for ..", false, "a pi pane was opened despite rejection");
}

// --- case 6: git repo → git worktree add ----------------------------------------
const GIT_REPO = "/tmp/zp-git-test";
execFs("rm", ["-rf", GIT_REPO]);
execFs("git", ["init", "-q", GIT_REPO]);
execFs("git", ["-C", GIT_REPO, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]);
notifies.length = 0;
await cmd.handler(`--workspace ${WS}`, fakeCtx({ cwd: GIT_REPO }));
check("git ws: notified success", notifies.some((n) => n.level === "info" && n.msg.includes("zp-git-test")), JSON.stringify(notifies));
const gitWsDir = `${HOME}/.worktrees/zp-git-test/${WS}`;
check("git ws: dir created", existsSync(gitWsDir), gitWsDir);
check(
  "git ws: worktree registered",
  execFs("git", ["-C", GIT_REPO, "worktree", "list"], { encoding: "utf8" }).includes(gitWsDir),
  execFs("git", ["-C", GIT_REPO, "worktree", "list"], { encoding: "utf8" }).slice(0, 120),
);
panes = await listPanes();
const gitPane = panes.find((p: any) => p.title === "pi" && p.pane_cwd?.includes(gitWsDir));
check("git ws: pi pane with worktree cwd", !!gitPane, JSON.stringify((panes as any[]).map((p) => [p.id, p.title, p.pane_cwd])));
if (gitPane) await closePane(gitPane.id);
// cleanup git repo
try {
  execFs("git", ["-C", GIT_REPO, "worktree", "remove", gitWsDir]);
  execFs("git", ["-C", GIT_REPO, "branch", "-D", WS]);
} catch {}
execFs("rm", ["-rf", GIT_REPO, gitWsDir]);
// --- cleanup: forget the jj workspace (by name) and remove the dir ----------------
console.log("cleanup:", jj(["workspace", "forget", WS]).slice(0, 80));
const { execFileSync } = await import("node:child_process");
try {
  execFileSync("rm", ["-rf", wsDir]);
} catch {}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
