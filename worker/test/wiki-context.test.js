import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { validateWikiContext } from "../src/api/contract.js";
import worker from "../src/index.js";
import { fakeArtifacts } from "./fakes/artifacts.js";

const fake = fakeArtifacts();
const call = (path, body, { method = body ? "POST" : "GET", token = env.OWNER_TOKEN } = {}) => worker.fetch(
  new Request(`http://cinder.test${path}`, { method, headers: { Authorization: `Bearer ${token}` }, body: body && JSON.stringify(body) }),
  { ...env, ARTIFACTS: fake },
);
const flag = (name, id, on) => call(`/api/repos/${name}/wiki/pages/${id}`, { agent_context: on }, { method: "PATCH" });

// A repo plus page(id, title, content, {parent, sort, type}) inserting a wiki page row.
async function repo(name) {
  expect((await call("/api/repos", { name })).status).toBe(201);
  const { id: repoId } = await env.DB.prepare("SELECT id FROM repos WHERE name = ?").bind(name).first();
  const page = (id, title, content = "", { parent = null, sort = 0, type = "page" } = {}) => env.DB.prepare(
    "INSERT INTO wiki_pages (id, repo_id, parent_id, title, slug, type, content, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', '')",
  ).bind(id, repoId, parent, title, title.toLowerCase(), type, content, sort).run();
  return { repoId, page };
}

// A develop claim on a change in a repo with no .cinder.yml, with "Conventions" flagged and "Billing" not.
async function developClaim(name) {
  const { page } = await repo(name);
  await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName(name)), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
  await page(`${name}-conv`, "Conventions", "Use tabs.");
  await page(`${name}-billing`, "Billing", "Invoices round billing totals half-up.");
  expect((await flag(name, `${name}-conv`, true)).status).toBe(200);
  const change = await (await call(`/api/repos/${name}/changes`, { intent: "round billing totals" })).json();
  // Other tests' queued jobs would be claimed first.
  await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE status IN ('queued', 'claimed') AND NOT (change_id = ? AND kind = 'develop')").bind(change.id).run();
  const token = (await (await call("/api/runners", { name: "lab", kinds: ["develop"] })).json()).token;
  const claim = await (await call("/api/work/claim", { kinds: ["develop"] }, { token })).json();
  return { claim, change };
}

describe("wiki agent context", () => {
  it("flagging a page adds it to /wiki/context and unflagging removes it", async () => {
    const { page } = await repo("ctx-flag");
    await page("ctx-guides", "Guides", "", { type: "folder" });
    await page("ctx-style", "Style", "Prefer early returns.", { parent: "ctx-guides" });
    await page("ctx-other", "Other", "Not context.", { sort: 1 });
    expect((await call("/api/repos/ctx-flag/wiki/context")).status).toBe(200);
    const flagged = await (await flag("ctx-flag", "ctx-style", true)).json();
    expect(flagged.agent_context).toBe(true);
    const on = await (await call("/api/repos/ctx-flag/wiki/context")).json();
    expect(validateWikiContext(on)).toEqual({ ok: true, errors: [] });
    expect(on).toEqual({ pages: [{ id: "ctx-style", title: "Style", path: "guides/style", content: "Prefer early returns." }], tokens: 6, truncated: false });
    expect((await flag("ctx-flag", "ctx-style", false)).status).toBe(200);
    expect(await (await call("/api/repos/ctx-flag/wiki/context")).json()).toEqual({ pages: [], tokens: 0, truncated: false });
    expect((await flag("ctx-flag", "ctx-style", "yes")).status).toBe(400);
  });

  it("context stops before 24k tokens without cutting a page and sets truncated", async () => {
    const { page } = await repo("ctx-cap");
    // 40,000 bytes each: 10,000 tokens, so the third would pass 24k.
    for (const n of [1, 2, 3]) {
      await page(`cap-${n}`, `Page ${n}`, "x".repeat(40000), { sort: n });
      await flag("ctx-cap", `cap-${n}`, true);
    }
    const ctx = await (await call("/api/repos/ctx-cap/wiki/context")).json();
    expect(ctx.pages.map((p) => [p.id, p.content.length])).toEqual([["cap-1", 40000], ["cap-2", 40000]]);
    expect(ctx).toMatchObject({ tokens: 20000, truncated: true });
  });

  it("a develop claim carries flagged pages without wiki.context in .cinder.yml and records them in job_wiki_context", async () => {
    const { claim } = await developClaim("ctx-claim");
    expect(claim.payload.wiki).toEqual([{ id: "ctx-claim-conv", title: "Conventions", content: "Use tabs.", sha: expect.stringMatching(/^[0-9a-f]{40}$/) }]);
    const { results } = await env.DB.prepare("SELECT page_id, sha FROM job_wiki_context WHERE job_id = ?").bind(claim.job.id).all();
    expect(results).toEqual([{ page_id: "ctx-claim-conv", sha: claim.payload.wiki[0].sha }]);
  });

  it("GET /api/changes/:id lists the wiki pages its agent run used", async () => {
    const { claim, change } = await developClaim("ctx-change");
    const detail = await (await call(`/api/changes/${change.id}`)).json();
    expect(detail.wiki_context).toEqual([{ id: "ctx-change-conv", title: "Conventions", sha: claim.payload.wiki[0].sha }]);
  });
});
