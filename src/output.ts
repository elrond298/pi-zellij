/**
 * Output shaping: line/byte capping with compression markers, and the shared
 * pane dump used by zellij_dump and zellij_run capture.
 */
import { runZellij } from "./cli.ts";

export function capOutput(text: string, maxLines: number, keepTail: boolean): { text: string; truncated: boolean; compressed: number } {
  const out: string[] = [];
  let compressed = 0;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    const last = out[out.length - 1];
    if (line === "" ? last === "" : line === last) {
      compressed++;
      continue;
    }
    out.push(line);
  }
  let truncated = false;
  let slice = out;
  if (out.length > maxLines) {
    slice = keepTail ? out.slice(-maxLines) : out.slice(0, maxLines);
    truncated = true;
  }
  let joined = slice.join("\n");
  // Byte cap (pi tool-output guidance ~50KB): a single huge line must not blow past it.
  if (joined.length > 60_000) {
    joined = (keepTail ? joined.slice(-60_000) : joined.slice(0, 60_000)) + "\n... [output truncated by size]";
    truncated = true;
  }
  return { text: joined, truncated, compressed };
}

export function showLine(line: string): string {
  return line.length > 200 ? line.slice(0, 200) + "... [line truncated]" : line;
}

/** Marker lines appended after capped/compressed output. */
/** Marker lines appended after capped/compressed output. */
export function capNote(o: { truncated: boolean; compressed: number }): string {
  return (o.truncated ? "\n... [truncated]" : "") +
    (o.compressed ? `\n... [${o.compressed} blank/duplicate line${o.compressed === 1 ? "" : "s"} collapsed]` : "");
}



export async function dumpPane(
  paneId: string,
  full: boolean,
  maxLines: number,
  keepTail: boolean,
  sessionArgs: string[],
  signal?: AbortSignal,
): Promise<{ text: string; truncated: boolean }> {
  const args = [...sessionArgs, "action", "dump-screen", "--pane-id", paneId];
  if (full) args.push("--full");
  const { stdout, code, killed } = await runZellij(args, { timeoutMs: 30_000, signal });
  if (code !== 0 && !killed) throw new Error(`dump-screen failed: ${stdout}`);
  // killed (abort/timeout) — no evidence available, caller decides what that means
  return capOutput(stdout.replace(/\n+$/, ""), maxLines, keepTail);
}

