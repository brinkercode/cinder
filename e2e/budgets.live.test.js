import { readFile } from "node:fs/promises";
import { REPOS } from "../seed/seed.mjs";
import { expect, test } from "./fixtures.js";
import { api, OWNER_TOKEN } from "./playwright.config.js";

// Budgets in ms, from click or navigation start until the content is drawn (see settle).
const COLD_MS = 1500; // any page, empty browser cache
const COLD_KEY_MS = 800; // repo root, Code, Changes and Change detail
const WARM_MS = 800; // a reload with the cache warm
const BRANCH_MENU_MS = 150;
const FILE_SWITCH_MS = 400;
const CARD_TO_DETAIL_MS = 600;
const TAB_SWITCH_MS = 200;
const SIDEBAR_NAV_MS = 600;
const FLOW_SELECT_MS = 300;

// Every page in docs/usage/README.md (plus the repo root and Change detail), by its path on repo r with change c.
// A page outside a repo is walked once.
const PAGES = {
  "Repo root": [(r) => `/${r}`, COLD_KEY_MS],
  Code: [(r, b) => `/${r}/code/${b}`, COLD_KEY_MS],
  Changes: [(r) => `/${r}/changes`, COLD_KEY_MS],
  "Change detail": [(r, b, c) => c && `/${r}/changes/${c}`, COLD_KEY_MS],
  Issues: [(r) => `/${r}/issues`],
  Releases: [(r) => `/${r}/releases`],
  Watchtower: [(r) => `/${r}/watchtower`],
  Insights: [(r) => `/${r}/insights`],
  Flows: [(r) => `/${r}/flows`],
  "Repo settings": [(r) => `/${r}/settings`],
  Environments: [(r) => `/${r}/environments`],
  Wiki: [(r) => `/wiki/${r}`],
  Repositories: [() => "/"],
  Agents: [() => "/automation/agents"],
  Marketplace: [() => "/automation/marketplace"],
  "Judges & calibration": [() => "/automation/judges"],
  Workers: [() => "/automation/workers"],
  "Needs you": [() => "/needs"],
  "Access & people": [() => "/settings/access"],
  Keystore: [() => "/settings/keystore"],
  "My model access": [() => "/me/models"],
};

// Runs in the page. Resolves with the time (performance.now()) of the first of three frames in a row where `ready`
// matches a visible element, no .bone or busy region is left and the layout doesn't move. The clicked element carries
// data-budget, so `ready` can name it. Gives up after 10 s, which fails any budget.
function settle(ready) {
  return new Promise((resolve) => {
    const start = performance.now();
    let last = "", since = 0, same = 0;
    const frame = (now) => {
      const main = document.querySelector("main");
      const sig = main && document.querySelector(ready)?.checkVisibility() && !document.querySelector(".bone, [aria-busy=true]")
        ? `${document.getElementsByTagName("*").length}:${main.getBoundingClientRect().height}:${main.scrollHeight}` : "";
      if (sig && sig === last) same++;
      else [same, since] = [sig ? 1 : 0, now];
      last = sig;
      if (same >= 3) return resolve(since);
      if (now - start > 10_000) return resolve(now);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}

// Fails listing every measure over its budget, printed as a table for the release log.
function report(rows) {
  const over = rows.filter((r) => !(r.measured <= r.budget));
  if (over.length) console.table(over);
  expect(over).toEqual([]);
}

test("every page draws within its cold and warm budget with no console errors or failed requests", async ({ page }) => {
  test.setTimeout(600_000);
  const listed = [...(await readFile(new URL("../docs/usage/README.md", import.meta.url), "utf8")).matchAll(/^\| \[([^\]]+)\]\(/gm)].map((m) => m[1]);
  expect(Object.keys(PAGES), "a page in docs/usage/README.md has no path here").toEqual(expect.arrayContaining(listed));

  let at = "";
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(`${at} console: ${m.text()}`); });
  page.on("pageerror", (e) => errors.push(`${at} pageerror: ${e.message}`));
  page.on("response", (r) => { if (r.status() >= 400 && new URL(r.url()).pathname.startsWith("/api/")) errors.push(`${at} ${r.status()}: ${r.url()}`); });
  const cdp = await page.context().newCDPSession(page);
  const rows = [], seen = new Set();
  for (const repo of Object.values(REPOS)) {
    const { default_branch: branch } = await api("GET", `/api/repos/${repo}`);
    const [change] = await api("GET", `/api/repos/${repo}/changes`);
    for (const [name, [path, budget = COLD_MS]] of Object.entries(PAGES)) {
      const url = path(repo, branch, change?.id);
      if (!url || seen.has(url)) continue; // no change to open, or a page outside a repo already walked
      seen.add(url);
      at = url;
      await cdp.send("Network.clearBrowserCache");
      await page.goto(url, { waitUntil: "commit" });
      rows.push({ page: `${name} ${url} cold`, measured: Math.round(await page.evaluate(settle, "main")), budget });
      await page.reload({ waitUntil: "commit" });
      rows.push({ page: `${name} ${url} warm`, measured: Math.round(await page.evaluate(settle, "main")), budget: WARM_MS });
    }
  }
  expect.soft(errors).toEqual([]);
  report(rows);
});

test("key actions finish within their budgets", async ({ page }) => {
  test.setTimeout(120_000);
  const repo = REPOS.gitflow;
  const { default_branch: branch } = await api("GET", `/api/repos/${repo}`);
  const rows = [];
  await page.addInitScript({ content: `window.settle = ${settle}` });
  // Opens url, waits for it to draw, then clicks target in the page and measures until ready is drawn.
  const time = async (action, budget, url, target, ready) => {
    if (url) {
      await page.goto(url, { waitUntil: "commit" });
      await page.evaluate(settle, target);
    }
    const measured = await page.locator(target).first().evaluate(async (el, ready) => {
      el.dataset.budget = "";
      const t0 = performance.now();
      el.click();
      return (await window.settle(ready)) - t0;
    }, ready);
    rows.push({ page: action, measured: Math.round(measured), budget });
  };
  await time("branch menu open", BRANCH_MENU_MS, `/${repo}/code/${branch}`, "[popovertarget=branch-menu]", "#branch-menu");
  await time("file switch", FILE_SWITCH_MS, `/${repo}/code/${branch}`, 'nav[aria-label=Files] a[href$="/.cinder.yml"]', '.codev[aria-label=".cinder.yml"]');
  await time("board card to Change detail", CARD_TO_DETAIL_MS, `/${repo}/changes`, ".board .chg:not(.intent)", "[role=tablist][aria-label=Change]");
  await time("Change detail tab switch", TAB_SWITCH_MS, null, "[aria-label=Change] [role=tab]:not([aria-selected=true])", "[role=tab][data-budget][aria-selected=true]");
  await time("sidebar navigation", SIDEBAR_NAV_MS, `/${repo}/code/${branch}`, `.side a[href="/${repo}/changes"]`, `.side a[href="/${repo}/changes"][aria-current=page]`);
  await time("Designer flow select", FLOW_SELECT_MS, `/${repo}/flows?view=designer&flow=ci`, ".dag-flows .fcard:not([aria-current=true])", ".fcard[data-budget][aria-current=true]");
  report(rows);
});

test("the SPA and API responses carry the security headers", async ({ request }) => {
  for (const path of ["/", `/${REPOS.gitflow}/changes`, "/api/health", "/api/repos"]) {
    const res = await request.get(path, { headers: { Authorization: `Bearer ${OWNER_TOKEN}` } });
    const h = res.headers();
    expect(h["content-security-policy"], path).toBeTruthy();
    expect(h["x-content-type-options"], path).toBe("nosniff");
    expect(h["referrer-policy"], path).toBeTruthy();
    expect(/frame-ancestors '(none|self)'/.test(h["content-security-policy"]) || /^(deny|sameorigin)$/i.test(h["x-frame-options"] ?? ""), `${path} frame-ancestors`).toBe(true);
  }
});
