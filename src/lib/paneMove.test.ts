import { expect, it } from "bun:test";
import { ComposerDraftStore } from "./composerDraft.ts";
import { carryPaneState } from "./paneMove.ts";
function fixture() {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
  return { data, drafts: new ComposerDraftStore(() => storage), storage: () => storage };
}
it("carries the chat draft, the held terminal input and the picked lens to the pane's new ID, sending nothing", () => {
  const { data, drafts, storage } = fixture();
  drafts.set("herdr-web-ui:composer-draft:w1:p1", "unsent question");
  data.set("herdr-web-ui:terminal-draft:w1:p1", JSON.stringify({ text: "echo held", at: 1 }));
  data.set("herdr-web-ui:view:w1:p1", "terminal");
  // another pane's state, and the same pane ID on another PC, stay where they are
  data.set("herdr-web-ui:view:w1:p2", "chat");
  drafts.set("herdr-web-ui:composer-draft:remote:pc:w1%3Ap1", "other PC");
  carryPaneState("local", "w1:p1", "w2:p4", drafts, storage);
  expect(drafts.read("herdr-web-ui:composer-draft:w2:p4")).toEqual({ text: "unsent question", sending: false });
  expect(drafts.read("herdr-web-ui:composer-draft:w1:p1").text).toBe("");
  expect(data.get("herdr-web-ui:terminal-draft:w2:p4")).toBe(JSON.stringify({ text: "echo held", at: 1 }));
  expect(data.get("herdr-web-ui:view:w2:p4")).toBe("terminal");
  expect([...data.keys()].filter((key) => key.endsWith(":w1:p1"))).toEqual([]);
  expect(data.get("herdr-web-ui:view:w1:p2")).toBe("chat");
  expect(drafts.read("herdr-web-ui:composer-draft:remote:pc:w1%3Ap1").text).toBe("other PC");
});
it("leaves a draft whose send is on its way, and keeps what the new ID holds already", () => {
  const { data, drafts, storage } = fixture();
  drafts.set("herdr-web-ui:composer-draft:w1:p1", "on its way");
  expect(drafts.begin("herdr-web-ui:composer-draft:w1:p1", "on its way")).toBe(true);
  data.set("herdr-web-ui:view:w1:p1", "chat");
  data.set("herdr-web-ui:view:w2:p4", "terminal");
  carryPaneState("local", "w1:p1", "w2:p4", drafts, storage);
  expect(drafts.read("herdr-web-ui:composer-draft:w1:p1")).toEqual({ text: "on its way", sending: true });
  expect(drafts.read("herdr-web-ui:composer-draft:w2:p4").text).toBe("");
  expect(data.get("herdr-web-ui:view:w2:p4")).toBe("terminal");
  expect(data.get("herdr-web-ui:view:w1:p1")).toBe("chat");
});
