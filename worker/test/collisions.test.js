import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { validateCollisions } from "../src/api/contract.js";
import worker from "../src/index.js";
import { scoreSeam } from "../src/judgments.js";
import { mergeBlockers } from "../src/queue.js";
import { fakeClefAI } from "./fakes/ai.js";
import { fakeArtifacts } from "./fakes/artifacts.js";

const stub = (id) => env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id));

// A repo with two changes: `holder` leases b.js, `ours` leases a.js#f. pushWrites makes `ours` write into the holder's symbol.
async function setup(name, extra = {}) {
  const fake = fakeArtifacts();
  const call = (path, body, token = env.OWNER_TOKEN) => worker.fetch(
    new Request(`http://cinder.test${path}`, { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${token}` }, body: body && JSON.stringify(body) }),
    { ...env, ARTIFACTS: fake, ...extra },
  );
  expect((await call("/api/repos", { name })).status).toBe(201);
  await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName(name)), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
  const ours = await (await call(`/api/repos/${name}/changes`, { intent: "x" })).json();
  const holder = await (await call(`/api/repos/${name}/changes`, { intent: "y" })).json();
  const later = await (await call(`/api/repos/${name}/changes`, { intent: "z" })).json();
  await env.DB.prepare("DELETE FROM jobs WHERE change_id IN (?, ?, ?)").bind(ours.id, holder.id, later.id).run();
  // Earlier tests leave jobs queued on other repos; a claim would pick them up.
  await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE status IN ('queued', 'claimed')").run();
  const repoDO = env.REPO_DO.get(env.REPO_DO.idFromName(name));
  await repoDO.grant("main", ours.id, ["a.js#f"]);
  await repoDO.grant("main", holder.id, ["b.js"]);
  await repoDO.grant("main", later.id, ["c.js#k"]);
  const runner = (await (await call("/api/runners", { name: "lab", kinds: ["develop"] })).json()).token;
  const pushWrites = async (change, writes) => {
    const job = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload) VALUES (?, ?, 'develop', ?, 'queued', ?, '{}')")
      .bind(job, change.repo_id, change.id, new Date().toISOString()).run();
    await call("/api/work/claim", { kinds: ["develop"] }, runner);
    return call(`/api/work/jobs/${job}/report`, { status: "done", writes }, runner);
  };
  // A person's change, `ours`, collides on b.js#g: it waits in conflict for its person.
  const openCollision = async () => {
    expect((await call(`/api/changes/${ours.id}/takeover`, {})).status).toBe(200);
    await pushWrites(ours, [{ symbol: "b.js#g", kind: "signature" }]);
    await stub(ours.id).takeMessages();
    await stub(holder.id).takeMessages();
  };
  const feed = async () => { const body = await (await call(`/api/repos/${name}/collisions`)).json(); expect(validateCollisions(body).errors).toEqual([]); return body; };
  return { call, fake, ours, holder, later, pushWrites, openCollision, feed };
}

// The repo's seam judge on clef@1, trusted when `outcomes` scored judgments meet the repo's minimum of 30.
async function seamJudge(repo, outcomes) {
  await env.DB.prepare("INSERT OR REPLACE INTO judge_config (repo_id, kind, backend, model_version) VALUES (?, 'seam', 'clef', 'clef@1')").bind(repo).run();
  await env.DB.prepare("INSERT INTO repo_trust (repo, min_outcomes) VALUES (?, 30)").bind(repo).run();
  for (let i = 0; i < outcomes; i++) {
    await env.DB.prepare("INSERT INTO judgments (id, repo_id, kind, backend, model_version, state_hash, question, answer, probability, made_at) VALUES (?, ?, 'seam', 'clef', 'clef@1', ?, 'q', 'yes', 0.9, '')")
      .bind(`${repo}-seam-${i}`, repo, `h${i}`).run();
    await env.DB.prepare("INSERT INTO outcomes (judgment_id, actual, correct, observed_at) VALUES (?, 'yes', 1, '')").bind(`${repo}-seam-${i}`).run();
  }
}

const setState = (id, state) => runInDurableObject(stub(id), async (i) => { await i.ctx.storage.put("change", { ...(await i.ctx.storage.get("change")), state }); });

describe("collisions", () => {
  it("a collision is stacked automatically in lease order without a person", async () => {
    const s = await setup("col-auto-stack");
    await s.pushWrites(s.ours, [{ symbol: "b.js#g", kind: "signature" }]);
    expect(await stub(s.ours.id).get()).toMatchObject({ state: "waiting", stacked_on: s.holder.id });
    expect((await s.feed()).feed[0]).toMatchObject({ ours: s.ours.id, theirs: s.holder.id, severity: "high", resolution: "stack", action: expect.stringMatching(/^Stacked: /) });
    // It develops on the holder's head once the holder pushes; no resolve job is queued for a person to unblock.
    const { results: jobs } = await env.DB.prepare("SELECT kind, payload FROM jobs WHERE change_id = ? AND status = 'queued'").bind(s.ours.id).all();
    expect(jobs.map((j) => [j.kind, JSON.parse(j.payload).wait_for])).toEqual([["develop", s.holder.id]]);
  });

  it("an untrusted seam judge falls back to stacking, not to a person", async () => {
    const s = await setup("col-untrusted", { AI: fakeClefAI(async () => ({ seam: 0.95 })) });
    await seamJudge(s.ours.repo_id, 0);
    await s.pushWrites(s.ours, [{ symbol: "b.js#g", kind: "signature" }]);
    const change = await stub(s.ours.id).get();
    expect(change.state).toBe("waiting");
    expect(change.events.find((e) => e.kind === "collision_resolved")).toMatchObject({ actor: { type: "system" }, reason: "stack: the default while the seam judge isn't trusted" });
    expect((await s.feed()).feed[0].action).toBe("Stacked: the default while the seam judge isn't trusted");
  });

  it("a trusted seam judge settles a collision on a shared interface with a seam", async () => {
    const s = await setup("col-seam-trusted", { AI: fakeClefAI(async () => ({ seam: 0.95 })) });
    await seamJudge(s.ours.repo_id, 30);
    await s.pushWrites(s.ours, [{ symbol: "b.js#g", kind: "signature" }]);
    expect((await s.feed()).feed[0]).toMatchObject({ resolution: "seam", action: expect.stringMatching(/^Seam proposed: the seam judge found a shared interface/) });
  });

  it("a stacked change merges only after its base", async () => {
    const s = await setup("col-order");
    await s.pushWrites(s.ours, [{ symbol: "b.js#g", kind: "body" }]);
    expect(await mergeBlockers(env, await stub(s.ours.id).get())).toContainEqual({ code: "stacked", reason: `stacked on ${s.holder.id}, which merges first`, since: null });
    expect((await mergeBlockers(env, await stub(s.holder.id).get())).map((b) => b.code)).not.toContain("stacked");
  });

  it.each(["stack", "seam", "handover", "reprioritize"])("a person resolving their change's collision with %s resolves it and tells both agents", async (action) => {
    const s = await setup(`col-${action}`);
    await s.openCollision();
    expect((await stub(s.ours.id).get()).state).toBe("conflict");
    expect((await s.feed()).feed[0]).toMatchObject({ ours: s.ours.id, theirs: s.holder.id, symbol: "b.js#g", resolution: null, action: "Stopped; the change moved to conflict" });

    const res = await s.call(`/api/changes/${s.ours.id}/collisions/resolve`, { action });
    expect(res.status).toBe(200);
    expect((await stub(s.ours.id).get()).state).not.toBe("conflict");
    expect((await s.feed()).feed[0]).toMatchObject({ resolution: action, resolved_at: expect.any(String) });
    for (const id of [s.ours.id, s.holder.id]) expect((await stub(id).takeMessages()).map((m) => m.text).join()).toContain(action);
    // Resolving twice finds nothing open.
    expect((await s.call(`/api/changes/${s.ours.id}/collisions/resolve`, { action })).status).toBe(409);
  });

  // The holder's verify wrote b.js (a file with no symbols, like a .tf) on these base lines; a person's change then
  // pushes its own edit of b.js.
  const personWrites = async (name, holderLines, ourLines) => {
    const s = await setup(name);
    await env.DB.batch([env.DB.prepare("INSERT INTO change_writes VALUES (?, 'b.js', 'body')").bind(s.holder.id),
      env.DB.prepare("INSERT INTO change_write_lines VALUES (?, 'b.js', ?)").bind(s.holder.id, holderLines)]);
    expect((await s.call(`/api/changes/${s.ours.id}/takeover`, {})).status).toBe(200);
    const res = await s.pushWrites(s.ours, [{ symbol: "b.js", kind: "body", lines: ourLines }]);
    return { ...s, change: (await res.json()).change };
  };

  it("two changes editing different attributes of one variable block both proceed with no collision", async () => {
    // variable "name": the holder rewrote description (line 7), ours the validation condition and message (12-13).
    const s = await personWrites("col-disjoint", "7-7", "12-13");
    expect(s.change.state).not.toBe("conflict");
    expect((await s.feed()).feed).toEqual([]);
  });

  it("a real line conflict still becomes a collision", async () => {
    // Both rewrote the validation condition on line 12; an edit touching the next line conflicts too, as in git.
    for (const [name, ours] of [["col-overlap", "12-13"], ["col-adjacent", "13-13"]]) {
      const s = await personWrites(name, "12-12", ours);
      expect(s.change.state).toBe("conflict");
      expect((await s.feed()).feed[0]).toMatchObject({ ours: s.ours.id, theirs: s.holder.id, symbol: "b.js" });
    }
  });

  it("a person-driven collision queues no resolve job", async () => {
    const s = await setup("col-person-wait");
    await s.openCollision();
    expect((await stub(s.ours.id).get()).state).toBe("conflict");
    const resolves = await env.DB.prepare("SELECT id FROM jobs WHERE change_id = ? AND kind = 'resolve'").bind(s.ours.id).all();
    expect(resolves.results).toEqual([]);
  });

  it("rejects an unknown action and leaves the collision open", async () => {
    const s = await setup("col-bad");
    await s.openCollision();
    expect((await s.call(`/api/changes/${s.ours.id}/collisions/resolve`, { action: "ignore" })).status).toBe(400);
    expect((await stub(s.ours.id).get()).state).toBe("conflict");
  });

  it("a push shows as editing now on its symbols until the signal lapses", async () => {
    const s = await setup("col-editing");
    await s.pushWrites(s.ours, [{ symbol: "b.js#g", kind: "signature" }]);
    expect((await s.feed()).editing).toMatchObject([{ symbol: "b.js#g", change_id: s.ours.id, kind: "signature" }]);
    await env.DB.prepare("UPDATE symbol_editing SET at = '2020-01-01T00:00:00.000Z'").run();
    expect((await s.feed()).editing).toEqual([]);
  });

  it("the feed lists exactly the diagnostics sent to the agents, newest first", async () => {
    const s = await setup("col-feed");
    await s.pushWrites(s.ours, [{ symbol: "b.js#g", kind: "signature" }, { symbol: "b.js#h", kind: "body" }]);
    const sent = (await stub(s.ours.id).takeMessages()).map((m) => m.text);
    const { feed } = await s.feed();
    expect(feed.map((f) => f.message).toSorted()).toEqual(sent.toSorted());
    expect(feed.map((f) => f.detected_at)).toEqual(feed.map((f) => f.detected_at).toSorted().toReversed());
    // A second change colliding later comes first.
    await s.pushWrites(s.later, [{ symbol: "b.js#g", kind: "body" }]);
    expect((await s.feed()).feed.map((f) => f.ours)).toEqual([s.later.id, s.ours.id, s.ours.id]);
  });
  it("a person-driven change gets a seam suggestion from a trusted yes seam judgment, and nothing is settled", async () => {
    const s = await setup("col-advise-seam", { AI: fakeClefAI(async () => ({ seam: 0.95 })) });
    await seamJudge(s.ours.repo_id, 30);
    await s.openCollision();
    expect((await stub(s.ours.id).get()).state).toBe("conflict");
    const [f] = (await s.feed()).feed;
    expect(f).toMatchObject({ resolution: null, resolved_by: null, suggested: { action: "seam", why: expect.stringMatching(/^The seam judge found a shared interface/), p: expect.any(Number) } });
  });

  it("a person-driven change whose holder is in queue gets a stack suggestion", async () => {
    const s = await setup("col-advise-stack");
    await setState(s.holder.id, "in_queue");
    await s.openCollision();
    expect((await stub(s.ours.id).get()).state).toBe("conflict");
    expect((await s.feed()).feed[0]).toMatchObject({ resolution: null, suggested: { action: "stack", why: `${s.holder.id} is in queue; stacking waits the least.` } });
  });

  it("an untrusted seam judge with the holder developing suggests nothing", async () => {
    const s = await setup("col-advise-none", { AI: fakeClefAI(async () => ({ seam: 0.95 })) });
    await seamJudge(s.ours.repo_id, 0);
    await setState(s.holder.id, "developing");
    await s.openCollision();
    expect((await s.feed()).feed[0]).toMatchObject({ resolution: null, suggested: null });
  });

  it("the seam judgment on a person-driven change is recorded and scored after the stack verifies", async () => {
    const s = await setup("col-advise-scored", { AI: fakeClefAI(async () => ({ seam: 0.95 })) });
    await seamJudge(s.ours.repo_id, 0);
    await s.openCollision();
    const asked = () => env.DB.prepare("SELECT j.answer, o.actual FROM judgments j LEFT JOIN outcomes o ON o.judgment_id = j.id WHERE j.change_id = ? AND j.kind = 'seam'").bind(s.ours.id).all();
    expect((await asked()).results).toEqual([{ answer: "yes", actual: null }]);
    expect((await s.call(`/api/changes/${s.ours.id}/collisions/resolve`, { action: "stack" })).status).toBe(200);
    // Its verify wrote the collided symbol's signature, so the overlap was a shared interface.
    await env.DB.prepare("INSERT INTO change_writes VALUES (?, 'b.js#g', 'signature')").bind(s.ours.id).run();
    await scoreSeam(env.DB, s.ours.id, new Date().toISOString());
    expect((await asked()).results).toEqual([{ answer: "yes", actual: "yes" }]);
  });

  it("a human resolve writes resolved_by human and cinder's own settle writes resolved_by system cinder", async () => {
    const person = await setup("col-by-human");
    await person.openCollision();
    expect((await person.call(`/api/changes/${person.ours.id}/collisions/resolve`, { action: "stack" })).status).toBe(200);
    expect((await person.feed()).feed[0].resolved_by).toEqual({ type: "human", id: "owner" });
    const agent = await setup("col-by-system");
    await agent.pushWrites(agent.ours, [{ symbol: "b.js#g", kind: "signature" }]);
    expect((await agent.feed()).feed[0]).toMatchObject({ resolution: "stack", resolved_by: { type: "system", id: "cinder" } });
  });

  it("?target=release/2.4 returns only that target's collisions", async () => {
    const s = await setup("col-target");
    await s.pushWrites(s.ours, [{ symbol: "b.js#g", kind: "signature" }]);
    await env.DB.prepare("UPDATE changes SET target_branch = 'release/2.4' WHERE id = ?").bind(s.ours.id).run();
    const of = async (q) => { const body = await (await s.call(`/api/repos/col-target/collisions${q}`)).json(); expect(validateCollisions(body).errors).toEqual([]); return body; };
    expect((await of("?target=main")).feed).toEqual([]);
    expect((await of("?target=main")).editing).toEqual([]);
    expect((await of("?target=release%2F2.4")).feed.map((f) => f.ours)).toEqual([s.ours.id]);
    expect((await of("?target=release%2F2.4")).editing.map((e) => e.change_id)).toEqual([s.ours.id]);
    expect((await of("")).feed.map((f) => f.ours)).toEqual([s.ours.id]);
  });

  it("the lease map honours ?target= and an unknown branch returns 404", async () => {
    const s = await setup("col-map-target");
    Object.assign(s.fake.repos.get("col-map-target"), { commits: [{ sha: "s1" }], branches: ["main", "release/2.4"] });
    await env.DB.prepare("UPDATE changes SET target_branch = 'release/2.4' WHERE id = ?").bind(s.later.id).run();
    await env.REPO_DO.get(env.REPO_DO.idFromName("col-map-target")).grant("release/2.4", s.later.id, ["r.js#x"]);
    const map = async (q) => (await s.call(`/api/repos/col-map-target/lease-map${q}`)).json();
    expect((await map("")).changes.map((c) => c.id)).not.toContain(s.later.id);
    const release = await map("?target=release%2F2.4");
    expect(release.changes.map((c) => c.id)).toEqual([s.later.id]);
    // Each listed change carries its repo key, which the Collisions page shows instead of the id.
    expect(release.changes[0].key).toMatch(/^COLMAPTARGET-\d+$/);
    expect(release.leases.map((l) => [l.holder, l.symbol])).toEqual([[s.later.id, "r.js#x"]]);
    const res = await s.call("/api/repos/col-map-target/lease-map?target=nope");
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("ref_not_found");
  });
});
