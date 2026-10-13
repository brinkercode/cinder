// The live intent box's API calls (agents and changes preview), answered by this worker after a full seed.
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, expect, it } from "vitest";
import { REPOS, client, seed } from "../../seed/seed.mjs";
import { validateChangePreview } from "../src/api/shapes.js";
import worker from "../src/index.js";
import { seedArtifacts } from "./fakes/seed.js";
import { indexFor, markReady } from "./helpers/pool.js";

const fake = seedArtifacts();
const real = (url, init) => worker.fetch(new Request(new URL(url, "http://cinder.test"), init), { ...env, ARTIFACTS: fake });
const api = client({ url: "http://cinder.test", token: env.OWNER_TOKEN, fetch: real });

// The fake can't take a git push, so the seed's release push is delivered as the push event Artifacts would queue.
const push = async ({ lock }) => {
  await env.DB.prepare("INSERT OR IGNORE INTO ref_writes (repo, ref, sha) VALUES ('cinder-agents', ?, ?)").bind(`refs/tags/agent/${lock.name}/v${lock.version}`, "b".repeat(40)).run();
  await worker.queue({ messages: [{ body: {
  type: "cf.artifacts.repo.pushed", source: { type: "artifacts.repo", namespace: "cinder", repoName: "cinder-agents" },
  payload: { ref: `refs/tags/agent/${lock.name}/v${lock.version}`, before: "a".repeat(40), after: "b".repeat(40), commits: [{ id: "c".repeat(40), message: JSON.stringify(lock, null, 2) }] },
} }] }, { ...env, ARTIFACTS: fake });
};

beforeAll(async () => {
  env.ARTIFACTS = fake;
  await fake.create("cinder-agents");
  // A pool indexes develop before the gitflow section files its intents, so they lease the symbols they name.
  await seed(api, push, []);
  await indexFor(api, REPOS.gitflow, "develop", [
    { path: "lib/cart/discount.ts", name: "applyDiscount", kind: "function", line: 2, end: 4 },
    { path: "lib/address/postcode.ts", name: "validatePostcode", kind: "function", line: 2, end: 4 },
    { path: "lib/payment/cards.ts", name: "sortSavedCards", kind: "function", line: 2, end: 4 },
  ]);
  await seed(api, push, ["gitflow"]);
  // A person marks the seed's drafts ready, so the changes take their leases.
  await markReady(api, [REPOS.gitflow]);
}, 120000); // seeds under every worker file starting at once; 30 s hook limit times out
afterAll(() => { delete env.ARTIFACTS; });

const preview = async (intent, target) => {
  const p = await api("POST", `/api/repos/${REPOS.gitflow}/changes/preview`, { intent, target });
  expect(validateChangePreview(p).errors).toEqual([]);
  return p;
};

it("after seeding, the page's API calls return data for every state the design shows", async () => {
  const changes = await api("GET", `/api/repos/${REPOS.gitflow}/changes`);
  const id = (intent) => changes.find((c) => c.intent === intent).id;
  // Agent: a stable default and a picked version (@developer@v3) that resolves.
  expect((await api("GET", "/api/agents")).find((a) => a.name === "developer").channels).toContainEqual(expect.objectContaining({ channel: "stable" }));
  // Predicted leases with collisions, @agent and a #change link.
  const busy = await preview(`Apply discount codes to the cart total @developer@v3 #${id("Validate postcodes on the address form")}`, "develop");
  expect(busy.symbols.map((s) => s.symbol)).toContain("lib/cart/discount.ts#applyDiscount");
  expect(busy.collisions.map((c) => c.change)).toContain(id("Apply discount codes before tax"));
  expect(busy.agents).toEqual([expect.objectContaining({ ref: "developer@v3", agent_version: expect.anything() })]);
  expect(busy.changes).toEqual([id("Validate postcodes on the address form")]);
  // Predicted leases, none colliding.
  const free = await preview("Sort saved cards by last use", "develop");
  expect(free.symbols.map((s) => s.symbol)).toContain("lib/payment/cards.ts#sortSavedCards");
  expect(free.collisions).toEqual([]);
  // No existing symbols matched.
  expect((await preview("Add a dark mode toggle", "develop")).symbols).toEqual([]);
});
