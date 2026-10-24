import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { paneStorageId } from "../../shared/machines.ts";
import { deviceBusy, followsHerdrFocus, unsentDraft } from "./followFocus.ts";
import { writeTerminalDraft } from "./terminalDraft.ts";

const base = {
  enabled: true,
  machineId: "local",
  paneId: "w1:p2",
  selection: { machineId: "local", paneId: "w1:p1" },
  splitOther: null,
  linkPending: false,
  busy: false,
};

describe("following herdr's focus", () => {
  it("opens the pane herdr's focus moved to on the PC this device has open", () => {
    expect(followsHerdrFocus(base)).toBe(true);
    expect(followsHerdrFocus({ ...base, selection: { machineId: "local", paneId: null } })).toBe(true);
  });

  it("does nothing until this device turns it on", () => {
    expect(followsHerdrFocus({ ...base, enabled: false })).toBe(false);
  });

  it("leaves another PC's focus to that PC", () => {
    expect(followsHerdrFocus({ ...base, machineId: "remote" })).toBe(false);
  });

  it("leaves a pane already in front where it is", () => {
    expect(followsHerdrFocus({ ...base, paneId: "w1:p1" })).toBe(false);
    expect(followsHerdrFocus({ ...base, splitOther: { machineId: "local", paneId: "w1:p2" } })).toBe(false);
    expect(followsHerdrFocus({ ...base, splitOther: { machineId: "remote", paneId: "w1:p2" } })).toBe(true);
  });

  it("lets a link that is still landing go first", () => {
    expect(followsHerdrFocus({ ...base, linkPending: true })).toBe(false);
  });

  it("keeps the pane of someone using this device (#1470)", () => {
    expect(followsHerdrFocus({ ...base, busy: true })).toBe(false);
  });
});

describe("a device in use", () => {
  const field = (selector: string) => ({ matches: (query: string) => query.split(", ").some((part) => part.split(":")[0] === selector) });
  const page = (active: unknown, front: boolean, modal = false) => ({
    activeElement: active as Element | null, hasFocus: () => front,
    querySelector: (query: string) => (modal && query.includes("aria-modal") ? ({} as Element) : null),
  });

  it("is typing into a text field of the window in front", () => {
    expect(deviceBusy(page(field("textarea"), true))).toBe(true);
    expect(deviceBusy(page(field("input"), true))).toBe(true);
  });

  it("is not while its window is behind herdr's, whatever field kept the focus", () => {
    expect(deviceBusy(page(field("textarea"), false))).toBe(false);
  });

  it("is not when the focus is on no field", () => {
    expect(deviceBusy(page(field("button"), true))).toBe(false);
    expect(deviceBusy(page(null, true))).toBe(false);
  });

  it("is while a dialog is open over the pane", () => {
    expect(deviceBusy(page(null, false, true))).toBe(true);
  });
});

describe("an unsent message on the pane this device has open", () => {
  // the real stores, on a page's storage: each pane below holds a different draft
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let data: Map<string, string>;
  beforeEach(() => {
    for (const key of ["window", "localStorage"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    data = new Map();
    const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
    Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: storage } });
  });
  afterEach(() => {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });
  const pane = (paneId: string) => ({ machineId: "local", paneId });

  it("keeps a pane whose composer draft holds text", () => {
    data.set(`ovis:composer-draft:${paneStorageId("local", "w9:p1")}`, "half a sentence");
    expect(unsentDraft(pane("w9:p1"))).toBe(true);
  });

  it("keeps a pane whose terminal input line holds text, the phone's own draft", () => {
    writeTerminalDraft(paneStorageId("local", "w9:p2"), "git commit -m 'wip");
    expect(unsentDraft(pane("w9:p2"))).toBe(true);
  });

  it("keeps a pane whose terminal held what was typed while it was disconnected", () => {
    data.set(`ovis:terminal-draft:${paneStorageId("local", "w9:p3")}`, JSON.stringify({ text: "echo ", at: Date.now() }));
    expect(unsentDraft(pane("w9:p3"))).toBe(true);
  });

  it("does not hold a pane with blank or no drafts, or no pane", () => {
    data.set(`ovis:composer-draft:${paneStorageId("local", "w9:p4")}`, "  \n");
    expect(unsentDraft(pane("w9:p4"))).toBe(false);
    expect(unsentDraft(pane("w9:p5"))).toBe(false);
    expect(unsentDraft({ machineId: "local", paneId: null })).toBe(false);
  });
});
