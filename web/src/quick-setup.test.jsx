import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import repos from "../../worker/src/api/fixtures/repos.json";
import { all, click, doc, El } from "./fake-dom.js";

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { Code, codeAction, codeLoader } = await import("./code.jsx");
const { forgetTrees } = await import("./client.js");

// A repo whose default branch is neither main nor the fixture's, so every command must read the real one.
const repo = { ...repos[0], name: "status-page", default_branch: "trunk" };
const REMOTE = "https://git.example.dev/cinder/status-page.git";
const base = `/api/repos/${repo.name}`;
const EMPTY = { [`${base}/tree?ref=trunk&path=&recursive=1`]: { ref: "trunk", sha: null, path: "", entries: [], empty: true, remote: REMOTE }, [`${base}/changes`]: [] };

afterEach(() => { vi.unstubAllEnvs(); forgetTrees(); });

const render = async () => {
  vi.stubEnv("VITE_FIXTURES", "0");
  vi.stubGlobal("sessionStorage", { getItem: () => null, setItem() {} });
  vi.stubGlobal("fetch", (url) => (EMPTY[url] ? Promise.resolve(Response.json(EMPTY[url])) : new Promise(() => {})));
  const router = createMemoryRouter([{ path: "/:repo", id: "repo", loader: () => repo, children: [
    { path: "code/:ref/*", element: <Code />, loader: codeLoader, action: codeAction }] }], { initialEntries: [`/${repo.name}/code/trunk`] });
  const root = doc.body.appendChild(new El("div"));
  await act(async () => createRoot(root).render(<RouterProvider router={router} />));
  return { root, router };
};

describe("Quick setup (empty repository)", () => {
  it("no Import button anywhere on an empty repo", async () => {
    const { root } = await render();
    expect(root.textContent).toContain("Quick setup");
    expect(root.textContent).toContain("status-page is empty. Push an existing project, or create the first file here.");
    expect(root.textContent).toContain("the token from cinder repo credentials status-page");
    expect(root.textContent).not.toMatch(/import/i);
    expect(all(root).filter((n) => n.nodeName === "A").map((n) => n.attrs.href)).not.toContain(`/${repo.name}/settings`);
  });

  it("the card is centred vertically and horizontally in .f-body at 1440, 1024 and 390px", async () => {
    const { root } = await render();
    const body = all(root).find((n) => n.attrs.class === "f-body");
    expect(body.childNodes.map((n) => n.attrs.class)).toEqual(["panel qs"]);
    const css = readFileSync(new URL("styles/quick-setup.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    // No @media: the same rules hold at every width.
    expect(css).not.toContain("@media");
    const rule = (sel) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(([, s]) => s.trim() === sel)?.[2].split(";");
    expect(rule(".frame:has(.qs)")).toEqual(expect.arrayContaining(["min-height:100%", "display:flex", "flex-direction:column"]));
    expect(rule(".frame:has(.qs)>.fc")).toEqual(expect.arrayContaining(["flex:1", "width:100%", "display:flex", "flex-direction:column"]));
    expect(rule(".frame:has(.qs) .f-body")).toEqual(expect.arrayContaining(["flex:1", "place-items:center"]));
    expect(rule(".qs")).toEqual(expect.arrayContaining(["width:100%", "max-width:760px"]));
    // The app's own rules never turn .f-body into anything but the grid that place-items centres in.
    const app = readFileSync(new URL("styles/app.css", import.meta.url), "utf8");
    expect([...app.matchAll(/(?:^|[},])\s*\.f-body\{([^}]*)\}/g)].map(([, b]) => b).join(";")).not.toMatch(/display:(?!grid)/);
  });

  it("every command uses the real host, repo name and default branch", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { root } = await render();
    const pres = all(root).filter((n) => n.nodeName === "PRE").map((n) => n.textContent);
    expect(pres).toEqual([
      ['echo "# status-page" >> README.md', "git init", "git add README.md", 'git commit -m "first commit"', "git branch -M trunk",
        `git remote add origin ${REMOTE}`, "git push -u origin trunk"].join("\n"),
      [`git remote add origin ${REMOTE}`, "git branch -M trunk", "git push -u origin trunk"].join("\n"),
    ]);
    expect(root.textContent).toContain("The first push to trunk lands directly.");
    expect(root.textContent).toContain("work arrives as changes on refs/for/trunk");
    await act(async () => click(all(root).find((n) => n.attrs["aria-label"] === "Copy clone URL")));
    await act(async () => click(all(root).find((n) => n.attrs["aria-label"] === "Copy: Push an existing repository from the command line")));
    expect(writeText.mock.calls).toEqual([[REMOTE], [pres[1]]]);
  });

  it("opening an empty repo throws no errors and handles no file selected", async () => {
    const consoleError = vi.spyOn(console, "error");
    const { root, router } = await render();
    // Create a README opens the new-file editor prefilled; Add a file opens it blank.
    await act(async () => click(all(root).find((n) => n.nodeName === "A" && n.textContent === "Create a README")));
    expect(router.state.location.search).toBe("?v=new");
    const path = () => all(root).find((n) => n.attrs["aria-label"] === "New file path");
    expect(path().value).toBe("README.md");
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("the first commit on an empty repo starts the branch with base_sha null", async () => {
    vi.stubEnv("VITE_FIXTURES", "0");
    const sent = [];
    vi.stubGlobal("fetch", async (url, init) => { sent.push([url, JSON.parse(init.body)]); return Response.json({ branch: "trunk", sha: "a".repeat(40) }, { status: 201 }); });
    const form = new FormData();
    for (const [k, v] of Object.entries({ op: "commit", base_sha: "", path: "README.md", content: "# status-page", intent: "first commit" })) form.set(k, v);
    const res = await codeAction({ request: new Request("http://cinder.test/x", { method: "POST", body: form }), params: { repo: repo.name, ref: "trunk", "*": "" } });
    expect(sent).toEqual([[`${base}/commits`, { branch: "trunk", base_sha: null, message: "first commit", changes: [{ path: "README.md", content: "# status-page" }] }]]);
    expect(res.headers.get("Location")).toBe("/status-page/code/trunk/README.md?v=history");
  });
});
