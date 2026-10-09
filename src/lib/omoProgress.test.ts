import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { OmoProgress } from "../../shared/protocol.ts";
import { OmoProgressView } from "../components/OmoProgress.tsx";
import { SettingsProvider } from "./settings.ts";

const progress: OmoProgress = {
  session_id: "session-a",
  activity: "compacting",
  todos: [
    { phase: "Build", content: "First item", status: "completed" },
    { phase: "Check", content: "Second item", status: "in_progress" },
    { phase: "Check", content: "Third item", status: "pending" },
    { phase: "Check", content: "Fourth item", status: "abandoned" },
  ],
};

const render = (overrides: Partial<Parameters<typeof OmoProgressView>[0]> = {}) => {
  const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(OmoProgressView, {
      progress, state: "ready", connected: true, ended: false, ...overrides,
    }) }));
  } finally {
    if (languages) Object.defineProperty(navigator, "languages", languages);
    else Reflect.deleteProperty(navigator, "languages");
  }
};

describe("OmO progress surface", () => {
  it("renders compaction and every phase's task state without dropping abandoned work", () => {
    const html = render();
    expect(html).toContain('class="omo-progress is-compacting"');
    for (const task of progress.todos ?? []) {
      expect(html).toContain(`class="is-${task.status}"`);
      expect(html).toContain(task.content);
    }
    expect(html).toContain('role="status"');
    expect(html).not.toContain("<details open");
  });

  it.each([
    { connected: false }, { ended: true }, { state: "failed" as const }, { state: "loading" as const },
  ])("keeps the last checklist but drops the live compaction claim for %j", (condition) => {
    const html = render(condition);
    expect(html).toContain('class="omo-progress is-unknown"');
    expect(html).not.toContain('class="omo-progress is-compacting"');
    expect(html).toContain("Second item");
  });

  it("replaces the old list with an explicit clear", () => {
    const html = render({ progress: { ...progress, activity: "idle", todos: [] } });
    expect(html).not.toContain("Second item");
    expect(html).not.toContain('class="omo-progress-current"');
    expect(html).toContain('class="omo-progress-empty"');
    expect(html).toContain('class="omo-progress is-idle"');
  });

  it("does not invent progress for older bridges without a snapshot", () => {
    const html = render({ progress: null });
    expect(html).toContain('class="omo-progress is-unknown"');
    expect(html).not.toContain('class="omo-progress-count"');
  });
});
