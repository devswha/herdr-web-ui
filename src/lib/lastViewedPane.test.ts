import { describe, expect, test } from "bun:test";
import { parseViewedPanes, withViewedPane } from "./lastViewedPane.ts";

describe("last viewed pane", () => {
  test("a stored list reads back in order, and anything malformed is dropped", () => {
    expect([...parseViewedPanes(JSON.stringify([["workspace:local:w1", "w1:p2"], ["tab:local:w1:t1", "w1:p2"]]))])
      .toEqual([["workspace:local:w1", "w1:p2"], ["tab:local:w1:t1", "w1:p2"]]);
    expect([...parseViewedPanes(JSON.stringify([["workspace:local:w1", 3], ["only one"], "w1:p1", ["workspace:local:w2", "w2:p1"]]))])
      .toEqual([["workspace:local:w2", "w2:p1"]]);
    expect(parseViewedPanes("{not json").size).toBe(0);
    expect(parseViewedPanes(JSON.stringify({ "workspace:local:w1": "w1:p1" })).size).toBe(0);
    expect(parseViewedPanes(null).size).toBe(0);
  });

  test("a view moves its entry to the end and replaces the pane it had", () => {
    const start = new Map([["workspace:local:w1", "w1:p1"], ["workspace:local:w2", "w2:p1"]]);
    const next = withViewedPane(start, "workspace:local:w1", "w1:p2");
    expect([...next]).toEqual([["workspace:local:w2", "w2:p1"], ["workspace:local:w1", "w1:p2"]]);
    expect(start.get("workspace:local:w1")).toBe("w1:p1");
  });

  test("past the limit the oldest entries go", () => {
    let entries = new Map<string, string>();
    for (let index = 0; index < 5; index++) entries = withViewedPane(entries, `workspace:local:w${index}`, `w${index}:p1`, 3);
    expect([...entries.keys()]).toEqual(["workspace:local:w2", "workspace:local:w3", "workspace:local:w4"]);
  });
});
