import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { validateEditCheck } from "../src/api/contract.js";
import worker from "../src/index.js";
import { fakeArtifacts } from "./fakes/artifacts.js";

const BASE = "a".repeat(40);

// A repo; changes(...bodies) creates its changes in order (older grants first) with no jobs queued.
async function repo(name) {
  const fake = fakeArtifacts();
  const call = (path, body, token = env.OWNER_TOKEN) => worker.fetch(
    new Request(`http://cinder.test${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: body && JSON.stringify(body) }),
    { ...env, ARTIFACTS: fake },
  );
  expect((await call("/api/repos", { name })).status).toBe(201);
  await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName(name)), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
  const changes = async (...bodies) => {
    const out = [];
    for (const body of bodies) out.push(await (await call(`/api/repos/${name}/changes`, body)).json());
    await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE status IN ('queued', 'claimed')").run();
    return out;
  };
  // Claims a develop job for change and checks one edit of it.
  const check = async (change, edit) => {
    const token = (await (await call("/api/runners", { name: "lab", kinds: ["develop"] })).json()).token;
    const job = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload) VALUES (?, ?, 'develop', ?, 'queued', ?, '{}')")
      .bind(job, change.repo_id, change.id, new Date().toISOString()).run();
    expect((await call("/api/work/claim", { kinds: ["develop"] }, token)).status).toBe(200);
    const res = await call("/api/work/edit-check", { job, base_sha: BASE, writes: [], reads: [], ...edit }, token);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(validateEditCheck(body)).toEqual({ ok: true, errors: [] });
    await env.DB.prepare("UPDATE jobs SET status = 'done' WHERE id = ?").bind(job).run();
    return body.diagnostics;
  };
  const repoDO = env.REPO_DO.get(env.REPO_DO.idFromName(name));
  return { changes, check, repoDO };
}

describe("edit check", () => {
  it("an edit calling a symbol whose signature changed on the target since the base returns an error naming the changing change", async () => {
    const { changes, check } = await repo("edit-signature");
    const [based, changer, editor] = await changes({ intent: "base merge" }, { intent: "rename the totals argument" }, { intent: "use totals" });
    // based's merge made BASE; changer merged after it, changing a.js#total's signature.
    await env.DB.batch([
      env.DB.prepare("UPDATE changes SET state = 'merged' WHERE id IN (?, ?)").bind(based.id, changer.id),
      env.DB.prepare("INSERT INTO change_merged_shas VALUES (?, ?)").bind(based.id, BASE),
      env.DB.prepare("INSERT INTO change_merged_shas VALUES (?, ?)").bind(changer.id, "b".repeat(40)),
      env.DB.prepare("INSERT INTO change_writes VALUES (?, 'a.js#total', 'signature')").bind(changer.id),
    ]);
    const diagnostics = await check(editor, { reads: ["a.js#total"] });
    expect(diagnostics).toContainEqual({ severity: "error", file: "a.js", symbol: "a.js#total", change: changer.id,
      intent: "rename the totals argument", suggestion: "rebase onto main and adapt to the new signature of a.js#total" });
  });

  it("an edit writing a symbol another in-flight change is editing returns a warning to the newer grant only", async () => {
    const { changes, check, repoDO } = await repo("edit-inflight");
    const [older, newer] = await changes({ intent: "older" }, { intent: "newer" });
    await repoDO.grant("main", older.id, ["a.js#f"]);
    await repoDO.grant("main", newer.id, ["b.js#g"]);
    const write = { writes: [{ symbol: "a.js#f", kind: "body" }] };
    expect(await check(newer, write)).toEqual([expect.objectContaining({ severity: "warning", symbol: "a.js#f", change: older.id, intent: "older" })]);
    expect(await check(older, write)).toEqual([expect.objectContaining({ severity: "info", symbol: "a.js#f", change: null })]);
    // The older grant also wins a symbol the newer one holds; the newer one is warned on its next check.
    expect((await check(older, { writes: [{ symbol: "b.js#g", kind: "body" }] })).map((d) => d.severity)).toEqual(["info"]);
    expect(await check(newer, {})).toEqual([expect.objectContaining({ severity: "warning", symbol: "b.js#g", change: older.id })]);
    expect((await repoDO.leases("main"))[older.id].symbols).toEqual(["a.js#f", "b.js#g"]);
  });

  it("a higher-priority change writing a lower-priority change's symbol takes it, and the other change is told to rework", async () => {
    const { changes, check, repoDO } = await repo("edit-priority");
    const [low, high] = await changes({ intent: "tidy totals", priority: "P3" }, { intent: "hotfix totals", priority: "P1" });
    await repoDO.grant("main", low.id, ["a.js#total"]);
    const taken = await check(high, { writes: [{ symbol: "a.js#total", kind: "signature" }] });
    expect(taken).toEqual([expect.objectContaining({ severity: "info", symbol: "a.js#total", change: low.id })]);
    const leases = await repoDO.leases("main");
    expect(leases[high.id].symbols).toEqual(["a.js#total"]);
    expect(leases[low.id].symbols).toEqual([]);
    expect(await check(low, {})).toEqual([{ severity: "error", file: "a.js", symbol: "a.js#total", change: high.id, intent: "hotfix totals",
      suggestion: `rework without a.js#total: ${high.id} has higher priority and took it` }]);
    // Recorded on the change.
    expect((await env.DB.prepare("SELECT severity FROM edit_diagnostics WHERE change_id IN (?, ?) AND severity != 'info'").bind(low.id, high.id).all()).results)
      .toEqual([{ severity: "error" }]);
  });
});
