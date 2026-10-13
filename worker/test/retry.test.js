import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import worker from "../src/index.js";
import { fakeArtifacts } from "./fakes/artifacts.js";

const OWNER = { Authorization: `Bearer ${env.OWNER_TOKEN}` };
const TEAM = "cinder-retry.cloudflareaccess.com";
const RSA = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const part = (obj) => b64url(new TextEncoder().encode(JSON.stringify(obj)));

const call = (path, e, headers = OWNER, body) =>
  worker.fetch(new Request(`http://cinder.test${path}`, { method: "POST", headers, body: body && JSON.stringify(body) }), e);

// A repo with one change set to `state`; returns its id and the env the calls use.
async function changeIn(name, state) {
  const e = { ...env, ARTIFACTS: fakeArtifacts() };
  env.ARTIFACTS = e.ARTIFACTS;
  onTestFinished(() => { delete env.ARTIFACTS; });
  expect((await call("/api/repos", e, OWNER, { name })).status).toBe(201);
  const { id } = await (await call(`/api/repos/${name}/changes`, e, OWNER, { intent: "retry me" })).json();
  await runInDurableObject(env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id)), async (i) => {
    await i.ctx.storage.put("change", { ...(await i.ctx.storage.get("change")), state });
  });
  await env.DB.prepare("UPDATE changes SET state = ? WHERE id = ?").bind(state, id).run();
  return { id, e };
}

const verifyJobs = (id, status) => env.DB.prepare(
  "SELECT id FROM jobs WHERE change_id = ? AND kind = 'verify' AND status = ? AND id NOT IN (SELECT job_id FROM job_cancels)",
).bind(id, status).all().then((r) => r.results);

describe("retry", () => {
  it("retry moves a failed change to verifying with one queued verify job", async () => {
    const { id, e } = await changeIn("retry-failed", "failed");
    await env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload) SELECT 'retry-old', repo_id, 'verify', id, 'failed', ?, '{}' FROM changes WHERE id = ?")
      .bind(new Date().toISOString(), id).run();
    const res = await call(`/api/changes/${id}/retry`, e);
    expect(res.status).toBe(202);
    const change = await res.json();
    expect(change).toMatchObject({ id, state: "verifying" });
    expect(await verifyJobs(id, "queued")).toHaveLength(1);
    // The repair count resets: the earlier failed verify no longer counts.
    expect(await verifyJobs(id, "failed")).toEqual([]);
  });

  it("Retry verify moves failed → verifying and runs only the checks that failed", async () => {
    const { id, e } = await changeIn("retry-only", "failed");
    await env.DB.prepare("INSERT INTO change_heads (change_id, head_sha) VALUES (?, 'h1')").bind(id).run();
    await env.DB.prepare("INSERT INTO test_runs (repo, sha, test, status, duration) SELECT repo_id, 'h1', 'retry backs off', 'fail', 1 FROM changes WHERE id = ?1 " +
      "UNION ALL SELECT repo_id, 'h1', 'jitter is zero', 'pass', 1 FROM changes WHERE id = ?1").bind(id).run();
    await runInDurableObject(env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id)), async (i) => {
      const at = new Date().toISOString();
      await i.ctx.storage.put("events", [...(await i.ctx.storage.get("events")), { id: "f", change_id: id, kind: "verify_failed", from_state: "verifying", to_state: "failed", at,
        actor: { type: "system", id: "cinder" }, action: "job.report", target: id, result: "failed", reason: "1 test failed" }]);
    });
    const failed = await (await worker.fetch(new Request(`http://cinder.test/api/changes/${id}`, { headers: OWNER }), e)).json();
    expect(failed.failure).toEqual({ stage: "verify", reason: "1 test failed", check: "retry backs off" });
    const change = await (await call(`/api/changes/${id}/retry`, e)).json();
    expect(change.state).toBe("verifying");
    expect((await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id)).get()).events.at(-1)).toMatchObject({ kind: "retried", reason: "retry backs off" });
    const job = await env.DB.prepare("SELECT payload FROM jobs WHERE change_id = ? AND kind = 'verify' AND status = 'queued'").bind(id).first("payload");
    expect(JSON.parse(job).only).toEqual(["retry backs off"]);
  });

  it("Close asks for confirmation and moves to closed. The leases are released", async () => {
    const e = { ...env, ARTIFACTS: fakeArtifacts() };
    env.ARTIFACTS = e.ARTIFACTS;
    onTestFinished(() => { delete env.ARTIFACTS; });
    expect((await call("/api/repos", e, OWNER, { name: "close-why" })).status).toBe(201);
    const { id } = await (await call("/api/repos/close-why/changes", e, OWNER, { intent: "close me" })).json();
    const leases = () => env.REPO_DO.get(env.REPO_DO.idFromName("close-why")).leases("main");
    expect((await leases())[id]).toBeDefined();
    expect((await call(`/api/changes/${id}/close`, e, OWNER, { reason: 7 })).status).toBe(400);
    const res = await call(`/api/changes/${id}/close`, e, OWNER, { reason: " Superseded by c-1044 " });
    expect(res.status).toBe(200);
    const change = await res.json();
    expect(change).toMatchObject({ state: "closed", closed_by: "owner", close_reason: "Superseded by c-1044", closed_at: expect.any(String) });
    expect((await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id)).get()).events.at(-1)).toMatchObject({ kind: "closed", reason: "Superseded by c-1044" });
    expect((await leases())[id]).toBeUndefined();
  });

  it("retry on a merged change answers 409 not_failed", async () => {
    const { id, e } = await changeIn("retry-merged", "merged");
    const res = await call(`/api/changes/${id}/retry`, e);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("not_failed");
    expect(await verifyJobs(id, "queued")).toEqual([]);
  });

  it("retry without repo.write answers 403", async () => {
    const { id, e } = await changeIn("retry-viewer", "failed");
    const keys = await crypto.subtle.generateKey(RSA, true, ["sign", "verify"]);
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url) !== `https://${TEAM}/cdn-cgi/access/certs`) throw new Error(`unexpected fetch ${url}`);
      return Response.json({ keys: [{ ...(await crypto.subtle.exportKey("jwk", keys.publicKey)), kid: "k1", alg: "RS256" }] });
    });
    onTestFinished(() => fetch.mockRestore());
    await env.DB.prepare("INSERT INTO person_roles (email, role) VALUES ('viewer@retry.test', 'viewer'), ('dev@retry.test', 'developer')").run();
    const as = async (email) => {
      const body = `${part({ alg: "RS256", kid: "k1" })}.${part({ aud: ["aud-retry"], iss: `https://${TEAM}`, email, exp: Math.floor(Date.now() / 1000) + 300 })}`;
      return { "Cf-Access-Jwt-Assertion": `${body}.${b64url(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(body)))}` };
    };
    const access = { ...e, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: "aud-retry", OWNERS: "boss@retry.test" };
    expect((await call(`/api/changes/${id}/retry`, access, await as("viewer@retry.test"))).status).toBe(403);
    expect(await verifyJobs(id, "queued")).toEqual([]);
    // A person with repo.write may retry.
    expect((await call(`/api/changes/${id}/retry`, access, await as("dev@retry.test"))).status).toBe(202);
  });
});
