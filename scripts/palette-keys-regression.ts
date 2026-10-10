/**
 * The command palette's picker keys against a roster that changes under them: a filter letter
 * that names the filter already shown, and panes that leave the filter while the keyboard is on
 * the list. Imported by ui-regression.ts, with the app open on pane A.
 */
import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import { herdrRpc, tabClose, tabCreate } from "../server/herdr/client.ts";

export interface PaletteKeysFixture {
  /** the open pane, in a workspace of its own */
  paneA: string;
  /** a pane in another workspace, whose root pane it is */
  paneB: string;
  /** B's workspace: the check opens two more panes there and closes them again */
  workspaceB: string;
}

/** Leaves A and B at rest with an agent reported (claude and codex), the two added panes closed. */
export async function checkPaletteKeys(page: Page, fixture: PaletteKeysFixture): Promise<void> {
  const until = async (check: () => Promise<boolean>, label: string): Promise<void> => {
    const deadline = Date.now() + 10_000;
    while (!(await check())) {
      assert.ok(Date.now() < deadline, `Timed out: ${label}`);
      await page.waitForTimeout(50);
    }
  };
  const palette = page.getByRole("dialog", { name: "Command palette", exact: true });
  const search = palette.getByRole("searchbox", { name: "Search panes and actions", exact: true });
  const chip = (status: string) => palette.locator(`.palette-filter[data-status="${status}"]`);
  const rows = palette.locator(".palette-pane");
  const titleAt = (index: number) => palette.locator(`#palette-item-${index} .palette-row-title`).textContent();
  const focusedId = () => page.evaluate(() => (document.activeElement === document.body ? "body" : document.activeElement?.id ?? ""));
  const pickedId = () => search.getAttribute("aria-activedescendant");
  const report = (pane: string, agent: string, state: string) => herdrRpc("pane.report_agent", { pane_id: pane, source: "manual", agent, state });

  // RUN lists A under its workspace, then B, C and D under theirs
  const third = await tabCreate({ workspaceId: fixture.workspaceB });
  const fourth = await tabCreate({ workspaceId: fixture.workspaceB });
  const paneC = third.root_pane.pane_id;
  const paneD = fourth.root_pane.pane_id;
  try {
    // named apart from each other and from B, whose rows otherwise all show their folder
    await herdrRpc("pane.rename", { pane_id: paneC, label: "palette keys C" });
    await herdrRpc("pane.rename", { pane_id: paneD, label: "palette keys D" });
    for (const [pane, agent] of [[fixture.paneA, "claude"], [fixture.paneB, "codex"], [paneC, "codex"], [paneD, "codex"]] as const) await report(pane, agent, "working");
    await page.keyboard.press("ControlOrMeta+Shift+k");
    await palette.waitFor();
    await until(() => search.evaluate((input) => document.activeElement === input), "palette search takes focus");
    await until(async () => await chip("working").locator(".palette-filter-count").textContent() === "4", "RUN counts the four working panes");

    // a letter naming the filter already shown still puts the focus on the first row: the row the
    // footer describes is the one Enter would run
    await palette.locator("#palette-item-1").focus();
    await until(async () => await pickedId() === "palette-item-1", "a focused row is the pick");
    await page.keyboard.press("a");
    await until(async () => await focusedId() === "palette-item-0" && await pickedId() === "palette-item-0",
      "`a` over the list with All shown puts the focus and the pick on the first row");

    // RUN by its letter: A, then B, C and D under their workspace, the keyboard on the second row
    await page.keyboard.press("w");
    await until(async () => await chip("working").getAttribute("aria-checked") === "true" && await rows.count() === 4, "RUN shows the four working panes");
    await until(async () => await focusedId() === "palette-item-0", "a filter letter puts the focus on the first row");
    const titleB = await titleAt(1);
    const titleC = await titleAt(2);
    await page.keyboard.press("ArrowDown");
    await until(async () => await focusedId() === "palette-item-1" && await pickedId() === "palette-item-1", "ArrowDown over the list moves the focus and the pick together");

    // the pane before the pick leaves the filter: the pick and the focus stay on the same row
    await report(fixture.paneA, "claude", "idle");
    await until(async () => await rows.count() === 3, "A left RUN");
    assert.equal(await focusedId(), "palette-item-0", "the focused row keeps the focus at its new place");
    assert.equal(await pickedId(), "palette-item-0", "the pick follows the focused row up the list");
    assert.equal(await titleAt(0), titleB, "the row at the pick is still the one the keyboard was on");

    // the picked row leaves: the row now at its place takes the focus (the one that stood right
    // after it, not the one at the place the pick had before the roster moved it), and the keys
    // still reach the palette
    await report(fixture.paneB, "codex", "idle");
    await until(async () => await rows.count() === 2, "B left RUN");
    assert.equal(await titleAt(0), titleC, "the row after the one that left stands at its place");
    assert.equal(titleC, "palette keys C", "the renamed third pane is the row the pick lands on");
    await until(async () => await focusedId() === "palette-item-0" && await pickedId() === "palette-item-0", "the row now at the pick's place takes the focus");
    await page.keyboard.press("a");
    await until(async () => await chip("all").getAttribute("aria-checked") === "true", "a filter letter still reaches the palette");
    await until(async () => await focusedId() === "palette-item-0", "and puts the focus on the first row again");

    // the rows under a filter leave one by one: the focus is handed on, then to the search
    await page.keyboard.press("w");
    await until(async () => await rows.count() === 2 && await focusedId() === "palette-item-0", "RUN shows the two working panes, the focus on the first");
    await report(paneC, "codex", "idle");
    await until(async () => await rows.count() === 1, "C left RUN");
    await until(async () => await focusedId() === "palette-item-0" && await pickedId() === "palette-item-0", "the last row takes the focus");
    await report(paneD, "codex", "idle");
    await until(async () => await rows.count() === 0, "D left RUN");
    await until(() => search.evaluate((input) => document.activeElement === input), "an emptied list hands the focus to the search");
    await search.press("Escape");
    await palette.waitFor({ state: "hidden" });
    console.log("PASS palette keys: a repeated filter letter refocuses the first row, and the pick survives panes leaving the filter");
  } finally {
    await tabClose(fourth.tab.tab_id).catch(() => undefined);
    await tabClose(third.tab.tab_id).catch(() => undefined);
  }
}
