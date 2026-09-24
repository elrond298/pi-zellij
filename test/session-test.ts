/**
 * Fallback session naming outside zellij: one session per project (nearest
 * git/jj repo root basename, else cwd basename). No live zellij needed —
 * a fake `zellij` on PATH answers list-sessions and records the rest.
 * Run:  node --experimental-strip-types test/session-test.ts
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSession } from "../src/cli.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-zellij-session-"));
const zellij = join(dir, "zellij");
const log = join(dir, "log");
writeFileSync(
  zellij,
  `#!/bin/sh
echo "$*" >> "${log}"
case " $* " in *" list-sessions "*) echo "other" ;; esac
`,
);
chmodSync(zellij, 0o755);

const oldPath = process.env.PATH;
const oldZellij = process.env.ZELLIJ;
process.env.PATH = `${dir}:${oldPath}`;
delete process.env.ZELLIJ;

function check(name: string, cond: boolean, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) throw new Error(name);
}

const target = async (cwd: string, session?: string) => (await resolveSession(session, cwd)).join(" ");

try {
  const plain = join(dir, "myproj");
  mkdirSync(plain);
  check("plain dir project names the session", (await target(plain)) === "--session myproj");

  const repo = join(dir, "coolrepo");
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, ".git"));
  check("repo subdirectory uses the repo root name", (await target(join(repo, "src"))) === "--session coolrepo");

  process.env.ZELLIJ = "0";
  check("inside zellij targets the current session", (await target(plain)) === "");
  delete process.env.ZELLIJ;

  check("explicit session wins over the fallback", (await target(plain, "other")) === "--session other");
} finally {
  process.env.PATH = oldPath;
  if (oldZellij === undefined) delete process.env.ZELLIJ;
  else process.env.ZELLIJ = oldZellij;
  rmSync(dir, { recursive: true, force: true });
}
