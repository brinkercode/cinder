import { env } from "cloudflare:workers";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { PEOPLE, REPOS, client, seed, seedReview } from "../../seed/seed.mjs";
import worker from "../src/index.js";
import { seedArtifacts } from "./fakes/seed.js";

// The RepoDO reads .cinder.yml through its own env, which has no Artifacts binding in tests. Patching a live
// instance's env is lost when workerd evicts it after ~10 s idle (a loaded run takes that long), but a
// re-created instance gets this shared env, so set the fake here.
// One fake for the file: a RepoDO instance outlives a test and keeps the env it was created with.
const fake = seedArtifacts();
beforeAll(() => { env.ARTIFACTS = fake; });
afterAll(() => { delete env.ARTIFACTS; });
function localApi() {
  return client({ url: "http://cinder.test", token: env.OWNER_TOKEN, fetch: (url, init) => worker.fetch(new Request(url, init), { ...env, ARTIFACTS: fake }) });
}

it("running the seed twice against a local worker yields the same repos and change count", async () => {
  const api = localApi();
  const snapshot = async () => {
    const repos = (await api("GET", "/api/repos")).map((r) => r.name);
    const changes = await Promise.all(repos.map((r) => api("GET", `/api/repos/${r}/changes`)));
    const judgments = await env.DB.prepare("SELECT count(*) AS n FROM judgments").first("n");
    return { repos, changes: changes.flat().map((c) => [c.id, c.state]), judgments };
  };

  await seed(api);
  const first = await snapshot();
  await seed(api);
  expect(await snapshot()).toEqual(first);
  expect(first.repos).toEqual(expect.arrayContaining(Object.values(REPOS)));
  expect(new Set(first.changes.map(([, state]) => state))).toEqual(new Set(["draft", "closed"]));
  // Judgments come only from real reviews and judges: the seed records none.
  expect(first.judgments).toBe(0);
}, 120000); // two full seeds: 5-7 s each idle, past 30 s when every worker file starts at once (as seed-full.test.js)

it("adding a new seed section doesn't change any other live file's setup time", async () => {
  // Every live file names the sections it reads, so a section added to seed()'s defaults runs in none of them.
  const live = import.meta.glob("./*-live.test.js", { query: "?raw", import: "default", eager: true });
  expect(Object.keys(live).length).toBeGreaterThan(0);
  for (const [file, src] of Object.entries(live)) expect(src, file).not.toMatch(/\bseed\([^[\n]*\);/);
  // A named section runs alone: the judges section files and claims nothing.
  const paths = [];
  const api = localApi();
  await seed((method, path, ...rest) => (paths.push(path), api(method, path, ...rest)), undefined, ["judges"]);
  expect(paths.filter((p) => p.includes("/changes") || p.includes("/claim"))).toEqual([]);
});

it("seed's repos section seeds the Repositories page with the seed repos, gitflow ones on develop", async () => {
  const api = localApi();
  await seed(api, undefined, ["repos"]);
  expect((await api("GET", "/api/repos")).map((r) => [r.name, r.default_branch])).toEqual(expect.arrayContaining([["svc-orders-go", "main"], ["web-store", "develop"], ["infra-cloudflare-tf", "main"]]));
});

// Runs one client call under fake timers so the backoff waits take no real time; returns the result and the fetch calls.
async function retried(responses, opts = {}) {
  vi.useFakeTimers();
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const calls = [];
  const fetch = async (url, init) => {
    calls.push(init);
    const next = responses[Math.min(calls.length, responses.length) - 1];
    if (next instanceof Error) throw next;
    return new Response(next.body ?? null, { status: next.status });
  };
  try {
    const result = client({ url: "http://cinder.test", token: "bearer-secret", fetch, ...opts })("POST", "/api/repos", { name: "x" })
      .then((value) => ({ value }), (error) => ({ error }));
    await vi.runAllTimersAsync();
    return { ...(await result), calls, lines: log.mock.calls.map((args) => args.join(" ")) };
  } finally {
    log.mockRestore();
    vi.useRealTimers();
  }
}

it("the seed client retries a 500 and returns the next success", async () => {
  const { value, calls, lines } = await retried([{ status: 500 }, { status: 200, body: '{"ok":true}' }]);
  expect(value).toEqual({ ok: true });
  expect(calls).toHaveLength(2);
  expect(lines).toEqual([expect.stringMatching(/POST \/api\/repos: 500, attempt 1/)]);
});

it("the seed client retries a network error from fetch", async () => {
  const { value, calls, lines } = await retried([new TypeError("connection reset"), { status: 200, body: '{"ok":true}' }]);
  expect(value).toEqual({ ok: true });
  expect(calls).toHaveLength(2);
  expect(lines[0]).toMatch(/POST \/api\/repos: network error \(connection reset\), attempt 1/);
});

it("the seed client gives up after five attempts and names the status and attempts", async () => {
  const { error, calls, lines } = await retried([{ status: 503 }]);
  expect(calls).toHaveLength(5);
  expect(lines).toHaveLength(4);
  expect(error.message).toMatch(/^POST \/api\/repos: 503 after 5 attempts/);
});

it("the seed client does not retry a 400", async () => {
  const { error, calls, lines } = await retried([{ status: 400, body: "bad" }, { status: 200 }]);
  expect(calls).toHaveLength(1);
  expect(lines).toEqual([]);
  expect(error.message).toMatch(/POST \/api\/repos: 400/);
});

it("the seed client never prints the Authorization or Access headers when it retries", async () => {
  const { calls, lines } = await retried([{ status: 502 }, { status: 429 }, new Error("dropped"), { status: 504 }, { status: 500 }],
    { accessId: "access-id-secret", accessSecret: "access-secret-value" });
  expect(calls[0].headers).toMatchObject({ Authorization: "Bearer bearer-secret", "CF-Access-Client-Secret": "access-secret-value" });
  expect(lines).toHaveLength(4);
  for (const line of lines) expect(line).not.toMatch(/bearer-secret|access-id-secret|access-secret-value|Authorization|CF-Access/i);
});

it("seedReview asks the owner and a placeholder maintainer to review a verifying change", async () => {
  const asked = [];
  const api = async (method, path, body) => {
    if (path === "/api/people") return [{ email: "owner@brinkercode.dev", owner: true }, { email: PEOPLE[0], owner: false, role: "maintainer" }];
    if (path === `/api/repos/${REPOS.trunk}/changes`) return [{ id: "c1", intent: "Reject orders with a non-positive quantity", state: "verifying" }];
    if (path === "/api/changes/c1/reviewers") asked.push(body.person ?? body.agent_version);
    return method === "GET" ? [] : { id: "t1" };
  };
  await seedReview(api);
  expect(asked).toEqual(["owner@brinkercode.dev", "ana.ruiz@brinkercode.dev", "reviewer@v2"]);
});
