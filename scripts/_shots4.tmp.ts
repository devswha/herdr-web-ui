import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
const origin = process.env.ORIGIN!; const out = process.env.OUT!; mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: "dark" });
await ctx.addInitScript(() => localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", theme: "dark", sidebarGrouping: "workspace" })));
const page = await ctx.newPage();
await page.goto(origin);
await page.locator(".conn-live").waitFor({ timeout: 20000 }).catch(() => console.log("no conn-live"));
await page.waitForTimeout(800);
console.log("worktree groups:", await page.locator(".worktree-children").count(), "children rows:", await page.locator(".worktree-children .pane-item").count());
await page.screenshot({ path: `${out}/grouped.png` });
const child = page.locator(".worktree-children .pane-item").first();
if (await child.count()) {
  await child.hover(); await child.locator(".row-menu-toggle").click();
  await page.getByRole("menu").waitFor();
  console.log("child menu:", await page.getByRole("menuitem").allTextContents());
  await page.screenshot({ path: `${out}/child-menu.png` });
  await page.getByRole("menuitem", { name: "Delete worktree checkout…", exact: true }).click();
  await page.getByRole("alertdialog").waitFor();
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${out}/delete-confirm.png` });
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("alertdialog").waitFor({ state: "detached" });
}
await ctx.close(); await browser.close(); console.log("done");
