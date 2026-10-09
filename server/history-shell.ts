/**
 * Conservative shell-input proof for restart recovery. Only a plain, empty prompt
 * on the last nonblank detection row is accepted. Custom/multiline prompts and
 * unrecognized output stay manual; never clear a draft to make room for a launch.
 */
export function historyShellInputEmpty(text: string): boolean {
  const line = text.split(/\r?\n/).filter((row) => row.trim().length > 0).at(-1);
  if (line === undefined) return false;
  return /^(?:(?:[\w.-]+@[\w.-]+(?::[~\w./-]+)?|[\w.-]+(?: [~\w./-]+)?)\s*)?[$#%❯]\s*$/.test(line);
}
