import { env } from "cloudflare:workers";
import { expect, it, onTestFinished } from "vitest";
import { PEOPLE, client, seed } from "../../seed/seed.mjs";
import worker from "../src/index.js";
import { seedArtifacts } from "./fakes/seed.js";

it("with both Access vars set every seed request carries both headers", async () => {
  const seen = [];
  const fetch = async (url, init) => { seen.push(init.headers); return Response.json({}); };
  const api = client({ url: "http://cinder.test", token: "t", accessId: "id", accessSecret: "secret", fetch });
  await api("GET", "/api/repos");
  await api("POST", "/api/repos", { name: "x" }, "runner-token");
  expect(seen).toHaveLength(2);
  for (const h of seen) expect(h).toMatchObject({ "CF-Access-Client-Id": "id", "CF-Access-Client-Secret": "secret" });
});

it("a redirect to cloudflareaccess.com raises the message naming the Access variables", async () => {
  const fetch = async () => new Response("<html>login</html>", { status: 302, headers: { Location: "https://team.cloudflareaccess.com/cdn-cgi/access/login" } });
  const api = client({ url: "http://cinder.test", token: "t", fetch });
  await expect(api("GET", "/api/repos")).rejects.toThrow(/CINDER_ACCESS_CLIENT_ID and CINDER_ACCESS_CLIENT_SECRET/);
});

it("a full seed's people are the owner and five @brinkercode.dev people, each with a role", async () => {
  // The owner has signed in through Access; only the access section creates people. RepoDOs read Artifacts from env itself.
  env.ARTIFACTS = seedArtifacts();
  onTestFinished(() => { delete env.ARTIFACTS; });
  const e = { ...env, OWNERS: "owner@brinkercode.dev" };
  await env.DB.prepare("INSERT INTO people (email, created_at) VALUES ('owner@brinkercode.dev', '2026-10-01T00:00:00Z')").run();
  const api = client({ url: "http://cinder.test", token: env.OWNER_TOKEN, fetch: (url, init) => worker.fetch(new Request(url, init), e) });
  await seed(api, undefined, ["access"]);
  const people = (await api("GET", "/api/people")).map((p) => [p.email, p.owner, p.role]);
  expect(people).toEqual([
    ["ana.ruiz@brinkercode.dev", false, "maintainer"], ["ben.okafor@brinkercode.dev", false, "developer"], ["chen.wu@brinkercode.dev", false, "developer"],
    ["dara.novak@brinkercode.dev", false, "contributor"], ["emeka.obi@brinkercode.dev", false, "viewer"], ["owner@brinkercode.dev", true, null],
  ]);
  expect(PEOPLE.every((p) => /^[a-z]+\.[a-z]+@brinkercode\.dev$/.test(p))).toBe(true);
}, 60000);
