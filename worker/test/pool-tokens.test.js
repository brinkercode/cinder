import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { validatePoolToken } from "../src/api/contract.js";
import worker from "../src/index.js";
import { hex, sha256 } from "../src/router.js";
import { ACCESS, as, serveCerts } from "./helpers/access.js";

const OWNER = { Authorization: `Bearer ${env.OWNER_TOKEN}` };
const call = (method, path, body, headers = {}, e = env) => worker.fetch(new Request(`http://cinder.test${path}`, { method, headers, body: body && JSON.stringify(body) }), e);
const byoPool = async (name) => (await call("POST", "/api/workers/byo-pools", { name, labels: ["linux"] }, OWNER)).json();
const mint = async (id) => (await call("POST", `/api/workers/byo-pools/${id}/tokens`, null, OWNER)).json();
const register = (name, pool_token) => call("POST", "/api/runners", { name, kinds: ["verify"], pool_token });
const memberOf = (runner) => env.DB.prepare("SELECT pool_id FROM byo_members WHERE runner_id = ?").bind(runner).first("pool_id");

describe("BYO pool tokens", () => {
  it("minting returns the token once and stores only its hash", async () => {
    const pool = await byoPool("pt-mint");
    const log = vi.spyOn(console, "log");
    const res = await call("POST", `/api/workers/byo-pools/${pool.id}/tokens`, null, OWNER);
    expect(res.status).toBe(201);
    const { token, expires_at } = await res.json();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(Math.abs(Date.parse(expires_at) - Date.now() - 24 * 3600_000)).toBeLessThan(60_000);
    const rows = (await env.DB.prepare("SELECT * FROM byo_pool_tokens WHERE pool_id = ?").bind(pool.id).all()).results;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ token_hash: hex(await sha256(token)), expires_at, created_by: "owner", used_at: null });
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(await (await call("GET", "/api/workers/byo-pools", null, OWNER)).text()).not.toContain(token);
    expect(JSON.stringify(log.mock.calls)).not.toContain(token);
    expect((await call("POST", "/api/workers/byo-pools/pt-nope/tokens", null, OWNER)).status).toBe(404);
    log.mockRestore();
  });

  it("a runner registers into the pool with a valid pool token and no owner token", async () => {
    const pool = await byoPool("pt-register");
    const { token } = await mint(pool.id);
    const res = await register("pt-r1", token);
    expect(res.status).toBe(201);
    const runner = await res.json();
    expect(runner.token).toMatch(/^[0-9a-f]{64}$/);
    expect(await memberOf(runner.id)).toBe(pool.id);
    expect(await env.DB.prepare("SELECT name FROM runner_tokens WHERE runner_id = ?").bind(runner.id).first("name")).toBe("pt-r1");
    expect(await env.DB.prepare("SELECT used_at FROM byo_pool_tokens WHERE pool_id = ?").bind(pool.id).first("used_at")).not.toBeNull();
    // An unknown token gets the same answer as an expired one.
    const bad = await register("pt-r-bad", "f".repeat(64));
    expect(bad.status).toBe(401);
    expect((await bad.json()).error.code).toBe("bad_pool_token");
  });

  it("a pool token can't register flow unless the pool allows it", async () => {
    const pool = await byoPool("pt-flow");
    const { token } = await mint(pool.id);
    const flow = (t) => call("POST", "/api/runners", { name: "pt-flow-r", kinds: ["verify", "flow"], pool_token: t });
    const refused = await flow(token);
    expect(refused.status).toBe(403);
    expect((await refused.json()).error.code).toBe("kind_not_allowed");
    expect(await env.DB.prepare("SELECT count(*) AS n FROM runner_tokens WHERE name = 'pt-flow-r'").first("n")).toBe(0);
    // Registering by pool name is refused the same way.
    expect((await call("POST", "/api/runners", { name: "pt-flow-r", kinds: ["flow"], pool: "pt-flow" }, OWNER)).status).toBe(403);
    // Only org.manage sets a pool's kinds, and only to BYO kinds.
    expect((await call("PUT", `/api/workers/byo-pools/${pool.id}`, { kinds: ["merge"] }, OWNER)).status).toBe(400);
    serveCerts();
    await env.DB.prepare("INSERT INTO person_roles VALUES (?, ?) ON CONFLICT (email) DO UPDATE SET role = excluded.role").bind("pt-flow-m@example.com", "maintainer").run();
    expect((await call("PUT", `/api/workers/byo-pools/${pool.id}`, { kinds: ["verify", "flow"] }, await as("pt-flow-m@example.com"), ACCESS)).status).toBe(403);
    expect((await call("PUT", `/api/workers/byo-pools/${pool.id}`, { kinds: ["verify", "flow"] }, OWNER)).status).toBe(200);
    // The refusal didn't spend the token.
    expect((await flow(token)).status).toBe(201);
  });

  it("an expired token is refused with 401 bad_pool_token", async () => {
    const pool = await byoPool("pt-expired");
    const { token } = await mint(pool.id);
    await env.DB.prepare("UPDATE byo_pool_tokens SET expires_at = ? WHERE pool_id = ?").bind(new Date(Date.now() - 1000).toISOString(), pool.id).run();
    const res = await register("pt-late", token);
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("bad_pool_token");
    expect(await env.DB.prepare("SELECT count(*) AS n FROM runner_tokens WHERE name = 'pt-late'").first("n")).toBe(0);
  });

  it("a pool token is not accepted by any other route", async () => {
    const pool = await byoPool("pt-other");
    const { token } = await mint(pool.id);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const bearer = { Authorization: `Bearer ${token}` };
    expect((await call("GET", "/api/workers", null, bearer)).status).toBe(401);
    expect((await call("POST", `/api/workers/byo-pools/${pool.id}/tokens`, null, bearer)).status).toBe(401);
    expect((await call("POST", "/api/runners", { name: "pt-x", kinds: ["verify"] }, bearer)).status).toBe(401);
    // In the body, only POST /api/runners lets it through; the /api/workers alias still needs the owner.
    expect((await call("POST", "/api/workers", { name: "pt-y", kinds: ["verify"], pool_token: token })).status).toBe(401);
    expect((await call("POST", "/api/repos", { name: "pt-repo", pool_token: token })).status).toBe(401);
    expect((await register("pt-z", token)).status).toBe(201);
  });

  it("minting a token needs org.manage", async () => {
    serveCerts();
    const pool = await byoPool("pt-perm");
    await env.DB.prepare("INSERT INTO person_roles VALUES (?, ?) ON CONFLICT (email) DO UPDATE SET role = excluded.role").bind("pt-maintainer@example.com", "maintainer").run();
    await env.DB.prepare("INSERT INTO person_roles VALUES (?, ?) ON CONFLICT (email) DO UPDATE SET role = excluded.role").bind("pt-admin@example.com", "admin").run();
    const path = `/api/workers/byo-pools/${pool.id}/tokens`;
    expect((await call("POST", path, null, await as("pt-maintainer@example.com"), ACCESS)).status).toBe(403);
    const res = await call("POST", path, null, await as("pt-admin@example.com"), ACCESS);
    expect(res.status).toBe(201);
    const { token } = await res.json();
    expect(await env.DB.prepare("SELECT created_by FROM byo_pool_tokens WHERE token_hash = ?").bind(hex(await sha256(token))).first("created_by")).toBe("pt-admin@example.com");
  });

  it("listing a pool's tokens shows prefixes and never the token", async () => {
    const pool = await byoPool("pt-list");
    const { token } = await mint(pool.id);
    const res = await call("GET", `/api/workers/byo-pools/${pool.id}/tokens`, null, OWNER);
    expect(res.status).toBe(200);
    const text = await res.text();
    const [row, ...rest] = JSON.parse(text);
    expect(rest).toEqual([]);
    expect(Object.keys(row).sort()).toEqual(["created_at", "created_by", "expires_at", "prefix", "used_at"]);
    expect(validatePoolToken(row).ok).toBe(true);
    expect(text).not.toContain(token);
    expect(text).not.toContain(hex(await sha256(token)));
  });

  it("a revoked pool token can't register a worker", async () => {
    const pool = await byoPool("pt-revoke");
    const { token } = await mint(pool.id);
    const [{ prefix }] = await (await call("GET", `/api/workers/byo-pools/${pool.id}/tokens`, null, OWNER)).json();
    expect((await call("DELETE", `/api/workers/byo-pools/${pool.id}/tokens/${prefix}`, null, OWNER)).status).toBe(204);
    const res = await register("pt-revoked", token);
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("bad_pool_token");
    expect(await (await call("GET", `/api/workers/byo-pools/${pool.id}/tokens`, null, OWNER)).json()).toEqual([]);
    expect((await call("DELETE", `/api/workers/byo-pools/${pool.id}/tokens/${prefix}`, null, OWNER)).status).toBe(404);
  });

  it("a revoked token stops its workers at the next heartbeat", async () => {
    const pool = await byoPool("pt-stop");
    const { token } = await mint(pool.id);
    const worker1 = await (await register("pt-stop-1", token)).json();
    const auth = { Authorization: `Bearer ${worker1.token}` };
    const now = new Date().toISOString();
    await env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, change_id, status, runner_id, lease_expires_at, created_at, payload) VALUES ('pt-job', 'r', 'verify', 'c-pt', 'claimed', ?, ?, ?, '{}')")
      .bind(worker1.id, new Date(Date.now() + 60_000).toISOString(), now).run();
    const [{ prefix }] = await (await call("GET", `/api/workers/byo-pools/${pool.id}/tokens`, null, OWNER)).json();
    expect((await call("DELETE", `/api/workers/byo-pools/${pool.id}/tokens/${prefix}`, null, OWNER)).status).toBe(204);
    // The running job finishes: its heartbeat still extends the lease, but the worker gets no new work.
    expect((await call("POST", "/api/work/jobs/pt-job/heartbeat", null, auth)).status).toBe(200);
    const refused = await call("POST", "/api/work/claim", { kinds: ["verify"], slots_free: 1 }, auth);
    expect(refused.status).toBe(401);
    expect((await refused.json()).error.code).toBe("token_revoked");
    expect(await memberOf(worker1.id)).toBe(pool.id);
    // Once it holds no job, its next heartbeat stops it: the worker and its token are gone.
    await env.DB.prepare("UPDATE jobs SET status = 'done' WHERE id = 'pt-job'").run();
    expect((await call("POST", "/api/work/claim", { kinds: ["verify"], slots_free: 1 }, auth)).status).toBe(401);
    expect(await memberOf(worker1.id)).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM runner_tokens WHERE runner_id = ?").bind(worker1.id).first()).toBeNull();
  });
});
