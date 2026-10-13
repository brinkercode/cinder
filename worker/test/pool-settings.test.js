import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateByoPool, validatePool } from "../src/api/contract.js";
import worker from "../src/index.js";
import { ACCESS, as, serveCerts } from "./helpers/access.js";
import { fakeArtifacts } from "./fakes/artifacts.js";

const containers = { idFromName: (name) => name, get: () => ({ start: async () => {}, stop: async () => {} }) };
const e = { ...ACCESS, ARTIFACTS: fakeArtifacts(), WORKER_LITE: containers, WORKER_BASIC: containers, WORKER_STANDARD: containers, WORKER_STANDARD4: containers };
const OWNER = { Authorization: `Bearer ${env.OWNER_TOKEN}` };
const call = async (method, path, body, headers = OWNER) => worker.fetch(new Request(`http://cinder.test${path}`, { method, headers, body: body && JSON.stringify(body) }), e);
const json = async (...args) => (await call(...args)).json();
const managed = (name, size = "lite") => json("POST", "/api/workers/pools", { name, size, max: 4, kinds: ["develop"] });
const listed = async (path, id) => (await json("GET", path)).find((p) => p.id === id);
const DEFAULTS = { labels: [], keep_warm_s: 60, placement: "nearest", egress: "allowlist", egress_allow: [], repos: "*", max_concurrent: 8 };

afterEach(() => vi.restoreAllMocks());

describe("pool settings", () => {
  it("PUT pools/:id stores labels, keep-warm, placement, egress, allow list and repos, and GET returns them", async () => {
    for (const name of ["ps-a", "ps-b"]) await call("POST", "/api/repos", { name });
    const pool = await managed("ps-settings");
    const settings = { labels: ["linux", "gpu"], keep_warm_s: 300, placement: "eu-west", egress: "none", egress_allow: ["registry.npmjs.org", "*.github.com"], repos: ["ps-b", "ps-a"] };
    const res = await call("PUT", `/api/workers/pools/${pool.id}`, { ...settings, max: 6, kinds: ["verify"] });
    expect(res.status).toBe(200);
    const want = { ...settings, repos: ["ps-a", "ps-b"], max: 6, kinds: ["verify"], max_concurrent: 8 };
    expect(await res.json()).toMatchObject(want);
    const got = await listed("/api/workers/pools", pool.id);
    expect(got).toMatchObject(want);
    expect(validatePool(got).errors).toEqual([]);
    // An unknown repo, a bad egress or a bad host pattern writes nothing.
    expect((await call("PUT", `/api/workers/pools/${pool.id}`, { labels: ["x"], repos: ["ps-nope"] })).status).toBe(404);
    expect((await call("PUT", `/api/workers/pools/${pool.id}`, { egress: "closed" })).status).toBe(400);
    expect((await call("PUT", `/api/workers/pools/${pool.id}`, { egress_allow: ["bad host"] })).status).toBe(400);
    expect((await call("PUT", `/api/workers/pools/${pool.id}`, { max: 21 })).status).toBe(400);
    expect(await listed("/api/workers/pools", pool.id)).toMatchObject(want);
    // "*" serves every repo again.
    expect(await json("PUT", `/api/workers/pools/${pool.id}`, { repos: "*" })).toMatchObject({ repos: "*" });

    const byo = await json("POST", "/api/workers/byo-pools", { name: "ps-byo", labels: ["arm64"], cloud: "AWS", max_concurrent: 2, egress: "open", repos: ["ps-a"] });
    expect(byo).toMatchObject({ labels: ["arm64"], cloud: "AWS", region: null, max_concurrent: 2, egress: "open", repos: ["ps-a"], keep_warm_s: 60 });
    const put = { labels: ["arm64", "gpu"], region: "eu-west-1", cloud: null, keep_warm_s: 0, egress_allow: ["proxy.golang.org"] };
    expect((await call("PUT", `/api/workers/byo-pools/${byo.id}`, put)).status).toBe(200);
    const got2 = await listed("/api/workers/byo-pools", byo.id);
    expect(got2).toMatchObject({ ...put, max_concurrent: 2, egress: "open", repos: ["ps-a"] });
    expect(validateByoPool(got2).errors).toEqual([]);
  });

  it("a pool with no settings row returns the defaults", async () => {
    const pool = await managed("ps-defaults");
    const byo = await json("POST", "/api/workers/byo-pools", { name: "ps-byo-defaults", labels: ["linux"] });
    expect(await env.DB.prepare("SELECT count(*) AS n FROM pool_settings WHERE pool_id IN (?, ?)").bind(pool.id, byo.id).first("n")).toBe(0);
    expect(await listed("/api/workers/pools", pool.id)).toMatchObject(DEFAULTS);
    expect(await listed("/api/workers/byo-pools", byo.id)).toMatchObject({ ...DEFAULTS, labels: ["linux"] });
  });

  it("a name used by a managed or BYO pool answers 409 name_taken for the other kind", async () => {
    const pool = await managed("ps-taken-managed");
    const byo = await json("POST", "/api/workers/byo-pools", { name: "ps-taken-byo", labels: [] });
    const code = async (...args) => { const res = await call(...args); return [res.status, (await res.json()).error?.code]; };
    const taken = [409, "name_taken"];
    expect(await code("POST", "/api/workers/byo-pools", { name: "ps-taken-managed", labels: [] })).toEqual(taken);
    expect(await code("POST", "/api/workers/pools", { name: "ps-taken-byo", size: "lite", max: 1 })).toEqual(taken);
    expect(await code("PUT", `/api/workers/pools/${pool.id}`, { name: "ps-taken-byo" })).toEqual(taken);
    expect(await code("PUT", `/api/workers/byo-pools/${byo.id}`, { name: "ps-taken-managed" })).toEqual(taken);
    expect(await code("POST", "/api/workers/pools", { name: "ps-taken-managed", size: "lite", max: 1 })).toEqual(taken);
    // Keeping its own name is no conflict.
    expect((await call("PUT", `/api/workers/pools/${pool.id}`, { name: "ps-taken-managed" })).status).toBe(200);
    expect(await json("PUT", `/api/workers/byo-pools/${byo.id}`, { name: "ps-renamed" })).toMatchObject({ name: "ps-renamed" });
  });

  it("resizing a pool with running workers saves the new size with its other settings", async () => {
    const pool = await managed("ps-resize");
    expect(await json("PUT", `/api/workers/pools/${pool.id}`, { size: "standard-4" })).toMatchObject({ size: "standard-4" });
    expect((await call("POST", `/api/workers/pools/${pool.id}/scale`, { count: 1 })).status).toBe(200);
    expect(await json("PUT", `/api/workers/pools/${pool.id}`, { size: "lite", labels: ["x"] })).toMatchObject({ size: "lite", labels: ["x"] });
    expect(await listed("/api/workers/pools", pool.id)).toMatchObject({ size: "lite", labels: ["x"] });
  });

  it("the migration backfills worker_pools.repo_id as a pool_repos row", async () => {
    const { id: repo } = await json("POST", "/api/repos", { name: "ps-backfill" });
    await env.DB.prepare("INSERT INTO worker_pools (id, name, size, min_count, max_count, repo_id, kinds, created_at) VALUES ('wp_bf', 'ps-bf', 'lite', 0, 1, ?, '[]', '2026-10-01T00:00:00Z')").bind(repo).run();
    const migration = env.TEST_MIGRATIONS.find((m) => m.name.endsWith("_pool_settings.sql"));
    // Applied twice: the replay adds no second row.
    for (let i = 0; i < 2; i++) for (const q of migration.queries) await env.DB.prepare(q).run();
    expect((await env.DB.prepare("SELECT pool_id, repo_id FROM pool_repos WHERE pool_id = 'wp_bf'").all()).results).toEqual([{ pool_id: "wp_bf", repo_id: repo }]);
    expect((await listed("/api/workers/pools", "wp_bf")).repos).toEqual(["ps-backfill"]);
  });

  it("pool writes need org.manage", async () => {
    serveCerts();
    const pool = await managed("ps-rbac");
    const byo = await json("POST", "/api/workers/byo-pools", { name: "ps-rbac-byo", labels: [] });
    await env.DB.prepare("INSERT INTO person_roles VALUES ('ps-maintainer@example.com', 'maintainer')").run();
    const maintainer = await as("ps-maintainer@example.com");
    expect((await call("PUT", `/api/workers/pools/${pool.id}`, { labels: ["x"] }, maintainer)).status).toBe(403);
    expect((await call("PUT", `/api/workers/byo-pools/${byo.id}`, { labels: ["x"] }, maintainer)).status).toBe(403);
    expect((await call("POST", "/api/workers/byo-pools", { name: "ps-rbac-2", labels: [] }, maintainer)).status).toBe(403);
    expect((await call("PUT", `/api/workers/pools/${pool.id}`, { labels: ["x"] })).status).toBe(200);
    expect((await call("PUT", `/api/workers/byo-pools/${byo.id}`, { labels: ["x"] })).status).toBe(200);
  });
});
