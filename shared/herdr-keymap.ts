/** Herdr 0.9.3 defaults, adapted from the local keymap series; no web-only bindings. */
export const HERDR_DEFAULT_KEYS: Readonly<Record<string, string | null>> = {
  help: "prefix+?", settings: "prefix+s", new_workspace: "prefix+shift+n",
  new_worktree: "prefix+shift+g", open_worktree: null, remove_worktree: null,
  rename_workspace: "prefix+shift+w", close_workspace: "prefix+shift+d",
  workspace_picker: "prefix+w", goto: "prefix+g", detach: "prefix+q",
  reload_config: "prefix+shift+r", open_notification_target: "prefix+o",
  previous_workspace: null, next_workspace: null, previous_agent: null, next_agent: null,
  focus_agent: null, new_tab: "prefix+c", rename_tab: "prefix+shift+t",
  previous_tab: "prefix+p", next_tab: "prefix+n", move_tab_previous: null,
  move_tab_next: null, switch_tab: "prefix+1..9", switch_workspace: null,
  close_tab: "prefix+shift+x", rename_pane: "prefix+shift+p",
  edit_scrollback: "prefix+e", clear_pane: null, copy_mode: "prefix+[",
  focus_pane_left: "prefix+h", focus_pane_down: "prefix+j",
  focus_pane_up: "prefix+k", focus_pane_right: "prefix+l",
  swap_pane_left: "prefix+shift+h", swap_pane_down: "prefix+shift+j",
  swap_pane_up: "prefix+shift+k", swap_pane_right: "prefix+shift+l",
  cycle_pane_next: "prefix+tab", cycle_pane_previous: "prefix+shift+tab", last_pane: null,
  split_vertical: "prefix+v", split_horizontal: "prefix+minus", close_pane: "prefix+x",
  zoom: "prefix+z", resize_mode: "prefix+r", resize_pane_left: null,
  resize_pane_down: null, resize_pane_up: null, resize_pane_right: null,
  toggle_sidebar: "prefix+b",
};

export interface HerdrKeymap {
  readonly prefix: readonly string[];
  readonly bindings: readonly { readonly action: string; readonly keys: readonly string[] }[];
  /** Informational only. Command bodies are neither returned nor executed. */
  readonly commands: readonly { readonly key: string; readonly type: string; readonly description: string }[];
}

function keymapObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function keyList(value: unknown): string[] {
  if (typeof value === "string") return value ? [value] : [];
  if (Array.isArray(value) && value.every((key: unknown) => typeof key === "string")) return value.filter((key: string) => key.length > 0);
  return [];
}

/** Explicit empty/invalid values stay disabled, rather than silently restoring a default. */
export function mergeHerdrKeymap(config: unknown): HerdrKeymap {
  if (keymapObject(config) && Object.hasOwn(config, "keys") && !keymapObject(config["keys"])) throw new TypeError("Invalid Herdr keys table");
  const keys = keymapObject(config) && keymapObject(config["keys"]) ? config["keys"] : {};
  const actions = new Set([...Object.keys(HERDR_DEFAULT_KEYS), ...Object.keys(keys).filter((key) => key !== "prefix" && key !== "command")]);
  const bindings = [...actions].map((action) => ({
    action,
    keys: keyList(Object.hasOwn(keys, action) ? keys[action] : HERDR_DEFAULT_KEYS[action]),
  }));
  const commands: HerdrKeymap["commands"][number][] = [];
  if (Array.isArray(keys["command"])) for (const entry of keys["command"]) {
    if (!keymapObject(entry) || typeof entry["key"] !== "string") continue;
    commands.push({
      key: entry["key"],
      type: typeof entry["type"] === "string" ? entry["type"] : "",
      description: typeof entry["description"] === "string" ? entry["description"] : "",
    });
  }
  return { prefix: Object.hasOwn(keys, "prefix") ? keyList(keys["prefix"]) : ["ctrl+b"], bindings, commands };
}

/** Parse the bridge response once; a malformed/older remote cannot install a partial keymap. */
export function readHerdrKeymap(value: unknown): HerdrKeymap {
  if (!keymapObject(value) || !Array.isArray(value["prefix"]) || !value["prefix"].every((key: unknown) => typeof key === "string")
    || !Array.isArray(value["bindings"]) || !Array.isArray(value["commands"])) throw new TypeError("Invalid Herdr keymap");
  const bindings: HerdrKeymap["bindings"][number][] = [];
  for (const binding of value["bindings"]) {
    if (!keymapObject(binding) || typeof binding["action"] !== "string" || !Array.isArray(binding["keys"])
      || !binding["keys"].every((key: unknown) => typeof key === "string")) throw new TypeError("Invalid Herdr binding");
    bindings.push({ action: binding["action"], keys: binding["keys"] });
  }
  const commands: HerdrKeymap["commands"][number][] = [];
  for (const command of value["commands"]) {
    if (!keymapObject(command) || typeof command["key"] !== "string" || typeof command["type"] !== "string"
      || typeof command["description"] !== "string") throw new TypeError("Invalid Herdr command description");
    commands.push({ key: command["key"], type: command["type"], description: command["description"] });
  }
  return { prefix: value["prefix"], bindings, commands };
}
