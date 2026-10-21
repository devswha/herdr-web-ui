import { readFileSync } from "node:fs";
import type { HerdrUiConfig } from "../shared/protocol.ts";
import { herdrConfigPath } from "./herdr-sidebar.ts";

/** Client-side selection follows this PC's herdr config, as the sidebar does, for every pane. */
export function readHerdrUi(path = herdrConfigPath()): HerdrUiConfig {
  try {
    const config = Bun.TOML.parse(readFileSync(path, "utf8")) as { ui?: { copy_on_select?: unknown } };
    if (typeof config.ui?.copy_on_select === "boolean") return { copy_on_select: config.ui.copy_on_select };
  } catch { /* Missing or unreadable config: use herdr's default. */ }
  return { copy_on_select: true };
}
