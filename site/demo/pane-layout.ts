import type { HerdrPane, SessionSnapshot } from "../../shared/protocol.ts";
import { withSplitRatio } from "../../src/lib/split-layout.ts";

/** Fictional native layout operations. No filesystem, processes or user session is involved. */
export function demoPaneLayout(snapshot: SessionSnapshot, operation: string, body: Record<string, unknown>, id: string):
  { status: number; body: { ok: true } | { pane_id: string } | { error: { code: string; message: string } } } {
  const fail = (code: string, message: string, status = 400) => ({ status, body: { error: { code, message } } });
  if (typeof body.pane_id !== "string" || !body.pane_id.trim()) return fail("missing_pane_id", "pane_id is required");
  const pane = snapshot.panes.find((entry) => entry.pane_id === body.pane_id);
  if (!pane) return fail("pane_not_found", "no such pane", 404);
  let layout = snapshot.layouts.find((entry) => entry.tab_id === pane.tab_id);
  if (!layout) {
    const area = { x: 0, y: 0, width: 120, height: 40 };
    layout = { area, workspace_id: pane.workspace_id, tab_id: pane.tab_id, focused_pane_id: pane.pane_id, zoomed: false,
      panes: [{ pane_id: pane.pane_id, focused: true, rect: area }], splits: [] };
  }
  switch (operation) {
    case "split": {
      const direction = body.direction ?? "right";
      if (direction !== "right" && direction !== "down") return fail("invalid_direction", "direction must be right or down");
      const cell = layout.panes.find((entry) => entry.pane_id === pane.pane_id);
      if (!cell) return fail("pane_not_found", "no layout cell", 404);
      const before = { ...cell.rect };
      const row = direction === "right";
      const leading = Math.floor((row ? before.width : before.height) / 2);
      if (leading < 1) return fail("pane_too_small", "this demo cell cannot be split further");
      const nextRect = row ? { ...before, x: before.x + leading, width: before.width - leading }
        : { ...before, y: before.y + leading, height: before.height - leading };
      cell.rect = row ? { ...before, width: leading } : { ...before, height: leading };
      layout.panes.push({ pane_id: id, focused: false, rect: nextRect });
      layout.splits.push({ id: `split:${id}`, direction, ratio: leading / (row ? before.width : before.height), rect: before });
      layout.zoomed = false;
      const created: HerdrPane = { ...pane, pane_id: id, terminal_id: `terminal:${id}`, label: null, title: "Shell",
        agent: null, agent_session: null, agent_status: "unknown", background_tasks: 0, focused: false };
      snapshot.panes.push(created);
      const tab = snapshot.tabs.find((entry) => entry.tab_id === pane.tab_id);
      if (tab) tab.pane_count += 1;
      if (!snapshot.layouts.includes(layout)) snapshot.layouts.push(layout);
      return { status: 200, body: { pane_id: id } };
    }
    case "focus": {
      snapshot.focused_pane_id = pane.pane_id;
      for (const entry of snapshot.panes) entry.focused = entry.pane_id === pane.pane_id;
      for (const entry of layout.panes) entry.focused = entry.pane_id === pane.pane_id;
      layout.focused_pane_id = pane.pane_id;
      const workspace = snapshot.workspaces.find((entry) => entry.workspace_id === pane.workspace_id);
      if (workspace) workspace.active_tab_id = pane.tab_id;
      break;
    }
    case "zoom": {
      const mode = body.mode ?? "toggle";
      if (mode !== "toggle" && mode !== "on" && mode !== "off") return fail("invalid_mode", "mode must be toggle, on, or off");
      layout.zoomed = mode === "toggle" ? !layout.zoomed : mode === "on";
      layout.focused_pane_id = pane.pane_id;
      break;
    }
    case "resize": {
      const { direction, amount } = body;
      if (direction !== "left" && direction !== "right" && direction !== "up" && direction !== "down") return fail("invalid_direction", "invalid direction");
      if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0 || amount > 0.8) return fail("invalid_amount", "invalid ratio delta");
      const cell = layout.panes.find((entry) => entry.pane_id === pane.pane_id);
      if (!cell) return fail("pane_not_found", "no layout cell", 404);
      const vertical = direction === "left" || direction === "right";
      const split = layout.splits.filter((entry) => (entry.direction === "right") === vertical
        && cell.rect.x >= entry.rect.x && cell.rect.y >= entry.rect.y
        && cell.rect.x + cell.rect.width <= entry.rect.x + entry.rect.width
        && cell.rect.y + cell.rect.height <= entry.rect.y + entry.rect.height)
        .sort((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height)[0];
      if (!split) return fail("no_split", "no boundary to resize", 404);
      const next = withSplitRatio(layout, split.id, split.ratio + (direction === "right" || direction === "down" ? amount : -amount));
      snapshot.layouts = snapshot.layouts.map((entry) => entry === layout ? next : entry);
      return { status: 200, body: { ok: true } };
    }
    default: return fail("not_found", "unknown layout operation", 404);
  }
  if (!snapshot.layouts.includes(layout)) snapshot.layouts.push(layout);
  return { status: 200, body: { ok: true } };
}
