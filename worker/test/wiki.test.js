import { env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { anchor, validateWikiComment, validateWikiPage, validateWikiSearchHit, validateWikiTree, validateWikiVersion } from "../src/api/contract.js";
import worker from "../src/index.js";
import { fakeArtifacts } from "./fakes/artifacts.js";
import { ACCESS, as, serveCerts } from "./helpers/access.js";
import { bareRepo, git } from "./fakes/bare-repo.js";

const OWNER = { Authorization: `Bearer ${env.OWNER_TOKEN}` };
// The org wiki is a bare repo in the runner relay, so saves push real commits; other repos are the plain fake.
const WIKI = `wiki-${crypto.randomUUID()}`;
const artifacts = fakeArtifacts();
const fakeGet = artifacts.get.bind(artifacts);
artifacts.get = async (name) => (name === "cinder-wiki" ? bareRepo(WIKI) : fakeGet(name));
const ENV = { ...env, ARTIFACTS: artifacts };
beforeAll(() => git(["init", "-q", "--bare", "-b", "main", `${WIKI}.git`]));
const call = (path, init) => worker.fetch(new Request(`http://cinder.test${path}`, { headers: OWNER, ...init }), ENV);

async function repo(name) {
  expect((await call("/api/repos", { method: "POST", body: JSON.stringify({ name }) })).status).toBe(201);
  const { id } = await env.DB.prepare("SELECT id FROM repos WHERE name = ?").bind(name).first();
  const now = new Date().toISOString();
  return (id_, parent, title, sort, type = "page", content = "") => env.DB.prepare("INSERT INTO wiki_pages VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)")
    .bind(id_, id, parent, title, title.toLowerCase(), type, content, sort, now, now).run();
}

describe("wiki pages", () => {
  it("a fresh repo returns an empty tree", async () => {
    await repo("wiki-empty");
    const res = await call("/api/repos/wiki-empty/wiki/tree");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
    expect((await call("/api/repos/wiki-nope/wiki/tree")).status).toBe(404);
  });

  it("the tree nests children under parents in sort order", async () => {
    const add = await repo("wiki-tree");
    await add("w-guides", null, "Guides", 2, "folder");
    await add("w-intro", null, "Intro", 1);
    await add("w-deploy", "w-guides", "Deploy", 2);
    await add("w-setup", "w-guides", "Setup", 1);
    const tree = await (await call("/api/repos/wiki-tree/wiki/tree")).json();
    expect(validateWikiTree(tree)).toEqual({ ok: true, errors: [] });
    const ids = (nodes) => nodes.map((n) => [n.id, ids(n.children)]);
    expect(ids(tree)).toEqual([["w-intro", []], ["w-guides", [["w-setup", []], ["w-deploy", []]]]]);
  });

  it("the tree marks agent-context pages", async () => {
    const add = await repo("wiki-tree-agent");
    await add("w-ctx", null, "Context", 1);
    await add("w-plain", null, "Plain", 2);
    await env.DB.prepare("INSERT INTO wiki_agent_context (page_id, flagged_at) VALUES ('w-ctx', ?)").bind(new Date().toISOString()).run();
    const tree = await (await call("/api/repos/wiki-tree-agent/wiki/tree")).json();
    expect(validateWikiTree(tree)).toEqual({ ok: true, errors: [] });
    expect(tree.map((n) => [n.id, n.agent_context])).toEqual([["w-ctx", true], ["w-plain", false]]);
  });

  it("reading a page returns its content and bumps view_count", async () => {
    const add = await repo("wiki-read");
    await add("w-read", null, "Readme", 0, "page", "# Hello");
    const first = await (await call("/api/repos/wiki-read/wiki/pages/w-read")).json();
    expect(validateWikiPage(first)).toEqual({ ok: true, errors: [] });
    expect(first).toMatchObject({ id: "w-read", content: "# Hello", view_count: 1 });
    expect((await (await call("/api/repos/wiki-read/wiki/pages/w-read")).json()).view_count).toBe(2);
    expect((await call("/api/repos/wiki-read/wiki/pages/missing")).status).toBe(404);
    expect((await call("/api/repos/wiki-empty/wiki/pages/w-read")).status).toBe(404);
  });

  it("adding and listing comments returns them oldest first", async () => {
    const add = await repo("wiki-comments");
    await add("w-c", null, "Notes", 0);
    const path = "/api/repos/wiki-comments/wiki/pages/w-c/comments";
    for (const body of ["first", "second", "third"]) {
      const res = await call(path, { method: "POST", body: JSON.stringify({ body }) });
      expect(res.status).toBe(201);
      expect(validateWikiComment(await res.json())).toEqual({ ok: true, errors: [] });
    }
    expect((await call(path, { method: "POST", body: JSON.stringify({ body: " " }) })).status).toBe(400);
    const list = await (await call(path)).json();
    expect(list.map((c) => [c.body, c.author, c.edited_at])).toEqual([["first", "owner", null], ["second", "owner", null], ["third", "owner", null]]);
    expect((await call("/api/repos/wiki-comments/wiki/pages/missing/comments")).status).toBe(404);
  });

  it("a non-author edit returns 403", async () => {
    const add = await repo("wiki-edit");
    await add("w-e", null, "Edit", 0);
    await env.DB.prepare("INSERT INTO wiki_page_comments (id, page_id, author, body, created_at) VALUES ('c-ana', 'w-e', 'ana@example.com', 'hi', ?)")
      .bind(new Date().toISOString()).run();
    const path = "/api/repos/wiki-edit/wiki/pages/w-e/comments";
    expect((await call(`${path}/c-ana`, { method: "PATCH", body: JSON.stringify({ body: "changed" }) })).status).toBe(403);
    const { id } = await (await call(path, { method: "POST", body: JSON.stringify({ body: "mine" }) })).json();
    const edited = await (await call(`${path}/${id}`, { method: "PATCH", body: JSON.stringify({ body: "mine, edited" }) })).json();
    expect(edited).toMatchObject({ body: "mine, edited", edited_at: expect.any(String) });
    expect((await call(`${path}/c-ana`, { method: "DELETE" })).status).toBe(204);
    expect((await (await call(path)).json()).map((c) => c.body)).toEqual(["mine, edited"]);
  });

  it("a member deleting someone else's wiki comment gets 403", async () => {
    serveCerts();
    onTestFinished(() => vi.restoreAllMocks());
    const add = await repo("wiki-del");
    await add("w-d", null, "Del", 0);
    await env.DB.prepare("INSERT INTO person_roles (email, role) VALUES ('sam@example.com', 'contributor'), ('ana@example.com', 'contributor')").run();
    await env.DB.prepare("INSERT INTO wiki_page_comments (id, page_id, author, body, created_at) VALUES ('c-del', 'w-d', 'ana@example.com', 'hi', ?)")
      .bind(new Date().toISOString()).run();
    const del = async (email) => (await worker.fetch(new Request("http://cinder.test/api/repos/wiki-del/wiki/pages/w-d/comments/c-del",
      { method: "DELETE", headers: await as(email) }), { ...ACCESS, ARTIFACTS: artifacts })).status;
    expect(await del("sam@example.com")).toBe(403);
    expect(await del("ana@example.com")).toBe(204);
  });

  it("the first use of an empty org wiki commits existing per-repo pages into a folder per repo", async () => {
    const add = await repo("wiki-legacy");
    await add("w-legacy", null, "Legacy", 0, "page", "# Old");
    const dir = `wiki-${crypto.randomUUID()}`;
    await git(["init", "-q", "--bare", "-b", "main", `${dir}.git`]);
    const res = await worker.fetch(new Request("http://cinder.test/api/repos/wiki-legacy/wiki/pages/w-legacy/history", { headers: OWNER }),
      { ...env, ARTIFACTS: { get: async () => bareRepo(dir) } });
    expect((await res.json()).map((v) => [v.version, v.edited_by, v.message])).toEqual([[1, "cinder", "Move per-repo wiki pages into the org wiki"]]);
    expect(await git(["--git-dir", `${dir}.git`, "show", "main:wiki-legacy/w-legacy.md"])).toBe("# Old");
  });

  it("a word from a page body finds the page", async () => {
    const add = await repo("wiki-find");
    await add("f-guides", null, "Guides", 0, "folder");
    await add("f-deploy", "f-guides", "Deploy", 0, "page", "Roll out with the canary pipeline.");
    await add("f-other", null, "Other", 1, "page", "Nothing here.");
    const find = async (q) => (await call(`/api/repos/wiki-find/wiki/search?q=${q}`)).json();
    const hits = await find("canary");
    expect(hits.map((h) => validateWikiSearchHit(h))).toEqual([{ ok: true, errors: [] }]);
    expect(hits[0]).toMatchObject({ id: "f-deploy", path: "guides/deploy", title: "Deploy" });
    const [m] = hits[0].matches;
    expect(hits[0].snippet.slice(m.start, m.end)).toBe("canary");
    await env.DB.prepare("UPDATE wiki_pages SET content = 'Blue green now.' WHERE id = 'f-deploy'").run();
    expect(await find("canary")).toEqual([]);
    expect((await find("green")).map((h) => h.id)).toEqual(["f-deploy"]);
    await env.DB.prepare("DELETE FROM wiki_pages WHERE id = 'f-deploy'").run();
    expect(await find("green")).toEqual([]);
    expect((await call("/api/repos/wiki-nope/wiki/search?q=green")).status).toBe(404);
    expect((await call("/api/repos/wiki-find/wiki/search?q=")).status).toBe(400);
  });

  it("a page containing <script> comes back as plain text", async () => {
    const add = await repo("wiki-xss");
    await add("x-evil", null, "Evil", 0, "page", "<script>alert(1)</script>");
    const res = await call("/api/repos/wiki-xss/wiki/search?q=alert");
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    const [hit] = await res.json();
    expect(validateWikiSearchHit(hit)).toEqual({ ok: true, errors: [] });
    expect(hit.snippet).toBe("<script>alert(1)</script>");
    expect(hit.matches.map((m) => hit.snippet.slice(m.start, m.end))).toEqual(["alert"]);
  });

  const send = (method, path, body) => call(path, { method, body: JSON.stringify(body) });
  // The page's versions as commits in the org wiki repo, oldest first, read with git.
  const versions = async (name, id) => {
    const wiki = (...args) => git(["--git-dir", `${WIKI}.git`, ...args]);
    const shas = (await wiki("log", "--reverse", "--format=%H", `--grep=^Wiki-Page: ${id}$`, "main")).split("\n").filter(Boolean);
    return Promise.all(shas.map(async (sha, i) => ({ version: i + 1, content: await wiki("show", `${sha}:${name}/${id}.md`), edited_by: await wiki("log", "-1", "--format=%an", sha),
      message: (await wiki("log", "-1", "--format=%B", sha)).split("\n").filter((l) => !l.startsWith("Wiki-Page: ")).join("\n").trim() })));
  };

  it("creating then editing a page leaves versions 1 and 2 with editors and messages", async () => {
    await repo("wiki-write");
    const res = await send("POST", "/api/repos/wiki-write/wiki/pages", { title: "Getting Started!", content: "# One", message: "first" });
    expect(res.status).toBe(201);
    const page = await res.json();
    expect(validateWikiPage(page)).toEqual({ ok: true, errors: [] });
    expect(page).toMatchObject({ slug: "getting-started" });
    const twin = await (await send("POST", "/api/repos/wiki-write/wiki/pages", { title: "Getting started", content: "" })).json();
    expect(twin.slug).toBe("getting-started-2");
    const edit = await send("PATCH", `/api/repos/wiki-write/wiki/pages/${page.id}`, { content: "# Two", message: "second", base_version: 1 });
    expect(edit.status).toBe(200);
    expect(await edit.json()).toMatchObject({ content: "# Two" });
    expect(await versions("wiki-write", page.id)).toEqual([
      { version: 1, content: "# One", edited_by: "owner", message: "first" },
      { version: 2, content: "# Two", edited_by: "owner", message: "second" },
    ]);
    const big = "x".repeat(200 * 1024 + 1);
    expect((await send("PATCH", `/api/repos/wiki-write/wiki/pages/${page.id}`, { content: big, base_version: 2 })).status).toBe(413);
  });

  it("a PATCH with only agent_context writes no new version", async () => {
    await repo("wiki-flag-only");
    const page = await (await send("POST", "/api/repos/wiki-flag-only/wiki/pages", { title: "Rules", content: "v1" })).json();
    expect(page.agent_context).toBe(false);
    const res = await send("PATCH", `/api/repos/wiki-flag-only/wiki/pages/${page.id}`, { agent_context: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ agent_context: true, content: "v1" });
    expect(await versions("wiki-flag-only", page.id)).toHaveLength(1);
  });

  it("views count once per person per page per day", async () => {
    serveCerts();
    onTestFinished(() => vi.useRealTimers());
    onTestFinished(() => vi.restoreAllMocks());
    const add = await repo("wiki-views");
    await add("w-views", null, "Seen", 0, "page", "one two three");
    await env.DB.prepare("INSERT OR IGNORE INTO person_roles (email, role) VALUES ('viewer@example.com', 'contributor')").run();
    const read = async (headers = OWNER) => (await (await worker.fetch(new Request("http://cinder.test/api/repos/wiki-views/wiki/pages/w-views", { headers }),
      { ...ACCESS, ARTIFACTS: artifacts })).json()).views;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-01T10:00:00Z"));
    expect(await read()).toBe(1);
    expect(await read()).toBe(1);
    expect(await read(await as("viewer@example.com"))).toBe(2);
    vi.setSystemTime(new Date("2026-10-02T10:00:00Z"));
    expect(await read()).toBe(3);
  });

  it("toc lists ## and ### headings with anchors matching the markdown renderer's", async () => {
    const add = await repo("wiki-toc");
    const text = "# Title\n## Getting Started!\n```\n## not a heading\n```\n### API & Keys\n#### Too deep\n" + "word ".repeat(201);
    await add("w-toc", null, "Toc", 0, "page", text);
    const page = await (await call("/api/repos/wiki-toc/wiki/pages/w-toc")).json();
    expect(validateWikiPage(page)).toEqual({ ok: true, errors: [] });
    expect(page.toc).toEqual([
      { level: 2, text: "Getting Started!", anchor: anchor("Getting Started!") },
      { level: 3, text: "API & Keys", anchor: anchor("API & Keys") },
    ]);
    expect(page.toc.map((h) => h.anchor)).toEqual(["getting-started", "api-keys"]);
    expect(page).toMatchObject({ read_minutes: 2, agent_context: false });
  });

  it("an edit with a stale base_version returns 409 and writes nothing", async () => {
    await repo("wiki-stale");
    const page = await (await send("POST", "/api/repos/wiki-stale/wiki/pages", { title: "Notes", content: "v1" })).json();
    await send("PATCH", `/api/repos/wiki-stale/wiki/pages/${page.id}`, { content: "v2", base_version: 1 });
    const res = await send("PATCH", `/api/repos/wiki-stale/wiki/pages/${page.id}`, { title: "Renamed", content: "lost", base_version: 1 });
    expect(res.status).toBe(409);
    expect(await versions("wiki-stale", page.id)).toHaveLength(2);
    expect(await env.DB.prepare("SELECT title, content FROM wiki_pages WHERE id = ?").bind(page.id).first()).toEqual({ title: "Notes", content: "v2" });
  });

  it("moving a page under its own child returns 400", async () => {
    await repo("wiki-move");
    const post = (body) => send("POST", "/api/repos/wiki-move/wiki/pages", { content: "", ...body }).then((r) => r.json());
    const top = await post({ title: "Top" });
    const child = await post({ title: "Child", parent_id: top.id });
    const grandchild = await post({ title: "Grandchild", parent_id: child.id });
    expect((await send("PATCH", `/api/repos/wiki-move/wiki/pages/${top.id}/move`, { parent_id: grandchild.id, sort_order: 1 })).status).toBe(400);
    expect((await send("PATCH", `/api/repos/wiki-move/wiki/pages/${top.id}/move`, { parent_id: top.id, sort_order: 1 })).status).toBe(400);
    const moved = await send("PATCH", `/api/repos/wiki-move/wiki/pages/${grandchild.id}/move`, { parent_id: null, sort_order: 5 });
    expect(await moved.json()).toMatchObject({ parent_id: null, sort_order: 5 });
  });

  it("deleting a page deletes its children", async () => {
    await repo("wiki-delete");
    const top = await (await send("POST", "/api/repos/wiki-delete/wiki/pages", { title: "Top", content: "a" })).json();
    const child = await (await send("POST", "/api/repos/wiki-delete/wiki/pages", { title: "Child", content: "b", parent_id: top.id })).json();
    expect((await call(`/api/repos/wiki-delete/wiki/pages/${top.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await call(`/api/repos/wiki-delete/wiki/pages/${child.id}`)).status).toBe(404);
    expect((await call(`/api/repos/wiki-delete/wiki/pages/${child.id}/history`)).status).toBe(404);
    expect((await call(`/api/repos/wiki-delete/wiki/pages/${top.id}`, { method: "DELETE" })).status).toBe(404);
  });

  it("history lists versions newest first with editors", async () => {
    await repo("wiki-history");
    const page = await (await send("POST", "/api/repos/wiki-history/wiki/pages", { title: "H", content: "a", message: "first" })).json();
    await send("PATCH", `/api/repos/wiki-history/wiki/pages/${page.id}`, { content: "b", message: "second", base_version: 1 });
    const list = await (await call(`/api/repos/wiki-history/wiki/pages/${page.id}/history`)).json();
    for (const v of list) expect(validateWikiVersion(v)).toEqual({ ok: true, errors: [] });
    expect(list.map(({ version, edited_by, message }) => ({ version, edited_by, message }))).toEqual([
      { version: 2, edited_by: "owner", message: "second" },
      { version: 1, edited_by: "owner", message: "first" },
    ]);
    expect((await call(`/api/repos/wiki-empty/wiki/pages/${page.id}/history`)).status).toBe(404);
  });

  it("diff between two versions shows added and removed lines", async () => {
    await repo("wiki-diff");
    const page = await (await send("POST", "/api/repos/wiki-diff/wiki/pages", { title: "D", content: "keep\nold" })).json();
    await send("PATCH", `/api/repos/wiki-diff/wiki/pages/${page.id}`, { content: "keep\nnew", base_version: 1 });
    const res = await call(`/api/repos/wiki-diff/wiki/pages/${page.id}/diff?from=1&to=2`);
    expect(await res.json()).toEqual({ from: 1, to: 2, lines: [" keep", "-old", "+new"] });
    expect((await call(`/api/repos/wiki-diff/wiki/pages/${page.id}/diff?from=1`)).status).toBe(400);
    expect((await call(`/api/repos/wiki-diff/wiki/pages/${page.id}/diff?from=1&to=7`)).status).toBe(404);
  });

  it("creating, editing and restoring a page writes commits to the org wiki repo and lists history from git", async () => {
    await repo("wiki-restore");
    const page = await (await send("POST", "/api/repos/wiki-restore/wiki/pages", { title: "R", content: "one" })).json();
    await send("PATCH", `/api/repos/wiki-restore/wiki/pages/${page.id}`, { content: "two", base_version: 1 });
    const res = await call(`/api/repos/wiki-restore/wiki/pages/${page.id}/restore/1`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ content: "one" });
    expect(await versions("wiki-restore", page.id)).toEqual([
      { version: 1, content: "one", edited_by: "owner", message: "" },
      { version: 2, content: "two", edited_by: "owner", message: "" },
      { version: 3, content: "one", edited_by: "owner", message: "Restored to v1" },
    ]);
    const history = await (await call(`/api/repos/wiki-restore/wiki/pages/${page.id}/history`)).json();
    expect(history.map(({ version, edited_by, message }) => ({ version, edited_by, message }))).toEqual([
      { version: 3, edited_by: "owner", message: "Restored to v1" },
      { version: 2, edited_by: "owner", message: "" },
      { version: 1, edited_by: "owner", message: "" },
    ]);
    expect((await call(`/api/repos/wiki-restore/wiki/pages/${page.id}/restore/9`, { method: "POST" })).status).toBe(404);
  });
});

describe("stale wiki pages", () => {
  // A repo with page <name>-page mentioning parseConfig, then a merged change <name>-c whose lease holds config.js#parseConfig.
  async function mergeOver(name) {
    const add = await repo(name);
    await add(`${name}-page`, null, "Config", 1, "page", "Startup calls parseConfig on the env.");
    await add(`${name}-other`, null, "Other", 2, "page", "Nothing about config parsing here.");
    const id = `${name}-c`;
    const { id: repo_id } = await env.DB.prepare("SELECT id FROM repos WHERE name = ?").bind(name).first();
    await env.DB.prepare("INSERT INTO changes (id, repo_id, target_branch, state, created_at) VALUES (?, ?, 'main', 'in_queue', '')").bind(id, repo_id).run();
    const change = env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id));
    await runInDurableObject(change, (i) => i.ctx.storage.put({ change: { id, repo_id, target_branch: "main", state: "in_queue" }, events: [] }));
    await env.REPO_DO.get(env.REPO_DO.idFromName(name)).grant("main", id, ["src/config.js#parseConfig"]);
    await change.transition("merged", { kind: "merge_done", actor: { type: "system", id: "r1" }, action: "job.report", target: "j1", result: "done" });
  }
  const flag = (page) => env.DB.prepare("SELECT change_id FROM wiki_stale WHERE page_id = ?").bind(page).first("change_id");

  it("merging a change to parseConfig flags the page that mentions parseConfig", async () => {
    await mergeOver("wiki-flag");
    expect(await flag("wiki-flag-page")).toBe("wiki-flag-c");
    expect(await flag("wiki-flag-other")).toBeNull();
  });

  it("editing the page clears the flag", async () => {
    await mergeOver("wiki-stale-edit");
    expect(await flag("wiki-stale-edit-page")).toBe("wiki-stale-edit-c");
    const history = await (await call("/api/repos/wiki-stale-edit/wiki/pages/wiki-stale-edit-page/history")).json();
    const res = await call("/api/repos/wiki-stale-edit/wiki/pages/wiki-stale-edit-page", { method: "PATCH", body: JSON.stringify({ content: "Startup reads the env.", base_version: history.length }) });
    expect(res.status).toBe(200);
    expect(await flag("wiki-stale-edit-page")).toBeNull();
  });
});
