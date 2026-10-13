// A real git repo for tests whose code pushes with commit() from src/git: bare repos in the runner relay (test/helpers/runners.js).
import { inject } from "vitest";

// Runs git in the relay's repos dir; input is stdin bytes, env extra variables. Returns trimmed stdout.
export const git = async (args, { input, env: vars } = {}) => {
  const res = await fetch(`${inject("runnerRelay").url}/git`, { method: "POST", body: JSON.stringify({ args, env: vars, input: input && btoa(String.fromCharCode(...input)) }) });
  const out = await res.json();
  if (!res.ok) throw new Error(out);
  return out.trim();
};

// An Artifacts repo capability over a bare repo in the relay, served by git http-backend.
export const bareRepo = (name) => ({
  info: async () => ({ name, remote: `${inject("runnerRelay").url}/smart/${name}.git` }),
  createToken: async () => ({ plaintext: "art_v2_secret?expires=1" }),
  // The branch's (or commit sha's) first-parent commits newest first, as the binding's log reads them; [] for an unknown or empty branch.
  log: async ({ ref, limit = 50 }) => {
    if (!/^[0-9a-f]{40}$/.test(ref) && !(await git(["--git-dir", `${name}.git`, "for-each-ref", `refs/heads/${ref}`]))) return [];
    const out = await git(["--git-dir", `${name}.git`, "log", "--first-parent", `-${limit}`, "--format=%H%x00%T%x00%an%x00%ae%x00%at%x00%B%x1e", ref]);
    return out.split("\x1e").filter((c) => c.trim()).map((c) => {
      const [hash, treeHash, author, email, at, message] = c.trim().split("\0");
      return { hash, treeHash, author: { name: author, email }, authoredAt: Number(at), message: message.trim() };
    });
  },
  readFile: ({ ref, path }) => git(["--git-dir", `${name}.git`, "show", `${ref}:${path}`]).then((text) => new Blob([text]), () => null),
  readCommit: async (sha) => ({ treeHash: await git(["--git-dir", `${name}.git`, "rev-parse", `${sha}^{tree}`]) }),
  readTree: async (sha) => (await git(["--git-dir", `${name}.git`, "ls-tree", sha])).split("\n").filter(Boolean).map((line) => {
    const [meta, entry] = line.split("\t");
    const [mode, type, hash] = meta.split(" ");
    return { name: entry, mode, type, hash };
  }),
});
