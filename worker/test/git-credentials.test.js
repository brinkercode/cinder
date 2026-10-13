import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import { commit } from "../src/git/index.js";
import { fakeArtifacts } from "./fakes/artifacts.js";
import { bareRepo, git } from "./fakes/bare-repo.js";
import { ACCESS, as, serveCerts } from "./helpers/access.js";

afterEach(() => vi.restoreAllMocks());

async function repo(name) {
  const e = { ...ACCESS, ARTIFACTS: fakeArtifacts() };
  const res = await worker.fetch(new Request("http://cinder.test/api/repos",
    { method: "POST", headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` }, body: JSON.stringify({ name }) }), e);
  expect(res.status).toBe(201);
  serveCerts();
  return e;
}

const credentials = (e, name, headers) => worker.fetch(new Request(`http://cinder.test/api/repos/${name}/git-credentials`, { method: "POST", headers }), e);

it("a request with an Access service token gets a repo-scoped token", async () => {
  const e = { ...(await repo("creds-service")), OWNERS: "deployer@service-token" };
  await env.DB.prepare("INSERT INTO service_tokens (client_id, name) VALUES ('svc.access', 'deployer')").run();
  // Access forwards the service token's JWT and also its CF_Authorization cookie.
  const { "Cf-Access-Jwt-Assertion": jwt } = await as(undefined, { common_name: "svc.access" });
  const res = await credentials(e, "creds-service", { "Cf-Access-Jwt-Assertion": jwt, "CF-Access-Client-Id": "svc.access", Cookie: `CF_Authorization=${jwt}` });
  expect(res.status).toBe(200);
  expect((await res.json()).token).toBeTruthy();
  expect(e.ARTIFACTS.calls.filter((c) => c.method === "createToken").at(-1).args.slice(0, 2)).toEqual(["creds-service", "write"]);
});

it("a browser request with only the Access cookie is refused with cli_only", async () => {
  const e = await repo("creds-browser");
  const { "Cf-Access-Jwt-Assertion": jwt } = await as("boss@example.com");
  const res = await credentials(e, "creds-browser", { Cookie: `theme=dark; CF_Authorization=${jwt}` });
  expect(res.status).toBe(403);
  expect((await res.json()).error.code).toBe("cli_only");
  expect(e.ARTIFACTS.calls.filter((c) => c.method === "createToken")).toHaveLength(0);
});

it("an archived repo gets no write token", async () => {
  const name = "creds-archived";
  const e = await repo(name);
  const owner = { Authorization: `Bearer ${env.OWNER_TOKEN}` };
  // A token issued before the archive lives out its TTL.
  expect((await credentials(e, name, owner)).status).toBe(200);
  expect((await worker.fetch(new Request(`http://cinder.test/api/repos/${name}/archive`, { method: "POST", headers: owner }), e)).status).toBe(204);
  const res = await credentials(e, name, owner);
  expect(res.status).toBe(409);
  expect((await res.json()).error.code).toBe("archived");
  expect(e.ARTIFACTS.calls.filter((c) => c.method === "createToken")).toHaveLength(1);
  // Its push for review lands in git, then is put back and opens no change.
  await git(["init", "-q", "--bare", "-b", "main", `${name}.git`]);
  const { sha } = await commit(bareRepo(name), { branch: "main", base: null, message: "one", author: { name: "Ann", email: "ann@x.test" }, changes: [{ path: "a", content: "1\n" }] });
  await git(["--git-dir", `${name}.git`, "update-ref", "refs/for/main", sha]);
  const payload = { ref: "refs/for/main", before: "0".repeat(40), after: sha, commits: [{ id: sha, message: "one" }] };
  await worker.queue({ messages: [{ body: { type: "cf.artifacts.repo.pushed", source: { repoName: name }, payload } }] }, { ...env, ARTIFACTS: { get: async (n) => bareRepo(n) } });
  expect(await git(["--git-dir", `${name}.git`, "for-each-ref", "refs/for/"])).toBe("");
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM changes c JOIN repos r ON r.id = c.repo_id WHERE r.name = ?").bind(name).first("n")).toBe(0);
});
