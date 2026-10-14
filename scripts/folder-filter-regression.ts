import assert from "node:assert/strict";
import type { Page, Locator } from "playwright-core";

/** Of the owned fixture directory's folders only a starts with an a; no workspace or folder is created by this check. */
export async function checkFolderFilter(page: Page, dialog: Locator, createRequests: () => number): Promise<void> {
  const field = dialog.getByRole("combobox", { name: /^Directory/ });
  const root = await field.inputValue();
  const rows = () => dialog.getByRole("option").allTextContents();
  const until = async (check: () => Promise<boolean>, label: string) => {
    const deadline = Date.now() + 5_000;
    while (!(await check())) {
      if (Date.now() >= deadline) assert.fail(`${label} (path ${JSON.stringify(await field.inputValue())}, rows ${JSON.stringify(await rows())})`);
      await page.waitForTimeout(50);
    }
  };
  const listed = (expected: string[], label: string) => until(async () => (await rows()).join() === expected.join(), label);
  await field.fill(`${root}/`);
  await until(async () => { const all = await rows(); return all[0] === ".." && all.includes("a") && all.includes("b"); }, "a path ending in a separator lists that folder's folders under the way up");
  await field.fill(`${root}/A`);
  await listed(["..", "a"], "the path's last part filters by a folder's start, in any case");
  const composition = await field.evaluate((input) => [
    { key: "Enter", isComposing: true },
    { key: "Enter", keyCode: 229 },
    { key: "Escape", isComposing: true },
  ].map((init) => input.dispatchEvent(new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true }))));
  assert.deepEqual(composition, [true, true, true], "IME candidate keys keep their default action");
  assert.equal(await field.inputValue(), `${root}/A`, "IME keys leave the path alone");
  assert.equal(await dialog.isVisible(), true, "IME Escape does not close the dialog");
  await field.press("ArrowDown");
  await field.press("ArrowDown");
  await dialog.getByRole("option", { name: "a", exact: true, selected: true }).waitFor();
  assert.equal(await field.evaluate((input) => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))), false, "Enter on a highlighted folder cannot submit the form");
  await until(async () => (await field.inputValue()) === `${root}/a/`, "Enter walks into the highlighted folder");
  assert.equal(createRequests(), 0, "walking into a folder creates no workspace");
  await dialog.getByText("No folders here", { exact: true }).waitFor();
  await dialog.getByRole("option", { name: "Parent folder", exact: true }).click();
  await until(async () => (await field.inputValue()) === `${root}/`, "the first row goes up one folder");
  assert.equal(await field.evaluate((input) => input === document.activeElement), true, "a row picked with the pointer leaves the caret in the path");
  await field.fill(`${root}/not-there-yet`);
  await dialog.getByText("Start makes this folder.", { exact: true }).waitFor();
  await field.fill(root);
  await dialog.getByText("absolute path or ~/…", { exact: true }).waitFor();
  console.log("PASS the directory path filters and walks folders, keeps IME keys, and says when Start makes the folder");
}
