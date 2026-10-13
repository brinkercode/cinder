import { env } from "cloudflare:workers";
import { afterEach } from "vitest";
import worker from "../src/index.js";
import { fakeAnalytics } from "./fakes/analytics.js";
import { withRefs } from "./fakes/artifacts.js";
import { applyMigrations } from "./helpers/migrations.js";

await applyMigrations(env);
// The test Worker binds no containers, so the install's managed pools are drained: autoscale never starts one for a queued job.
await env.DB.prepare("UPDATE worker_pools SET draining = 1").run();
// Every test file runs this; the first creates the local secret (a second, racing create rewrites the same value).
const tickets = env.LIVE_TICKET_KEY["SecretsStoreSecret::admin_api"]();
if (!(await tickets.list()).length) await tickets.create("test-live-ticket-key");
// Durable Objects share this env, so ChangeDO writes the points GET insights reads.
const insights = fakeAnalytics();
Object.assign(env, { INSIGHTS: insights, INSIGHTS_SQL: insights.sql });

// Live tests render web routes whose loaders fire requests at the worker that may still be in flight (a loader's
// Promise.all settles on the first failure) when the test ends; teardown then kills them mid-import. Every file's
// requests go through worker.fetch, so track those and let them finish after each test.
const sent = new Set();
const fetch = worker.fetch.bind(worker);
worker.fetch = (...args) => {
  const p = fetch(...args);
  sent.add(p);
  p.then(() => sent.delete(p), () => sent.delete(p));
  return p;
};
afterEach(async () => { await Promise.allSettled([...sent]); });

// The Artifacts fake hands out https://artifacts.fake remotes. A real fetch to one fails workerd's DNS lookup, which logs
// an uncaught jsg internal error on every call, so it is refused here, as a network failure, before it leaves the isolate.
const net = globalThis.fetch;
globalThis.fetch = withRefs((input, init) => (String(input?.url ?? input).startsWith("https://artifacts.fake/")
  ? Promise.reject(new Error("artifacts.fake is not reachable from tests"))
  : net(input, init)));
