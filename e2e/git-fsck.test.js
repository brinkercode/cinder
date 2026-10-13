// Real git checks the objects and packfile cinder writes (worker/src/git/index.js). Runs under node --test in make check-ts.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { commitObject, gitObject, packfile, tagObject, treeObject } from "../worker/src/git/index.js";

const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd, args, input) => execFileSync("git", args, { cwd, env, input, encoding: input ? undefined : "utf8" }).toString().trim();
const who = { name: "Cinder", email: "cinder@example.com", time: 1700000000 };

// A temporary bare repo holding objects, indexed from cinder's packfile, with refs {name: sha}.
async function bareRepo(objects, refs) {
  const dir = mkdtempSync(join(tmpdir(), "cinder-fsck-"));
  git(dir, ["init", "--bare", "-q"]);
  git(dir, ["index-pack", "--stdin", "--strict"], await packfile(objects));
  for (const [ref, sha] of Object.entries(refs)) git(dir, ["update-ref", ref, sha]);
  return dir;
}

// A nested tree with a directory a next to a file a.txt, as cinder builds it: [blobs, subtree, root].
async function nested() {
  const [b, aTxt] = await Promise.all([gitObject("blob", "inner\n"), gitObject("blob", "outer\n")]);
  const a = await treeObject([{ name: "b.txt", mode: "100644", sha: b.sha }]);
  const root = await treeObject([{ name: "a", mode: "40000", sha: a.sha }, { name: "a.txt", mode: "100644", sha: aTxt.sha }]);
  return [b, aTxt, a, root];
}

// Every kind cinder writes: nested trees, an empty tree, a binary blob, a merge commit with two parents, an annotated tag.
async function history() {
  const [b, aTxt, a, root] = await nested();
  const empty = await treeObject([]);
  const bin = await gitObject("blob", Uint8Array.from({ length: 256 }, (_, i) => i));
  const binTree = await treeObject([{ name: "bin.dat", mode: "100644", sha: bin.sha }]);
  const base = await commitObject({ tree: empty.sha, author: who, message: "empty" });
  const left = await commitObject({ tree: root.sha, parents: [base.sha], author: who, message: "nested" });
  const right = await commitObject({ tree: binTree.sha, parents: [base.sha], author: who, message: "binary" });
  const merge = await commitObject({ tree: root.sha, parents: [left.sha, right.sha], author: who, message: "merge" });
  const tag = await tagObject({ object: merge.sha, tag: "v1", tagger: who, message: "v1" });
  const objects = [b, aTxt, a, root, empty, bin, binTree, base, left, right, merge, tag];
  return { objects, left, right, merge, tag };
}

test("objects cinder writes pass git fsck --strict", async () => {
  const { objects, merge, tag } = await history();
  const dir = await bareRepo(objects, { "refs/heads/main": merge.sha, "refs/tags/v1": tag.sha });
  git(dir, ["fsck", "--strict", "--no-dangling"]);
  assert.equal(git(dir, ["count-objects", "-v"]).match(/in-pack: (\d+)/)[1], String(objects.length));
});

test("a tree with a directory a and a file a.txt matches git's own tree hash", async () => {
  const [, , , root] = await nested();
  const dir = mkdtempSync(join(tmpdir(), "cinder-tree-"));
  git(dir, ["init", "-q"]);
  mkdirSync(join(dir, "a"));
  writeFileSync(join(dir, "a", "b.txt"), "inner\n");
  writeFileSync(join(dir, "a.txt"), "outer\n");
  git(dir, ["add", "."]);
  assert.equal(root.sha, git(dir, ["write-tree"]));
});

test("a merge commit and an annotated tag index and verify", async () => {
  const { objects, left, right, merge, tag } = await history();
  const dir = await bareRepo(objects, { "refs/tags/v1": tag.sha });
  git(dir, ["fsck", "--strict", "--no-dangling", tag.sha]);
  assert.equal(git(dir, ["cat-file", "-t", "v1"]), "tag");
  assert.equal(git(dir, ["rev-parse", "v1^{commit}"]), merge.sha);
  assert.equal(git(dir, ["rev-parse", `${merge.sha}^1`, `${merge.sha}^2`]), `${left.sha}\n${right.sha}`);
});
