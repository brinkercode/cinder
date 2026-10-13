import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import { WorkerLite } from "../src/workers.js";
import { fakeArtifacts } from "./fakes/artifacts.js";

// A fake Containers binding: a pool member's container id is its runner id.
const started = [];
const containers = { idFromName: (name) => name, get: (id) => ({ start: async (o) => { started.push({ id, ...o }); }, stop: async () => {} }) };
const fake = fakeArtifacts();
const e = { ...env, ARTIFACTS: fake, WORKER_LITE: containers };
const call = (path, body) => worker.fetch(new Request(`http://cinder.test${path}`,
  { method: "POST", headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` }, body: JSON.stringify(body) }), e);

afterEach(() => vi.restoreAllMocks());

// A pool container holding a claimed verify job on repo `name`'s change, whose fork is `<name>--X-1`. Returns a request
// through the container's egress and the requests that reached fetch.
async function verifierOn(name) {
  await call("/api/workers/pools", { name: `pool-${name}`, size: "lite", min: 1, max: 1, kinds: ["verify"] });
  const { id } = started.at(-1);
  await call("/api/repos", { name });
  await fake.create(`${name}--X-1`);
  const repo = await env.DB.prepare("SELECT id FROM repos WHERE name = ?").bind(name).first("id");
  await env.DB.batch([
    env.DB.prepare("INSERT INTO change_numbers (change_id, repo_id, number, fork) VALUES (?, ?, 1, ?)").bind(`c-${name}`, repo, `${name}--X-1`),
    env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, change_id, status, runner_id, lease_expires_at, created_at, payload) VALUES (?, ?, 'verify', ?, 'claimed', ?, ?, ?, '{}')")
      .bind(`job-${name}`, repo, `c-${name}`, id, new Date(Date.now() + 60_000).toISOString(), new Date().toISOString()),
  ]);
  const sent = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (req) => { sent.push(req); return new Response("ok"); });
  const send = (path, init = {}) => WorkerLite.outbound(new Request(`https://artifacts.fake/cinder/${path}`, init), e, { containerId: id, className: "WorkerLite" });
  return { send, sent };
}

it("a git read of the job's repo or its change fork from a pool container gets a short-lived read token", async () => {
  const { send, sent } = await verifierOn("lazy-read");
  await send("lazy-read.git/info/refs?service=git-upload-pack");
  await send("lazy-read--X-1.git/git-upload-pack", { method: "POST", body: "0000" });
  expect(sent.map((r) => r.headers.get("authorization"))).toEqual([expect.stringMatching(/^Bearer fake-token-/), expect.stringMatching(/^Bearer fake-token-/)]);
  expect(await sent[1].text()).toBe("0000");
  expect(fake.calls.filter((c) => c.method === "createToken").slice(-2).map((c) => c.args)).toEqual([["lazy-read", "read", 60], ["lazy-read--X-1", "read", 60]]);
});

it("a push, another repo, or a request that already carries a token gets no token from the container's egress", async () => {
  const { send, sent } = await verifierOn("lazy-none");
  await fake.create("someone-else");
  await send("lazy-none.git/info/refs?service=git-receive-pack");
  await send("lazy-none.git/git-receive-pack", { method: "POST", body: "0000" });
  await send("someone-else.git/info/refs?service=git-upload-pack");
  await send("lazy-none.git/info/refs?service=git-upload-pack", { headers: { authorization: "Bearer from-the-job" } });
  expect(sent.map((r) => r.headers.get("authorization"))).toEqual([null, null, null, "Bearer from-the-job"]);
});
