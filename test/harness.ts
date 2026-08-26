/**
 * Test harness: loads the extension, captures registered tools via a fake pi,
 * and exercises each tool's execute() against a live zellij session.
 * Run:  node --experimental-strip-types test/harness.ts [session-name]
 */
import { default as ext } from "../src/index.ts";

// Fresh session per run: zellij resurrects killed sessions from its cache, so a fixed
// name accumulates panes across runs and the server slows down. Pass a name to override.
const SESSION = process.argv[2] ?? `tool-test-${Date.now() % 100000}`;

const tools = new Map<string, { execute: Function; parameters: unknown }>();
const fakePi = {
  registerTool: (def: { name: string; execute: Function; parameters: unknown }) =>
    tools.set(def.name, def),
  registerCommand: () => {},
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
async function callExpectError(name: string, params: Record<string, unknown>): Promise<boolean> {
  try {
    await call(name, params);
    return false; // no error thrown — failure
  } catch {
    return true;
  }
}

// --- session resolution: auto-create explicit session -----------------------
{
  const { details } = await call("zellij_list", { session: SESSION });
  check("session auto-created + list works", Array.isArray(details.panes), JSON.stringify(details.panes ?? []).slice(0, 120));
}

// --- zellij_run: basic run + exit code + output ------------------------------
{
  const r = await call("zellij_run", { command: "echo hello-from-tool", session: SESSION, timeout: 30 });
  check("run: exit code captured", r.details.exit_status === 0, `status=${r.details.exit_status}`);
  check("run: output captured", r.content.includes("hello-from-tool"), r.content.slice(0, 100));
  check("run: pane id", String(r.details.pane_id).startsWith("terminal_"), String(r.details.pane_id));
}

// --- zellij_run: close_on_exit preserves waited results and cleans up --------
{
  const r = await call("zellij_run", { command: "echo CLOSE_WAITED", close_on_exit: true, session: SESSION, timeout: 30 });
  const panes = await call("zellij_list", { session: SESSION });
  const gone = !(panes.details.panes as Array<{ id: string }>).some((p) => p.id === r.details.pane_id);
  check("run: close_on_exit keeps result", r.details.exit_status === 0 && r.content.includes("CLOSE_WAITED"), JSON.stringify(r.details));
  check("run: close_on_exit removes waited pane", r.details.pane_closed === true && gone, JSON.stringify(r.details));
}

// --- zellij_run: close_on_exit is native for detached commands ---------------
{
  const r = await call("zellij_run", { command: "sleep 0.5", wait: "none", close_on_exit: true, session: SESSION });
  const w = await call("zellij_wait", { pane_id: r.details.pane_id, for: "exit", timeout: 5, session: SESSION });
  check("run: close_on_exit removes detached pane", w.details.exited === true && w.details.removed_from_layout === true, JSON.stringify(w.details));
}

// --- zellij_run: non-zero exits use Pi bash error semantics ------------------
{
  const failed = await callExpectError("zellij_run", { command: "exit 1", session: SESSION, timeout: 30 });
  check("run: non-zero exit is an error", failed);
}

// --- zellij_run: wait=none returns immediately --------------------------------
{
  const start = Date.now();
  const r = await call("zellij_run", { command: "sleep 20", wait: "none", session: SESSION });
  const fast = Date.now() - start < 5000;
  check("run: wait=none immediate", fast && r.details.waited === false, `${Date.now() - start}ms`);
}

// --- zellij_run: timeout is a Pi bash-style error ---------------------------
{
  const timedOut = await callExpectError("zellij_run", { command: "sleep 30", timeout: 1, session: SESSION });
  check("run: timeout is an error", timedOut);
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

// --- display compression: blank runs + consecutive duplicates collapsed ----------
{
  const r = await call("zellij_run", { command: "printf 'A\\n\\n\\n\\nB\\nB\\nB\\nC\\n'", session: SESSION, timeout: 30 });
  const pid = r.details.pane_id as string;
  const d = await call("zellij_dump", { pane_id: pid, max_lines: 50, session: SESSION });
  check("dump: blank+dup lines collapsed", d.content.includes("A\n\nB\nC") && !d.content.includes("B\nB"), JSON.stringify(d.content.slice(0, 150)));
  // count is pty-dependent (zellij may coalesce blank rows); >= 3 proves both kinds collapsed
  check("dump: compression counted", (d.details.compressed_lines as number) >= 3, JSON.stringify(d.details));

  await call("zellij_close", { pane_id: pid, session: SESSION });
}

// --- matched-line display: very long lines capped in content, full in details ----
{
  const r = await call("zellij_run", { command: "printf 'X%.0s' $(seq 1 1000); echo; sleep 20", wait: "none", session: SESSION });
  const pid = r.details.pane_id as string;
  const w = await call("zellij_wait", { pane_id: pid, pattern: "XXXXXXXXXX", timeout: 10, session: SESSION });
  check("wait: long matched line capped in content", w.content.includes("line truncated") && (w.content.match(/X/g) ?? []).length <= 200, w.content.slice(0, 260));
  // long lines may be wrapped by the pty mid-dump; contract is: content capped, details carries more than the capped display
  check("wait: full line kept in details", String(w.details.line ?? "").length > 200, JSON.stringify(w.details.line ?? "").slice(0, 120));

  await call("zellij_close", { pane_id: pid, session: SESSION });
}


// --- zellij_run: target=tab ------------------------------------------------------
{
  const r = await call("zellij_run", { command: "echo TABRUN_OK", target: "tab", name: "harness-tab", session: SESSION, timeout: 30 });
  check("run in tab: exit code", r.details.exit_status === 0 && typeof r.details.tab_id === "number", JSON.stringify(r.details));
  check("run in tab: output", r.content.includes("TABRUN_OK"), r.content.slice(0, 120));
  const panes = await call("zellij_list", { session: SESSION });
  const p = (panes.details.panes as Array<{ id: string; tab_name: string | null }>).find((x) => x.id === r.details.pane_id);
  check("run in tab: pane lives in named tab", p?.tab_name === "harness-tab", JSON.stringify(p));
}

// --- zellij_wait for=exit, raw bytes, interactive-TUI flow ------------------------
{
  // wait on exit for a plain command pane
  const r = await call("zellij_run", { command: "sleep 3", wait: "none", session: SESSION });
  const pid = r.details.pane_id as string;
  const w = await call("zellij_wait", { pane_id: pid, for: "exit", timeout: 10, session: SESSION });
  check("wait exit: command pane exits with status", w.details.exited === true && w.details.exit_status === 0, JSON.stringify(w.details));
  await call("zellij_close", { pane_id: pid, session: SESSION });

  // raw bytes path (pty echoes what is written)
  const r2 = await call("zellij_run", { command: "sleep 10", wait: "none", session: SESSION });
  const pid2 = r2.details.pane_id as string;
  await call("zellij_send", { pane_id: pid2, raw: "echo RAW_BYTES_99\n", session: SESSION });
  const w2 = await call("zellij_wait", { pane_id: pid2, pattern: "RAW_BYTES_99", timeout: 5, session: SESSION });
  check("raw bytes: written and matched", w2.details.matched === true, JSON.stringify(w2.details));
  await call("zellij_close", { pane_id: pid2, session: SESSION });

  // full interactive-TUI flow in a tab: spawn top, exit-wait times out while running,
  // 'q' quits it, exit-wait fires, close (last pane of tab -> tab closes too)
  const r3 = await call("zellij_run", { command: "top", target: "tab", name: "tui-tab", wait: "none", session: SESSION });
  const pid3 = r3.details.pane_id as string;
  const w3 = await call("zellij_wait", { pane_id: pid3, for: "exit", timeout: 3, session: SESSION });
  check("tui: exit-wait times out while running", w3.details.exited === false, JSON.stringify(w3.details));
  await call("zellij_send", { pane_id: pid3, keys: ["q"], session: SESSION });
  const w4 = await call("zellij_wait", { pane_id: pid3, for: "exit", timeout: 10, session: SESSION });
  check("tui: exited after q", w4.details.exited === true, JSON.stringify(w4.details));
  await call("zellij_close", { pane_id: pid3, session: SESSION });
}

// --- principles: evidence on failure, terminal-state early return, idle wait ------
{
  // output-wait on a pane that exits mid-wait: must return early with the exit state, not burn the timeout
  const r = await call("zellij_run", { command: "sleep 1; echo BYE_NOW", wait: "none", session: SESSION });
  const pid = r.details.pane_id as string;
  const w = await call("zellij_wait", { pane_id: pid, pattern: "NEVER_MATCH_99", timeout: 20, session: SESSION });
  check(
    "wait output: pane exit returns early with state",
    w.details.matched === false && w.details.terminal === "exited" && w.details.exit_status === 0 && w.details.elapsed_ms < 10000,
    JSON.stringify(w.details),
  );
  await call("zellij_close", { pane_id: pid, session: SESSION });

  // output-wait timeout: evidence must be included
  const r2 = await call("zellij_run", { command: "echo EVIDENCE_LINE_77; sleep 15", wait: "none", session: SESSION });
  const pid2 = r2.details.pane_id as string;
  const w2 = await call("zellij_wait", { pane_id: pid2, pattern: "NEVER_MATCH_98", timeout: 2, session: SESSION });
  check(
    "wait output: timeout carries evidence",
    w2.details.matched === false && String(w2.details.evidence ?? "").includes("EVIDENCE_LINE_77"),
    JSON.stringify(w2.details).slice(0, 300),
  );
  await call("zellij_close", { pane_id: pid2, session: SESSION });

  // exit-wait timeout: evidence too
  const r2b = await call("zellij_run", { command: "echo EXIT_EVIDENCE_66; sleep 15", wait: "none", session: SESSION });
  const pid2b = r2b.details.pane_id as string;
  const w2b = await call("zellij_wait", { pane_id: pid2b, for: "exit", timeout: 2, session: SESSION });
  check(
    "wait exit: timeout carries evidence",
    w2b.details.exited === false && String(w2b.details.evidence ?? "").includes("EXIT_EVIDENCE_66"),
    JSON.stringify(w2b.details).slice(0, 300),
  );
  await call("zellij_close", { pane_id: pid2b, session: SESSION });

  // idle wait: settles after output stops (pane must stay alive past the settle window,
  // otherwise terminal:exited correctly wins the race)
  const r3 = await call("zellij_run", { command: "echo IDLE_FIRST; sleep 1; echo IDLE_LAST_66; sleep 30", wait: "none", session: SESSION });
  const pid3 = r3.details.pane_id as string;
  const w3 = await call("zellij_wait_idle", { pane_id: pid3, settle: 1, timeout: 15, session: SESSION });
  check(
    "wait idle: settles with evidence",
    w3.details.idle === true && String(w3.details.evidence ?? "").includes("IDLE_LAST_66"),
    JSON.stringify(w3.details).slice(0, 300),
  );
  await call("zellij_close", { pane_id: pid3, session: SESSION });

  // idle wait on a pane that exits while quiet: terminal state, not timeout
  const r3b = await call("zellij_run", { command: "sleep 3", wait: "none", session: SESSION });
  const pid3b = r3b.details.pane_id as string;
  const w3b = await call("zellij_wait_idle", { pane_id: pid3b, settle: 10, timeout: 15, session: SESSION });
  check(
    "wait idle: pane exit returns early",
    w3b.details.terminal === "exited" && w3b.details.exit_status === 0 && w3b.details.elapsed_ms < 10000,
    JSON.stringify(w3b.details),
  );
  await call("zellij_close", { pane_id: pid3b, session: SESSION });

  // run timeout: carries output so far
  let runTimeout = "";
  try {
    await call("zellij_run", { command: "echo RUN_EVIDENCE_55; sleep 20", timeout: 1, session: SESSION });
  } catch (error) {
    runTimeout = String(error);
  }
  check(
    "run timeout: carries output so far",
    runTimeout.includes("RUN_EVIDENCE_55") && runTimeout.includes("timed out"),
    runTimeout.slice(0, 300),
  );
}


// --- send to a nonexistent pane must throw, not claim success -----------------
{
  check("send: invalid pane throws", await callExpectError("zellij_send", { pane_id: "terminal_999999", text: "x", session: SESSION }));
}

// --- pre-aborted signal must not crash the wait (TDZ guard) -------------------
{
  const tool = tools.get("zellij_wait")!;
  const aborted = new AbortController();
  aborted.abort();
  const res = await tool.execute("test", { pane_id: "terminal_1", pattern: "NEVER", timeout: 5, session: SESSION }, aborted.signal);
  check("wait: pre-aborted signal returns timeout", res.details?.matched === false, JSON.stringify(res.details ?? {}).slice(0, 200));
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
