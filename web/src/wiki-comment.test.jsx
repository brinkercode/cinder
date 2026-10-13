import { afterEach, describe, expect, it, vi } from "vitest";
import history from "../../worker/src/api/fixtures/wiki-history.json";
import { all, doc, El } from "./fake-dom.js";

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { Wiki, wikiAction, wikiLoader } = await import("./wiki.jsx");

const PAGE = "/wiki/acme%2Fweb/p-arch";
const API = "/api/repos/acme%2Fweb/wiki";
const tree = [{ id: "p-arch", parent_id: null, title: "Architecture", slug: "architecture", type: "page", sort_order: 1, agent_context: false, children: [] }];
const row = { id: "p-arch", repo_id: "r-web", parent_id: null, title: "Architecture", slug: "architecture", type: "page", content: "Leases first.",
  sort_order: 1, view_count: 4, created_at: "2026-10-01T08:00:00.000Z", updated_at: "2026-10-04T16:20:00.000Z",
  agent_context: false, words: 2, read_minutes: 1, views: 3, toc: [] };
const comment = { id: "c1", page_id: "p-arch", author: "owner", body: "Ship it", created_at: "2026-10-06T09:00:00.000Z", edited_at: null };

// Posts "Ship it" through the page's comment form; post is the POST's Response.
const postComment = async (post) => {
  vi.stubEnv("VITE_FIXTURES", "0");
  vi.stubGlobal("sessionStorage", { getItem: () => null });
  let comments = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    if (init?.method === "POST") {
      if (post.ok) comments = [comment];
      return post;
    }
    return Response.json({ "/api/repos": [], [`${API}/tree`]: tree, [`${API}/pages/p-arch/history`]: history, [`${API}/pages/p-arch/comments`]: comments, [`${API}/pages/p-arch`]: row }[url]);
  }));
  const router = createMemoryRouter([{ path: "/wiki/:repo/:id?", element: <Wiki />, loader: wikiLoader, action: wikiAction }], { initialEntries: [PAGE] });
  const root = doc.body.appendChild(new El("div"));
  await act(async () => createRoot(root).render(<RouterProvider router={router} />));
  const box = () => all(root).find((n) => n.attrs["aria-label"] === "New comment");
  box().value = "Ship it";
  const formData = new FormData();
  formData.set("intent", "comment");
  formData.set("body", box().value);
  await act(async () => router.navigate(PAGE, { formMethod: "post", formData }));
  return { root, text: box().value };
};

afterEach(() => vi.unstubAllEnvs()); // not unstubAllGlobals: that drops fake-dom.js's window

describe("wiki comment composer", () => {
  it("posting a comment successfully empties the textarea", async () => {
    const { root, text } = await postComment(Response.json(comment, { status: 201 }));
    expect(root.textContent).toContain("Ship it"); // the posted comment renders
    expect(text ?? "").toBe("");
  });

  it("a failed post keeps the text", async () => {
    const { root, text } = await postComment(Response.json({ error: { code: "boom", message: "comment refused" } }, { status: 500 }));
    expect(root.textContent).toContain("comment refused");
    expect(text).toBe("Ship it");
  });
});
