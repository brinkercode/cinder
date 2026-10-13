// Artifacts' import is public-only, so a private import fetches over smart HTTP and pushes with cinder's writer.
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, inject, it, vi } from "vitest";
import worker from "../src/index.js";
import { fakeArtifacts } from "./fakes/artifacts.js";
import { git } from "./fakes/bare-repo.js";
import { fakeCloudflare } from "./fakes/cloudflare.js";

const TOKEN = "ghp_secret-read-token";
const GIT_ENV = { GIT_AUTHOR_NAME: "a", GIT_AUTHOR_EMAIL: "a@x.test", GIT_COMMITTER_NAME: "a", GIT_COMMITTER_EMAIL: "a@x.test" };
const refsOf = (dir) => git(["--git-dir", `${dir}.git`, "for-each-ref", "--format=%(objectname) %(refname)"]);

let cf;
// Cloudflare API calls (Secrets Store, where a private import's token is kept) go to the fake; the rest go out.
beforeEach(() => {
  cf = fakeCloudflare();
  const out = globalThis.fetch;
  vi.stubGlobal("fetch", (input, init) => (String(input.url ?? input).startsWith("https://api.cloudflare.com/") ? cf.fetch(input, init) : out(input, init)));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// A private source with HEAD on develop, two branches, a lightweight and an annotated tag. Its smart-HTTP remote answers
// 401 unless Basic auth carries TOKEN; `public` URLs (github.com ones among them) are served from it.
async function privateRemote(publicUrl) {
  const src = `private-src-${crypto.randomUUID()}`;
  const g = (args) => git(["--git-dir", `${src}.git`, ...args], { env: GIT_ENV });
  await git(["init", "-q", "--bare", "-b", "develop", `${src}.git`]);
  const blob = await git(["--git-dir", `${src}.git`, "hash-object", "-w", "--stdin"], { input: new TextEncoder().encode("hi\n") });
  const tree = await git(["--git-dir", `${src}.git`, "mktree"], { input: new TextEncoder().encode(`100644 blob ${blob}\ta.txt\n`) });
  const first = await g(["commit-tree", tree, "-m", "first"]);
  const second = await g(["commit-tree", tree, "-p", first, "-m", "second"]);
  await g(["update-ref", "refs/heads/main", first]);
  await g(["update-ref", "refs/heads/develop", second]);
  await g(["tag", "v0", first]);
  await g(["tag", "-a", "v1", "-m", "v1", second]);
  const remote = `${inject("runnerRelay").url}/smart/${src}.git`;
  const realFetch = globalThis.fetch;
  const seen = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const req = new Request(input, init);
    if (!req.url.startsWith(publicUrl) && !req.url.startsWith(remote)) return realFetch(input, init);
    seen.push(req.headers.get("authorization"));
    if (req.headers.get("authorization") !== `Basic ${btoa(`x-access-token:${TOKEN}`)}`) return Promise.resolve(new Response("auth required", { status: 401 }));
    return realFetch(new Request(req.url.replace(publicUrl, remote), req));
  });
  return { src, remote, seen };
}

// Artifacts whose create() lands each repo as a fresh bare repo in the relay, its log read from git.
async function artifactsOverGit() {
  const dest = `private-dest-${crypto.randomUUID()}`;
  await git(["init", "-q", "--bare", `${dest}.git`]);
  const fake = fakeArtifacts({ remote: () => `${inject("runnerRelay").url}/smart/${dest}.git` });
  const get = fake.get.bind(fake);
  fake.get = async (name) => ({ ...(await get(name)), log: async ({ ref }) => (await git(["--git-dir", `${dest}.git`, "log", "--format=%H", ref]).catch(() => ""))
    .split("\n").filter(Boolean).map((hash) => ({ hash })) });
  const call = (path, body, extra) => worker.fetch(new Request(`http://cinder.test${path}`, body
    ? { method: "POST", headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` }, body: JSON.stringify(body) }
    : { headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` } }), { ...env, ARTIFACTS: fake, ...cf.env, ...extra });
  return { dest, fake, call };
}

it("a private import from a smart-HTTP remote that requires auth lands every branch and tag with the same SHAs", async () => {
  const { src, seen } = await privateRemote("https://github.com/acme/secret.git");
  const { dest, fake, call } = await artifactsOverGit();
  const res = await call("/api/repos", { name: "priv-gh", import: { url: "https://github.com/acme/secret.git", token: TOKEN } });
  expect(res.status).toBe(201);
  expect((await res.json()).default_branch).toBe("develop");
  expect(fake.calls.some((c) => c.method === "import")).toBe(false);
  expect(seen.length).toBeGreaterThan(0);
  expect(await refsOf(dest)).toBe(await refsOf(src));
  expect((await refsOf(dest)).split("\n")).toHaveLength(4);
});

it("e2e: the Repositories private-import path imports a private repo end to end", async () => {
  const remote = "https://no-such.invalid/acme/panel.git";
  const { src } = await privateRemote(remote);
  const { dest, call } = await artifactsOverGit();
  const logged = [];
  for (const m of ["log", "info", "warn", "error", "debug"]) vi.spyOn(console, m).mockImplementation((...a) => logged.push(a.join(" ")));

  const denied = await call("/api/repos", { name: "priv-panel", import: { url: remote, token: "wrong" } });
  expect(denied.status).toBe(502);
  expect((await denied.json()).error.code).toBe("import_failed");
  // A failed private import leaves no repo behind, so the same name imports on retry.
  const res = await call("/api/repos", { name: "priv-panel", import: { url: remote, branch: "main", token: TOKEN } });
  expect(res.status).toBe(201);
  const body = await res.text();
  expect(JSON.parse(body).default_branch).toBe("main");
  expect(await refsOf(dest)).toBe(await refsOf(src));
  const listed = await (await call("/api/repos")).text();
  expect(JSON.parse(listed).find((r) => r.name === "priv-panel").status).toBe("ready");
  const { results } = await env.DB.prepare("SELECT * FROM repos").all();
  for (const text of [body, listed, JSON.stringify(results), ...logged]) expect(text).not.toContain(TOKEN);
});

it("importing with a per-import token stores it and a re-import reuses it without GITHUB_IMPORT_TOKEN", async () => {
  const { src, seen } = await privateRemote("https://github.com/acme/kept.git");
  const { dest, fake, call } = await artifactsOverGit();
  const made = await call("/api/repos", { name: "priv-kept", import: { url: "https://github.com/acme/kept.git", token: TOKEN } });
  expect(made.status).toBe(201);
  const row = await env.DB.prepare("SELECT * FROM keystore_secrets WHERE kind = 'import_credential' AND scope = 'repo' AND repo = 'priv-kept'").first();
  expect([...cf.secrets.values()].find((s) => s.name === row.store_secret_name).value).toBe(TOKEN);
  expect(JSON.stringify(row)).not.toContain(TOKEN);

  // Deleting the Artifacts repo empties its bare repo too, so the re-import pushes every ref again.
  const del = fake.delete.bind(fake);
  fake.delete = async (name) => {
    for (const line of (await refsOf(dest)).split("\n").filter(Boolean)) await git(["--git-dir", `${dest}.git`, "update-ref", "-d", line.split(" ")[1]]);
    return del(name);
  };
  const before = seen.length;
  const res = await call("/api/repos/priv-kept/import", { url: "https://github.com/acme/kept.git" });
  expect(res.status).toBe(200);
  expect(seen.length).toBeGreaterThan(before);
  expect(fake.calls.some((c) => c.method === "import")).toBe(false);
  expect(await refsOf(dest)).toBe(await refsOf(src));
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM keystore_secrets WHERE repo = 'priv-kept'").first("n")).toBe(1);
});
