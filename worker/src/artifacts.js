// The only module that talks to the Artifacts binding. It translates the binding's real shape (a namespace whose get()
// returns a repo capability; Blob file reads; {plaintext} tokens; commits keyed by `hash`) into the small interface the
// rest of cinder uses. Tests pass a fake with the same real shape from test/fakes/artifacts.js.
export const MAX_TOKEN_TTL_SECONDS = 7200;
const SCOPES = ["read", "write"];
export const READ_MS = 5000;
export const PUSH_MS = 30000;

// Runs call(signal) with a timeout of ms and one retry when it timed out or never got a response (fetch's TypeError).
// An answer, an error one included, is final. The second failure is thrown.
export async function twice(call, ms) {
  for (let tries = 1; ; tries++) {
    const ctl = new AbortController();
    // Registered before call so a stalled fetch's AbortError never beats the timeout error.
    const timeout = new Promise((_, reject) => ctl.signal.addEventListener("abort", () => reject(new Error(`artifacts: call timed out after ${ms} ms`))));
    const timer = setTimeout(() => ctl.abort(), ms);
    try {
      return await Promise.race([call(ctl.signal), timeout]);
    } catch (e) {
      if (tries > 1 || !(ctl.signal.aborted || e instanceof TypeError)) throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}
const read = (call) => twice(call, READ_MS);

export function createArtifacts(binding) {
  if (!binding) throw new Error("artifacts: binding is required");
  // The binding rejects get() of a missing repo; every caller here treats a missing repo as null.
  const repo = (name) => read(() => binding.get(name)).catch((e) => {
    if (/^Repository not found/.test(e?.message)) return null;
    throw e;
  });
  return {
    create: (name, opts) => binding.create(name, opts),
    import: (name, source) => binding.import({ source: { url: source.url, branch: source.branch }, target: { name } }),
    get: (name) => repo(name),
    fork: async (parent, name) => (await repo(parent)).fork(name),
    createToken(name, scope, ttlSeconds) {
      if (!name) throw new Error("artifacts: token repo is required");
      if (!SCOPES.includes(scope)) throw new Error(`artifacts: token scope must be one of ${SCOPES.join(", ")}`);
      if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > MAX_TOKEN_TTL_SECONDS) {
        throw new Error(`artifacts: token ttl must be 1..${MAX_TOKEN_TTL_SECONDS} seconds`);
      }
      // Validation above throws synchronously; the binding call is async. The binding's minimum ttl is 60 s.
      return repo(name).then((r) => read(() => r.createToken(scope, Math.max(60, ttlSeconds))))
        .then((t) => ({ token: t.plaintext, scope: t.scope, expiresAt: t.expiresAt }));
    },
    delete: (name) => binding.delete(name),
    async list() {
      const names = [];
      for (let cursor; ;) {
        const page = await read(() => binding.list(cursor ? { cursor } : undefined));
        names.push(...page.repos.map((r) => r.name));
        if (!(cursor = page.cursor)) return names;
      }
    },
    async readFile(name, ref, path) {
      return (await this.readBlob(name, ref, path))?.text() ?? null;
    },
    // The file's bytes as a Blob, for files that aren't text (images); null when missing.
    async readBlob(name, ref, path) {
      const r = await repo(name);
      return (r && await read(() => r.readFile({ ref, path }))) || null;
    },
    // [{name, path, type: "tree" | "blob"}] directly under path ("" is the root); null when path is not a directory.
    // A missing repo (a finished change's deleted fork) reads as empty: null here and in readFile, [] from log.
    // The binding reads trees by hash only, so this walks from the ref's root tree down path, one read per directory.
    async readTree(name, ref, path) {
      const r = await repo(name);
      let hash = r && (await read(() => r.log({ ref, limit: 1 })))[0]?.treeHash;
      for (const dir of path ? path.split("/") : []) hash = hash && (await read(() => r.readTree(hash)))?.find((e) => e.name === dir && e.type === "tree")?.hash;
      const entries = hash && await read(() => r.readTree(hash));
      // Executables and symlinks are files to cinder; only "tree" is a directory.
      return entries?.map((e) => ({ name: e.name, path: path ? `${path}/${e.name}` : e.name, type: e.type === "tree" ? "tree" : "blob" })) ?? null;
    },
    // Every entry of the commit's tree, as readTree's, read by tree hash with each level's subtrees in parallel; null when ref has no commit.
    // lazy: one read per directory in one request; ask a runner for `git ls-tree -r` once trees outgrow the subrequest limit.
    async listTree(name, ref) {
      const r = await repo(name);
      const root = r && (await read(() => r.log({ ref, limit: 1 })))[0]?.treeHash;
      const walk = async (hash, dir) => (await Promise.all(((await read(() => r.readTree(hash))) ?? []).map((e) => {
        const entry = { name: e.name, path: dir ? `${dir}/${e.name}` : e.name, type: e.type === "tree" ? "tree" : "blob" };
        return entry.type === "tree" ? walk(e.hash, entry.path).then((under) => [entry, ...under]) : [entry];
      }))).flat();
      return root ? walk(root, "") : null;
    },
    // The root tree hash of commit ref, or null; trees by hash are read with readTreeHash.
    async rootTree(name, ref) {
      const r = await repo(name);
      return (r && (await read(() => r.log({ ref, limit: 1 })))[0]?.treeHash) ?? null;
    },
    // [{name, type, hash}] of the tree at hash as the binding returns it, or null.
    async readTreeHash(name, hash) {
      const r = await repo(name);
      return (r && await read(() => r.readTree(hash))) ?? null;
    },
    async log(name, ref) {
      const r = await repo(name);
      return ((r && await read(() => r.log({ ref }))) ?? []).map((c) => ({ ...c, sha: c.hash }));
    },
  };
}
