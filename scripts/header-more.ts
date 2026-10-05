/**
 * The header's More menu, for the browser scripts: New tab, Browse files and Alerts are its
 * items, and at phone width the command palette is its first. It is a popover on a desktop and
 * a bottom sheet at 640px and below (RowMenu), so an item is found in either.
 */
import type { Locator, Page } from "playwright-core";

const ITEMS = '.row-menu [role="menuitem"], .row-sheet .row-sheet-item';

/** Opens the menu when it is not open and returns the item that starts with `label`. */
export async function moreItem(page: Page, label: string): Promise<Locator> {
  const item = page.locator(ITEMS).filter({ hasText: new RegExp(`^${label}`) });
  if (!(await item.isVisible())) await page.locator(".header-more-button").click();
  await item.waitFor();
  return item;
}

/** Runs an item; the menu closes with it. */
export async function runMoreItem(page: Page, label: string): Promise<void> {
  const item = await moreItem(page, label);
  await item.click();
  await item.waitFor({ state: "hidden" });
}

/**
 * What the Alerts item says of this device, in its words ("On in the app", "Off on this
 * device"), read from the open menu, which is closed again.
 */
export async function alertsState(page: Page): Promise<string> {
  const item = await moreItem(page, "Alerts");
  const state = (await item.locator(".menu-item-hint, .row-sheet-hint").textContent()) ?? "";
  await page.keyboard.press("Escape");
  await item.waitFor({ state: "hidden" });
  return state;
}

/** Whether the menu's button carries the dot, and says so in its name: alerts are off on this device. */
export async function alertsOffMarked(page: Page): Promise<boolean> {
  const dot = (await page.locator(".header-more .header-more-dot").count()) === 1;
  const named = (await page.locator(".header-more-button").getAttribute("aria-label")) === "More · alerts are off";
  if (dot !== named) throw new Error(`the More button's dot (${dot}) and its name (${named}) disagree`);
  return dot;
}
