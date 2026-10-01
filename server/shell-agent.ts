/**
 * Agents herdr's agent.start cannot launch (`herdr agent start --kind` lists its
 * kinds; omo and gjc are not among them). The pane's shell runs the command
 * instead, and the pane's process tree, not the prompt, says when it is up.
 */
import { herdrRpc } from "./herdr/client.ts";
import { isGjcProcess } from "./gjc-runtime.ts";
import { isOmoProcess } from "./omo.ts";

/** kind -> the foreground-process test that proves the agent is running in the pane. */
export const SHELL_AGENTS: Record<string, (argv: readonly string[]) => boolean> = {
  omo: isOmoProcess,
  gjc: isGjcProcess,
};

export function isShellAgentKind(kind: string): boolean { return Object.hasOwn(SHELL_AGENTS, kind); }

/** Types `<kind> args…` into the pane's shell and resolves once `kind` is its foreground process. */
export async function startShellAgent(kind: string, paneId: string, args: string[] = [], options: { command?: string; timeoutMs?: number } = {}): Promise<void> {
  const isProcess = SHELL_AGENTS[kind];
  if (!isProcess) throw new Error(`${kind} is not a shell-started agent`);
  const quoted = args.map((arg) => `'${arg.replaceAll("'", `'\\''`)}'`);
  await herdrRpc("pane.send_text", { pane_id: paneId, text: `${[options.command ?? kind, ...quoted].join(" ")}\n` });
  const deadline = Date.now() + (options.timeoutMs ?? 60_000);
  while (Date.now() < deadline) {
    const info = await herdrRpc<{ process_info?: { foreground_processes?: { argv?: string[] }[] } }>("pane.process_info", { pane_id: paneId }).catch(() => null);
    if (info?.process_info?.foreground_processes?.some((process) => isProcess(process.argv ?? []))) return;
    await Bun.sleep(250);
  }
  throw new Error(`${kind} did not start in the pane`);
}
