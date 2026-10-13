import assert from "node:assert/strict";
import { afterEach, beforeEach, it, mock } from "node:test";
import worker, { check } from "../src/index.js";
import { fakeEnv } from "./fakes.js";

beforeEach(() => {
  mock.method(globalThis, "fetch", async (url) => {
    if (url.includes("down")) throw new Error("connection refused");
    return new Response("", { status: url.includes("fail") ? 503 : 200 });
  });
});
afterEach(() => mock.restoreAll());

const get = (env, path) => worker.fetch(new Request(`https://pulse.test${path}`), env);

it("check records each target in D1 and the latest status in KV", async () => {
  const env = fakeEnv("https://a.test, https://fail.test,https://down.test");
  await check(env, 1000);
  assert.deepEqual(env.DB.rows.map(({ url, ok, status }) => [url, ok, status]),
    [["https://a.test", 1, 200], ["https://fail.test", 0, 503], ["https://down.test", 0, 0]]);
  const latest = await env.CACHE.get("latest", "json");
  assert.equal(latest.checked_at, 1000);
  assert.deepEqual(latest.results.map((r) => r.ok), [true, false, false]);
});

it("check records the targets that went down since the previous check", async () => {
  const env = fakeEnv("https://a.test,https://b.test");
  await check(env);
  mock.method(globalThis, "fetch", async (url) => new Response("", { status: url.includes("a.test") ? 503 : 200 }));
  await check(env);
  assert.deepEqual((await env.CACHE.get("latest", "json")).went_down, ["https://a.test"]);
});

it("check with no targets stores an empty latest status", async () => {
  const env = fakeEnv(undefined);
  assert.deepEqual(await check(env), []);
  assert.deepEqual((await env.CACHE.get("latest", "json")).results, []);
});

it("scheduled runs the check", async () => {
  const env = fakeEnv("https://a.test");
  let done;
  await worker.scheduled({}, env, { waitUntil: (p) => { done = p; } });
  await done;
  assert.equal(env.DB.rows.length, 1);
});

it("status page shows the latest status and 24h uptime, escaped", async () => {
  const env = fakeEnv("https://a.test/?q=<x>");
  await check(env);
  mock.method(globalThis, "fetch", async () => new Response("", { status: 500 }));
  await check(env);
  const res = await get(env, "/");
  assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
  const html = await res.text();
  assert.match(html, /https:\/\/a\.test\/\?q=&#60;x&#62;<\/td><td>down<\/td><td>500<\/td>/);
  assert.match(html, /50\.00%/);
});

it("status page before any check says so", async () => {
  assert.match(await (await get(fakeEnv(""), "/")).text(), /No checks yet/);
});

it("healthz answers ok and unknown paths 404", async () => {
  const env = fakeEnv("");
  assert.equal(await (await get(env, "/healthz")).text(), "ok");
  assert.equal((await get(env, "/nope")).status, 404);
});
