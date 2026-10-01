/**
 * What typing into a mirrored pane hands to herdr's `pane.send_text`.
 *
 * A mirror repaint carries no terminal modes, so the browser's xterm never learns that the
 * program turned bracketed paste on and sends a pasted block as bare lines joined by CR. An
 * agent's composer takes the first CR for Enter and sends line one alone. Checked on a
 * Windows PC (#257): the same block inside the paste markers stays in gjc's composer unsent,
 * while PowerShell and cmd still run it line by line. Those two do not read VT input, and the
 * Windows console drops a sequence it has no key for on the way to such a program. A program
 * that does read VT input receives the markers whether or not it turned bracketed paste on:
 * one without paste support (a shell under wsl.exe, ssh.exe or Git Bash) sees them as text.
 * Enter, Ctrl+C, Esc, Tab and the arrows already work there as plain bytes and stay as typed.
 *
 * A herdr elsewhere hands the bytes to the program as they are (`cat` shows `^[[200~`), so
 * only a Windows pane gets the markers.
 */
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

export function mirrorInput(text: string, windowsConsole: boolean): string {
  // typing is one key per frame: only a paste has a line break with more text after it
  if (!windowsConsole || !/[\r\n][^\r\n]/.test(text)) return text;
  // a terminal that knew the mode has wrapped it already
  if (text.includes(PASTE_START) || text.includes(PASTE_END)) return text;
  return PASTE_START + text + PASTE_END;
}
