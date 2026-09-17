/**
 * notify_on_exit: zellij_run wait=none signals the agent when the command exits
 * (exit status + last output via pi.sendMessage followUp), and the signal is
 * suppressed when the agent already learned the exit from zellij_close or
 * zellij_wait. Run:  node --experimental-strip-types test/notify-test.ts
 */
import { execFileSync } from "node:child_process";
import ext from "../src/index.ts";

const session = `notify-test-${Date.now() % 100000}`;
const tools = new Map<string, any>();
const sent: Array<{ msg: any; opts: any }> = [];
const fakePi = {
  registerTool: (tool: any) => tools.set(tool.name, tool),
  registerCommand: () => {},
  sendMessage: (msg: any, opts: any) => sent.push({ msg, opts }),
} as never;
ext(fakePi);
const run = tools.get("zellij_run");
const wait = tools.get("zellij_wait");
const close = tools.get("zellij_close");
let failures = 0;

function check(name: string, condition: boolean, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures++;
}

async function call(name: string, params: Record<string, unknown>) {
  const res = await (tools.get(name) as any).execute("notify-test", { session, ...params }, undefined);
  return { content: res.content?.[0]?.text ?? "", details: res.details ?? {} };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

try {
  // --- notify fires: exit status + output tail + followUp/triggerTurn ----------
  {
    const { details } = await call("zellij_run", { command: "echo hello-exit", wait: "none", notify_on_exit: true, name: "notify-fire" });
    const paneId: string = details.pane_id;
    let signal: (typeof sent)[number] | undefined;
    for (let i = 0; i < 40 && !signal; i++) {
      await sleep(250);
      signal = sent.find((s) => s.msg.content?.includes(paneId));
    }
    check("notification fires for exited command", !!signal, signal?.msg.content?.slice(0, 120) ?? "none within 10s");
    check("notification carries exit status 0", signal?.msg.content.includes("with status 0") ?? false);
    check("notification carries last output", signal?.msg.content.includes("hello-exit") ?? false);
    check("notification wakes the agent", signal?.opts?.deliverAs === "followUp" && signal?.opts?.triggerTurn === true, JSON.stringify(signal?.opts));
    await call("zellij_close", { pane_id: paneId });
  }

  // --- suppression: zellij_close means the agent already knows ----------------
  {
    sent.length = 0;
    const { details } = await call("zellij_run", { command: "sleep 30", wait: "none", notify_on_exit: true });
    const paneId: string = details.pane_id;
    await call("zellij_close", { pane_id: paneId });
    await sleep(3500); // watcher polls at 1s, holds 500ms, then skips if consumed
    check("zellij_close suppresses the notification", !sent.some((s) => s.msg.content?.includes(paneId)), JSON.stringify(sent.map((s) => s.msg.content?.slice(0, 60))));
  }

  // --- suppression: zellij_wait for=exit reports it first ---------------------
  {
    sent.length = 0;
    const { details } = await call("zellij_run", { command: "sleep 2", wait: "none", notify_on_exit: true });
    const paneId: string = details.pane_id;
    const waited = await call("zellij_wait", { pane_id: paneId, for: "exit", timeout: 20 });
    check("zellij_wait for=exit observes the exit", waited.details.exited === true, waited.content.slice(0, 80));
    await sleep(3500);
    check("zellij_wait suppresses the notification", !sent.some((s) => s.msg.content?.includes(paneId)), JSON.stringify(sent.map((s) => s.msg.content?.slice(0, 60))));
    await call("zellij_close", { pane_id: paneId });
  }
} finally {
  try {
    execFileSync("zellij", ["kill-session", session], { stdio: "ignore" });
  } catch {}
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
