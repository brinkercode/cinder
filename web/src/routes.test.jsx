import { createStaticHandler } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import repos from "../../worker/src/api/fixtures/repos.json";
import { routes } from "./routes.jsx";

beforeEach(() => {
  vi.stubEnv("VITE_FIXTURES", "1");
  vi.stubGlobal("fetch", () => { throw new Error("fixture mode must not fetch"); });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const query = (path) => createStaticHandler(routes).query(new Request(`http://cinder.test${path}`));

it("/:repo/queues is not a route", async () => {
  const res = await query("/acme%2Fweb/queues");
  expect(res.headers.get("Location")).toBe("/acme%2Fweb/code/develop");
});

it("an unknown repo subpath opens Code", async () => {
  for (const path of ["/acme%2Fweb", "/acme%2Fweb/nonexistent-page", "/acme%2Fweb/branches", "/acme%2Fweb/compare?base=develop&head=x", "/acme%2Fweb/leases"]) {
    expect((await query(path)).headers.get("Location"), path).toBe("/acme%2Fweb/code/develop");
  }
});

it("a repo page's loader request starts before the shell's account requests finish", async () => {
  vi.stubEnv("VITE_FIXTURES", "0");
  const repo = repos[0], base = `/api/repos/${encodeURIComponent(repo.name)}`;
  // Only the repo itself answers: the shell's /api/me, /api/me/accounts and /api/repos stay pending.
  vi.stubGlobal("fetch", vi.fn((url) => (url === base ? Promise.resolve(Response.json(repo)) : new Promise(() => {}))));
  query(`/${encodeURIComponent(repo.name)}/flows`);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledWith(`${base}/flows?ref=${repo.default_branch}`));
  expect(fetch).toHaveBeenCalledWith("/api/me");
});

it("each page loads its component lazily", async () => {
  const flat = (rs) => rs.flatMap((r) => [r, ...flat(r.children ?? [])]);
  // Only the shell's own frames are drawn from the entry chunk; every page comes from its route's lazy().
  expect([...new Set(flat(routes).filter((r) => r.element).map((r) => r.element.type.name))]).toEqual(["Shell", "RepoGate", "PickRepo", "WikiFolders"]);
  const lazy = flat(routes).filter((r) => r.lazy);
  expect(lazy.map((r) => r.path)).toEqual(expect.arrayContaining(["/", "code/:ref/*", "changes", "changes/:id/:tab?", "changes/new", "/needs", "/wiki/:repo/:id?"]));
  for (const r of lazy) expect((await r.lazy()).element, r.path).toBeTruthy();
});
