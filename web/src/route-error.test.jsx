import { describe, expect, it, vi } from "vitest";
import { all, doc, El } from "./fake-dom.js";
import { repoAt } from "./fake-repos.js";
import repos from "../../worker/src/api/fixtures/repos.json";

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { routes } = await import("./routes.jsx");
// Pages load lazily: importing them here first lets a render resolve its route without waiting on a fresh import.
await import("./environments.jsx");
await import("./insights.jsx");
await import("./code.jsx");
await import("./changes.jsx");
await import("./flows.jsx");

const repo = repos[0].name;
const requested = [];
// Live mode against a stand-in Worker: only the repos exist; a repo's changes, tree and flows fail with "boom".
vi.stubGlobal("fetch", async (url) => {
  requested.push(String(url));
  if (repoAt(url)) return Response.json(repoAt(url));
  if (url === "/api/needs") return Response.json([]);
  if (/\/(changes|tree|flows)(\?|$)/.test(String(url))) throw new Error("boom");
  return Response.json({ error: { message: "not found" } }, { status: 404 });
});
vi.stubGlobal("localStorage", { getItem: () => repo, setItem() {} });

async function open(url) {
  const router = createMemoryRouter(routes, { initialEntries: [url] });
  const root = doc.body.appendChild(new El("div"));
  await act(async () => createRoot(root).render(<RouterProvider router={router} />));
  await act(async () => new Promise((r) => setTimeout(r)));
  const text = root.textContent;
  root.remove?.();
  return { router, text, sidebar: all(root).some((n) => n.nodeName === "ASIDE" && n.attrs.class === "side") };
}

describe("route errors", () => {
  it("an ErrorResponse 404 renders its status and text inside the shell, never [object Object]", async () => {
    const { text, sidebar } = await open("/no-such-repo/insights");
    expect(sidebar).toBe(true);
    expect(text).toContain("404 Repo not found");
    expect(text).not.toContain("[object Object]");
  });

  it("a thrown Error(\"boom\") renders boom inside the shell", async () => {
    const { text, sidebar } = await open(`/${encodeURIComponent(repo)}/flows`);
    expect(sidebar).toBe(true);
    expect(text).toContain("boom");
  });
});
