import { badRequest, errorResponse, isJsonObject, jsonResponse } from "./http.ts";
import { paneFocus, paneResize, paneSplit, paneZoom } from "./herdr/client.ts";
import type { PaneSplit } from "../shared/protocol.ts";

/** Called only after the server's normal access gate, including PC-scoped proxy requests. */
export async function handlePaneLayoutRequest(request: Request, pathname = new URL(request.url).pathname): Promise<Response> {
  if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
  let body: unknown;
  try { body = await request.json(); }
  catch { return badRequest("invalid_json", "request body must be JSON"); }
  if (!isJsonObject(body)) return badRequest("invalid_body", "request body must be a JSON object");
  const paneId = body.pane_id;
  if (typeof paneId !== "string" || !paneId.trim()) return badRequest("missing_pane_id", "pane_id is required");
  try {
    switch (pathname) {
      case "/api/pane/split": {
        const direction = body.direction ?? "right";
        if (direction !== "right" && direction !== "down") return badRequest("invalid_direction", "direction must be right or down");
        const result = await paneSplit(paneId, direction);
        return jsonResponse({ pane_id: result.pane.pane_id } satisfies PaneSplit);
      }
      case "/api/pane/focus":
        await paneFocus(paneId);
        break;
      case "/api/pane/zoom": {
        const mode = body.mode ?? "toggle";
        if (mode !== "toggle" && mode !== "on" && mode !== "off") return badRequest("invalid_mode", "mode must be toggle, on, or off");
        await paneZoom(paneId, mode);
        break;
      }
      case "/api/pane/resize": {
        const { direction, amount } = body;
        if (direction !== "left" && direction !== "right" && direction !== "up" && direction !== "down") {
          return badRequest("invalid_direction", "direction must be left, right, up, or down");
        }
        if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0 || amount > 0.8) {
          return badRequest("invalid_amount", "amount must be a ratio delta above 0 and at most 0.8");
        }
        await paneResize(paneId, direction, amount);
        break;
      }
      default: return badRequest("not_found", "unknown pane layout operation");
    }
    return jsonResponse({ ok: true });
  } catch (error) { return errorResponse(error); }
}
