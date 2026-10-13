import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import repos from "../../worker/src/api/fixtures/repos.json";
import { all, click, doc, El } from "./fake-dom.js";

// The live connection is down and the branch list fails to load, for the shell's states test.
vi.mock("./client.js", async (real) => ({ ...(await real()), reconnecting: () => true, branchesFor: () => Promise.reject(new Error("refs down")) }));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { Shell } = await import("./shell.jsx");

async function mountShell(path) {
  const router = createMemoryRouter([{ path: "/", element: <Shell />, loader: () => ({ repos, needs: Promise.resolve([]) }), children: [{ path: "*" }] }],
    { initialEntries: [path] });
  const root = doc.body.appendChild(new El("div"));
  await act(async () => createRoot(root).render(<RouterProvider router={router} />));
  const aside = all(root).find((n) => n.nodeName === "ASIDE");
  const heads = () => all(aside).filter((n) => n.attrs.class === "sec-head");
  const head = (name) => heads().find((h) => h.textContent === name);
  const expanded = () => heads().filter((h) => h.attrs["aria-expanded"] === "true").map((h) => h.textContent);
  return { aside, router, head, expanded };
}

describe("sidebar sections", () => {
  it("navigating to a route in Settings opens Settings and closes the previously open section", async () => {
    const { router, head, expanded } = await mountShell("/automation/agents");
    expect(expanded()).toEqual(["Automation"]);
    expect(head("Settings").attrs["aria-controls"]).toBe("sec-Settings");
    await act(() => router.navigate("/settings/keystore"));
    expect(expanded()).toEqual(["Settings"]);
    expect(head("Automation").attrs["aria-expanded"]).toBe("false");
  });

  it("clicking an open section's header closes it, and clicking another opens it and closes the first", async () => {
    const { head, expanded } = await mountShell("/automation/agents");
    expect(head("Automation").nodeName).toBe("BUTTON");
    await act(() => click(head("Automation")));
    expect(expanded()).toEqual([]);
    await act(() => click(head("Settings")));
    expect(expanded()).toEqual(["Settings"]);
    await act(() => click(head("Automation")));
    expect(expanded()).toEqual(["Automation"]);
  });

  it("Web test: the sidebar has no Community group and no Explore, Topics or Spotlight link", async () => {
    const { aside, head } = await mountShell("/");
    expect(head("Community")).toBeUndefined();
    const links = all(aside).filter((n) => n.nodeName === "A").map((a) => [a.attrs.href, a.textContent]);
    expect(links.filter(([href, text]) => /explore|topics|spotlight|community/i.test(`${href} ${text}`))).toEqual([]);
  });

  it("Git's header element has the same class as the Build group label and still shows the Beta pill", async () => {
    const { aside } = await mountShell("/");
    const label = (text) => all(aside).find((n) => n.childNodes[0]?.nodeValue === text);
    const [build, git] = [label("Build"), label("Git")];
    expect(build.attrs.class).toBe("slabel");
    expect([git.nodeName, git.attrs.class]).toEqual([build.nodeName, build.attrs.class]);
    expect(git.childNodes.map((c) => [c.attrs.class, c.textContent])).toEqual([[undefined, "Git"], ["pill", "Beta"]]);
    expect(all(git).some((n) => n.nodeName === "SVG")).toBe(false);
  });

  it("the open group shows the guide line element", async () => {
    const { aside, head } = await mountShell("/automation/agents");
    const body = all(aside).find((n) => n.attrs.id === head("Automation").attrs["aria-controls"]);
    const line = all(body).find((n) => n.attrs.class === "sec-line");
    expect(line.attrs["aria-hidden"]).toBe("true");
    expect(all(line.parentNode).filter((n) => n.nodeName === "A").length).toBeGreaterThan(0);
  });
});

describe("round 2 placement", () => {
  beforeAll(() => { globalThis.localStorage = { getItem: () => null, setItem() {} }; });
  afterAll(() => { delete globalThis.localStorage; });
  const mount = async (path) => {
    const router = createMemoryRouter([{ path: "/", element: <Shell />, loader: () => ({ repos, needs: Promise.resolve([]) }),
      children: [{ path: ":repo/*", id: "repo", loader: () => repos[1] }, { path: "wiki/*" }, { path: "*" }] }], { initialEntries: [path] });
    const root = doc.body.appendChild(new El("div"));
    await act(async () => createRoot(root).render(<RouterProvider router={router} />));
    const body = (name) => all(root).find((n) => n.attrs.id === `sec-${name}`);
    const links = (name) => all(body(name)).filter((n) => n.nodeName === "A");
    return { root, links };
  };
  const repo = `/${encodeURIComponent(repos[1].name)}`;

  it("the Automation section lists Agents, Judges & calibration, Flows, Environments, Workers in order", async () => {
    const { links } = await mount("/automation/agents");
    expect(links("Automation").map((a) => a.textContent)).toEqual(["Agents", "Marketplace", "Judges & calibration", "Flows", "Environments", "Workers"]);
  });

  it("the Code group lists Code, Changes, Watchtower, Insights, Settings, then All repositories, and Wiki sits after Code", async () => {
    const { root, links } = await mount(`${repo}/changes`);
    expect(links("Code").slice(-6).map((a) => a.textContent)).toEqual(["Code", "Changes", "Watchtower", "Insights", "Settings", `All repositories${repos.length}`]);
    const git = all(root).find((n) => n.attrs["aria-label"] === "Git");
    expect(git.childNodes.map((n) => (n.attrs.class === "sec" ? n.childNodes[0].textContent : n.textContent))).toEqual(["Code", "Wiki", "Automation", "Needs you", "Settings"]);
    expect(git.childNodes[1].attrs.href).toBe("/wiki");
  });

  it("/releases highlights Code, /wiki/* highlights Wiki", async () => {
    const current = async (path) => all(all((await mount(path)).root).find((n) => n.nodeName === "ASIDE")).filter((n) => n.attrs["aria-current"] === "page").map((n) => n.textContent);
    expect(await current(`${repo}/releases`)).toEqual(["Code"]);
    expect(await current(`/wiki/${encodeURIComponent(repos[1].name)}/p-arch`)).toEqual(["Wiki"]);
  });

  it("/wiki/<repo> reads Wiki › {repo ▾} with no branch switcher", async () => {
    const { root } = await mount(`/wiki/${encodeURIComponent(repos[1].name)}`);
    const crumb = all(root).find((n) => n.attrs["aria-label"] === "Breadcrumb");
    expect(crumb.childNodes.filter((n) => n.nodeName === "SPAN" || n.nodeName === "BUTTON").map((n) => n.textContent)).toEqual(["Wiki", repos[1].name]);
    expect(all(crumb).filter((n) => n.nodeName === "A").map((a) => a.attrs.href)).toEqual(repos.map((r) => `/wiki/${encodeURIComponent(r.name)}`));
    expect(all(root).some((n) => n.attrs.id === "branch-menu")).toBe(false);
  });

  it("on /<repo>/flows the breadcrumb starts with Automation › Flows and the Automation Flows item is current", async () => {
    const { root, links } = await mount(`${repo}/flows`);
    const crumb = all(root).find((n) => n.attrs["aria-label"] === "Breadcrumb");
    expect(crumb.childNodes.filter((n) => n.nodeName === "SPAN").slice(0, 3).map((n) => n.textContent)).toEqual(["Automation", "Flows", repos[1].name]);
    expect(links("Automation").find((a) => a.attrs["aria-current"] === "page").textContent).toBe("Flows");
    expect(links("Code").some((a) => a.attrs["aria-current"] === "page")).toBe(false);
  });
});

describe("backed by links", () => {
  it("each page renders a link to dash.cloudflare.com with the account id and resource", async () => {
    globalThis.localStorage = { getItem: () => null, setItem() {} };
    const router = createMemoryRouter([{ path: "/", element: <Shell />, loader: () => ({ repos, needs: Promise.resolve([]) }),
      children: [{ path: ":repo/*", id: "repo", loader: () => repos[1] }, { path: "automation/*" }, { path: "settings/*" }] }], { initialEntries: ["/automation/judges"] });
    const root = doc.body.appendChild(new El("div"));
    await act(async () => createRoot(root).render(<RouterProvider router={router} />));
    const repo = `/${encodeURIComponent(repos[1].name)}`;
    const dash = "https://dash.cloudflare.com/?to=/:account/";
    const pages = {
      [`${repo}/code/main`]: `workers/artifacts/cinder/${encodeURIComponent(repos[1].name)}`, [`${repo}/changes`]: "workers/durable-objects",
      [`${repo}/flows`]: "workers/workflows/cinder-pipeline", [`${repo}/insights`]: "ai/ai-gateway/cinder/logs", "/automation/judges": "ai/workers-ai",
      "/automation/workers": "workers/containers", "/settings/access": "one/access/apps", "/settings/keystore": "secrets-store",
    };
    const backed = () => all(root).filter((n) => n.nodeName === "A" && n.textContent.startsWith("Backed by")).map((n) => n.attrs.href);
    for (const [path, resource] of Object.entries(pages)) {
      await act(() => router.navigate(path));
      expect([path, backed()]).toEqual([path, [dash + resource]]);
    }
    const stub = (label) => all(root).find((n) => n.attrs.class === "stub" && n.textContent === label);
    expect([stub("Compute").nodeName, stub("Compute").attrs.href]).toEqual(["A", `${dash}workers/services/view/cinder/production`]);
    expect(stub("Storage & databases").attrs.href).toBe(`${dash}workers/d1`);
    expect(stub("Zero Trust").attrs.href).toBe(`${dash}one/access/apps`);
    delete globalThis.localStorage; // not vi.unstubAllGlobals(): that also drops fake-dom's window
  });
});

describe("shell states", () => {
  it("Needs-you error shows ! with a tooltip, the header shows no Live badge even when the connection drops, a failed branch load offers Retry", async () => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem() {} });
    const needs = Promise.reject(new Error("inbox down")); needs.catch(() => {}); // <Await> still sees the rejection
    const router = createMemoryRouter([{ path: "/", element: <Shell />, loader: () => ({ repos, needs }),
      children: [{ path: ":repo/*", id: "repo", loader: () => repos[1] }] }], { initialEntries: ["/acme%2Fweb/changes"] });
    const root = doc.body.appendChild(new El("div"));
    await act(async () => createRoot(root).render(<RouterProvider router={router} />));
    const at = (pred) => all(root).find(pred);
    expect(at((n) => n.attrs.class === "count" && n.textContent === "!").attrs.title).toBe("Couldn't load Needs you");
    expect(all(root).some((n) => /^live\b/.test(n.attrs.class ?? "") || n.textContent === "live" || n.textContent === "reconnecting")).toBe(false);
    const menu = at((n) => n.attrs.id === "branch-menu");
    await act(async () => menu.listeners.toggle.forEach((f) => f({ type: "toggle", target: menu, newState: "open" })));
    expect(at((n) => n.attrs.role === "alert").textContent).toBe("Couldn't load branches Retry");
    vi.unstubAllGlobals();
  });
});

describe("context card", () => {
  const keys = [];
  const mount = async () => {
    keys.length = 0;
    // The states test above unstubbed fake-dom's globals.
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("document", doc);
    vi.stubGlobal("window", Object.assign(globalThis, { addEventListener: (type, f) => type === "keydown" && keys.push(f), removeEventListener() {} }));
    vi.stubGlobal("localStorage", { getItem: () => null, setItem() {} });
    const router = createMemoryRouter([{ path: "/", element: <Shell />, loader: () => ({ repos, needs: Promise.resolve([]) }),
      children: [{ path: ":repo/*", id: "repo", loader: () => repos[1] }] }], { initialEntries: ["/acme%2Fweb/changes"] });
    const root = doc.body.appendChild(new El("div"));
    await act(async () => createRoot(root).render(<RouterProvider router={router} />));
    return all(root);
  };
  afterAll(() => vi.unstubAllGlobals());

  it("the context card has a repo button and a branch button, each its own tab stop", async () => {
    const card = (await mount()).find((n) => n.attrs.class === "ctx" && n.parentNode.parentNode.attrs.id === "sec-Code");
    expect(card.childNodes.map((b) => [b.nodeName, b.attrs.class, b.attrs.tabindex, b.attrs.disabled])).toEqual([["BUTTON", "ctx-r", undefined, undefined], ["BUTTON", "ctx-b", undefined, undefined]]);
    expect(card.childNodes[0].attrs.popovertarget ?? card.childNodes[0].attrs.popoverTarget).toBe("sec-repo-menu");
    expect(card.childNodes[1].textContent).toBe(repos[1].default_branch);
  });

  it("B opens the branch menu, but not while typing in an input", async () => {
    const nodes = await mount();
    const menu = nodes.find((n) => n.attrs.id === "branch-menu");
    const calls = [];
    menu.showPopover = () => calls.push("open");
    doc.getElementById = (id) => nodes.find((n) => n.attrs?.id === id) ?? null;
    doc.querySelector = () => null;
    const press = (key, target = { closest: () => null }) => keys.forEach((f) => f({ key, target, preventDefault() {} }));
    press("b"); press("b", { closest: () => ({}) });
    expect(calls).toEqual(["open"]);
  });
});

describe("sidebar stylesheet", () => {
  const css = readFileSync(new URL("styles/app.css", import.meta.url), "utf8");
  const tokens = readFileSync(new URL("styles/tokens.css", import.meta.url), "utf8");
  // No layout engine in tests: each spec size is read from the rule that sets it.
  const rule = (sel) => css.match(new RegExp(`(?:^|\\})${sel.replace(/[.*+?^$()[\]]/g, "\\$&")}\\{([^}]*)\\}`, "m"))?.[1];

  it("computed sizes match the spec: rows 34px with 1px gap, header 58px, footer 48px, sub-items indented 28px, sidebar 260px", () => {
    expect(rule(".stub,.sec-head,.nav a")).toContain("height:34px");
    expect(rule(".sb-menu,.nav")).toContain("gap:1px");
    expect(rule(".sec-body>div")).toMatch(/gap:1px;padding-left:28px/);
    expect(rule(".sb-header")).toContain("height:58px");
    expect(rule(".sb-footer")).toContain("height:48px");
    expect(rule(".app")).toContain("grid-template-columns:260px minmax(0,1fr)");
    expect(css).toContain("dialog.drawer{margin:0;height:100vh;max-height:none;width:280px");
    expect(rule(".slabel")).toContain("margin:16px 0 8px");
  });

  it("the stylesheet has the grid-template-rows 0fr→1fr transition with cubic-bezier(0.77,0,0.175,1) and a reduced-motion override", () => {
    expect(tokens).toContain("--ease-sidebar:cubic-bezier(0.77,0,0.175,1);--dur-sidebar:320ms;");
    expect(rule(".sec-body")).toBe("display:grid;grid-template-rows:0fr;transition:grid-template-rows var(--dur-sidebar) var(--ease-sidebar)");
    expect(rule('.sec-head[aria-expanded="true"]+.sec-body')).toBe("grid-template-rows:1fr");
    expect(rule(".sec-body>div")).toMatch(/^min-height:0;overflow:hidden;/);
    expect(rule(".sec-head>.ico:last-child")).toBe("transition:rotate var(--dur-sidebar) var(--ease-sidebar)");
    expect(css).toContain("@media (prefers-reduced-motion:reduce){.sec-body,.sec-head>.ico:last-child{transition:none}}");
  });

  it("a long sidebar scrolls with no visible scrollbar", () => {
    expect(rule(".sb-viewport")).toBe("flex:1;overflow-y:auto;padding:12px 14px;scrollbar-width:none");
    expect(rule(".side")).toContain("min-height:0");
    // The drawer's row is capped so its viewport, not the whole dialog, scrolls.
    expect(rule("dialog.drawer[open]")).toBe("display:grid;grid-template-rows:minmax(0,1fr)");
  });

  it("the guide line is a 1px --sb-line down the left of the children", () => {
    expect(rule(".sec-body>div")).toContain("overflow:hidden;position:relative");
    expect(rule(".sec-line")).toBe("position:absolute;top:0;bottom:0;left:20px;border-left:var(--bw) solid var(--sb-line)");
  });

  it("the transition uses grid-template-rows and there's no height animation", () => {
    const transitions = [...css.matchAll(/transition:([^;}]*)/g)].map((m) => m[1]);
    expect(transitions).toContain("grid-template-rows var(--dur-sidebar) var(--ease-sidebar)");
    expect(transitions.filter((t) => /height/.test(t))).toEqual([]);
    expect(readFileSync(new URL("shell.jsx", import.meta.url), "utf8")).not.toMatch(/scrollHeight|offsetHeight|clientHeight|getBoundingClientRect/);
  });

  it("the shell stylesheet sets the sidebar column to 260px for widths above 900px", () => {
    expect(rule(".app")).toContain("grid-template-columns:260px minmax(0,1fr)");
    // Any max-width breakpoint above 900px that resizes .app's columns would shrink the sidebar there.
    const wide = [...css.matchAll(/@media \(max-width:(\d+)px\)\{([^@]*)\}/g)].filter(([, w, body]) => +w > 900 && /(^|\})\.app\{[^}]*grid-template-columns/.test(body));
    expect(wide.map(([m]) => m)).toEqual([]);
  });
});
