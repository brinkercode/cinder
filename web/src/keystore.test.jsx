import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { all, click, doc, El } from "./fake-dom.js";

doc.oninput = null; // react-dom checks "oninput" in document once, at import; without it a text input's onChange never fires

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { Keystore, keystoreLoader } = await import("./keystore.jsx");

const SECRET = { id: "ks_1", name: "STRIPE_WEBHOOK_SECRET", kind: "environment_secret", scope: "environment", repo: "billing-api", environment: "production", flow: null,
  owner: "jon@nimbusedge.dev", expires_at: null, created_at: "2026-10-01T00:00:00Z", rotated_at: null, last_used: null, changed_by: "jon@nimbusedge.dev" };

// answer(url): each request's Response, or a pending Promise.
const mount = async (answer) => {
  vi.stubEnv("VITE_FIXTURES", "0");
  vi.stubGlobal("sessionStorage", { getItem: () => null });
  const fetch = vi.fn(async (url, init) => answer(url, init));
  vi.stubGlobal("fetch", fetch);
  const router = createMemoryRouter([{ path: "/settings/keystore", element: <Keystore />, loader: keystoreLoader }], { initialEntries: ["/settings/keystore"] });
  const root = doc.body.appendChild(new El("div"));
  await act(async () => createRoot(root).render(<RouterProvider router={router} />));
  return { root, fetch, find: (pred) => all(root).find(pred) };
};
const lists = (secrets, wanted = []) => (url) => Response.json({ "/api/keystore": { secrets, wanted }, "/api/keystore/usage": { used: 96, limit: 100 } }[url]);

afterEach(() => vi.unstubAllEnvs()); // not unstubAllGlobals: that drops fake-dom.js's window

describe("keystore", () => {
  it("keystore loading shows skeletons, then the secrets", async () => {
    const loading = await mount(() => new Promise(() => {}));
    expect(loading.find((n) => n.attrs["aria-busy"] === "true").childNodes).toHaveLength(5);
    const { root } = await mount(lists([SECRET]));
    expect(root.textContent).toContain("STRIPE_WEBHOOK_SECRETenvironmentbilling-api › productionneverjon · ");
    expect(root.textContent).toContain("Secrets Store: 96 of 100 secrets used (beta limit per account)");
    expect(root.textContent).toContain("set •••• Replace Remove");
  });

  it("Add secret is disabled until the secrets list loads", async () => {
    let answer;
    const pending = new Promise((r) => { answer = r; });
    const { find } = await mount(async (url) => { await pending; return lists([SECRET])(url); });
    const add = () => find((n) => n.nodeName === "BUTTON" && n.textContent === "Add secret");
    expect([add().attrs.disabled, add().attrs["aria-disabled"], add().attrs.title]).toEqual(["", "true", "Available once the secrets list loads"]);
    await act(async () => answer());
    expect(["disabled" in add().attrs, "aria-disabled" in add().attrs]).toEqual([false, false]);
  });

  it("the secrets list renders before usage answers", async () => {
    const usage = Promise.withResolvers();
    const { root } = await mount((url) => (url === "/api/keystore/usage" ? usage.promise : lists([SECRET])(url)));
    expect(root.textContent).toContain("STRIPE_WEBHOOK_SECRET");
    const bar = all(root).find((n) => n.attrs.class === "tb");
    const before = bar.parentNode.childNodes[bar.parentNode.childNodes.indexOf(bar) - 1];
    expect(before.childNodes[0].attrs.class).toBe("bone");
    await act(async () => usage.resolve(Response.json({ used: 96, limit: 100 })));
    expect(root.textContent).toContain("Secrets Store: 96 of 100 secrets used (beta limit per account)");
  });

  it("the Keystore skeleton renders a usage-line bone in the same position the usage line takes with data", async () => {
    const beforeBar = ({ root }) => { const bar = all(root).find((n) => n.attrs.class === "tb"); return bar.parentNode.childNodes[bar.parentNode.childNodes.indexOf(bar) - 1]; };
    const bone = beforeBar(await mount(() => new Promise(() => {})));
    expect(bone.attrs.class).toBe("meta");
    expect(bone.childNodes[0].attrs.class).toBe("bone");
    const line = beforeBar(await mount(lists([SECRET])));
    expect(line.attrs.class).toBe("meta");
    expect(line.textContent).toContain("Secrets Store: 96 of 100");
  });

  it("Keystore has no Runner tokens card", async () => {
    const { root, fetch } = await mount(lists([SECRET]));
    expect(root.textContent).toContain("STRIPE_WEBHOOK_SECRET");
    expect(root.textContent).not.toContain("Runner tokens");
    expect(root.textContent).not.toContain("New token");
    expect(fetch.mock.calls.map(([url]) => url)).not.toContain("/api/workers");
  });

  it("keystore error shows the card error with Retry", async () => {
    const { find } = await mount(() => new Response("", { status: 503 }));
    expect(find((n) => n.attrs.role === "alert").textContent).toBe("Couldn't load the keystore: /api/keystore: HTTP 503Retry");
  });

  it("keystore with no secrets shows No secrets stored", async () => {
    const { root } = await mount(lists([]));
    expect(root.textContent).toContain("No secrets stored");
  });

  it("personal keys never appear here: the page reads only the org keystore and points to My model access", async () => {
    const { fetch, find } = await mount(lists([SECRET]));
    expect(fetch.mock.calls.map(([url]) => url).sort()).toEqual(["/api/keystore", "/api/keystore/usage"]);
    expect(find((n) => n.nodeName === "A" && n.textContent === "My model access").attrs.href).toBe("/me/models");
    const gateway = find((n) => n.nodeName === "A" && n.textContent === "AI Gateway › Provider Keys");
    expect([gateway.attrs.href, gateway.attrs.target]).toEqual(["https://dash.cloudflare.com/?to=/:account/ai/ai-gateway", "_blank"]);
  });

  it("search and the scope filter narrow the secrets", async () => {
    const org = { ...SECRET, id: "ks_2", name: "SENTRY_DSN", scope: "global", repo: null, environment: null };
    const shown = async (label, value) => {
      const { find, root } = await mount(lists([SECRET, org]));
      const el = find((n) => n.attrs["aria-label"] === label);
      await act(async () => {
        Object.assign(el, { value, type: el.attrs.type ?? "text" }); // React treats only typed inputs as text inputs
        for (const type of ["input", "change"]) for (let n = el; n; n = n.parentNode) for (const f of n.listeners[type] ?? []) f({ type, target: el, bubbles: true, preventDefault() {}, stopPropagation() {} });
      });
      return [SECRET.name, org.name].filter((name) => root.textContent.includes(name));
    };
    expect(await shown("Scope", "global")).toEqual(["SENTRY_DSN"]);
    expect(await shown("Search secrets", "stripe")).toEqual(["STRIPE_WEBHOOK_SECRET"]);
  });

  it("usage doc lists scope filtering under What you can do, absent from Planned", () => {
    const md = readFileSync(new URL("../../docs/usage/keystore.md", import.meta.url), "utf8");
    const section = (h) => md.split(`\n## ${h}\n`)[1].split("\n## ")[0];
    expect(section("What you can do")).toMatch(/filter them by scope/);
    expect(section("Planned")).not.toMatch(/scope/i);
  });

  const press = (el) => act(async () => click(el));

  // Clicks Remove on SECRET's row; returns the confirm dialog (fake-dom has no showModal) and the DELETE calls so far.
  const clickRemove = async () => {
    const page = await mount(lists([SECRET]));
    const dialog = page.find((n) => n.nodeName === "DIALOG" && n.textContent.startsWith("Remove "));
    dialog.showModal = vi.fn();
    await act(async () => click(page.find((n) => n.nodeName === "BUTTON" && n.textContent === "Remove")));
    const deletes = () => page.fetch.mock.calls.filter(([, init]) => init?.method === "DELETE").map(([url]) => url);
    const close = (value) => act(async () => { dialog.returnValue = value; for (const f of dialog.listeners.close) f({ type: "close", target: dialog }); });
    return { dialog, deletes, close };
  };

  it("clicking Remove makes no DELETE request and shows a dialog naming the secret and its Applies to text", async () => {
    const { dialog, deletes } = await clickRemove();
    expect(deletes()).toEqual([]);
    expect(dialog.showModal).toHaveBeenCalled();
    expect(dialog.textContent).toContain("Remove STRIPE_WEBHOOK_SECRET?");
    expect(dialog.textContent).toContain("Applies to billing-api › production. It is deleted from Secrets Store and can't be undone.");
  });

  it("confirming Remove sends DELETE /api/keystore/<id>; cancelling sends nothing", async () => {
    const cancelled = await clickRemove();
    await cancelled.close("cancel");
    expect(cancelled.deletes()).toEqual([]);
    const confirmed = await clickRemove();
    await confirmed.close("ok");
    expect(confirmed.deletes()).toEqual(["/api/keystore/ks_1"]);
  });

  it("Wanted by flows links each missing secret to its run and Add fills the name", async () => {
    const wanted = [{ name: "AWS_SECRET_ACCESS_KEY", repo: "billing-api", flow: "deploy", step: "ship", run_id: "run_42" }];
    const { find } = await mount(lists([SECRET], wanted));
    const card = find((n) => n.attrs.class === "card" && n.textContent.startsWith("Wanted by flows"));
    const link = all(card).find((n) => n.nodeName === "A");
    expect([link.textContent, link.attrs.href]).toEqual(["billing-api › deploy › ship", "/billing-api/flows?flow=deploy&run=run_42"]);
    expect(card.textContent).toContain("AWS_SECRET_ACCESS_KEY");
    const dialog = find((n) => n.nodeName === "DIALOG" && n.textContent.startsWith("Add secret"));
    dialog.showModal = vi.fn();
    await press(all(card).find((n) => n.nodeName === "BUTTON" && n.textContent === "Add"));
    expect(dialog.showModal).toHaveBeenCalled();
    expect(all(dialog).find((n) => n.nodeName === "INPUT" && n.name === "name").value).toBe("AWS_SECRET_ACCESS_KEY");
  });
});
