/**
 * Where the selected pane is, as the header says it on its one line: PC › workspace › folder.
 * The folder shows as its last name, and only when nothing beside it already says that name (the
 * title, the PC, the workspace): it is what tells two worktrees of one workspace apart, and
 * "api › api" told nobody anything. The full path is not lost: it is in the header's tooltip and
 * the first thing in its More menu, which is where a touch screen reads it.
 */
import { folderName } from "./paneName.ts";

export interface HeaderCrumb {
  machine: string;
  workspace: string;
  /** the folder's last name, or null when another part already says it (or there is no folder) */
  folder: string | null;
  /** "PC › workspace": the More menu's first line */
  place: string;
  /** the folder written out, as herdr reports it: the More menu's second line */
  path: string | null;
  /** the context's tooltip: workspace › title, then the full path */
  tooltip: string;
}

export function headerCrumb(input: { machine: string; workspace: string; title: string; cwd: string | null | undefined }): HeaderCrumb {
  const machine = input.machine.trim();
  const workspace = input.workspace.trim();
  const title = input.title.trim();
  const path = input.cwd?.trim() || null;
  const name = path === null ? null : folderName(path);
  const said = name === null || [title, machine, workspace].includes(name);
  return {
    machine,
    workspace,
    folder: said ? null : name,
    place: `${machine} › ${workspace}`,
    path,
    tooltip: path === null ? `${workspace} › ${title}` : `${workspace} › ${title} · ${path}`,
  };
}
