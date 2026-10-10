import { describe, expect, it } from "bun:test";
import type { SessionSnapshot } from "../../shared/protocol.ts";
import { ComposerDraftStore } from "./composerDraft.ts";
import { carryPaneRecords, paneMoveTargets } from "./paneMove.ts";

const t = (key: string, vars?: Record<string, string | number>): string => key.replace(/\{(\w+)\}/g, (_, name: string) => String(vars?.[name] ?? ""));

const snapshot = {
  workspaces: [
    { workspace_id: "w1", label: "api" },
    { workspace_id: "w2", label: "docs" },
    { workspace_id: "w3", label: "infra" },
  ],
  tabs: [
    { tab_id: "w1:t2", workspace_id: "w1", label: "", number: 2 },
    { tab_id: "w1:t1", workspace_id: "w1", label: "build", number: 1 },
    { tab_id: "w1:t3", workspace_id: "w1", label: "", number: 3 },
    { tab_id: "w2:t1", workspace_id: "w2", label: "", number: 1 },
  ],
} as unknown as Pick<SessionSnapshot, "tabs" | "workspaces">;

describe("paneMoveTargets", () => {
  it("lists a new tab, the workspace's other tabs in order, every other workspace, then a new workspace", () => {
    const targets = paneMoveTargets(snapshot, { workspace_id: "w1", tab_id: "w1:t2" }, t);
    expect(targets.map((target) => [target.id, target.label, target.divider ?? false])).toEqual([
      ["new-tab", "New tab", false],
      ["tab:w1:t1", "build", false],
      ["tab:w1:t3", "Tab 3", false],
      ["workspace:w2", "docs", true],
      ["workspace:w3", "infra", false],
      ["new-workspace", "New workspace", true],
    ]);
    expect(targets.map((target) => target.destination)).toEqual([
      { type: "new_tab" },
      { type: "tab", tab_id: "w1:t1" },
      { type: "tab", tab_id: "w1:t3" },
      { type: "new_tab", workspace_id: "w2" },
      { type: "new_tab", workspace_id: "w3" },
      { type: "new_workspace" },
    ]);
  });

  it("offers a lone pane a new tab and the other workspaces only", () => {
    const targets = paneMoveTargets(snapshot, { workspace_id: "w2", tab_id: "w2:t1" }, t);
    expect(targets.map((target) => target.id)).toEqual(["new-tab", "workspace:w1", "workspace:w3", "new-workspace"]);
  });
});

describe("carryPaneRecords", () => {
  const fakeStorage = (entries: Record<string, string>) => {
    const data = new Map(Object.entries(entries));
    return { data, storage: { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } } };
  };

  it("moves the lens, the terminal draft and the composer draft to the new id", () => {
    const { data, storage } = fakeStorage({
      "herdr-web-ui:view:w1:p1": "chat",
      "herdr-web-ui:terminal-draft:w1:p1": JSON.stringify({ text: "ls", at: 1 }),
      "herdr-web-ui:composer-draft:w1:p1": "half a message",
      "herdr-web-ui:queue:w1:p1": "held",
    });
    const drafts = new ComposerDraftStore(() => storage);
    carryPaneRecords("local", "w1:p1", "w2:p3", { storage: () => storage, drafts });
    expect(data.get("herdr-web-ui:view:w2:p3")).toBe("chat");
    expect(data.get("herdr-web-ui:terminal-draft:w2:p3")).toBe(JSON.stringify({ text: "ls", at: 1 }));
    expect(data.get("herdr-web-ui:composer-draft:w2:p3")).toBe("half a message");
    expect(drafts.read("herdr-web-ui:composer-draft:w2:p3").text).toBe("half a message");
    expect(data.has("herdr-web-ui:view:w1:p1")).toBe(false);
    expect(data.has("herdr-web-ui:terminal-draft:w1:p1")).toBe(false);
    expect(data.has("herdr-web-ui:composer-draft:w1:p1")).toBe(false);
    expect(data.get("herdr-web-ui:queue:w1:p1")).toBe("held");
  });

  it("keeps a remote pane's namespace and leaves a draft that is being sent", () => {
    const { data, storage } = fakeStorage({ "herdr-web-ui:view:remote:pc:w1%3Ap1": "terminal", "herdr-web-ui:composer-draft:remote:pc:w1%3Ap1": "on its way" });
    const drafts = new ComposerDraftStore(() => storage);
    expect(drafts.begin("herdr-web-ui:composer-draft:remote:pc:w1%3Ap1", "on its way")).toBe(true);
    carryPaneRecords("pc", "w1:p1", "w2:p1", { storage: () => storage, drafts });
    expect(data.get("herdr-web-ui:view:remote:pc:w2%3Ap1")).toBe("terminal");
    expect(data.get("herdr-web-ui:composer-draft:remote:pc:w1%3Ap1")).toBe("on its way");
    expect(data.has("herdr-web-ui:composer-draft:remote:pc:w2%3Ap1")).toBe(false);
  });

  it("does nothing when the id stayed", () => {
    const { data, storage } = fakeStorage({ "herdr-web-ui:view:w1:p1": "chat" });
    carryPaneRecords("local", "w1:p1", "w1:p1", { storage: () => storage, drafts: new ComposerDraftStore(() => storage) });
    expect([...data.keys()]).toEqual(["herdr-web-ui:view:w1:p1"]);
  });
});
