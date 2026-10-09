# Optional Herdr key bindings

Settings → Shortcuts → **Import Herdr key bindings** is off by default. It adds supported
Herdr bindings alongside the existing web shortcut overrides; it does not replace or rewrite them.
The setting belongs to this browser/device. Each selected PC supplies its own keymap.

The bridge reads `herdr/config.toml` beneath `XDG_CONFIG_HOME` (default `~/.config`) on
Linux/macOS or `APPDATA` (default `~/AppData/Roaming`) on Windows. A missing file uses the
Herdr 0.9.3 defaults. Other read errors or invalid TOML disable the import and show an error,
not a guessed fallback. After editing the file, use **Reload bindings**. This reads the file;
it does not ask Herdr to reload its configuration.

`[keys]` strings and arrays override defaults. An explicit empty string or array disables that
action. Invalid values also stay disabled. Unknown actions and `[[keys.command]]` descriptions
are shown as unsupported; command bodies are never sent to the browser or executed.

## Ownership and conflicts

- Existing web shortcuts, their default aliases (even when set to Off), overrides and held
  dictation retain their keys. Import never changes the shortcut labels those controls display.
- Import is inactive in text fields, contenteditable regions, menus and dialogs; in observe mode,
  when disconnected, and after an automatic pane selection. Select a pane yourself to reactivate.
  The chat composer and terminal input line keep native editing; the xterm input can use the import.
- IME composition, key code 229, dead keys, AltGraph and repeated keydown events are passed through.
  A handled key stops before xterm, so it cannot also type into the terminal.
- A prefix/direct chord must pass a conservative policy, not just be syntactically valid:
  free Mod+Shift letters/digits only, excluding known browser/system reservations, editing and
  clipboard keys, and every web shortcut. On a Mac, a Ctrl-only letter may also be a prefix
  (including Herdr's default Ctrl+B); Cmd is the browser modifier there.
  Ctrl+B is blocked on non-Mac browsers, where it can open bookmarks.
  A free Ctrl+Shift+8 is one possible non-Mac prefix; custom OS shortcuts can still intercept it.
- Cmd+T / Ctrl+T is not available in a normal browser, and is never imported. No installed-app
  exception guesses whether a browser-reserved chord is available.
- After a prefix, only an unmodified or Shift-modified key is accepted. A browser shortcut
  remains the browser's even during a sequence. Escape cancels; an unmatched or unsupported key
  passes through and cancels. The already-consumed prefix is not replayed as terminal input.
  Sequences expire after 1.5 seconds and cancel on focus, pointer, visibility, PC, pane, permission
  or keymap changes. No prefix is taken if it has no executable suffix.
- Ambiguous bindings do nothing. This includes collisions with unsupported actions/commands;
  an unsupported command must not accidentally run a supported default sharing its key.
  Settings shows each configured binding and its active, protected, duplicate, invalid,
  disabled or unsupported status.

## Supported actions

| Herdr action | Web behavior |
| --- | --- |
| `help`, `goto`, `workspace_picker` | Open the existing command palette |
| `settings` | Open Settings |
| `new_workspace`, `new_tab` | Open the existing creation dialog on the selected PC |
| `toggle_sidebar` | Existing sidebar/drawer toggle |
| `previous_tab`, `next_tab`, `switch_tab` | Select within the current workspace, in Herdr tab-number order |
| `previous_workspace`, `next_workspace`, `switch_workspace` | Select in workspace-number order on this PC |
| `previous_agent`, `next_agent`, `focus_agent` | Select an existing agent on this PC |
| `cycle_pane_next`, `cycle_pane_previous` | Select a pane in this tab's layout, top-to-bottom then left-to-right |

Indexed actions require `1..9`, for example `switch_workspace = "prefix+1..9"`.
Navigation changes this browser's selection, not global Herdr focus. Creation uses the existing
dialogs and existing machine-scoped RPC-backed endpoints, including their confirmation and
server mutation gates. There is no new mutation or key-command endpoint.

All remaining actions are unsupported in this contribution, including split, swap, zoom,
resize, directional pane focus, close/rename, scrollback editor, copy mode, detach, config
reload and command execution. They do not become an arbitrary RPC call. Multi-pane docking
is independent work; this import requires none of its UI or endpoints.
