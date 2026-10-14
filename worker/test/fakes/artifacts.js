// In-memory stand-in for the ARTIFACTS binding with the binding's real shape (see the Artifacts and ArtifactsRepo types
// from `wrangler types`). Every operation is recorded in `calls` as {method, args} in cinder's terms.
// remote(name) is a repo's git URL; the runner integration test points it at local bare repos.
// imports maps a source URL to the files an import of it lands with, already committed; creates a repo name to the
// files its create lands with, as a push the fake can't take would have left them.
// A fake sha as a 40-hex id, which is all the ref advertisement can carry: "s1" is advertised as refSha("s1").
export const refSha = (s) => (/^[0-9a-f]{40}$/.test(s) ? s : [...s].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("").padEnd(40, "0"));
// A fetch that serves the upload-pack ref advertisement of a fake repo at its default remote URL and leaves every other
// request to next (setup.js installs it; a test that stubs fetch wraps its stub), so listRefs reads a fake repo's refs. Branches are repo.branches (default: main) at the newest commit; tags is {name: sha}.
// A source a fake imported advertises no refs, with HEAD at heads[url] when set, so import never reads a real host.
const repoByRemote = new Map();
const sourceHeads = new Map();
export const withRefs = (next) => (input, init) => {
  const adv = String(input?.url ?? input).includes("/info/refs?service=git-upload-pack") && advertisement(input?.url ?? input);
  return adv ? Promise.resolve(new Response(adv)) : next(input, init);
};
function advertisement(url) {
  const base = String(url).replace(/\/info\/refs.*/, "");
  const pkt = (l) => (l.length + 5).toString(16).padStart(4, "0") + l + "\n";
  if (sourceHeads.has(base)) {
    const head = sourceHeads.get(base);
    return pkt("# service=git-upload-pack") + "0000" + (head ? pkt(`${"0".repeat(40)} capabilities^{}\0symref=HEAD:refs/heads/${head}`) : "") + "0000";
  }
  const repo = repoByRemote.get(base);
  if (!repo?.commits.length) return null;
  const lines = [
    ...(repo.branches ?? ["main"]).map((b) => `${refSha(repo.commits[0].sha ?? repo.commits[0].hash)} refs/heads/${b}`),
    ...Object.entries(repo.tags ?? {}).map(([t, sha]) => `${refSha(sha)} refs/tags/${t}`),
  ];
  return pkt("# service=git-upload-pack") + "0000" + lines.map(pkt).join("") + "0000";
}

export function fakeArtifacts({ now = () => Date.now(), remote = (name) => `https://artifacts.fake/cinder/${name}.git`, imports = {}, creates = {}, heads = {} } = {}) {
  const calls = [];
  const repos = new Map();
  let seq = 0;
  const record = (method, args) => calls.push({ method, args });
  const mustGet = (name) => {
    const repo = repos.get(name);
    if (!repo) throw new Error(`fake artifacts: no repo ${name}`);
    return repo;
  };
  const add = (name, extra) => {
    if (repos.has(name)) throw new Error(`fake artifacts: repo ${name} exists`);
    const repo = { name, remote: remote(name), files: {}, commits: [], ...extra };
    repos.set(name, repo);
    // Only the default fake host: a repo whose remote is a real git server keeps its own advertisement.
    if (repo.remote.startsWith("https://artifacts.fake/")) repoByRemote.set(repo.remote, repo);
    return repo;
  };
  // The real result is {name, remote, defaultBranch, token}; files, commits and parent are extra handles for tests.
  const result = (r) => ({ name: r.name, remote: r.remote, defaultBranch: "main", token: `fake-token-${++seq}`, files: r.files, commits: r.commits, parent: r.parent });
  const capability = (name) => ({
    async info() { return { name, remote: remote(name) }; },
    async fork(child) {
      record("fork", [name, child]);
      const src = mustGet(name);
      return result(add(child, { parent: name, files: { ...src.files }, commits: [...src.commits] }));
    },
    async createToken(scope = "write", ttl = 86400) {
      record("createToken", [name, scope, ttl]);
      mustGet(name);
      return { id: `tok-${seq}`, plaintext: `fake-token-${++seq}`, scope, expiresAt: new Date(now() + ttl * 1000).toISOString() };
    },
    async readFile({ ref, path }) {
      record("readFile", [name, ref, path]);
      // Tests that set repo.at[ref] see those files at that ref, as for a commit where the file differed.
      const text = (mustGet(name).at?.[ref] ?? mustGet(name).files)[path];
      return text == null ? null : new Blob([text]);
    },
    // Like the binding, trees are read by hash: "tree:<dir prefix>" over repo.files, the root's "tree:" is every commit's
    // treeHash; a commit with repo.at[sha] has "tree@<sha>:" over those files, whose blob hashes follow their content.
    async readTree(hash) {
      record("readTree", [name, hash]);
      const [, sha, prefix] = /^tree(?:@([^:]*))?:(.*)$/.exec(hash);
      const files = sha ? mustGet(name).at[sha] : mustGet(name).files;
      const tree = sha ? `tree@${sha}:` : "tree:";
      const entries = new Map();
      for (const file of Object.keys(files).filter((f) => f.startsWith(prefix))) {
        const [first, ...rest] = file.slice(prefix.length).split("/");
        entries.set(first, { name: first, mode: rest.length ? "40000" : "100644", hash: rest.length ? `${tree}${prefix}${first}/` : `blob:${sha ? files[file] : prefix + first}`, type: rest.length ? "tree" : "blob" });
      }
      return entries.size ? [...entries.values()] : null;
    },
    async log({ ref } = {}) {
      record("log", [name, ref]);
      // The binding resolves bare names and commit ids only: a full ref such as refs/heads/main is unknown.
      if (typeof ref === "string" && ref.startsWith("refs/")) return [];
      // Like git, a bare name is a tag before it is a branch.
      if (mustGet(name).tags?.[ref]) return [{ sha: mustGet(name).tags[ref], hash: mustGet(name).tags[ref], treeHash: "tree:" }];
      const at = mustGet(name).at ?? {};
      const withTree = (list) => list.map((c) => ({ ...c, hash: c.hash ?? c.sha, treeHash: at[c.hash ?? c.sha] ? `tree@${c.hash ?? c.sha}:` : "tree:" }));
      const commits = withTree(mustGet(name).commits);
      // A commit id as ref logs from that commit, as the binding does, on the default history or a repo.refs branch.
      for (const list of [commits, ...Object.values(mustGet(name).refs ?? {}).map(withTree)]) {
        const i = list.findIndex((c) => c.hash === ref);
        if (i >= 0) return list.slice(i);
      }
      // Tests that set repo.refs[ref] get that branch's own commits, newest first.
      if (mustGet(name).refs?.[ref]) return withTree(mustGet(name).refs[ref]);
      // Tests that set repo.branches get no commits for any other ref, as for an unknown branch.
      if (mustGet(name).branches && ref && !mustGet(name).branches.includes(ref)) return [];
      return commits;
    },
  });

  const fake = {
    calls,
    repos,
    // Like Artifacts' async create: a new repo's next `creating` get() calls reject "being created" (Infinity: stuck).
    creating: 0,
    // Like the binding's list(), pages of `page` repos, newest first, with a cursor while more remain.
    page: Infinity,
    async create(name, opts) {
      record("create", [name, opts]);
      const files = creates[name];
      return result(add(name, { creating: fake.creating, ...(files && { files: { ...files }, commits: [{ sha: "created" }] }) }));
    },
    async import({ source, target }) {
      record("import", [target.name, source]);
      sourceHeads.set(source.url, heads[source.url]);
      const files = imports[source.url];
      return result(add(target.name, { source, ...(files && { files: { ...files }, commits: [{ sha: "imported" }] }) }));
    },
    async get(name) {
      record("get", [name]);
      // Like the binding, a missing repo rejects rather than resolving null.
      if (!repos.has(name)) throw Object.assign(new Error(`Repository not found: ${name}.`), { name: "ArtifactsError" });
      if (repos.get(name).creating-- > 0) {
        throw Object.assign(new Error(`Repository "${name}" is currently being created. The repository is not yet available. Retry after 5 seconds.`), { name: "ArtifactsError" });
      }
      return capability(name);
    },
    async list({ cursor = 0 } = {}) {
      const names = [...repos.keys()].reverse();
      const end = cursor + fake.page;
      return { repos: names.slice(cursor, end).map((name) => ({ name })), ...(end < names.length && { cursor: end }) };
    },
    async delete(name) {
      record("delete", [name]);
      return repos.delete(name);
    },
  };
  return fake;
}
