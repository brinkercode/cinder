import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import worker from "../src/index.js";
import { queueScan } from "../src/scans.js";
import { validateDependency, validateSbom } from "../src/api/contract.js";
import { fakeArtifacts } from "./fakes/artifacts.js";

// Fakes OSV: osv[package] lists that package's vulns as full OSV records.
function fakeOsv(osv) {
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (String(url) === "https://api.osv.dev/v1/querybatch") {
      return Response.json({ results: JSON.parse(init.body).queries.map((q) => ({ vulns: (osv[q.package.name] ?? []).map(({ id }) => ({ id })) })) });
    }
    const id = String(url).split("/").at(-1);
    return Response.json(Object.values(osv).flat().find((v) => v.id === id));
  });
  onTestFinished(() => fetch.mockRestore());
}

const range = (name, ...events) => ({ package: { name, ecosystem: "npm" }, ranges: [{ type: "SEMVER", events }] });

// Runs a full scan of main reporting deps, then GETs the dependency inventory with query.
async function scanThenList(name, deps, query) {
  const fake = fakeArtifacts();
  const call = (path, { method = "POST", body, token = env.OWNER_TOKEN } = {}) => worker.fetch(
    new Request(`http://cinder.test${path}`, { method, headers: { Authorization: `Bearer ${token}` }, body: body && JSON.stringify(body) }),
    { ...env, ARTIFACTS: fake },
  );
  await call("/api/repos", { body: { name } });
  fake.repos.get(name).commits.unshift({ sha: "s1" });
  await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName(name)), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
  const repo = await env.DB.prepare("SELECT id FROM repos WHERE name = ?").bind(name).first();
  const token = (await (await call("/api/runners", { body: { name: `${name}-lab`, kinds: ["scan"] } })).json()).token;
  await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE kind = 'scan' AND status = 'queued'").run();
  await queueScan(env, repo.id, "main", "merge");
  const { job } = await (await call("/api/work/claim", { body: { kinds: ["scan"] }, token })).json();
  expect((await call(`/api/work/jobs/${job.id}/report`, { body: { status: "done", deps }, token })).status).toBe(200);
  return { repo, call, list: async () => (await call(`/api/repos/${name}/dependencies${query}`, { method: "GET" })).json() };
}

const dep = (name, version, extra = {}) => ({ ecosystem: "npm", name, version, license: "MIT", class: "permissive", ...extra });

describe("dependency inventory", () => {
  it("the filter vulnerable returns only deps with open vulnerabilities", async () => {
    fakeOsv({
      "bad-open": [{ id: "GHSA-open", affected: [range("bad-open", { introduced: "0" }, { fixed: "2.0.0" })] }],
      "bad-dismissed": [{ id: "GHSA-dismissed", affected: [range("bad-dismissed", { introduced: "0" }, { fixed: "3.0.0" })] }],
    });
    const { repo, list } = await scanThenList("deps-vulnerable",
      [dep("bad-open", "1.0.0", { direct: true }), dep("bad-dismissed", "1.0.0"), dep("clean", "1.0.0", { latest: "2.0.0" })], "?filter=vulnerable");
    await env.DB.prepare("UPDATE findings SET state = 'dismissed' WHERE repo_id = ? AND rule = 'GHSA-dismissed'").bind(repo.id).run();
    const deps = await list();
    expect(deps.map((d) => [d.name, d.status, d.direct])).toEqual([["bad-open", "vulnerable", true]]);
    expect(deps.every((d) => validateDependency(d).ok)).toBe(true);
  });

  it("fixed_in and also_fixes are computed from the OSV ranges", async () => {
    fakeOsv({
      lib: [
        // Two ranges: the fix is the end of the one 1.2.0 is in, not the later range's, and not one below 1.2.0.
        { id: "GHSA-a", affected: [range("lib", { introduced: "0" }, { fixed: "1.0.0" }, { introduced: "1.1.0" }, { fixed: "1.2.5" }, { introduced: "2.0.0" }, { fixed: "2.0.1" })] },
        { id: "GHSA-b", affected: [range("lib", { introduced: "0" }, { fixed: "1.10.0" })] },
        { id: "GHSA-c", affected: [range("lib", { introduced: "0" }, { fixed: "1.3.0" })] },
        { id: "GHSA-none", affected: [range("lib", { introduced: "0" })] },
      ],
    });
    const { list } = await scanThenList("deps-fixed-in", [dep("lib", "1.2.0")], "");
    const [lib] = await list();
    expect(lib.vulns.map((v) => [v.id, v.fixed_in, v.also_fixes])).toEqual([
      ["GHSA-a", "1.2.5", 0], ["GHSA-b", "1.10.0", 2], ["GHSA-c", "1.3.0", 1], ["GHSA-none", null, 0],
    ]);
    expect(validateDependency(lib).ok).toBe(true);
  });

  it("PATCH auto_fix turns auto-fix on and off for one package", async () => {
    fakeOsv({});
    const { call, list } = await scanThenList("deps-auto-fix", [dep("@scope/a", "1.0.0"), dep("b", "1.0.0")], "");
    const patch = (repo, body) => call(`/api/repos/${repo}/dependencies`, { method: "PATCH", body });
    expect((await patch("deps-auto-fix", { ecosystem: "npm", name: "@scope/a", auto_fix: true })).status).toBe(204);
    expect((await list()).map((d) => [d.name, d.auto_fix])).toEqual([["@scope/a", true], ["b", false]]);
    await patch("deps-auto-fix", { ecosystem: "npm", name: "@scope/a", auto_fix: false });
    expect((await list()).map((d) => d.auto_fix)).toEqual([false, false]);
    expect((await patch("deps-auto-fix", { ecosystem: "npm", name: "b", auto_fix: "yes" })).status).toBe(400);
    expect((await patch("missing", { ecosystem: "npm", name: "b", auto_fix: true })).status).toBe(404);
  });
  it("auto-fix on opens one change for a vulnerable package after a scan", async () => {
    fakeOsv({ minimist: [{ id: "GHSA-minimist", affected: [range("minimist", { introduced: "0" }, { fixed: "1.2.6" })] }] });
    const deps = [dep("minimist", "1.2.5")];
    // The first scan finds the advisory before auto-fix is on.
    const { repo, call } = await scanThenList("deps-auto-fix-scan", deps, "");
    expect((await call("/api/repos/deps-auto-fix-scan/dependencies", { method: "PATCH", body: { ecosystem: "npm", name: "minimist", auto_fix: true } })).status).toBe(204);
    const token = (await (await call("/api/runners", { body: { name: "deps-auto-fix-scan-2", kinds: ["scan"] } })).json()).token;
    for (let i = 0; i < 2; i++) {
      await queueScan(env, repo.id, "main", "daily");
      const { job } = await (await call("/api/work/claim", { body: { kinds: ["scan"] }, token })).json();
      expect((await call(`/api/work/jobs/${job.id}/report`, { body: { status: "done", deps }, token })).status).toBe(200);
    }
    const fixes = await env.DB.prepare("SELECT x.change_id FROM finding_fixes x JOIN findings f ON f.id = x.finding_id " +
      "JOIN auto_fix_changes a ON a.change_id = x.change_id WHERE f.repo_id = ?").bind(repo.id).all();
    expect(fixes.results).toHaveLength(1);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM changes WHERE repo_id = ?").bind(repo.id).first("n")).toBe(1);
  });
});

describe("SBOM export", () => {
  const sbom = async (name, deps) => {
    fakeOsv({});
    const { call } = await scanThenList(name, deps, "");
    return (await call(`/api/repos/${name}/sbom?target=main`, { method: "GET" })).json();
  };

  it("a scoped npm package gets a percent-encoded PURL", async () => {
    const bom = await sbom("sbom-purl", [dep("@types/node", "20.1.0"), dep("github.com/gorilla/mux", "v1.8.0", { ecosystem: "go" }),
      dep("serde", "1.0.0", { ecosystem: "cargo" }), dep("Django_Rest", "3.0", { ecosystem: "pypi" })]);
    expect(bom.components.map((c) => c.purl).sort()).toEqual(["pkg:cargo/serde@1.0.0", "pkg:golang/github.com/gorilla/mux@v1.8.0",
      "pkg:npm/%40types/node@20.1.0", "pkg:pypi/django-rest@3.0"]);
  });

  it("the document validates against the required CycloneDX fields", async () => {
    const bom = await sbom("sbom-valid", [dep("left-pad", "1.3.0")]);
    expect(validateSbom(bom).errors).toEqual([]);
    expect(bom).toMatchObject({ bomFormat: "CycloneDX", specVersion: "1.5", version: 1,
      components: [{ type: "library", name: "left-pad", version: "1.3.0", purl: "pkg:npm/left-pad@1.3.0", licenses: [{ license: { name: "MIT" } }] }] });
  });
});
