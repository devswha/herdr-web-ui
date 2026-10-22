import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as herdr from "./herdr/client.ts";
import { HerdrError } from "./herdr/client.ts";
import { createServer } from "./index.ts";

describe("GET /api/pane/omo-tasks", () => {
  let server: ReturnType<typeof createServer>;
  let stateDir: string;
  const url = (path: string) => `http://127.0.0.1:${server.port}${path}`;
  const error = async (response: Response) => [response.status, ((await response.json()) as { error: { code: string } }).error.code];

  beforeAll(() => {
    stateDir = mkdtempSync(join(tmpdir(), "ovis-tasks-route-"));
    server = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "", machines: false, sidecar: false });
  });
  afterAll(() => {
    server.stop();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("wants GET and a pane", async () => {
    expect(await error(await fetch(url("/api/pane/omo-tasks?pane_id=w1:p1"), { method: "POST", headers: { origin: url("") } }))).toEqual([400, "method_not_allowed"]);
    expect(await error(await fetch(url("/api/pane/omo-tasks")))).toEqual([400, "missing_pane_id"]);
  });

  it("answers no tasks and no runs, on this PC's clock, for a pane that runs neither OmO nor Claude Code", async () => {
    const get = spyOn(herdr, "paneGet").mockImplementation(async (paneId) => { throw new HerdrError("pane_not_found", `pane ${paneId} not found`); });
    try {
      const response = await fetch(url("/api/pane/omo-tasks?pane_id=w9:p9"));
      expect(response.status).toBe(200);
      const body = await response.json() as { tasks: unknown[]; runs: unknown[]; server_time: string };
      expect(body.tasks).toEqual([]);
      expect(body.runs).toEqual([]);
      expect(Number.isFinite(Date.parse(body.server_time))).toBe(true);
      expect(get).toHaveBeenCalledWith("w9:p9");
    } finally {
      get.mockRestore();
    }
  });

  it("answers what is known when herdr does not answer the pane lookup", async () => {
    let answer: () => void = () => undefined;
    const get = spyOn(herdr, "paneGet").mockImplementation(() => new Promise((_resolve, reject) => { answer = () => reject(new HerdrError("timeout", "herdr did not answer")); }));
    try {
      const response = await fetch(url("/api/pane/omo-tasks?pane_id=w9:p8"));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ tasks: [], runs: [] });
    } finally {
      answer();
      get.mockRestore();
    }
  });
});
