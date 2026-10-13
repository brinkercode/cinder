import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.js";
import { raiseBudgetNeeds } from "../src/needs.js";

const OWNER = { Authorization: `Bearer ${env.OWNER_TOKEN}` };
const spend = (tokens) => env.DB.prepare("INSERT INTO usage_logs (id, repo_id, at, tokens, cost_usd) VALUES (?, '', ?, ?, 0)")
  .bind(crypto.randomUUID(), new Date().toISOString(), tokens).run();
const alerts = async () => (await (await worker.fetch(new Request("http://cinder.test/api/needs", { headers: OWNER }), env)).json())
  .filter((n) => n.kind === "Budget alert");

it("crossing the 80% alert raises one Budget alert need for the month", async () => {
  await env.DB.prepare("UPDATE account SET budget_tokens = 1000, alerts = '[80]' WHERE id = 1").run();
  await spend(799);
  await raiseBudgetNeeds(env);
  expect(await alerts()).toEqual([]);
  await spend(1);
  await raiseBudgetNeeds(env);
  await spend(100);
  await raiseBudgetNeeds(env);
  const month = new Date().toISOString().slice(0, 7);
  expect(await alerts()).toEqual([{ id: expect.any(String), kind: "Budget alert", repo: "account", change: null,
    text: `80% of the ${month} token budget used`, actions: ["Raise budget", "Open Insights", "Edit alerts"] }]);
});
