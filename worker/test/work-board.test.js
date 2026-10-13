import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { REPOS, client, seed } from "../../seed/seed.mjs";
import { CHANGE_STATES } from "../src/api/contract.js";
import worker from "../src/index.js";
import { laneOf } from "../src/api/lanes.js";
import { signedIn } from "./helpers/edge.js";
import { SEED_SOURCES, seedArtifacts } from "./fakes/seed.js";

const now = () => new Date().toISOString();
const work = async (repo, query = "") => (await worker.fetch(signedIn(`/api/repos/${repo}/work${query}`), env)).json();

// A repo with issues [n, fields] and changes [id, card fields, linked issue numbers, requester], straight into D1.
async function board(name, issues, changes = []) {
  const repo = `id-${name}`;
  const at = now();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO repos (id, name, default_branch, strategy, branch_policy, created_at) VALUES (?, ?, 'main', 'trunk', '{}', ?)").bind(repo, name, at),
    ...issues.map(([n, f = {}]) => env.DB.prepare("INSERT INTO issues (id, repo_id, number, title, state, author, assignee, labels, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(`${name}-i${n}`, repo, n, f.title ?? `Issue ${n}`, f.state ?? "open", f.author ?? "ana@example.com", f.assignee ?? null, JSON.stringify(f.labels ?? []), at, at)),
    ...changes.flatMap(([id, card, ns = [], person]) => [
      env.DB.prepare("INSERT INTO changes (id, repo_id, target_branch, state, created_at) VALUES (?, ?, 'main', ?, ?)").bind(id, repo, card.state, at),
      env.DB.prepare("INSERT INTO change_cards (change_id, card) VALUES (?, ?)").bind(id, JSON.stringify({ id, repo_id: repo, title: `Change ${id}`, agent: "owner", ver: null, updated_at: at, ...card })),
      ...ns.map((n) => env.DB.prepare("INSERT INTO issue_links (issue_id, change_id) VALUES (?, ?)").bind(`${name}-i${n}`, id)),
      ...(person ? [env.DB.prepare("INSERT INTO change_requesters (change_id, person) VALUES (?, ?)").bind(id, person)] : []),
    ]),
  ]);
}

describe("work board", () => {
  it("laneOf maps every CHANGE_STATE and an unlinked open issue to its lane", () => {
    const at = now();
    const lanes = Object.fromEntries(CHANGE_STATES.map((state) => [state, laneOf(null, { state, updated_at: at })]));
    expect(lanes).toEqual({
      draft: "progress", planned: "progress", leased: "verify", waiting: "verify", developing: "verify", converging: "verify", verifying: "verify",
      needs_fix: "review", in_queue: "queue", conflict: "verify", resolving: "verify", merged: "merged", failed: "verify", closed: null,
    });
    expect(laneOf(null, { state: "merged", updated_at: new Date(Date.now() - 25 * 3600e3).toISOString() })).toBeNull();
    expect(laneOf({ state: "open" }, null)).toBe("intent");
    expect(laneOf({ state: "closed" }, null)).toBeNull();
    // An issue's agent change stays a claimed intent in progress until its first commit.
    expect(["planned", "leased", "developing"].map((state) => [laneOf({ state: "open" }, { state }), laneOf({ state: "open" }, { state, head_sha: "c" })]))
      .toEqual([["progress", "verify"], ["progress", "verify"], ["progress", "verify"]]);
  });

  it("a verifying change routed to a person is in review, and needs_fix after changes_requested is in review", () => {
    expect(laneOf(null, { state: "verifying", review: { route: "human" } })).toBe("review");
    expect(laneOf(null, { state: "verifying", review: { route: "auto" } })).toBe("verify");
    expect(laneOf({ state: "open" }, { state: "needs_fix" })).toBe("review");
    // An agent repairing its own failed check is still verifying.
    expect(laneOf(null, { state: "needs_fix", repair: { round: 1, max: 2 } })).toBe("verify");
  });

  it("a change linked to issue #n is one item carrying n and change_id, and the issue is not listed alone", async () => {
    await board("wb-link", [[1, { labels: ["bug"] }], [2], [3]], [["wb-c1", { state: "developing" }, [3, 2]], ["wb-c2", { state: "closed" }, [1]]]);
    await env.DB.prepare("INSERT INTO change_heads (change_id, head_sha) VALUES ('wb-c1', ?)").bind("c".repeat(40)).run();
    const { items } = await work("wb-link");
    expect(items.map(({ kind, n, change_id, lane }) => ({ kind, n, change_id, lane }))).toEqual([
      { kind: "change", n: 2, change_id: "wb-c1", lane: "verify" },
      // #1's only change is closed, so #1 is an intent again; #3 is linked to a change carrying the lower #2.
      { kind: "intent", n: 1, change_id: null, lane: "intent" },
      { kind: "intent", n: 3, change_id: null, lane: "intent" },
    ]);
  });

  it("closing an issue publishes its removal", async () => {
    await board("wb-close", [[1]]);
    const { ticket } = await (await worker.fetch(signedIn("/api/live-ticket", { method: "POST", body: JSON.stringify({ repo: "wb-close" }) }), env)).json();
    const ws = (await worker.fetch(signedIn(`/api/repos/wb-close/live?ticket=${ticket}`, { headers: { Origin: "http://cinder.test", Upgrade: "websocket" } }), env)).webSocket;
    ws.accept();
    const updated = new Promise((resolve) => ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.kind === "work.updated") resolve(m);
    }));
    expect((await worker.fetch(signedIn("/api/repos/wb-close/issues/1", { method: "PATCH", body: JSON.stringify({ state: "closed" }) }), env)).status).toBe(200);
    expect(await updated).toMatchObject({ kind: "work.updated", repo: "wb-close", item: null, n: 1 });
    ws.close();
  });

  describe("over seed data", () => {
    const fake = seedArtifacts();
    const real = (url, init) => worker.fetch(signedIn(url, init), { ...env, ARTIFACTS: fake });
    const api = client({ url: "http://cinder.test", token: env.OWNER_TOKEN, fetch: real });
    beforeAll(async () => {
      env.ARTIFACTS = fake;
      await seed(api, undefined, ["changes", "states", "issues"], undefined, SEED_SOURCES);
    }, 120000);

    it("every issue and change of the seeded repos appears exactly once (property test over seed data)", async () => {
      let linked = 0;
      for (const repo of Object.values(REPOS)) {
        const [{ items }, changes, issues] = await Promise.all([api("GET", `/api/repos/${repo}/work`), api("GET", `/api/repos/${repo}/changes`), api("GET", `/api/repos/${repo}/issues`)]);
        expect(issues.length).toBeGreaterThan(0);
        const ids = items.map((i) => i.change_id).filter(Boolean);
        const ns = items.map((i) => i.n).filter(Boolean);
        expect(new Set(ids).size).toBe(ids.length);
        expect(new Set(ns).size).toBe(ns.length);
        expect(ids.sort()).toEqual(changes.filter((c) => laneOf(null, c)).map((c) => c.id).sort());
        for (const i of issues.filter((x) => x.state === "open")) expect(ns).toContain(i.number);
        linked += items.filter((i) => i.n && i.change_id).length;
      }
      expect(linked).toBeGreaterThan(0);
    });
  });

  it("needs_you equals approval plus requested", async () => {
    await board("wb-needs", [[1]], [
      ["wb-n1", { state: "verifying", review: { route: "human" } }], ["wb-n2", { state: "needs_fix" }], ["wb-n3", { state: "verifying" }],
      ["wb-n4", { state: "needs_fix", repair: { round: 1, max: 2 } }], ["wb-n5", { state: "in_queue" }],
    ]);
    const { tiles } = await work("wb-needs");
    expect(tiles).toMatchObject({ needs_you: 2, review: 2, intents: 1, in_flight: 3, merged_24h: 0, verifier: { pass: 0, n: 0, trusted: false } });
  });

  it("q matches title, #n, c-id, author and labels, and who filters agents, people and you", async () => {
    await board("wb-q", [[1, { title: "Cart overflows", labels: ["checkout"] }], [2, { assignee: "developer@v7" }], [3, { author: "owner" }]], [
      ["wb-qa", { state: "developing", agent: "developer", ver: "v7" }], ["wb-qb", { state: "verifying", reviewers: [{ person: "owner" }] }, [], "bo@example.com"],
      ["wb-qc", { state: "planned" }, [], "cy@example.com"],
    ]);
    const keys = async (query) => (await work("wb-q", query)).items.map((i) => i.change_id ?? `#${i.n}`).sort();
    expect(await keys("?q=overflows")).toEqual(["#1"]);
    expect(await keys("?q=%233")).toEqual(["#3"]);
    expect(await keys("?q=c-wb-qb")).toEqual(["wb-qb"]);
    expect(await keys("?q=CY@example")).toEqual(["wb-qc"]);
    expect(await keys("?q=checkout")).toEqual(["#1"]);
    expect(await keys("?who=agents")).toEqual(["#2", "wb-qa"]);
    expect(await keys("?who=people")).toEqual(["#1", "#3", "wb-qb", "wb-qc"]);
    expect(await keys("?who=you")).toEqual(["#3", "wb-qb"]);
    expect((await worker.fetch(signedIn("/api/repos/wb-q/work?who=bots"), env)).status).toBe(400);
  });
});
