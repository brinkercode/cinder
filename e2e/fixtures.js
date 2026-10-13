import { test as base, expect } from "@playwright/test";
import { OWNER_TOKEN } from "./playwright.config.js";

// A page signed in as the owner. The SPA holds no token, so the browser adds it where the edge would identify the
// person (Access is off locally; a service token behind Access carries no email). Merged with the config's Access headers.
export const test = base.extend({
  page: async ({ page }, use) => {
    await page.setExtraHTTPHeaders({ Authorization: `Bearer ${OWNER_TOKEN}` });
    await use(page);
  },
});
export { expect };

// Clicks every enabled, visible button and link in root (<main> by default), bar a segmented group's pressed option
// (already the choice), and fails naming each one that does nothing observable: no navigation or popup, no 2xx response,
// no native dialog, no popover opened and no change to the DOM within five seconds.
// The starting URL is reloaded before each control after the first: a click's navigation can commit after its response,
// so without the reload the next control can be one the late commit removes, and an opened menu, dialog or section
// can't shift or cover the next one. open: opens what holds root (a modal, a popover) before each click, as the reload closes it.
export async function clickEveryControl(page, root = "main", open) {
  const start = page.url();
  const controls = page.locator(root).locator("button:enabled:not([role=group] > [aria-pressed=true]):not([role=tablist] > [aria-selected=true]):not([inert] *), a[href]:not([inert] *)").filter({ visible: true });
  const dead = [];
  let total; // a click that adds controls (a restore adds a version to restore) must not loop
  for (let i = 0; ; i++) {
    // A router navigation can still be pending after the last click and land this one on the next page.
    if (i) await page.goto(start, { waitUntil: "networkidle" });
    await open?.();
    total ??= await controls.count();
    // Recounted after the reload: a delete removes its own control, an opened menu's items are gone again, and the last click's page can hold more.
    if (i >= Math.min(total, await controls.count())) break;
    const control = controls.nth(i);
    const name = await control.evaluate((el) => el.getAttribute("aria-label") || el.textContent.trim() || el.title || el.outerHTML);
    // An opened popover changes no markup, so its open state is part of the snapshot.
    const snapshot = () => page.evaluate(() => document.documentElement.outerHTML + document.querySelectorAll(":popover-open").length);
    const before = await snapshot();
    const pressed = (await control.getAttribute("aria-pressed")) === "true"; // picking the option already picked keeps it
    let acted = false;
    const ok = (res) => { if (res.ok()) acted = true; };
    const dialog = (d) => { acted = true; return d.dismiss(); };
    const popup = (p) => { acted = true; return p.close(); };
    page.on("response", ok).on("dialog", dialog).on("popup", popup);
    // A submit the browser blocks on an empty required field answers with its own validation message.
    const invalid = await control.evaluate((el) => el.type === "submit" && el.form?.checkValidity() === false);
    await control.click();
    // A router navigation commits its URL only once the next page's loaders answer, which takes seconds on a loaded host.
    await expect.poll(async () => acted || pressed || invalid || page.url() !== start || (await snapshot()) !== before, { timeout: 5000 })
      .toBe(true).catch(() => dead.push(name));
    page.off("response", ok).off("dialog", dialog).off("popup", popup);
  }
  expect(dead, "controls that do nothing").toEqual([]);
}
