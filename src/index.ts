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
 * Install:  pi install /path/to/pi-zellij
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTools } from "./tools.ts";
import { registerZellijPi } from "./command.ts";

export default function zellijExtension(pi: ExtensionAPI) {
  registerTools(pi);
  registerZellijPi(pi);
}
