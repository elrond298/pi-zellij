import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitForIdle } from "../src/wait.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-zellij-wait-"));
const zellij = join(dir, "zellij");
writeFileSync(zellij, `#!/bin/sh
case " $* " in
  *" subscribe "*)
    for _ in $(seq 1 20); do
      echo '{"event":"pane_update","pane_id":"terminal_1","viewport":["unchanged"],"scrollback":null}'
      sleep 0.03
    done
    sleep 1
    ;;
  *) echo '[{"id":1,"exited":false}]' ;;
esac
`);
chmodSync(zellij, 0o755);

const path = process.env.PATH;
process.env.PATH = `${dir}:${path}`;
try {
  const result = await waitForIdle("terminal_1", 100, 1_000, []);
  if (result.status !== "idle" || result.elapsedMs >= 400) {
    throw new Error(`duplicate snapshots delayed idle: ${JSON.stringify(result)}`);
  }
  console.log("PASS  unchanged pane snapshots do not reset idle");
} finally {
  process.env.PATH = path;
  rmSync(dir, { recursive: true, force: true });
}
