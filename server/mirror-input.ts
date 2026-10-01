/**
 * What typing into a mirrored pane hands to herdr's `pane.send_text`.
 *
 * A mirror repaint carries no terminal modes, so the browser's xterm never learns that the
 * program turned bracketed paste on and sends a pasted block as bare lines joined by CR. An
 * agent's composer takes the first CR for Enter and sends line one alone. Checked on a
 * Windows PC (#257): the same block inside the paste markers stays in gjc's composer unsent,
 * while PowerShell and cmd, which never asked for bracketed paste, still run it line by line,
 * because the Windows console keeps the markers from a program that did not ask for them.
 * Enter, Ctrl+C, Esc, Tab and the arrows already work there as plain bytes and stay as typed.
 *
 * A herdr elsewhere hands the bytes to the program as they are (`cat` shows `^[[200~`), so
 * only a Windows pane gets the markers.
 */
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

export function mirrorInput(text: string, windowsConsole: boolean): string {
  // typing is one key per frame: only a paste has a line break with more text after it
  if (!windowsConsole || text.includes("\x1b") || !/[\r\n][^\r\n]/.test(text)) return text;
  return PASTE_START + text + PASTE_END;
}
