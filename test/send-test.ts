/**
 * zellij_send wait_for: send + wait in one call. pattern matches only NEW
 * output since a pre-send baseline (stale on-screen text never matches), idle
 * settles, exit reports the exit status. Run:
 *   node --experimental-strip-types test/send-test.ts
 */
import { execFileSync } from "node:child_process";
import ext from "../src/index.ts";

const session = `send-test-${Date.now() % 100000}`;
const tools = new Map<string, any>();
const fakePi = {
  registerTool: (tool: any) => tools.set(tool.name, tool),
  registerCommand: () => {},
} as never;
ext(fakePi);
let failures = 0;

function check(name: string, condition: boolean, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures++;
}

async function call(name: string, params: Record<string, unknown>) {
  const res = await (tools.get(name) as any).execute("send-test", { session, ...params }, undefined);
  return { content: res.content?.[0]?.text ?? "", details: res.details ?? {} };
}

const panes: string[] = [];
try {
  // --- pattern: matches output produced by the send ---------------------------
  {
    const run = await call("zellij_run", { command: "echo STALE_MARKER; cat", wait: "none" });
    const paneId: string = run.details.pane_id;
    panes.push(paneId);
    const res = await call("zellij_send", { pane_id: paneId, text: "fresh-input", wait_for: "pattern", pattern: "fresh-input", timeout: 15 });
    check("send+pattern matches new output", res.details.matched === true, res.content.slice(0, 100));

    // --- pattern: stale on-screen text must NOT match -------------------------
    const stale = await call("zellij_send", { pane_id: paneId, keys: ["a"], wait_for: "pattern", pattern: "fresh-input", timeout: 3 });
    check("stale on-screen text does not match", stale.details.matched === false && stale.details.timed_out === true, stale.content.slice(0, 100));

    // --- idle: settles after the echo ----------------------------------------
    const idle = await call("zellij_send", { pane_id: paneId, keys: ["b"], wait_for: "idle", settle: 1, timeout: 15 });
    check("send+idle settles", idle.details.idle === true, idle.content.slice(0, 100));
  }

  // --- exit: reports the exit status after the send ---------------------------
  {
    const run = await call("zellij_run", { command: "read x; exit 7", wait: "none" });
    const paneId: string = run.details.pane_id;
    panes.push(paneId);
    const res = await call("zellij_send", { pane_id: paneId, text: "go", wait_for: "exit", timeout: 15 });
    check("send+exit reports exit status", res.details.exited === true && res.details.exit_status === 7, res.content.slice(0, 100));
  }

  // --- pattern when the pane exits without matching: exit state + evidence ----
  {
    const run = await call("zellij_run", { command: "read x; echo BYE_LINE; exit 3", wait: "none" });
    const paneId: string = run.details.pane_id;
    panes.push(paneId);
    const res = await call("zellij_send", { pane_id: paneId, text: "go", wait_for: "pattern", pattern: "NEVER_APPEARS", timeout: 15 });
    check(
      "send+pattern on exit reports exit, not timeout",
      res.details.matched === false && res.details.terminal === "exited" && res.details.exit_status === 3,
      res.content.slice(0, 120),
    );
    check("exit evidence carries last output", (res.details.evidence ?? "").includes("BYE_LINE") || res.content.includes("BYE_LINE"));
  }

  // --- validation --------------------------------------------------------------
  {
    let threw = false;
    try {
      await call("zellij_send", { pane_id: panes[0], text: "x", wait_for: "pattern" });
    } catch {
      threw = true;
    }
    check("wait_for=pattern without pattern throws", threw);
  }
} finally {
  for (const paneId of panes) {
    try {
      await call("zellij_close", { pane_id: paneId });
    } catch {}
  }
  try {
    execFileSync("zellij", ["kill-session", session], { stdio: "ignore" });
  } catch {}
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
