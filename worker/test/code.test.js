import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { validateAuthorship, validateCodeFile, validateCodeTree } from "../src/api/contract.js";
import { indexCode } from "../src/code.js";
import { onPushes } from "../src/pushes.js";
import worker from "../src/index.js";
import { fakeArtifacts } from "./fakes/artifacts.js";

const OWNER = { Authorization: `Bearer ${env.OWNER_TOKEN}` };

// Artifacts' push event for store; a refs/cinder/ ref does nothing past dropping the store's cached heads.
const pushed = (store) => onPushes({ messages: [{ body: { type: "cf.artifacts.repo.pushed", source: { repoName: store }, payload: { ref: "refs/cinder/x", after: "b".repeat(40) } } }] }, env);

async function setup(name) {
  const fake = fakeArtifacts();
  const call = (path, init) => worker.fetch(new Request(`http://cinder.test${path}`, { headers: OWNER, ...init }), { ...env, ARTIFACTS: fake });
  expect((await call("/api/repos", { method: "POST", body: JSON.stringify({ name }) })).status).toBe(201);
  const repo = fake.repos.get(name);
  repo.branches = ["main"];
  repo.commits.unshift({ sha: "m1" });
  Object.assign(repo.files, { "README.md": "# hi", "src/a.js": "a", "src/lib/b.js": "b" });
  return { fake, call, repo };
}

describe("code browse api", () => {
  it("tree lists a branch's directory", async () => {
    const { call } = await setup("code-tree");
    const res = await call("/api/repos/code-tree/tree?ref=main&path=src");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(validateCodeTree(body)).toEqual({ ok: true, errors: [] });
    expect(body).toEqual({ ref: "main", sha: "m1", path: "src", entries: [
      { name: "a.js", path: "src/a.js", type: "blob" },
      { name: "lib", path: "src/lib", type: "tree" },
    ] });
  });

  it("GET /api/repos/:name/tree?ref=main returns the root entries; a subdirectory path returns its entries", async () => {
    const { call } = await setup("code-root");
    const root = await (await call("/api/repos/code-root/tree?ref=main")).json();
    expect(validateCodeTree(root)).toEqual({ ok: true, errors: [] });
    expect(root).toEqual({ ref: "main", sha: "m1", path: "", remote: "https://artifacts.fake/cinder/code-root.git", entries: [
      { name: "README.md", path: "README.md", type: "blob" },
      { name: "src", path: "src", type: "tree" },
    ] });
    const sub = await (await call("/api/repos/code-root/tree?ref=main&path=src/lib")).json();
    expect(sub).toEqual({ ref: "main", sha: "m1", path: "src/lib", entries: [{ name: "b.js", path: "src/lib/b.js", type: "blob" }] });
    expect((await call("/api/repos/code-root/tree?ref=main&path=README.md")).status).toBe(404);
  });

  it("a change id reads from its fork's head", async () => {
    const { fake, call } = await setup("code-chg");
    const id = crypto.randomUUID();
    const repoId = (await env.DB.prepare("SELECT id FROM repos WHERE name = ?").bind("code-chg").first()).id;
    await env.DB.prepare("INSERT INTO changes (id, repo_id, target_branch, state, created_at) VALUES (?, ?, 'main', 'planned', ?)")
      .bind(id, repoId, new Date().toISOString()).run();
    await env.DB.prepare("INSERT INTO change_numbers VALUES (?1, ?2, 1, 'code-chg--c' || ?1)").bind(id, repoId).run();
    const fork = await fake.get("code-chg").then((r) => r.fork(`code-chg--c${id}`));
    fork.commits.unshift({ sha: "f1" });
    fork.files["src/a.js"] = "edited";

    const res = await call(`/api/repos/code-chg/file?ref=${id}&path=src/a.js`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(validateCodeFile(body)).toEqual({ ok: true, errors: [] });
    expect(body).toEqual({ ref: id, sha: "f1", path: "src/a.js", size: 6, content: "edited" });
    expect(fake.calls).toContainEqual({ method: "readFile", args: [`code-chg--c${id}`, "f1", "src/a.js"] });

    fake.repos.get(`code-chg--c${id}`).files["big.bin"] = "x".repeat(1024 * 1024 + 1);
    const big = await (await call(`/api/repos/code-chg/file?ref=${id}&path=big.bin`)).json();
    expect(big).toMatchObject({ size: 1024 * 1024 + 1, content: null });
  });

  it("raw serves a file's bytes, typed as an image only for image extensions and sandboxed", async () => {
    const { call, repo } = await setup("code-raw");
    Object.assign(repo.files, { "img/logo.png": new Uint8Array([137, 80, 78, 71, 0, 255]), "img/x.svg": "<svg><script>1</script></svg>" });
    const png = await call("/api/repos/code-raw/raw?ref=main&path=img/logo.png");
    expect(png.status).toBe(200);
    expect(png.headers.get("Content-Type")).toBe("image/png");
    expect([...new Uint8Array(await png.arrayBuffer())]).toEqual([137, 80, 78, 71, 0, 255]);
    const svg = await call("/api/repos/code-raw/raw?ref=main&path=img/x.svg");
    expect(svg.headers.get("Content-Type")).toBe("image/svg+xml");
    expect(svg.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(svg.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect((await call("/api/repos/code-raw/raw?ref=main&path=src/a.js")).headers.get("Content-Type")).toBe("application/octet-stream");
    expect((await call("/api/repos/code-raw/raw?ref=main&path=nope.png")).status).toBe(404);
    expect((await worker.fetch(new Request("http://cinder.test/api/repos/code-raw/raw?ref=main&path=img/logo.png"), env)).status).toBe(401);
  });

  it("unknown ref → 404", async () => {
    const { call } = await setup("code-404");
    expect((await call("/api/repos/code-404/tree?ref=nope")).status).toBe(404);
    expect((await call("/api/repos/code-404/file?ref=nope&path=README.md")).status).toBe(404);
    expect((await call("/api/repos/code-404/tree?ref=main")).status).toBe(200);
  });

  it("an empty repo's tree returns 200 with empty:true and the clone URL", async () => {
    const fake = fakeArtifacts();
    const call = (path, init) => worker.fetch(new Request(`http://cinder.test${path}`, { headers: OWNER, ...init }), { ...env, ARTIFACTS: fake });
    expect((await call("/api/repos", { method: "POST", body: JSON.stringify({ name: "code-empty" }) })).status).toBe(201);
    const res = await call("/api/repos/code-empty/tree?ref=develop&path=");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(validateCodeTree(body)).toEqual({ ok: true, errors: [] });
    expect(body).toEqual({ ref: "develop", sha: null, path: "", entries: [], empty: true, remote: "https://artifacts.fake/cinder/code-empty.git" });
  });

  it("an unknown ref returns 404 ref_not_found", async () => {
    const { call } = await setup("code-noref");
    const res = await call("/api/repos/code-noref/tree?ref=develop&path=");
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("ref_not_found");
  });

  it("authorship is cached per sha and path once the blame job reports", async () => {
    const { call, repo } = await setup("code-blame");
    const { id, token: runner } = await (await call("/api/runners", { method: "POST", body: JSON.stringify({ name: "lab", kinds: ["blame"] }) })).json();
    // The runner holds the repo's queued blame job, as a claim would leave it.
    const put = async (lines, sha = "m1") => {
      await env.DB.prepare("UPDATE jobs SET status = 'claimed', runner_id = ?, lease_expires_at = ? WHERE kind = 'blame' AND status = 'queued' AND json_extract(payload, '$.store') = 'code-blame'")
        .bind(id, new Date(Date.now() + 60000).toISOString()).run();
      return call(`/api/work/repos/code-blame/authorship/${sha}?path=src/a.js`, { method: "PUT", headers: { Authorization: `Bearer ${runner}` }, body: JSON.stringify(lines) });
    };
    const repoId = (await env.DB.prepare("SELECT id FROM repos WHERE name = ?").bind("code-blame").first()).id;
    const jobs = async () => (await env.DB.prepare("SELECT payload FROM jobs WHERE repo_id = ? AND kind = 'blame'").bind(repoId).all()).results;

    for (let i = 0; i < 2; i++) {
      const res = await call("/api/repos/code-blame/authorship?ref=main&path=src/a.js");
      expect(res.status).toBe(202);
      expect(validateAuthorship(await res.json())).toEqual({ ok: true, errors: [] });
    }
    expect(await jobs()).toEqual([{ payload: JSON.stringify({ store: "code-blame", sha: "m1", path: "src/a.js" }) }]);
    expect((await call("/api/repos/code-blame/authorship?ref=main")).status).toBe(400);

    expect((await put([{ commit: "m1" }])).status).toBe(400);
    const lines = [{ commit: "m1", change: "c-7", agent: "patch@v3" }, { commit: "h1", person: "ren" }];
    expect((await put(lines)).status).toBe(204);
    const res = await call("/api/repos/code-blame/authorship?ref=main&path=src/a.js");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(validateAuthorship(body)).toEqual({ ok: true, errors: [] });
    expect(body).toEqual({ ref: "main", sha: "m1", path: "src/a.js", lines });

    repo.commits.unshift({ sha: "m2" });
    await pushed("code-blame");
    expect((await call("/api/repos/code-blame/authorship?ref=main&path=src/a.js")).status).toBe(202);
  });

  it("the tree endpoint returns every path for a commit in one response", async () => {
    const { fake, call } = await setup("code-full-tree");
    fake.calls.length = 0;
    const res = await call("/api/repos/code-full-tree/tree?ref=main&recursive=1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(validateCodeTree(body)).toEqual({ ok: true, errors: [] });
    expect(body.entries.map((e) => e.path).sort()).toEqual(["README.md", "src", "src/a.js", "src/lib", "src/lib/b.js"]);
    expect(body.remote).toBe("https://artifacts.fake/cinder/code-full-tree.git");
    // Subtrees are read by hash, never walked from the ref per directory.
    expect(fake.calls.filter((c) => c.method === "log")).toHaveLength(2);
    expect((await call("/api/repos/code-full-tree/tree?ref=main&recursive=1&path=src")).status).toBe(400);
  });

  it("a second request for the same sha's file is served from the cache without an Artifacts read", async () => {
    const { fake, call, repo } = await setup("code-file-cache");
    const sha = "a".repeat(40);
    repo.commits.unshift({ sha });
    const first = await call("/api/repos/code-file-cache/file?ref=main&path=src/a.js");
    expect(first.headers.get("Cache-Control")).toBeNull();
    fake.calls.length = 0;
    const res = await call(`/api/repos/code-file-cache/file?ref=main&sha=${sha}&path=src/a.js`);
    expect(await res.json()).toEqual({ ref: "main", sha, path: "src/a.js", size: 1, content: "a" });
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=31536000, immutable");
    expect((await call("/api/repos/code-file-cache/file?ref=main&path=src/a.js")).status).toBe(200);
    expect(fake.calls).toEqual([]);
    expect((await call("/api/repos/code-file-cache/file?ref=main&sha=nope&path=src/a.js")).status).toBe(400);
  });

  it("resolving a ref twice reads the log once until a push invalidates it", async () => {
    const { fake, call, repo } = await setup("code-heads");
    fake.calls.length = 0;
    const logs = () => fake.calls.filter((c) => c.method === "log" && c.args[1] === "main").length;
    expect((await (await call("/api/repos/code-heads/tree?ref=main")).json()).sha).toBe("m1");
    expect((await (await call("/api/repos/code-heads/tree?ref=main&path=src")).json()).sha).toBe("m1");
    expect(logs()).toBe(1);
    repo.commits.unshift({ sha: "m2" });
    await pushed("code-heads");
    expect((await (await call("/api/repos/code-heads/tree?ref=main")).json()).sha).toBe("m2");
    expect(logs()).toBe(2);
  });

  it("code search queries the push-time index with no readTree walk on search", async () => {
    const { fake, call, repo } = await setup("code-index");
    repo.files["src/lib/b.js"] = "const B = 1;\nreturn b_value;";
    // cinder wrote main (a direct push to it is rolled back instead).
    const push = async (after) => {
      await env.DB.prepare("INSERT INTO ref_writes (repo, ref, sha) VALUES ('code-index', 'refs/heads/main', ?)").bind(after).run();
      await worker.queue({ messages: [{ body: { type: "cf.artifacts.repo.pushed", source: { repoName: "code-index" },
        payload: { ref: "refs/heads/main", before: "0".repeat(40), after, commits: [] } } }] }, { ...env, ARTIFACTS: fake });
    };
    await push("m1");
    fake.calls.length = 0;
    expect(await (await call("/api/repos/code-index/code-search?ref=main&q=B_VALUE")).json()).toEqual([{ path: "src/lib/b.js", line: 2, text: "return b_value;" }]);
    // % and _ are literal, not LIKE wildcards.
    expect(await (await call("/api/repos/code-index/code-search?ref=main&q=b%25v")).json()).toEqual([]);
    expect(fake.calls.filter((c) => c.method === "readTree" || c.method === "readFile")).toEqual([]);
    // A new push replaces the branch's index.
    repo.commits.unshift({ sha: "m2" });
    repo.files["src/lib/b.js"] = "gone";
    await push("m2");
    expect(await (await call("/api/repos/code-index/code-search?ref=main&q=b_value")).json()).toEqual([]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM code_search WHERE store = 'code-index'").first("n")).toBe(3);
  });

  it("code search on an imported ref finds a word from an imported file", async () => {
    const fake = fakeArtifacts({ imports: { "https://git.example.com/acme/shop.git": { "src/cart/discount.js": "export const discount = 0.1;" } } });
    const call = (path, init) => worker.fetch(new Request(`http://cinder.test${path}`, { headers: OWNER, ...init }), { ...env, ARTIFACTS: fake });
    expect((await call("/api/repos", { method: "POST", body: JSON.stringify({ name: "code-imp", import: { url: "https://git.example.com/acme/shop.git" } }) })).status).toBe(201);
    expect(await (await call("/api/repos/code-imp/code-search?ref=main&q=discount")).json())
      .toEqual([{ path: "src/cart/discount.js", line: 1, text: "export const discount = 0.1;" }]);
  });

  it("indexing the same sha under two refs, then searching, returns each hit once", async () => {
    const { fake, call } = await setup("code-dup");
    await indexCode({ ...env, ARTIFACTS: fake }, "code-dup", "main", "m1");
    await indexCode({ ...env, ARTIFACTS: fake }, "code-dup", "dev", "m1");
    expect(await (await call("/api/repos/code-dup/code-search?ref=main&q=hi")).json()).toEqual([{ path: "README.md", line: 1, text: "# hi" }]);
  });

  it("the log returns each commit's author date", async () => {
    const { call, repo } = await setup("code-date");
    repo.commits[0].authoredAt = 1791936000;
    expect((await (await call("/api/repos/code-date/log?ref=main")).json()).commits[0].date).toBe("2026-10-14T00:00:00.000Z");
  });

  it("a commit diff reads only blobs whose tree entries differ", async () => {
    const { call, fake, repo } = await setup("code-diff");
    repo.commits.unshift({ sha: "m2" });
    const same = { "README.md": "# hi", "src/lib/b.js": "b", "docs/x.md": "x" };
    repo.at = { m1: { ...same, "src/a.js": "a" }, m2: { ...same, "src/a.js": "a2", "new.md": "n" } };
    const reads = () => fake.calls.filter((c) => c.method === "readFile").map((c) => c.args.slice(1).join(":")).sort();
    const diff = async () => (await call("/api/repos/code-diff/commits/m2?ref=main")).json();
    const body = await diff();
    expect(body.files.map((f) => [f.path, f.status])).toEqual([["new.md", "added"], ["src/a.js", "modified"]]);
    expect(reads()).toEqual(["m1:src/a.js", "m2:new.md", "m2:src/a.js"]);
    // Cached by sha pair: a second request reads no blob.
    expect(await diff()).toEqual(body);
    expect(reads()).toHaveLength(3);
  });

  it("a ref with no index returns matches on its first search", async () => {
    const { call } = await setup("code-noidx");
    expect(await env.DB.prepare("SELECT 1 FROM code_search WHERE store = 'code-noidx'").first()).toBeNull();
    expect(await (await call("/api/repos/code-noidx/code-search?ref=main&q=hi")).json()).toEqual([{ path: "README.md", line: 1, text: "# hi" }]);
  });
});
