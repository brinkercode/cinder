import { inject } from "vitest";
import { fakeArtifacts } from "./artifacts.js";
import { bareRepo } from "./bare-repo.js";

const relay = inject("runnerRelay");
// Captured before tests stub fetch to answer from the worker.
const net = globalThis.fetch;
export const BAKED_IN = ["developer", "resolver", "reviewer"];

// git in the relay's root, where bare repos are served by git http-backend.
export async function git(args) {
  const res = await net(`${relay.url}/git`, { method: "POST", body: JSON.stringify({ args }) });
  const out = await res.json();
  if (!res.ok) throw new Error(out);
  return out.trim();
}

// The fake Artifacts namespace with every repo pushed to the relay's bare repo <dir>.git (created here), whose
// commits and trees read as the binding reads them for cinder-agents, so the agents bootstrap's commit chain works. Other
// repos (imports as fakeArtifacts') read as the plain fake, but the org wiki cinder-wiki, the bare repo <dir>-wiki.git.
export async function agentsFake(dir, imports) {
  await git(["init", "-q", "--bare", "-b", "main", `${dir}.git`]);
  await git(["init", "-q", "--bare", "-b", "main", `${dir}-wiki.git`]);
  const fake = fakeArtifacts({ remote: () => `${relay.url}/smart/${dir}.git`, imports });
  const get = fake.get.bind(fake);
  const ls = async (sha) => (await git(["--git-dir", `${dir}.git`, "ls-tree", sha])).split("\n").filter(Boolean).map((line) => line.split(/[ \t]/));
  fake.get = async (name) => {
    if (name === "cinder-wiki") return bareRepo(`${dir}-wiki`);
    const repo = await get(name);
    if (!repo || name !== "cinder-agents") return repo;
    return { ...repo, readCommit: async (sha) => ({ treeHash: await git(["--git-dir", `${dir}.git`, "rev-parse", `${sha}^{tree}`]) }),
      readTree: async (sha) => (await ls(sha)).map(([mode, type, hash, name]) => ({ name, mode, type, hash })) };
  };
  // Like the binding, a deleted repo's refs go with it: the bare repo behind it (none for most) is emptied.
  const remove = fake.delete.bind(fake);
  fake.delete = async (name) => {
    const bare = `${{ "cinder-agents": dir, "cinder-wiki": `${dir}-wiki` }[name] ?? `${dir}-${name}`}.git`;
    const refs = await git(["--git-dir", bare, "for-each-ref", "--format=%(refname)"]).catch(() => "");
    for (const ref of refs.split("\n").filter(Boolean)) await git(["--git-dir", bare, "update-ref", "-d", ref]);
    return remove(name);
  };
  return fake;
}
