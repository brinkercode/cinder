import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker, { RepoDO } from "../src/index.js";
import { fakeArtifacts } from "./fakes/artifacts.js";

const OWNER = { Authorization: `Bearer ${env.OWNER_TOKEN}` };

describe("RepoDO restart", () => {
  it("a restarted RepoDO serves ref heads and symbols from storage without an Artifacts call", async () => {
    await worker.fetch(new Request("http://cinder.test/api/repos", { method: "POST", headers: OWNER, body: JSON.stringify({ name: "do-restart" }) }),
      { ...env, ARTIFACTS: fakeArtifacts() });
    const repo = await env.DB.prepare("SELECT id, name FROM repos WHERE name = ?").bind("do-restart").first();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO symbol_indexes (repo_id, sha) VALUES (?, 'h1')").bind(repo.id),
      env.DB.prepare("INSERT INTO symbols (repo_id, sha, path, name, kind, start_line, end_line) VALUES (?, 'h1', 'a.go', 'A', 'func', 4, 6)").bind(repo.id),
    ]);
    const fake = fakeArtifacts();
    await fake.create("do-restart");
    fake.repos.get("do-restart").commits.unshift({ sha: "h1" });
    const stub = env.REPO_DO.get(env.REPO_DO.idFromName("do-restart"));
    const want = { sha: "h1", symbols: [{ path: "a.go", name: "A", kind: "func", start: 4, end: 6, exported: false }] };
    await runInDurableObject(stub, async (instance) => {
      instance.env = { ...instance.env, ARTIFACTS: fake };
      expect(await instance.symbols(repo, "main")).toEqual(want);
    });

    // A new instance over the same storage, as after a deploy: its Artifacts binding records every call.
    const cold = fakeArtifacts();
    await runInDurableObject(stub, async (_, state) => {
      const restarted = new RepoDO(state, { ...env, ARTIFACTS: cold });
      expect((await restarted.heads()).refs.get("main")).toBe("h1");
      expect(await restarted.symbols(repo, "main")).toEqual(want);
    });
    expect(cold.calls).toEqual([]);
  });
});
