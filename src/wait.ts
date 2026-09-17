/**
 * Output waits: pattern matching and idle/settle detection via zellij subscribe.
 * Both resolve early on a terminal pane state and report the state to the caller.
 */
import { spawn } from "node:child_process";
import { paneExitState } from "./cli.ts";
import { dumpPane } from "./output.ts";

export type WaitOutcome = {
  status: "matched" | "idle" | "timeout" | "exited";
  line?: string;
  elapsedMs: number;
  exit_status: number | null;
  removed: boolean;
};

/**
 * Subscribe to a pane's output; resolve on first matching line, on the pane
 * reaching a terminal state (process exited / pane closed), or on timeout.
 * The caller gets the terminal state so a failed match is immediately diagnosable.
 */
/**
 * Subscribe to a pane's output; resolve on first matching line, on the pane
 * reaching a terminal state (process exited / pane closed), or on timeout.
 * The caller gets the terminal state so a failed match is immediately diagnosable.
 */
export async function waitForPattern(
  paneId: string,
  pattern: string,
  regex: boolean,
  timeoutMs: number,
  sessionArgs: string[],
  signal?: AbortSignal,
): Promise<WaitOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn("zellij", [...sessionArgs, "subscribe", "--pane-id", paneId], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buf = "";
    let done = false;
    // Declared before finish so a pre-aborted signal can't hit a TDZ ReferenceError.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let watchdog: ReturnType<typeof setInterval> | undefined;

    const finish = (outcome: WaitOutcome) => {
      if (done) return;
      done = true;
      if (watchdog) clearInterval(watchdog);
      if (timer) clearTimeout(timer);
      child.kill("SIGKILL");
      resolve(outcome);
    };

    const start = Date.now();
    timer = setTimeout(
      () => finish({ status: "timeout", elapsedMs: Date.now() - start, exit_status: null, removed: false }),
      timeoutMs,
    );
    const onAbort = () =>
      finish({ status: "timeout", elapsedMs: Date.now() - start, exit_status: null, removed: false });
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });

    // Terminal-state watchdog: if the pane's process exits while we wait for output,
    // return that state instead of burning the full timeout.
    watchdog = setInterval(async () => {
      if (done) return;
      const st = await paneExitState(sessionArgs, paneId);
      if (st?.exited) {
        signal?.removeEventListener("abort", onAbort);
        finish({
          status: "exited",
          elapsedMs: Date.now() - start,
          exit_status: st.exit_status,
          removed: st.removed,
        });
      }
    }, 500);
    child.stdout.on("data", (d) => {
      buf += d;
      let line: string;
      while ((line = buf.split("\n", 1)[0], buf.includes("\n"))) {
        buf = buf.slice(line.length + 1);
        const hit = regex ? new RegExp(pattern).test(line) : line.includes(pattern);
        if (hit) {
          signal?.removeEventListener("abort", onAbort);
          finish({ status: "matched", line: line.trim(), elapsedMs: Date.now() - start, exit_status: null, removed: false });
          return;
        }
      }
    });
    child.on("error", (err) => {
      // spawn failure (e.g. binary missing) — a real error, not a timeout
      signal?.removeEventListener("abort", onAbort);
      child.kill("SIGKILL");
      done = true;
      reject(new Error(`zellij subscribe failed: ${err.message}`));
    });
    child.on("close", async () => {
      // subscriber exited (e.g. pane closed) — flush remaining buffer
      if (!done && buf.trim()) {
        const hit = regex ? new RegExp(pattern).test(buf) : buf.includes(pattern);
        if (hit) finish({ status: "matched", line: buf.trim(), elapsedMs: Date.now() - start, exit_status: null, removed: false });
      }
      if (!done) {
        const st = await paneExitState(sessionArgs, paneId);
        if (st?.exited) {
          finish({ status: "exited", elapsedMs: Date.now() - start, exit_status: st.exit_status, removed: st.removed });
        } else {
          finish({ status: "timeout", elapsedMs: Date.now() - start, exit_status: null, removed: false });
        }
      }
    });
  });
}

/**
 * Subscribe to a pane's output and resolve once the pane has produced no new
 * output for `settleMs` ("wait for stability"), or when its process exits,
 * or on timeout.
 */
/**
 * Subscribe to a pane's output and resolve once the pane has produced no new
 * output for `settleMs` ("wait for stability"), or when its process exits,
 * or on timeout.
 */
export async function waitForIdle(
  paneId: string,
  settleMs: number,
  timeoutMs: number,
  sessionArgs: string[],
  signal?: AbortSignal,
): Promise<WaitOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn("zellij", [...sessionArgs, "subscribe", "--pane-id", paneId, "--format", "json"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let done = false;
    let buf = "";
    let snapshot: string | undefined;
    let lastChange = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let watchdog: ReturnType<typeof setInterval> | undefined;

    const finish = (outcome: WaitOutcome) => {
      if (done) return;
      done = true;
      if (watchdog) clearInterval(watchdog);
      if (timer) clearTimeout(timer);
      child.kill("SIGKILL");
      resolve(outcome);
    };

    const start = Date.now();
    timer = setTimeout(
      () => finish({ status: "timeout", elapsedMs: Date.now() - start, exit_status: null, removed: false }),
      timeoutMs,
    );
    const onAbort = () =>
      finish({ status: "timeout", elapsedMs: Date.now() - start, exit_status: null, removed: false });
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });

    watchdog = setInterval(async () => {
      if (done) return;
      const st = await paneExitState(sessionArgs, paneId);
      if (st?.exited) {
        signal?.removeEventListener("abort", onAbort);
        finish({
          status: "exited",
          elapsedMs: Date.now() - start,
          exit_status: st.exit_status,
          removed: st.removed,
        });
        return;
      }
      if (Date.now() - lastChange >= settleMs) {
        signal?.removeEventListener("abort", onAbort);
        finish({ status: "idle", elapsedMs: Date.now() - start, exit_status: null, removed: false });
      }
    }, 200);

    child.stdout.on("data", (d) => {
      buf += d;
      for (let newline; (newline = buf.indexOf("\n")) !== -1; ) {
        const line = buf.slice(0, newline);
        buf = buf.slice(newline + 1);
        try {
          const update = JSON.parse(line);
          if (update.event !== "pane_update" || !Array.isArray(update.viewport)) continue;
          const next = JSON.stringify([update.viewport, update.scrollback]);
          if (snapshot !== undefined && next !== snapshot) lastChange = Date.now();
          snapshot = next;
        } catch {}
      }
    });
    child.on("error", (err) => {
      signal?.removeEventListener("abort", onAbort);
      child.kill("SIGKILL");
      done = true;
      reject(new Error(`zellij subscribe failed: ${err.message}`));
    });
    child.on("close", async () => {
      if (!done) {
        // subscriber died (pane closed or server hiccup) — prefer a terminal state
        const st = await paneExitState(sessionArgs, paneId);
        if (st?.exited) {
          finish({ status: "exited", elapsedMs: Date.now() - start, exit_status: st.exit_status, removed: st.removed });
        } else {
          finish({ status: "timeout", elapsedMs: Date.now() - start, exit_status: null, removed: false });
        }
      }
    });
  });
}

export type PaneExitOutcome = {
  exited: boolean;
  exit_status: number | null;
  removed: boolean;
  elapsed_ms: number;
};

/**
 * Poll until the pane's process exits, the pane disappears from the layout,
 * or the timeout hits. Shared by zellij_wait for=exit and zellij_send wait_for=exit.
 */
export async function waitForPaneExit(
  paneId: string,
  timeoutMs: number,
  sessionArgs: string[],
  signal?: AbortSignal,
): Promise<PaneExitOutcome> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const state = await paneExitState(sessionArgs, paneId);
    if (state?.exited) {
      return { exited: true, exit_status: state.exit_status, removed: state.removed, elapsed_ms: Date.now() - started };
    }
    if (signal?.aborted) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  return { exited: false, exit_status: null, removed: false, elapsed_ms: Date.now() - started };
}

export type NewPatternOutcome =
  | { status: "matched"; line: string; elapsedMs: number }
  | { status: "timeout"; elapsedMs: number }
  | { status: "exited"; elapsedMs: number; exit_status: number | null; removed: boolean };

/**
 * Wait for a pattern in output that is NEW since `baseline` — a full dump captured
 * just before the keystrokes were sent. Appended output keeps the baseline as a
 * prefix, so the delta is the new text; a rewritten screen (TUI, alt-screen) loses
 * the prefix and the whole screen is then treated as new. Polls full dumps and
 * also ends when the pane's process exits (after giving that iteration's dump a
 * chance to match final output).
 */
export async function waitForNewPattern(
  paneId: string,
  pattern: string,
  regex: boolean,
  timeoutMs: number,
  sessionArgs: string[],
  baseline: string,
  signal?: AbortSignal,
): Promise<NewPatternOutcome> {
  const started = Date.now();
  const rx = regex ? new RegExp(pattern) : null;
  const matchNew = (text: string) => {
    const delta = text.startsWith(baseline) ? text.slice(baseline.length) : text;
    return delta.split("\n").find((line) => (rx ? rx.test(line) : line.includes(pattern)));
  };
  while (Date.now() - started < timeoutMs) {
    if (signal?.aborted) return { status: "timeout", elapsedMs: Date.now() - started };
    let text: string | null = null;
    try {
      text = (await dumpPane(paneId, true, 5000, true, sessionArgs, signal)).text;
    } catch {
      // pane may have just been removed from the layout
    }
    if (text !== null) {
      const line = matchNew(text);
      if (line !== undefined) return { status: "matched", line, elapsedMs: Date.now() - started };
    }
    const state = await paneExitState(sessionArgs, paneId);
    if (state?.exited) {
      return { status: "exited", elapsedMs: Date.now() - started, exit_status: state.exit_status, removed: state.removed };
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return { status: "timeout", elapsedMs: Date.now() - started };
}

