/** Operator-selected application state; tests always supply a temporary directory. */
import { homedir } from "node:os";
import { join } from "node:path";

export function defaultStateDir(): string {
  return process.env["HERDR_WEB_STATE_DIR"] || join(process.env["XDG_CONFIG_HOME"] || join(homedir(), ".config"), "herdr-web-ui");
}
