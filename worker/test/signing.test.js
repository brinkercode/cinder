import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import worker from "../src/index.js";
import { fakeArtifacts } from "./fakes/artifacts.js";

const MERGE_SIGNING_KEY = { get: async () => "test-merge-signing-secret" };

it("GET signing-key returns a key without reading a D1 private column", async () => {
  const fake = fakeArtifacts();
  const seen = [];
  // Records every SQL statement the request runs, so the test sees what it read.
  const DB = new Proxy(env.DB, { get: (t, k) => k === "prepare" ? (sql) => { seen.push(sql); return t.prepare(sql); } : t[k].bind?.(t) ?? t[k] });
  const call = (path, init = {}, token = env.OWNER_TOKEN, e = {}) => worker.fetch(
    new Request(`http://cinder.test${path}`, { ...init, headers: { Authorization: `Bearer ${token}` } }), { ...env, ARTIFACTS: fake, MERGE_SIGNING_KEY, ...e });
  const post = (path, body, token) => call(path, { method: "POST", body: JSON.stringify(body) }, token);
  expect((await post("/api/repos", { name: "sign" })).status).toBe(201);
  await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName("sign")), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
  const change = await (await post("/api/repos/sign/changes", { intent: "x" })).json();
  await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE status IN ('queued', 'claimed')").run();
  const job = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload) VALUES (?, ?, 'merge', ?, 'claimed', ?, ?)")
    .bind(job, change.repo_id, change.id, new Date().toISOString(), JSON.stringify({ batch: [{ tree: "x" }] })).run();

  const res = await call("/api/repos/sign/signing-key", {}, env.OWNER_TOKEN, { DB });
  expect(res.status).toBe(200);
  const [type, blob] = (await res.text()).trim().split(" ");
  expect(type).toBe("ssh-ed25519");
  expect(seen.some((sql) => /private_key|signing_keys/.test(sql))).toBe(false);
  expect((await env.DB.prepare("SELECT name FROM sqlite_master WHERE name = 'signing_keys'").first())).toBeNull();
  // The same repo always gets the same key, and the private half stays in the Worker: the runner only gets a signature by it.
  expect((await (await call("/api/repos/sign/signing-key")).text()).trim()).toBe(`ssh-ed25519 ${blob}`);
  const { id: runnerId, token: runner } = await (await post("/api/runners", { name: "signer", kinds: ["merge"] })).json();
  expect((await post(`/api/work/jobs/${job}/sign`, { commit: "tree x\n" }, runner)).status).toBe(403);
  await env.DB.prepare("UPDATE jobs SET runner_id = ?, lease_expires_at = ? WHERE id = ?").bind(runnerId, new Date(Date.now() + 60000).toISOString(), job).run();
  const signed = await (await post(`/api/work/jobs/${job}/sign`, { commit: "tree x\n" }, runner)).json();
  const armored = signed.signature.match(/-----BEGIN SSH SIGNATURE-----\n([^-]+)-----END/)[1].replace(/\n/g, "");
  const file = Uint8Array.from(atob(armored), (c) => c.charCodeAt(0));
  // SSHSIG: magic (6), version (4), then the length-prefixed public key blob (4 + 51).
  expect(btoa(String.fromCharCode(...file.slice(14, 14 + 51)))).toBe(blob);
  expect((await call("/api/repos/nope/signing-key")).status).toBe(404);
  expect((await call("/api/repos/sign/signing-key", {}, env.OWNER_TOKEN, { MERGE_SIGNING_KEY: undefined })).status).toBe(503);
});

it("refuses to sign a merge commit whose tree was not verified", async () => {
  const fake = fakeArtifacts();
  const call = (path, body, token = env.OWNER_TOKEN) => worker.fetch(new Request(`http://cinder.test${path}`,
    { method: "POST", body: JSON.stringify(body), headers: { Authorization: `Bearer ${token}` } }), { ...env, ARTIFACTS: fake, MERGE_SIGNING_KEY });
  expect((await call("/api/repos", { name: "unverified" })).status).toBe(201);
  await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName("unverified")), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
  const change = await (await call("/api/repos/unverified/changes", { intent: "x" })).json();
  const { id: runnerId, token: runner } = await (await call("/api/runners", { name: "unverified-signer", kinds: ["merge"] })).json();
  const job = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload, runner_id, lease_expires_at)
    VALUES (?, ?, 'merge', ?, 'claimed', ?, ?, ?, ?)`).bind(job, change.repo_id, change.id, new Date().toISOString(),
    JSON.stringify({ batch: [{ change_id: change.id, head_sha: "h", tree: "aaa" }, { change_id: "c2", head_sha: "h2", tree: null }] }),
    runnerId, new Date(Date.now() + 60000).toISOString()).run();

  expect((await call(`/api/work/jobs/${job}/sign`, { commit: "tree bbb\nparent p\n\nmsg\n" }, runner)).status).toBe(409);
  // A batch entry with no verified tree vouches for nothing, not even an empty tree line.
  expect((await call(`/api/work/jobs/${job}/sign`, { commit: "tree \n" }, runner)).status).toBe(409);
  const ok = await call(`/api/work/jobs/${job}/sign`, { commit: "tree aaa\nparent p\n\nmsg\n" }, runner);
  expect(ok.status).toBe(200);
  expect((await ok.json()).signature).toMatch(/BEGIN SSH SIGNATURE/);
});
