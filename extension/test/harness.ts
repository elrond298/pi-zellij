/**
 * Test harness: loads the extension, captures registered tools via a fake pi,
 * and exercises each tool's execute() against a live zellij session.
 * Run:  node --experimental-strip-types test/harness.ts [session-name]
 */
import { default as ext } from "../src/index.ts";

const SESSION = process.argv[2] ?? "tool-test";

const tools = new Map<string, { execute: Function; parameters: unknown }>();
const fakePi = {
  registerTool: (def: { name: string; execute: Function; parameters: unknown }) =>
    tools.set(def.name, def),
} as never;

ext(fakePi as never);
console.log(`loaded tools: ${[...tools.keys()].join(", ")}`);

let failures = 0;
function check(name: string, cond: boolean, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}

async function call(name: string, params: Record<string, unknown>) {
  const tool = tools.get(name)!;
  const res = await tool.execute("test", params, undefined);
  return { content: res.content?.[0]?.text ?? "", details: res.details ?? {} };
}

// --- session resolution: auto-create explicit session -----------------------
{
  const { details } = await call("zellij_list", { session: SESSION });
  check("session auto-created + list works", Array.isArray(details.panes), JSON.stringify(details.panes ?? []).slice(0, 120));
}

// --- zellij_run: basic run + exit code + output ------------------------------
{
  const r = await call("zellij_run", { command: "echo hello-from-tool; exit 3", session: SESSION, timeout: 30 });
  check("run: exit code captured", r.details.exit_status === 3, `status=${r.details.exit_status}`);
  check("run: output captured", r.content.includes("hello-from-tool"), r.content.slice(0, 100));
  check("run: pane id", String(r.details.pane_id).startsWith("terminal_"), String(r.details.pane_id));
}

// --- zellij_run: wait=exit-success with failing command ----------------------
{
  const r = await call("zellij_run", { command: "exit 1", wait: "exit-success", session: SESSION, timeout: 30 });
  check("run: exit-success NOT met", r.content.includes("NOT met") && r.details.exit_status === 1, r.content.slice(0, 100));
}

// --- zellij_run: wait=none returns immediately --------------------------------
{
  const start = Date.now();
  const r = await call("zellij_run", { command: "sleep 20", wait: "none", session: SESSION });
  const fast = Date.now() - start < 5000;
  check("run: wait=none immediate", fast && r.details.waited === false, `${Date.now() - start}ms`);
}

// --- zellij_run: timeout returns partial results ------------------------------
{
  const r = await call("zellij_run", { command: "sleep 30", timeout: 3, session: SESSION });
  check("run: timeout returns partial", r.details.timed_out === true, JSON.stringify(r.details));
}

// --- zellij_send + zellij_wait (live pattern) ---------------------------------
{
  const r = await call("zellij_run", { command: "sleep 20", wait: "none", name: "interactive", session: SESSION });
  const pid = r.details.pane_id as string;
  await call("zellij_send", { pane_id: pid, text: "echo FRESH_PATTERN_42", session: SESSION });
  const w = await call("zellij_wait", { pane_id: pid, pattern: "FRESH_PATTERN_42", timeout: 10, session: SESSION });
  check("wait: live pattern matched", w.details.matched === true, JSON.stringify(w.details));

  // live subscribe path: pattern appears AFTER the wait starts (1s delay)
  const pending = call("zellij_wait", { pane_id: pid, pattern: "LIVE_AFTER_WAIT_77", timeout: 10, session: SESSION });
  await new Promise((r) => setTimeout(r, 1000));
  await call("zellij_send", { pane_id: pid, text: "echo LIVE_AFTER_WAIT_77", session: SESSION });
  const w3 = await pending;
  check("wait: live subscribe path", w3.details.matched === true && w3.details.elapsed_ms > 0, JSON.stringify(w3.details));
  // wait timeout path
  const w2 = await call("zellij_wait", { pane_id: pid, pattern: "NEVER_SHOWN_99", timeout: 2, session: SESSION });
  check("wait: timeout path", w2.details.matched === false, JSON.stringify(w2.details));

  // dump sees the output
  const d = await call("zellij_dump", { pane_id: pid, session: SESSION });
  check("dump: contains output", d.content.includes("FRESH_PATTERN_42"), d.content.slice(0, 120));

  // close the interactive pane
  await call("zellij_close", { pane_id: pid, session: SESSION });
  const after = await call("zellij_list", { session: SESSION });
  const gone = !(after.details.panes as Array<{ id: string }>).some((p) => p.id === pid);
  check("close: pane removed", gone, JSON.stringify(after.details.panes ?? []));
}

// --- zellij_list: tabs resource ------------------------------------------------
{
  const r = await call("zellij_list", { resource: "tabs", session: SESSION });
  check("list tabs", r.content.includes("tab "), r.content.slice(0, 100));
}

// --- zellij_list: sessions resource --------------------------------------------
{
  const r = await call("zellij_list", { resource: "sessions", session: SESSION });
  check("list sessions", r.details.sessions?.includes(SESSION), JSON.stringify(r.details.sessions));
}

// --- tail behavior: capped dumps keep the tail, not the head --------------------
{
  const r = await call("zellij_run", { command: "seq 1 60", session: SESSION, timeout: 30 });
  const pid = r.details.pane_id as string;

  const tail = await call("zellij_dump", { pane_id: pid, max_lines: 10, session: SESSION });
  check("dump: tail kept when capped", tail.content.includes("60") && !tail.content.includes("1\n2"), tail.content.slice(0, 150));

  const head = await call("zellij_dump", { pane_id: pid, max_lines: 10, tail: false, session: SESSION });
  check("dump: head when tail=false", head.content.includes("1") && !head.content.includes("60"), head.content.slice(0, 150));

  await call("zellij_close", { pane_id: pid, session: SESSION });
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
