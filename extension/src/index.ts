/**
 * zellij — reliable programmatic control of zellij for pi.
 *
 * Tools encode the reliability lessons from the zellij skill:
 * - exit codes only from panes created with a command (zellij_run wraps cmd in sh -c)
 * - wait via blocking/polling, never a hard sleep (zellij_run polls exit_status at 1s)
 * - "tell me when X appears" via subscribe, not polling (zellij_wait)
 * - bracketed paste for multi-line input (zellij_send)
 * - every wait has a timeout; timeouts return partial results, never hang
 *
 * Install:  pi install /path/to/extension
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
  killed: boolean;
}

/** Run a zellij CLI command, capturing output. Kills the child on timeout or abort. */
function runZellij(
  args: string[],
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("zellij", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGKILL");
          finish(() => resolve({ stdout, stderr, code: null, killed: true }));
        }, opts.timeoutMs)
      : undefined;

    const onAbort = () => {
      child.kill("SIGKILL");
      finish(() => resolve({ stdout, stderr, code: null, killed: true }));
    };
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      finish(() => reject(err));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      finish(() => resolve({ stdout, stderr, code, killed: false }));
    });
  });
}

/** Active (non-exited) zellij session names. */
async function listSessions(): Promise<string[]> {
  const { stdout, code } = await runZellij(["list-sessions"]);
  if (code !== 0) return [];
  const clean = stdout.replace(/\x1b\[[0-9;]*m/g, ""); // strip ANSI colors (zellij colors output even when piped)
  return clean
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !l.includes("EXITED")) // tombstones: "(EXITED - attach to resurrect)"
    .map((l) => l.split(" ")[0])
    .filter((s) => s && s !== "No" && !s.startsWith("No active"));
}

/**
 * Resolve which session commands should target:
 * - explicit session: auto-create it headless if it does not exist
 * - inside zellij (ZELLIJ env set): current session, no --session flag
 * - otherwise: a persistent default session named "pi"
 */
async function resolveSession(explicit?: string): Promise<string[]> {
  if (explicit) {
    const sessions = await listSessions();
    if (!sessions.includes(explicit)) {
      await runZellij(["attach", "--create-background", explicit]);
    }
    return ["--session", explicit];
  }
  if (process.env.ZELLIJ) return [];
  const sessions = await listSessions();
  if (!sessions.includes("pi")) {
    await runZellij(["attach", "--create-background", "pi"]);
  }
  return ["--session", "pi"];
}

/** Normalize a pane id like "terminal_3" or "3". */
function normalizePaneId(paneId?: string): string {
  if (paneId) return paneId;
  if (process.env.ZELLIJ_PANE_ID) return process.env.ZELLIJ_PANE_ID;
  throw new Error("pane_id is required when not running inside a zellij pane");
}

interface PaneInfo {
  id: number;
  title: string;
  pane_command: string | null;
  pane_cwd: string | null;
  exited: boolean;
  exit_status: number | null;
  is_focused: boolean;
  is_floating: boolean;
  tab_name: string | null;
}

async function listPanes(sessionArgs: string[]): Promise<PaneInfo[]> {
  const { stdout, code } = await runZellij([...sessionArgs, "action", "list-panes", "--json"]);
  if (code !== 0) throw new Error(`list-panes failed: ${stdout} ${code}`);
  const parsed = JSON.parse(stdout) as Array<Record<string, unknown>>;
  return parsed
    .filter((p) => p.is_plugin !== true)
    .map((p) => ({
      id: p.id as number,
      title: (p.title as string) ?? "",
      pane_command: (p.pane_command as string | null) ?? null,
      pane_cwd: (p.pane_cwd as string | null) ?? null,
      exited: p.exited === true,
      exit_status: (p.exit_status as number | null) ?? null,
      is_focused: p.is_focused === true,
      is_floating: p.is_floating === true,
      tab_name: (p.tab_name as string | null) ?? null,
    }));
}

function findPane(panes: PaneInfo[], paneId: string): PaneInfo {
  const numeric = paneId.replace(/^terminal_/, "");
  const found = panes.find((p) => String(p.id) === numeric);
  if (!found) throw new Error(`pane ${paneId} not found`);
  return found;
}

/** Subscribe to a pane's output; resolve on first matching line, or null on timeout. */
async function waitForPattern(
  paneId: string,
  pattern: string,
  regex: boolean,
  timeoutMs: number,
  sessionArgs: string[],
  signal?: AbortSignal,
): Promise<{ matched: string | null; elapsedMs: number }> {
  return new Promise((resolve) => {
    const child = spawn("zellij", [...sessionArgs, "subscribe", "--pane-id", paneId], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buf = "";
    let done = false;

    const finish = (matched: string | null, elapsedMs: number) => {
      if (done) return;
      done = true;
      child.kill("SIGKILL");
      resolve({ matched, elapsedMs });
    };

    const start = Date.now();
    const timer = setTimeout(() => finish(null, Date.now() - start), timeoutMs);
    const onAbort = () => finish(null, Date.now() - start);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (d) => {
      buf += d;
      let line: string;
      while ((line = buf.split("\n", 1)[0], buf.includes("\n"))) {
        buf = buf.slice(line.length + 1);
        const hit = regex ? new RegExp(pattern).test(line) : line.includes(pattern);
        if (hit) {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          finish(line.trim(), Date.now() - start);
          return;
        }
      }
    });
    child.on("error", () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      finish(null, Date.now() - start);
    });
    child.on("close", () => {
      // subscriber exited (e.g. pane closed) — flush remaining buffer
      if (!done && buf.trim()) {
        const hit = regex ? new RegExp(pattern).test(buf) : buf.includes(pattern);
        if (hit) finish(buf.trim(), Date.now() - start);
      }
      if (!done) finish(null, Date.now() - start);
    });
  });
}

/** Cap long text for LLM context; keep the tail by default (terminal output is read bottom-up). */
function capOutput(text: string, maxLines: number, keepTail: boolean): { text: string; truncated: boolean } {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return { text, truncated: false };
  const slice = keepTail ? lines.slice(-maxLines) : lines.slice(0, maxLines);
  return { text: slice.join("\n"), truncated: true };
}

// ---------------------------------------------------------------------------
// extension
// ---------------------------------------------------------------------------

export default function zellijExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "zellij_run",
    label: "Zellij: Run Command",
    description:
      "Run a shell command in a new zellij pane and wait for it to finish. Returns the pane id, real exit code, and final output. Use for long-running commands, builds, tests, servers — anything where the duration is unknown. Never combine with sleep; the tool waits internally. " +
      "The command runs via sh -c, so pipes, globs, and $VARS work. On timeout returns partial results (pane keeps running) so the caller can zellij_wait or zellij_dump later. Captured output keeps the tail when capped.",
    promptSnippet: "Run a command in a zellij pane and wait for it (returns exit code + output)",
    promptGuidelines: [
      "Use zellij_run for any command that should run in a terminal pane with visible output — do not emulate long-running processes with bash sleep loops.",
      "Never fall back to raw `zellij action new-pane` or `zellij run` + manual waiting: zellij_run waits internally and returns the real exit code and output.",
    ],
    parameters: Type.Object({
      command: Type.String({ description: "Command to run (shell syntax allowed; wrapped in sh -c)" }),
      wait: Type.Optional(
        Type.String({
          description: "exit (default): wait until the command exits, any status. exit-success / exit-failure: wait until that outcome, otherwise return immediately with the actual status. none: create the pane and return at once.",
          enum: ["exit", "exit-success", "exit-failure", "none"],
          default: "exit",
        }),
      ),
      capture: Type.Optional(
        Type.Boolean({ description: "Capture final pane output (default true; ignored when wait=none)", default: true }),
      ),
      name: Type.Optional(Type.String({ description: "Optional pane name" })),
      cwd: Type.Optional(Type.String({ description: "Working directory for the new pane" })),
      session: Type.Optional(Type.String({ description: "Zellij session name. Default: current session when running inside zellij, else a session named 'pi' (auto-created)." })),
      timeout: Type.Optional(
        Type.Number({ description: "Max seconds to wait (default 600). On expiry returns partial results.", default: 600 }),
      ),
      max_lines: Type.Optional(Type.Number({ description: "Cap on returned output lines (default 500)", default: 500 })),
      tail: Type.Optional(
        Type.Boolean({ description: "When output exceeds max_lines, return the last lines instead of the first (default true)", default: true }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const sessionArgs = await resolveSession(params.session);
      const createArgs = [...sessionArgs, "action", "new-pane"];
      if (params.name) createArgs.push("--name", params.name);
      if (params.cwd) createArgs.push("--cwd", params.cwd);
      createArgs.push("--", "sh", "-c", params.command);

      const created = await runZellij(createArgs, { timeoutMs: 30_000, signal });
      const paneId = created.stdout.trim();
      if (!paneId || !paneId.startsWith("terminal_")) {
        throw new Error(`new-pane failed: ${created.stdout} ${created.stderr}`);
      }

      if (params.wait === "none") {
        return {
          content: [{ type: "text", text: `Started pane ${paneId}.` }],
          details: { pane_id: paneId, waited: false },
        };
      }

      const timeoutMs = (params.timeout ?? 600) * 1000;
      const deadline = Date.now() + timeoutMs;
      let pane: PaneInfo | undefined;
      let waited = 0;

      while (Date.now() < deadline) {
        const panes = await listPanes(sessionArgs);
        pane = findPane(panes, paneId);
        if (pane.exited) break;
        if (signal?.aborted) break;
        await new Promise((r) => setTimeout(r, 1000));
        waited += 1;
      }

      const timedOut = !pane?.exited;
      const output = timedOut
        ? null
        : params.capture !== false
          ? await dumpPane(paneId, true, params.max_lines ?? 500, params.tail !== false, sessionArgs, signal)
          : null;

      let condition = "exit";
      if (params.wait === "exit-success" && pane?.exit_status === 0) condition = "exit-success (met)";
      if (params.wait === "exit-failure" && pane?.exit_status !== 0 && pane?.exited) condition = "exit-failure (met)";
      if (pane?.exited && params.wait === "exit-success" && pane.exit_status !== 0)
        condition = `exit-success NOT met — command exited ${pane.exit_status}`;
      if (pane?.exited && params.wait === "exit-failure" && pane.exit_status === 0)
        condition = "exit-failure NOT met — command exited 0";

      const text = timedOut
        ? `Pane ${paneId} still running after ${params.timeout ?? 600}s (timeout). Pane keeps running; use zellij_wait or zellij_dump.`
        : `Command finished: exit status ${pane?.exit_status} (${condition}), waited ${waited}s.` +
          (output?.text ? `\n\n--- output (${paneId}) ---\n${output.text}` + (output.truncated ? "\n... [truncated]" : "") : "");

      return {
        content: [{ type: "text", text }],
        details: {
          pane_id: paneId,
          waited_seconds: waited,
          timed_out: timedOut,
          exited: pane?.exited ?? false,
          exit_status: pane?.exit_status ?? null,
          output_captured: output?.text ?? null,
        },
      };
    },
  });

  pi.registerTool({
    name: "zellij_dump",
    label: "Zellij: Dump Screen",
    description:
      "Read a zellij pane's current output (viewport, or full scrollback with full=true). ANSI stripped. " +
      "Use to check what is on a pane's screen right now, or to capture final output after a command finished. " +
      "When the output exceeds max_lines, the tail (last lines) is returned by default — for terminal output the tail is what matters.",
    promptSnippet: "Read the current or full output of a zellij pane (tail kept when capped)",
    promptGuidelines: [
      "Use zellij_dump — never the raw `zellij action dump-screen` CLI — when reading pane output; it handles session targeting, ANSI stripping, and line capping (tail by default).",
    ],
    parameters: Type.Object({
      pane_id: Type.Optional(Type.String({ description: "Pane id (e.g. terminal_3 or 3). Default: the pane this agent runs in." })),
      full: Type.Optional(Type.Boolean({ description: "Include full scrollback (default true)", default: true })),
      max_lines: Type.Optional(Type.Number({ description: "Cap on returned lines (default 500); the tail is kept when capped", default: 500 })),
      tail: Type.Optional(
        Type.Boolean({ description: "When output exceeds max_lines, return the last lines instead of the first (default true)", default: true }),
      ),
      session: Type.Optional(Type.String({ description: "Zellij session name (default: current session when running inside zellij, else a session named 'pi', auto-created)" })),
    }),
    async execute(_toolCallId, params, signal) {
      const sessionArgs = await resolveSession(params.session);
      const paneId = normalizePaneId(params.pane_id);
      const output = await dumpPane(paneId, params.full !== false, params.max_lines ?? 500, params.tail !== false, sessionArgs, signal);
      return {
        content: [{ type: "text", text: output.text + (output.truncated ? "\n... [truncated]" : "") }],
        details: { pane_id: paneId, truncated: output.truncated, lines: output.text.split("\n").length },
      };
    },
  });

  pi.registerTool({
    name: "zellij_send",
    label: "Zellij: Send Input",
    description:
      "Send input to a zellij pane: paste text (bracketed paste — multi-line safe) and/or named keys. " +
      "Use for interactive commands, answering prompts, or driving a REPL in a pane.",
    promptSnippet: "Send text or keys to a zellij pane (paste + Enter)",
    promptGuidelines: [
      "Use zellij_send — never raw `zellij action paste` / `zellij action send-keys` — for pane input; it combines text + keys and handles session targeting.",
    ],
    parameters: Type.Object({
      pane_id: Type.Optional(Type.String({ description: "Pane id (e.g. terminal_3 or 3). Default: the pane this agent runs in." })),
      text: Type.Optional(Type.String({ description: "Text to paste into the pane (multi-line safe)" })),
      keys: Type.Optional(
        Type.Array(Type.String({ description: "Named keys to send after text, e.g. [\"Enter\"], [\"Ctrl c\"], [\"Escape\"]" })),
      ),
      press_enter: Type.Optional(
        Type.Boolean({ description: "Send Enter after the text (default true when text is given)", default: true }),
      ),
      session: Type.Optional(Type.String({ description: "Zellij session name (default: current session when running inside zellij, else a session named 'pi', auto-created)" })),
    }),
    async execute(_toolCallId, params, signal) {
      const sessionArgs = await resolveSession(params.session);
      const paneId = normalizePaneId(params.pane_id);
      const keys = [...(params.keys ?? [])];
      if (params.text && params.press_enter !== false) keys.unshift("Enter");

      if (params.text) {
        await runZellij([...sessionArgs, "action", "paste", "--pane-id", paneId, params.text], { signal });
      }
      for (const key of keys) {
        await runZellij([...sessionArgs, "action", "send-keys", "--pane-id", paneId, key], { signal });
      }
      return {
        content: [
          {
            type: "text",
            text: `Sent to ${paneId}:${params.text ? ` "${params.text.replace(/\n/g, "\\n")}"` : ""}${keys.length ? ` + keys [${keys.join(", ")}]` : ""}`,
          },
        ],
        details: { pane_id: paneId },
      };
    },
  });

  pi.registerTool({
    name: "zellij_wait",
    label: "Zellij: Wait for Output",
    description:
      "Block until a pattern appears in a zellij pane's output (subscribe-based, no polling; also matches output already on screen). " +
      "Returns the matched line. Use for 'tell me when X appears' — e.g. a build log line, an error, a prompt.",
    promptSnippet: "Wait until a pattern appears in a zellij pane's output",
    promptGuidelines: [
      "Use zellij_wait — never raw `zellij subscribe | grep` pipelines — to wait for output patterns; it handles the subscriber lifecycle and timeout.",
    ],
    parameters: Type.Object({
      pane_id: Type.String({ description: "Pane id (e.g. terminal_3 or 3)" }),
      pattern: Type.String({ description: "Text to look for (substring match unless regex=true)" }),
      regex: Type.Optional(Type.Boolean({ description: "Treat pattern as a regular expression (default false)", default: false })),
      timeout: Type.Optional(Type.Number({ description: "Max seconds to wait (default 300)", default: 300 })),
      session: Type.Optional(Type.String({ description: "Zellij session name (default: current session when running inside zellij, else a session named 'pi', auto-created)" })),
    }),
    async execute(_toolCallId, params, signal) {
      const sessionArgs = await resolveSession(params.session);
      // Pre-check the full scrollback: subscribe only replays the viewport, so output that
      // appeared before we attached would otherwise be missed.
      const existing = await dumpPane(params.pane_id, true, 5000, true, sessionArgs, signal);
      const rx = params.regex === true ? new RegExp(params.pattern) : null;
      const hit = existing.text.split("\n").find((line) => (rx ? rx.test(line) : line.includes(params.pattern)));
      if (hit) {
        return {
          content: [{ type: "text", text: `Matched in 0.0s (already on screen): ${hit.trim()}` }],
          details: { pane_id: params.pane_id, matched: true, elapsed_ms: 0, line: hit.trim() },
        };
      }
      const { matched, elapsedMs } = await waitForPattern(
        params.pane_id,
        params.pattern,
        params.regex === true,
        (params.timeout ?? 300) * 1000,
        sessionArgs,
        signal,
      );
      if (matched === null) {
        return {
          content: [
            { type: "text", text: `Pattern not found within ${params.timeout ?? 300}s in pane ${params.pane_id}.` },
          ],
          details: { pane_id: params.pane_id, matched: false, elapsed_ms: elapsedMs },
        };
      }
      return {
        content: [{ type: "text", text: `Matched in ${(elapsedMs / 1000).toFixed(1)}s: ${matched}` }],
        details: { pane_id: params.pane_id, matched: true, elapsed_ms: elapsedMs, line: matched },
      };
    },
  });

  pi.registerTool({
    name: "zellij_list",
    label: "Zellij: List Panes",
    description:
      "List panes, tabs, or sessions in zellij with id, title, command, cwd, exit status, focus. " +
      "Use to discover pane ids, check whether commands have finished (exited/exit_status), or find which session a pane lives in.",
    promptSnippet: "List zellij panes, tabs, or sessions with their ids and state",
    promptGuidelines: [
      "Use zellij_list — never raw `zellij action list-panes`, `zellij list-tabs`, or `zellij list-sessions` — to inspect state.",
    ],
    parameters: Type.Object({
      resource: Type.Optional(
        Type.String({ description: "What to list: panes (default), tabs, or sessions", enum: ["panes", "tabs", "sessions"], default: "panes" }),
      ),
      session: Type.Optional(Type.String({ description: "Zellij session name (default: current session when running inside zellij, else a session named 'pi', auto-created)" })),
    }),
    async execute(_toolCallId, params, signal) {
      const sessionArgs = await resolveSession(params.session);
      if (params.resource === "sessions") {
        const sessions = await listSessions();
        return {
          content: [{ type: "text", text: sessions.join("\n") || "(no active sessions)" }],
          details: { sessions },
        };
      }
      if (params.resource === "tabs") {
        const { stdout, code } = await runZellij([...sessionArgs, "action", "list-tabs", "--json"], { signal });
        if (code !== 0) throw new Error(`list-tabs failed: ${stdout}`);
        const tabs = JSON.parse(stdout) as Array<Record<string, unknown>>;
        const text = tabs
          .map((t) => `tab ${t.tab_id} "${t.name}" active=${t.active} panes=${t.selectable_tiled_panes_count ?? "?"}`)
          .join("\n");
        return { content: [{ type: "text", text: text || "(no tabs)" }], details: {} };
      }
      const panes = await listPanes(sessionArgs);
      const text = panes
        .map(
          (p) =>
            `terminal_${p.id} [${p.is_focused ? "focused" : "     "}${p.exited ? " exited" : " running"}] ` +
            `${p.exit_status !== null ? `status=${p.exit_status} ` : ""}"${p.title}" ${p.pane_command ?? ""} ${p.pane_cwd ?? ""}`,
        )
        .join("\n");
      return {
        content: [{ type: "text", text: text || "(no panes)" }],
        details: { panes: panes.map((p) => ({ ...p, id: `terminal_${p.id}` })) },
      };
    },
  });

  pi.registerTool({
    name: "zellij_close",
    label: "Zellij: Close Pane",
    description: "Close a zellij pane (terminates its process). Use for cleanup after a command finished.",
    promptSnippet: "Close a zellij pane",
    promptGuidelines: [
      "Use zellij_close — never raw `zellij action close-pane` — to clean up panes.",
    ],
    parameters: Type.Object({
      pane_id: Type.Optional(Type.String({ description: "Pane id (e.g. terminal_3 or 3). Default: the pane this agent runs in." })),
      session: Type.Optional(Type.String({ description: "Zellij session name (default: current session when running inside zellij, else a session named 'pi', auto-created)" })),
    }),
    async execute(_toolCallId, params, signal) {
      const sessionArgs = await resolveSession(params.session);
      const paneId = normalizePaneId(params.pane_id);
      const { stdout, code } = await runZellij([...sessionArgs, "action", "close-pane", "--pane-id", paneId], { signal });
      if (code !== 0) throw new Error(`close-pane failed: ${stdout}`);
      return { content: [{ type: "text", text: `Closed pane ${paneId}.` }], details: { pane_id: paneId } };
    },
  });
}

// ---------------------------------------------------------------------------
// shared pane dump (used by zellij_dump and zellij_run capture)
// ---------------------------------------------------------------------------

async function dumpPane(
  paneId: string,
  full: boolean,
  maxLines: number,
  keepTail: boolean,
  sessionArgs: string[],
  signal?: AbortSignal,
): Promise<{ text: string; truncated: boolean }> {
  const args = [...sessionArgs, "action", "dump-screen", "--pane-id", paneId];
  if (full) args.push("--full");
  const { stdout, code } = await runZellij(args, { timeoutMs: 30_000, signal });
  if (code !== 0) throw new Error(`dump-screen failed: ${stdout}`);
  return capOutput(stdout.replace(/\n+$/, ""), maxLines, keepTail);
}
