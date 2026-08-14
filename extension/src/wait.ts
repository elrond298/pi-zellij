/**
 * Output waits: pattern matching and idle/settle detection via zellij subscribe.
 * Both resolve early on a terminal pane state and report the state to the caller.
 */
import { spawn } from "node:child_process";
import { paneExitState } from "./cli.ts";

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
    const child = spawn("zellij", [...sessionArgs, "subscribe", "--pane-id", paneId], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let done = false;
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
      if (!done && d.length) lastChange = Date.now();
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

