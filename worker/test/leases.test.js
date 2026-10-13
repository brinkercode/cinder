import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const repoDO = (name) => env.REPO_DO.get(env.REPO_DO.idFromName(name));

describe("RepoDO leases", () => {
  it("disjoint leases both granted", async () => {
    const repo = repoDO("lease-disjoint");
    expect(await repo.grant("main", "c1", ["a.js#f"])).toEqual({ granted: true });
    expect(await repo.grant("main", "c2", ["b.js#g"])).toEqual({ granted: true });
  });

  it("overlap returns the other change", async () => {
    const repo = repoDO("lease-overlap");
    await repo.grant("main", "c1", ["a.js#f", "a.js#g"]);
    expect(await repo.grant("main", "c2", ["a.js#g"])).toEqual({ granted: false, overlaps: ["c1"] });
  });

  it("leases on different targets never collide", async () => {
    const repo = repoDO("lease-targets");
    await repo.grant("main", "c1", ["a.js#f"]);
    expect(await repo.grant("release/1", "c2", ["a.js#f"])).toEqual({ granted: true });
    expect(await repo.collisions("main")).toEqual([]);
  });

  it("collision graph links overlapping leases and judged collisions above threshold", async () => {
    const repo = repoDO("lease-graph");
    await repo.grant("main", "c1", ["a.js#f"]);
    await repo.grant("main", "c2", ["a.js#f"]);
    await repo.grant("main", "c3", ["b.js#g"]);
    expect(await repo.collisions("main", [{ a: "c1", b: "c3", p: 0.31 }, { a: "c2", b: "c3", p: 0.3 }, { a: "c2", b: "c1", p: 0.9 }]))
      .toEqual([["c1", "c2"], ["c1", "c3"]]);
  });

  it("closing a change releases its lease", async () => {
    await env.DB.prepare("INSERT INTO repos (id, name, default_branch, strategy, branch_policy, created_at) VALUES ('lease-close', 'lease-close', 'main', 'trunk', '{}', '')").run();
    await env.DB.prepare("INSERT INTO changes (id, repo_id, target_branch, state, created_at) VALUES ('lc1', 'lease-close', 'main', 'planned', '')").run();
    const change = env.CHANGE_DO.get(env.CHANGE_DO.idFromName("lc1"));
    await change.create({ id: "lc1", repo_id: "lease-close", target_branch: "main", state: "planned", created_at: "2026-10-04T00:00:00Z" }, []);
    const repo = repoDO("lease-close");
    await repo.grant("main", "lc1", ["a.js#f"]);
    await change.transition("closed", {
      kind: "closed", actor: { type: "human", id: "owner" }, action: "change.close", target: "lc1", result: "ok",
    });
    expect(await repo.grant("main", "lc2", ["a.js#f"])).toEqual({ granted: true });
  });
});
