import { afterEach, expect, it, vi } from "vitest";
import { all, click, doc, El } from "./fake-dom.js";

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { Agent, agentLoader, Agents, agentsLoader } = await import("./automation-agents.jsx");

Object.assign(El.prototype, { showModal() { this.attrs.open = ""; }, close() {} });

const ver = (name, version, races, wins) => ({ id: `${name}@${version}`, name, version, harness: "claude-code", model: "claude-sonnet-5", effort: "default", prompt_hash: "h",
  tools: [], limits: { max_cost_usd: 8, max_minutes: 120 }, released_at: null, egress: null, races, wins });
const AGENTS = [["developer", 7, 20, 14, "stable"], ["splitter", 1, 19, 19, "stable"], ["dev-open", 1, 0, 0, "canary"]]
  .map(([name, version, races, wins, channel]) => ({ name, versions: [ver(name, version, races, wins)], channels: [{ channel, version }] }));
const CATALOG = [["claude-sonnet-5", "anthropic", ["claude-code", "opencode"]], ["gpt-5-codex", "openai", ["codex", "opencode"]], ["Kimi K2.7 Code", "cf", ["opencode"]]]
  .map(([id, provider, harnesses]) => ({ id, provider, context: "200k", price: "$1 / $5", harnesses, hosted: provider === "cf" }));
const ACCESS = { source: "credits", account: null, org_keys: [], usage: { tokens: 0, cost_usd: 0, runs: 0 }, providers: [["cf", "Cloudflare credits", "credits", "connected"], ["anthropic", "Anthropic", null, "missing"],
  ["openai", "OpenAI", "org", "failing"]].map(([id, name, source, status]) => ({ id, name, source, method: null, status, reason: null, last_used_at: null })) };
const API = { "/api/agents": AGENTS, "/api/fleet": { canary_auto_promote: false, agents: [] }, "/api/races": [], "/api/models/catalog": CATALOG, "/api/me/models": ACCESS,
  "/api/agents/splitter": { ...AGENTS[1], prompt: "Split it.", draft_model: null, draft_egress: ["pkg.go.dev"] }, "/api/races?agent=splitter": [] };

const mount = async (path, over = {}) => {
  vi.stubEnv("VITE_FIXTURES", "0");
  vi.stubGlobal("sessionStorage", { getItem: () => null });
  vi.stubGlobal("fetch", vi.fn(async (url) => { const body = { ...API, ...over }[url]; return typeof body === "function" ? body() : Response.json(body); }));
  const router = createMemoryRouter([{ path: "/automation/agents", element: <Agents />, loader: agentsLoader },
    { path: "/automation/agents/:name/:tab?", element: <Agent />, loader: agentLoader }], { initialEntries: [path] });
  const root = doc.body.appendChild(new El("div"));
  await act(async () => createRoot(root).render(<RouterProvider router={router} />));
  const find = (pred) => all(root).find(pred);
  return { root, find, button: (text) => find((n) => n.nodeName === "BUTTON" && n.textContent === text) };
};
// React's handler on a radio, since the fake DOM has no checked state for React to see change.
const pick = (radio) => act(async () => radio[Object.keys(radio).find((k) => k.startsWith("__reactProps"))].onChange());

afterEach(() => vi.unstubAllEnvs()); // not unstubAllGlobals: that drops fake-dom.js's window

it("The wizard can't finish without a working credential: a missing or failing provider disables Continue until a model with one is picked", async () => {
  const { find, button } = await mount("/automation/agents");
  await act(async () => click(button("New agent")));
  await act(async () => click(button("Continue")));
  const step = () => [find((n) => n.nodeName === "SPAN" && /^No credential for /.test(n.textContent))?.textContent, "disabled" in button("Continue").attrs];
  expect(step()).toEqual(["No credential for Anthropic. Agents can't start without one.", true]);
  expect(find((n) => n.nodeName === "A" && n.textContent === "Connect in My model access").attrs.href).toBe("/me/models");
  const harness = (h) => find((n) => n.name === "harness" && n.parentNode.textContent.startsWith(h));
  await pick(harness("Codex"));
  expect(step()).toEqual(["No credential for OpenAI. Agents can't start without one.", true]);
  // Changing the harness resets the model to its first, the suggested Cloudflare-hosted one, which credits cover.
  await pick(harness("OpenCode"));
  expect(step()).toEqual([undefined, false]);
  expect(find((n) => n.nodeName === "DIV" && n.textContent.startsWith("Runs will use")).textContent).toBe("Runs will use Cloudflare credits");
  await pick(find((n) => n.name === "model" && n.value === "Kimi K2.7 Code"));
  await act(async () => click(button("Continue")));
  expect("disabled" in button("Create agent").attrs).toBe(false);
});

it("the harness picker offers only supported harnesses", async () => {
  const { root, button } = await mount("/automation/agents");
  await act(async () => click(button("New agent")));
  expect(all(root).filter((n) => n.name === "harness").map((n) => n.parentNode.textContent))
    .toEqual(["Claude CodeAnthropic models only", "CodexOpenAI models with the Responses API", "OpenCodeAny provider"]);
});

it("with an Anthropic model in the catalog and a connected Anthropic credential, Claude Code lists it and Continue is enabled", async () => {
  const providers = ACCESS.providers.map((p) => (p.id === "anthropic" ? { ...p, source: "mine", status: "connected" } : p));
  const { root, find, button } = await mount("/automation/agents", { "/api/models/catalog": [CATALOG[0], CATALOG[2]], "/api/me/models": { ...ACCESS, providers } });
  await act(async () => click(button("New agent")));
  await act(async () => click(button("Continue")));
  expect(all(root).filter((n) => n.name === "model").map((n) => n.value)).toEqual(["claude-sonnet-5"]);
  expect("disabled" in button("Continue").attrs).toBe(false);
  // A harness with no models in the catalog says so, not that a credential is missing.
  await pick(find((n) => n.name === "harness" && n.parentNode.textContent.startsWith("Codex")));
  expect(find((n) => n.nodeName === "P" && n.textContent.startsWith("No "))?.textContent).toBe("No Codex models in the catalog.");
  expect(find((n) => n.nodeName === "SPAN" && /^No credential for /.test(n.textContent))).toBeUndefined();
  expect("disabled" in button("Continue").attrs).toBe(true);
});

it("Every rate under 20 races is untrusted: the index and the win rate tile show untrusted or no outcomes yet, never a percentage", async () => {
  const { root } = await mount("/automation/agents");
  const text = all(root).filter((n) => n.attrs.class === "lc-f").map((n) => n.childNodes[0].textContent);
  expect(text).toEqual(["Win rate 70% n=20", "Win rate untrusted: 19 outcomes", "Win rate no outcomes yet"]);
  const tile = all((await mount("/automation/agents/splitter/runs")).root).find((n) => n.attrs.class === "tile flat" && n.textContent.startsWith("Win rate"));
  expect(tile.textContent).toBe("Win rate—untrusted: 19 outcomes");
});

it("Dummy data (client-only state): agents loading shows skeletons", async () => {
  const { find } = await mount("/automation/agents", { "/api/agents": () => new Promise(() => {}) });
  expect(find((n) => n.attrs["aria-busy"] === "true").childNodes).toHaveLength(3);
});

it("Dummy data (client-only state): an agents error shows the card error with Retry", async () => {
  const { find } = await mount("/automation/agents", { "/api/fleet": () => new Response("", { status: 503 }) });
  expect(find((n) => n.attrs.role === "alert").textContent).toBe("Couldn't load agents: /api/fleet: HTTP 503Retry");
});

it("No agents: the index says No agents registered with New agent", async () => {
  const { find } = await mount("/automation/agents", { "/api/agents": [] });
  expect(find((n) => n.attrs.class === "empty").textContent).toBe("No agents registeredRegister an agent to let it pick up intents.New agent");
});

it("Dummy data (client-only state): a catalog error shows Retry on the wizard's step 2, and Retry reloads it", async () => {
  let fail = true;
  const { find, button } = await mount("/automation/agents", { "/api/models/catalog": () => (fail ? new Response("", { status: 503 }) : Response.json(CATALOG)) });
  await act(async () => click(button("New agent")));
  await act(async () => click(button("Continue")));
  expect([find((n) => n.attrs.role === "alert").textContent, "disabled" in button("Continue").attrs]).toEqual(["Couldn't load the model catalog: /api/models/catalog: HTTP 503Retry", true]);
  fail = false;
  await act(async () => click(button("Retry")));
  expect([find((n) => n.attrs.role === "alert"), find((n) => n.name === "model")?.value]).toEqual([undefined, "claude-sonnet-5"]);
});

it("Settings & prompt with an invalid saved model selects it and shows the not-available notice", async () => {
  const { root, find } = await mount("/automation/agents/splitter/settings", { "/api/agents/splitter": { ...AGENTS[1], prompt: "Split it.", draft_model: "Kimi K2.7 Code", draft_egress: [] } });
  const props = (n) => n[Object.keys(n).find((k) => k.startsWith("__reactProps"))];
  const checked = all(root).filter((n) => n.nodeName === "INPUT" && props(n).checked).map((n) => props(n).value);
  expect(checked).toEqual(["Kimi K2.7 Code"]);
  expect(find((n) => n.attrs.class === "pill" && n.textContent === "Not available for this harness")).toBeTruthy();
});

it("shows a marketplace agent's prompt read-only", async () => {
  const { root, find } = await mount("/automation/agents/splitter/settings", { "/api/agents/splitter": { ...AGENTS[1], marketplace: true, prompt: "Split it.", draft_model: null, draft_egress: [] } });
  const buttons = all(root).filter((n) => n.nodeName === "BUTTON").map((n) => n.textContent);
  expect([buttons.includes("Edit"), !!find((n) => n.textContent === "Installed from the marketplace; its prompt is locked."), !!find((n) => n.textContent === "Split it.")]).toEqual([false, true, true]);
});

it("the Settings Network allowlist adds and removes hosts in the draft, not the released version", async () => {
  const { find } = await mount("/automation/agents/splitter/settings", { "/api/agents/splitter/draft": () => Response.json({}) });
  const props = (n) => n[Object.keys(n).find((k) => k.startsWith("__reactProps"))];
  const drafts = () => fetch.mock.calls.filter(([url, init]) => init?.method === "PUT" && url === "/api/agents/splitter/draft").map(([, init]) => JSON.parse(init.body).egress);
  await act(async () => props(find((n) => n.attrs["aria-label"] === "Add a host")).onChange({ target: { value: " *.GitHub.com " } }));
  await act(async () => props(find((n) => n.nodeName === "FORM")).onSubmit({ preventDefault() {} }));
  await act(async () => click(find((n) => n.attrs["aria-label"] === "Remove pkg.go.dev")));
  expect(drafts()).toEqual([["pkg.go.dev", "*.github.com"], []]);
  expect(fetch.mock.calls.some(([url, init]) => init?.method && url !== "/api/agents/splitter/draft")).toBe(false);
});

const leg = (race, name, won) => ({ change_id: `${race}-${name}`, leg: name, won, started_at: new Date().toISOString(), model: null, tokens: null, duration_ms: null, verdict: null, diff_lines: null, new_deps: null, review_findings: null, cost_usd: null,
  tests_total: null, tests_passed: null, p_merge: null, rpm: null, rpm_limit: null });
const tags = (root, cls) => all(all(root).find((n) => n.attrs.class === cls)).filter((n) => n.nodeName === "TD" && /^(won|lost|pending)$/.test(n.textContent)).map((n) => n.textContent);

it("A leg with won: null renders no lost tag", async () => {
  const races = [{ id: "inherited:178db711", winner: null, legs: [leg("a", "splitter@v1", null), leg("a", "developer@v7", null)] }];
  const { root } = await mount("/automation/agents/splitter/races", { "/api/races?agent=splitter": races });
  expect(tags(root, "tbl")).toEqual(["pending", "pending"]);
});

it("Recent races with winner: null renders no race as lost", async () => {
  // Legs scored 0 but no winner yet: the race is undecided, so not lost. Inherited ids skip the change fetch.
  const races = ["inherited:r1", "inherited:r2"].map((id) => ({ id, winner: null, legs: [leg(id, "splitter@v1", 0), leg(id, "developer@v7", 0)] }));
  const { root } = await mount("/automation/agents/splitter/races", { "/api/races?agent=splitter": races });
  expect(tags(root, "tbl cm")).toEqual(["pending", "pending"]);
});

// developer: v8 canary at 20% with 3 outcomes, v7 stable, v6 older; the PUTs answer from moved.
const versionsTab = async (over = {}) => {
  const out = (merged, n) => ({ merged, n, trusted: false });
  const raw = { mode: "raw", converted: 0, saved_bytes: 0 };
  const versions = [{ version: 6, channel: null, share: 0, released_at: "2026-10-01T09:00:00Z", outcomes: out(15, 30), web: raw },
    { version: 7, channel: "stable", share: 0, released_at: "2026-10-04T09:00:00Z", outcomes: out(20, 25), web: raw },
    { version: 8, channel: "canary", share: 20, released_at: "2026-10-07T09:00:00Z", outcomes: out(2, 3), web: { mode: "markdown", converted: 18, saved_bytes: 412000 } }];
  const history = [{ kind: "released", version: 7, share: null, by: "maya@example.com", at: "2026-10-04T09:00:00Z" },
    { kind: "rolled_back", version: 7, share: null, by: "maya@example.com", at: "2026-10-07T10:00:00Z" }];
  const moved = vi.fn(() => Response.json({}));
  const page = await mount(over.path ?? "/automation/agents/developer/versions", { "/api/agents/developer": { ...AGENTS[0], prompt: null, draft_model: null, draft_egress: [] },
    "/api/races?agent=developer": [], "/api/agents/developer/versions": versions, "/api/agents/developer/history": history,
    "/api/agents/developer/channels/stable": moved, "/api/agents/developer/channels/canary": moved, ...over });
  await act(async () => {});
  const rows = () => all(page.root).filter((n) => n.nodeName === "TR").slice(1, 4).map((r) => r.childNodes.slice(0, 4).map((c) => c.textContent));
  const puts = () => fetch.mock.calls.filter(([, init]) => init?.method === "PUT").map(([url, init]) => [url, JSON.parse(init.body)]);
  const dialog = page.find((n) => n.nodeName === "DIALOG");
  const confirm = async (label) => {
    await act(async () => click(page.button(label)));
    const text = dialog.textContent;
    await act(async () => { dialog.returnValue = "ok"; for (const f of dialog.listeners.close) f({ type: "close", target: dialog }); });
    return text;
  };
  return { ...page, rows, puts, confirm };
};
it("the Versions tab shows each version's web setting and the responses it converted", async () => {
  const { root } = await versionsTab();
  const web = all(root).filter((n) => n.nodeName === "TR").slice(1, 4).map((r) => r.childNodes[4].textContent);
  expect(web).toEqual(["markdown · 18 converted · 412k bytes saved", "raw", "raw"]);
});
const reactProps = (n) => n[Object.keys(n).find((k) => k.startsWith("__reactProps"))];

it("Traffic changes apply to new runs: the canary's slider PUTs its share and stable shows the remainder", async () => {
  const { root, find, rows, puts } = await versionsTab();
  expect(rows()).toEqual([["developer@v8", "canary", "20%", "untrusted: 3 outcomes"], ["developer@v7", "stable", "80%", "80.0% n=25"],
    ["developer@v6", "—", "0%", "50.0% n=30"]]);
  expect(all(root).some((n) => n.nodeName === "TD" && n.textContent === "Rolled back stable to v7 by maya@example.com")).toBe(true);
  const slider = find((n) => n.attrs?.["aria-label"] === "Canary traffic share");
  await act(async () => reactProps(slider).onChange({ target: { value: "35" } }));
  expect(rows()[1][2]).toBe("65%");
  await act(async () => reactProps(slider).onPointerUp());
  expect(puts()).toEqual([["/api/agents/developer/channels/canary", { version: 8, share: 35 }]]);
});

it("Rollback moves the stable channel. Runs in flight finish on the old version: Roll back to v6 confirms, then points stable at v6", async () => {
  const { confirm, puts } = await versionsTab();
  expect(await confirm("Roll back to v6")).toContain("Stable moves from v7 to v6 for every new run. Runs already going finish on v7.");
  expect(puts()).toEqual([["/api/agents/developer/channels/stable", { version: 6 }]]);
});

it("Promote to stable warns that the canary is untrusted before pointing stable at it", async () => {
  const { confirm, puts } = await versionsTab();
  expect(await confirm("Promote to stable")).toContain("v8's win rate is untrusted: 3 outcomes. Promoting before 20 outcomes");
  expect(puts()).toEqual([["/api/agents/developer/channels/stable", { version: 8 }]]);
});

const props = (n) => n[Object.keys(n).find((k) => k.startsWith("__reactProps"))];
const DRAFT = { harness: "claude-code", model: "claude-sonnet-5", effort: "default", tools: [], limits: { max_cost_usd: 8, max_minutes: 120 }, prompt: "Split it.\nStack first.", saved_at: new Date().toISOString() };
const DIFF = { "/api/agents/splitter/diff?from=1&to=draft": { from: "1", to: "draft", fields: [{ field: "egress", from: ["pkg.go.dev"], to: ["pkg.go.dev", "api.example.com"], widens: true }],
  prompt: [" Split it.", "+Stack first."] } };
const closeDialog = (dialog) => act(async () => { dialog.returnValue = "ok"; for (const f of dialog.listeners.close) f({ type: "close", currentTarget: dialog, target: dialog }); });

it("A draft never runs: Edit then Save draft saves splitter@v2-draft, not running anywhere, and releases or moves nothing", async () => {
  let draft = null;
  const put = vi.fn(() => { draft = DRAFT; return Response.json(DRAFT); });
  const { root, find, button } = await mount("/automation/agents/splitter/settings", { ...DIFF, "/api/agents/splitter/draft": put,
    "/api/agents/splitter": () => Response.json({ ...AGENTS[1], prompt: "Split it.", draft_model: draft?.model ?? null, draft_egress: [], draft }) });
  expect(find((n) => n.textContent === "not running anywhere")).toBeUndefined();
  await act(async () => click(button("Edit")));
  const area = find((n) => n.nodeName === "TEXTAREA");
  await act(async () => props(area).onChange({ target: { value: "Split it.\nStack first." } }));
  await act(async () => click(button("Save draft")));
  expect(JSON.parse(fetch.mock.calls.find(([url]) => url === "/api/agents/splitter/draft")[1].body)).toMatchObject({ prompt: "Split it.\nStack first.", model: "claude-sonnet-5" });
  expect(find((n) => n.nodeName === "H3" && n.textContent === "splitter@v2-draft")).toBeTruthy();
  expect(root.textContent).toContain("not running anywhere");
  expect(find((n) => n.attrs.class === "draft-diff").textContent).toBe(" Split it.\n+Stack first.\n+egress: api.example.com\n");
  expect(fetch.mock.calls.filter(([url]) => /\/(release|channels)/.test(url))).toEqual([]);
});

it("the draft card's diff shows a web setting change", async () => {
  const { find } = await mount("/automation/agents/splitter/settings", { "/api/agents/splitter/diff?from=1&to=draft": { from: "1", to: "draft",
    fields: [{ field: "web", from: "raw", to: "markdown", widens: false }], prompt: [" Split it."] },
  "/api/agents/splitter": { ...AGENTS[1], prompt: "Split it.", draft_model: DRAFT.model, draft_egress: [], draft: DRAFT } });
  expect(find((n) => n.attrs.class === "draft-diff").textContent).toBe(" Split it.\n-web: raw\n+web: markdown\n");
});

it("Release tags the version and points the chosen channel at it: Release v2… to stable posts the channel and note", async () => {
  const release = vi.fn(() => Response.json({ id: "j1" }, { status: 202 }));
  const { find, button } = await mount("/automation/agents/splitter/settings", { ...DIFF, "/api/agents/splitter/release": release,
    "/api/agents/splitter": { ...AGENTS[1], prompt: "Split it.", draft_model: DRAFT.model, draft_egress: [], draft: DRAFT } });
  await act(async () => click(button("Release v2…")));
  const dialog = find((n) => n.nodeName === "DIALOG" && n.textContent.startsWith("Release splitter@v2"));
  await pick(all(dialog).filter((n) => n.nodeName === "INPUT" && (n.attrs.type ?? n.type) === "radio")[1]);
  await act(async () => props(all(dialog).find((n) => n.nodeName === "INPUT" && (n.attrs.type ?? n.type) !== "radio")).onChange({ target: { value: "Stack first" } }));
  await closeDialog(dialog);
  expect(release).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fetch.mock.calls.find(([url]) => url === "/api/agents/splitter/release")[1].body)).toEqual({ channel: "stable", note: "Stack first" });
});

it("Catalog links a third-party model to its own page", async () => {
  const catalog = [["@cf/moonshotai/kimi-k2.7-code", "cf"], ["anthropic/claude-sonnet-5", "anthropic"]].map(([id, provider]) => ({ ...CATALOG[2], id, provider }));
  const { root, button } = await mount("/automation/agents", { "/api/models/catalog": catalog });
  await act(async () => click(button("New agent")));
  await act(async () => click(button("Continue")));
  await pick(all(root).find((n) => n.name === "harness" && n.parentNode.textContent.startsWith("OpenCode")));
  expect(all(root).filter((n) => n.nodeName === "A" && n.textContent === "Catalog ").map((n) => n.attrs.href)).toEqual([
    "https://developers.cloudflare.com/workers-ai/models/kimi-k2.7-code/", "https://developers.cloudflare.com/ai/models/anthropic/claude-sonnet-5/"]);
});

const V6 = { id: "agent/developer/v6", name: "developer", version: 6, harness: "claude-code", model: "claude-sonnet-5", effort: "default", prompt_hash: "h", tools: ["bash"],
  limits: { max_cost_usd: 8, max_minutes: 120 }, egress: ["pkg.go.dev"], web: "raw", prompt: "# Developer v6\nWrite tests first." };
const openV6 = async (over = {}) => {
  const page = await versionsTab({ "/api/agents/developer/versions/6": V6, ...over });
  await act(async () => click(page.find((n) => n.nodeName === "A" && n.textContent === "developer@v6")));
  return page;
};

it("a version row opens that version's prompt and lock", async () => {
  const { root, find } = await openV6();
  expect(find((n) => n.nodeName === "H3" && n.textContent === "developer@v6")).toBeTruthy();
  expect(all(root).filter((n) => n.nodeName === "DT").map((n) => `${n.textContent}: ${n.parentNode.childNodes[1].textContent}`)).toEqual(["Model: claude-sonnet-5",
    "Harness: claude-code", "Effort: default", "Tools: bash", "Limits: $8.00 · 120 min", "Egress: pkg.go.dev", "Web: raw"]);
  expect(find((n) => n.nodeName === "DIV" && n.attrs.class === "md").childNodes.map((n) => `${n.nodeName}: ${n.textContent}`)).toEqual(["H2: Developer v6", "P: Write tests first."]);
  await act(async () => reactProps(find((n) => n.attrs?.["aria-label"] === "Raw prompt")).onChange({ target: { checked: true } }));
  expect(find((n) => n.nodeName === "PRE" && n.attrs.class === "prompt").textContent).toBe("# Developer v6\nWrite tests first.");
});

it("an agent's page lists its versions and opens one with its prompt and diff", async () => {
  const V7 = { ...V6, version: 7, model: "gpt-5-codex", prompt: "# Developer v6\nWrite tests last." };
  const { root, find } = await versionsTab({ path: "/automation/agents/developer", "/api/agents/developer/versions/7": V7,
    "/api/agents/developer/diff?from=6&to=7": { from: "6", to: "7", fields: [], prompt: [" # Developer v6", "-Write tests first.", "+Write tests last."] } });
  const by = all(root).filter((n) => n.nodeName === "TR").slice(1, 4).map((r) => r.childNodes[6].textContent);
  expect(by).toEqual(["cinder", "maya@example.com", "cinder"]);
  await act(async () => click(find((n) => n.nodeName === "A" && n.textContent === "developer@v7")));
  expect(find((n) => n.nodeName === "H3" && n.textContent === "developer@v7")).toBeTruthy();
  expect(find((n) => n.nodeName === "DIV" && n.attrs.class === "md").textContent).toBe("Developer v6Write tests last.");
  expect(find((n) => n.attrs.class === "draft-diff").textContent).toBe(" # Developer v6\n-Write tests first.\n+Write tests last.\n");
});

it("two versions compare by prompt and lock", async () => {
  const { find } = await openV6({ "/api/agents/developer/diff?from=6&to=8": { from: "6", to: "8", fields: [{ field: "model", from: "claude-sonnet-5", to: "gpt-5-codex", widens: false },
    { field: "egress", from: ["pkg.go.dev"], to: [], widens: false }], prompt: [" # Developer v6", "-Write tests first.", "+Write tests last."] } });
  await act(async () => reactProps(find((n) => n.attrs?.["aria-label"] === "Compare with")).onChange({ target: { value: "8" } }));
  expect(find((n) => n.attrs.class === "draft-diff").textContent)
    .toBe(" # Developer v6\n-Write tests first.\n+Write tests last.\n-model: claude-sonnet-5\n+model: gpt-5-codex\n-egress: pkg.go.dev\n");
});

it("editing from an old version starts the draft from it", async () => {
  let draft = null;
  const put = vi.fn(async (init) => { draft = { ...JSON.parse(init.body), saved_at: new Date().toISOString() }; return Response.json(draft); });
  const { root, button } = await openV6({ "/api/agents/developer/draft": () => put(fetch.mock.calls.at(-1)[1]),
    "/api/agents/developer": () => Response.json({ ...AGENTS[0], prompt: "Stable prompt.", draft_model: draft?.model ?? null, draft_egress: draft?.egress ?? [], draft }),
    "/api/agents/developer/diff?from=7&to=draft": { from: "7", to: "draft", fields: [], prompt: ["-Stable prompt.", "+# Developer v6", "+Write tests first."] } });
  await act(async () => click(button("Edit from this version")));
  const { harness, model, effort, tools, egress, web, limits, prompt } = V6;
  expect(JSON.parse(fetch.mock.calls.find(([url]) => url === "/api/agents/developer/draft")[1].body)).toEqual({ harness, model, effort, tools, egress, web, limits, prompt });
  expect(root.textContent).toContain("Draft saved · ");
  expect(all(root).find((n) => n.attrs.class === "draft-diff").textContent).toBe("-Stable prompt.\n+# Developer v6\n+Write tests first.\n");
  expect(all(root).find((n) => n.nodeName === "PRE" && n.attrs.class === "card-b prompt").textContent).toBe(V6.prompt);
});
