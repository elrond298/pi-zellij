import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import ext from "../src/index.ts";

const session = `run-test-${Date.now() % 100000}`;
const counter = `/tmp/${session}-counter`;
const tools = new Map<string, any>();
const fakePi = {
  registerTool: (tool: any) => tools.set(tool.name, tool),
  registerCommand: () => {},
} as never;
ext(fakePi);
const run = tools.get("zellij_run");
let failures = 0;

function check(name: string, condition: boolean, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures++;
}

async function call(params: Record<string, unknown>, updates: string[] = []) {
  return run.execute(
    "run-test",
    { session, ...params },
    undefined,
    (partial: any) => updates.push(partial.content?.[0]?.text ?? ""),
    { cwd: process.cwd() },
  );
}

try {
  writeFileSync(counter, "");
  const updates: string[] = [];
  const result = await call(
    { command: `echo once >> ${counter}; echo STREAM_START; sleep 0.4; echo STREAM_END`, close_on_exit: true, timeout: 10 },
    updates,
  );
  const output = result.content?.[0]?.text ?? "";
  check("waited run returns output", output.includes("STREAM_START") && output.includes("STREAM_END"), output);
  check("waited run streams updates", updates.some((update) => update.includes("STREAM_START")), JSON.stringify(updates));
  check("waited run executes once", readFileSync(counter, "utf8").trim().split("\n").length === 1);
  check("explicit session is reported", result.details.session === session, JSON.stringify(result.details));
  check("successful exit is reported", result.details.exit_status === 0 && result.details.pane_closed === true, JSON.stringify(result.details));

  const [concurrentA, concurrentB] = await Promise.all([
    call({ command: "sleep 0.2; echo CONCURRENT_A", close_on_exit: true, timeout: 10 }),
    call({ command: "sleep 0.2; echo CONCURRENT_B", close_on_exit: true, timeout: 10 }),
  ]);
  check(
    "concurrent runs keep distinct panes and output",
    concurrentA.details.pane_id !== concurrentB.details.pane_id &&
      concurrentA.content?.[0]?.text.includes("CONCURRENT_A") &&
      !concurrentA.content?.[0]?.text.includes("CONCURRENT_B") &&
      concurrentB.content?.[0]?.text.includes("CONCURRENT_B") &&
      !concurrentB.content?.[0]?.text.includes("CONCURRENT_A"),
    JSON.stringify([concurrentA.details, concurrentB.details]),
  );

  let failure = "";
  try {
    await call({ command: "echo EXPECTED_FAILURE; exit 7", close_on_exit: true, timeout: 10 });
  } catch (error) {
    failure = String(error);
  }
  check("non-zero exit is a bash-style error", failure.includes("EXPECTED_FAILURE") && failure.includes("code 7"), failure);
  check("failed run identifies its pane", failure.includes("Zellij pane: terminal_"), failure);

  let timeout = "";
  try {
    await call({ command: "echo BEFORE_TIMEOUT; sleep 30", timeout: 0.3 });
  } catch (error) {
    timeout = String(error);
  }
  check("timeout reports partial output", timeout.includes("BEFORE_TIMEOUT") && timeout.includes("timed out"), timeout);
  const timedOutPane = timeout.match(/Zellij pane: (terminal_\d+)/)?.[1];
  const panes = JSON.parse(execFileSync("zellij", ["--session", session, "action", "list-panes", "--json"], { encoding: "utf8" }));
  check("timeout terminates its pane", !!timedOutPane && !panes.some((pane: any) => `terminal_${pane.id}` === timedOutPane), JSON.stringify(panes));

  const detached = await call({ command: "sleep 5", wait: "none", close_on_exit: true });
  check(
    "detached run targets explicit session",
    detached.details.waited === false && detached.details.session === session && String(detached.details.pane_id).startsWith("terminal_"),
    JSON.stringify(detached.details),
  );

  if (process.env.ZELLIJ_PANE_ID) {
    const listCurrent = () =>
      JSON.parse(execFileSync("zellij", ["action", "list-panes", "--json"], { encoding: "utf8" })) as any[];
    const beforePlacement = listCurrent();
    const piPane = beforePlacement.find((pane) => String(pane.id) === process.env.ZELLIJ_PANE_ID);
    const focusedBefore = beforePlacement.filter((pane) => pane.is_focused).map((pane) => pane.id).sort();
    const clientsBefore = execFileSync("zellij", ["action", "list-clients"], { encoding: "utf8" });
    let placedPane: string | undefined;
    try {
      const placed = await call({ command: "sleep 20", wait: "none", session: undefined });
      placedPane = placed.details.pane_id;
      const afterPlacement = listCurrent();
      const created = afterPlacement.find((pane) => `terminal_${pane.id}` === placedPane);
      const focusedAfter = afterPlacement.filter((pane) => pane.is_focused).map((pane) => pane.id).sort();
      check("default pane stays in Pi tab", created?.tab_id === piPane?.tab_id, JSON.stringify({ piPane, created }));
      check("default pane is floating", created?.is_floating === true, JSON.stringify(created));
      check("default pane preserves focus", JSON.stringify(focusedAfter) === JSON.stringify(focusedBefore), JSON.stringify({ focusedBefore, focusedAfter }));
    } finally {
      if (placedPane) execFileSync("zellij", ["action", "close-pane", "--pane-id", placedPane], { stdio: "ignore" });
      const clientsAfterClose = execFileSync("zellij", ["action", "list-clients"], { encoding: "utf8" });
      check("closing default pane preserves client focus", clientsAfterClose === clientsBefore, JSON.stringify({ clientsBefore, clientsAfterClose }));
    }
  }

  const earlyAbort = new AbortController();
  const earlyCancelledRun = run.execute(
    "run-early-cancel-test",
    { command: `echo should-not-run >> ${counter}`, session, timeout: 10 },
    earlyAbort.signal,
    () => {},
    { cwd: process.cwd() },
  );
  earlyAbort.abort();
  let earlyCancelled = "";
  try {
    await earlyCancelledRun;
  } catch (error) {
    earlyCancelled = String(error);
  }
  check(
    "abort during setup prevents command side effects",
    earlyCancelled.includes("aborted") && !readFileSync(counter, "utf8").includes("should-not-run"),
    earlyCancelled,
  );

  const controller = new AbortController();
  const cancelledRun = run.execute(
    "run-cancel-test",
    { command: "echo BEFORE_CANCEL; sleep 30", session, timeout: 10 },
    controller.signal,
    () => {},
    { cwd: process.cwd() },
  );
  setTimeout(() => controller.abort(), 300);
  let cancelled = "";
  try {
    await cancelledRun;
  } catch (error) {
    cancelled = String(error);
  }
  check("abort reports partial output", cancelled.includes("BEFORE_CANCEL") && cancelled.includes("aborted"), cancelled);
  const cancelledPane = cancelled.match(/Zellij pane: (terminal_\d+)/)?.[1];
  const afterCancel = JSON.parse(execFileSync("zellij", ["--session", session, "action", "list-panes", "--json"], { encoding: "utf8" }));
  check("abort terminates its pane", !!cancelledPane && !afterCancel.some((pane: any) => `terminal_${pane.id}` === cancelledPane), JSON.stringify(afterCancel));

  const tab = await call({ command: "echo TAB_OK", target: "tab", name: "run-test-tab", close_on_exit: true, timeout: 10 });
  check("target tab returns output and id", tab.content?.[0]?.text.includes("TAB_OK") && typeof tab.details.tab_id === "number", JSON.stringify(tab.details));
} finally {
  rmSync(counter, { force: true });
  try {
    execFileSync("zellij", ["kill-session", session], { stdio: "ignore" });
  } catch {}
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
