// Cinder's own minimal git writer: the Artifacts binding can read objects but not write them, so the Worker hashes
// objects itself, packs them (version 2, no deltas) and pushes over smart HTTP with a 60 s repo-scoped write token.
import { PUSH_MS, READ_MS, twice } from "../artifacts.js";
import { hex } from "../hex.js";

const enc = new TextEncoder();
const ZERO = "0".repeat(40);
const TYPES = { commit: 1, tree: 2, blob: 3, tag: 4 };

const bytes = (x) => (typeof x === "string" ? enc.encode(x) : x);
const unhex = (s) => Uint8Array.from(s.match(/../g), (h) => parseInt(h, 16));
function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
}
const sha1 = async (data) => hex(await crypto.subtle.digest("SHA-1", data));

// {type, body, sha} for a git object; sha is git hash-object's.
export async function gitObject(type, body) {
  body = bytes(body);
  return { type, body, sha: await sha1(concat([enc.encode(`${type} ${body.length}\0`), body])) };
}

// entries [{name, mode, sha}]; git orders a tree's entries by name with a "/" after directory names.
export function treeObject(entries) {
  const key = (e) => (e.mode === "40000" ? `${e.name}/` : e.name);
  const sorted = [...entries].sort((a, b) => (key(a) < key(b) ? -1 : 1));
  return gitObject("tree", concat(sorted.flatMap((e) => [enc.encode(`${e.mode} ${e.name}\0`), unhex(e.sha)])));
}

// who = {name, email, time?}; time is unix seconds, now when missing.
const ident = (who) => `${who.name} <${who.email}> ${who.time ?? Math.floor(Date.now() / 1000)} +0000`;
const withNewline = (m) => (m.endsWith("\n") ? m : `${m}\n`);

export function commitObject({ tree, parents = [], author, committer = author, message }) {
  const head = [`tree ${tree}`, ...parents.map((p) => `parent ${p}`), `author ${ident(author)}`, `committer ${ident(committer)}`];
  return gitObject("commit", `${head.join("\n")}\n\n${withNewline(message)}`);
}

export function tagObject({ object, type = "commit", tag, tagger, message }) {
  return gitObject("tag", `object ${object}\ntype ${type}\ntag ${tag}\ntagger ${ident(tagger)}\n\n${withNewline(message)}`);
}

// A version-2 packfile of whole (undeltified) zlib-deflated objects, with its trailing SHA-1.
export async function packfile(objects) {
  const header = new Uint8Array(12);
  header.set(enc.encode("PACK"));
  new DataView(header.buffer).setUint32(4, 2);
  new DataView(header.buffer).setUint32(8, objects.length);
  const parts = [header];
  for (const { type, body } of objects) {
    let size = body.length;
    const head = [(TYPES[type] << 4) | (size & 15)];
    for (size >>= 4; size; size >>= 7) {
      head[head.length - 1] |= 0x80;
      head.push(size & 0x7f);
    }
    const zipped = new Uint8Array(await new Response(new Blob([body]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer());
    parts.push(new Uint8Array(head), zipped);
  }
  const pack = concat(parts);
  return concat([pack, unhex(await sha1(pack))]);
}

// Applies changes [{path: [segments], content?, delete?, mode?}] to the tree at sha (null: none), pushing every new
// object onto out. Untouched subtrees keep their hash, so only changed directories are read. Returns null when empty.
async function buildTree(repo, sha, changes, out) {
  const entries = new Map();
  for (const e of (sha && (await repo.readTree(sha))) || []) entries.set(e.name, { name: e.name, mode: e.mode.replace(/^0+/, ""), sha: e.hash });
  const nested = new Map();
  for (const c of changes) {
    const [name, ...rest] = c.path;
    if (rest.length) nested.set(name, [...(nested.get(name) ?? []), { ...c, path: rest }]);
    else if (c.delete) entries.delete(name);
    else {
      const blob = await gitObject("blob", c.content);
      out.push(blob);
      entries.set(name, { name, mode: c.mode ?? entries.get(name)?.mode ?? "100644", sha: blob.sha });
    }
  }
  await Promise.all([...nested].map(async ([name, sub]) => {
    const old = entries.get(name);
    const tree = await buildTree(repo, old?.mode === "40000" ? old.sha : null, sub, out);
    if (tree) entries.set(name, { name, mode: "40000", sha: tree });
    else entries.delete(name);
  }));
  if (!entries.size) return null;
  const tree = await treeObject([...entries.values()]);
  out.push(tree);
  return tree.sha;
}

const pkt = (line) => `${(enc.encode(line).length + 4).toString(16).padStart(4, "0")}${line}`;

// Lines of a pkt-line stream, flushes dropped.
function pktLines(buf) {
  const lines = [];
  for (let i = 0; i + 4 <= buf.length;) {
    const n = parseInt(new TextDecoder().decode(buf.subarray(i, i + 4)), 16);
    if (n > 4) lines.push(new TextDecoder().decode(buf.subarray(i + 4, i + n)).replace(/\n$/, ""));
    i += Math.max(n, 4);
  }
  return lines;
}

const commandsOf = (updates) => enc.encode(updates.map((u, i) => pkt(`${u}${i ? "" : "\0report-status"}\n`)).join("") + "0000");

// Pushes body (update commands + packfile) to remote's receive-pack; returns the report-status lines once unpacked.
// A push with no response is sent once more; if that is refused for a ref that now sits at the sha of one of updates
// ("old new ref"), the first push landed and the refusal is dropped. A streamed body can't be sent twice.
async function receivePack(remote, headers, body, updates = []) {
  let sent = 0;
  const post = (signal) => {
    sent++;
    return fetch(`${remote}/git-receive-pack`, { method: "POST", headers: { ...headers, "Content-Type": "application/x-git-receive-pack-request" }, body, signal });
  };
  // lazy: a streamed push (mirror, copyRef) has no timeout; give it one when a stalled copy shows up.
  const res = await (body instanceof Uint8Array ? twice(post, PUSH_MS) : post());
  if (!res.ok) throw new Error(`git: push to ${remote} answered ${res.status}`);
  let report = pktLines(new Uint8Array(await res.arrayBuffer()));
  if (report[0] !== "unpack ok") throw new Error(`git: ${report[0] ?? "no report-status"}`);
  if (sent > 1 && report.some((l) => l.startsWith("ng "))) {
    const now = await advertised(remote, headers);
    report = report.filter((l) => !updates.some((u) => l.startsWith(`ng ${u.split(" ")[2]} `) && now[u.split(" ")[2]] === u.split(" ")[1]));
  }
  return report;
}

// Marks a branch move as cinder's (unless ours is false: a person's browser commit) before pushing it, so its push event isn't taken for a person's (pushes.js onPushes).
// Imported when called: the e2e setup runs this module in Node, against a git stand-in that sends no push events.
async function wrote(repo, ref, sha, ours = true) {
  const { env } = await import("cloudflare:workers").catch(() => ({}));
  const { name } = await repo.info();
  if (ours) await env?.DB.prepare("INSERT OR IGNORE INTO ref_writes (repo, ref, sha) VALUES (?, ?, ?)").bind(name, ref, sha).run();
  // The Code API's cached ref heads (code.js resolve), dropped now so a read after this write sees it; the push event
  // drops them again, in case a read landed between this and the push.
  await env?.REPO_DO.get(env.REPO_DO.idFromName(name)).dropHeads();
}

const conflict = (message) => Object.assign(new Error(message), { code: "conflict" });

// The remote and its auth headers, with a 60 s token of scope.
async function auth(repo, scope) {
  const { remote } = await repo.info();
  // The token's secret is what precedes "?expires=".
  const secret = (await repo.createToken(scope, 60)).plaintext.split("?")[0];
  return { remote, headers: { Authorization: `Basic ${btoa(`x:${secret}`)}` } };
}

// The repo's branches and tags [{name, kind: "branch" | "tag", sha}] in ref order, read from its upload-pack
// advertisement. An annotated tag's sha is the commit it peels to; an empty repo has none.
export async function listRefs(repo) {
  const { remote, headers } = await auth(repo, "read");
  const adv = await twice((signal) => fetch(`${remote}/info/refs?service=git-upload-pack`, { headers, signal }), READ_MS);
  if (!adv.ok) throw new Error(`git: ${remote} advertised refs with ${adv.status}`);
  const refs = new Map();
  for (const line of pktLines(new Uint8Array(await adv.arrayBuffer()))) {
    const m = /^([0-9a-f]{40}) refs\/(heads|tags)\/([^\0^]+)/.exec(line);
    // A peeled "^{}" line follows its tag's and replaces its sha.
    if (m) refs.set(`${m[2]}/${m[3]}`, { name: m[3], kind: m[2] === "heads" ? "branch" : "tag", sha: m[1] });
  }
  return [...refs.values()];
}

// The refs {name: sha} that remote's receive-pack advertises.
async function advertised(remote, headers) {
  const adv = await twice((signal) => fetch(`${remote}/info/refs?service=git-receive-pack`, { headers, signal }), READ_MS);
  if (!adv.ok) throw new Error(`git: ${remote} advertised refs with ${adv.status}`);
  return Object.fromEntries(pktLines(new Uint8Array(await adv.arrayBuffer())).map((l) => l.split("\0")[0].split(" ").reverse()));
}

// The remote, its auth headers (a 60 s write token) and its advertised refs {name: sha}.
async function connect(repo) {
  const { remote, headers } = await auth(repo, "write");
  return { remote, headers, refs: await advertised(remote, headers) };
}

// Creates branch at the head of from, or deletes it when from is null (a delete sends no pack). Throws {code: "conflict"}
// when a new branch exists already or from has no head, a deleted one doesn't exist, or the remote refuses the update.
export async function setBranch(repo, branch, from) {
  const { remote, headers, refs } = await connect(repo);
  const ref = `refs/heads/${branch}`;
  const [old, sha] = [refs[ref], from && refs[`refs/heads/${from}`]];
  if (from ? old || !sha : !old) throw conflict(from ? `${ref} exists or ${from} has no commits` : `${ref} does not exist`);
  const update = `${old ?? ZERO} ${sha ?? ZERO} ${ref}`;
  const commands = commandsOf([update]);
  await wrote(repo, ref, sha ?? ZERO);
  const failed = (await receivePack(remote, headers, from ? concat([commands, await packfile([])]) : commands, [update])).find((l) => l.startsWith("ng "));
  if (failed) throw conflict(`git: ${failed}`);
}

// Creates the lightweight tag refs/tags/<tag> at sha, a commit already in the repo: no new objects, no branch moves, and
// its push event's `after` is the commit itself. Throws {code: "conflict"} when the tag exists or the remote refuses it.
export async function setTag(repo, tag, sha) {
  const { remote, headers, refs } = await connect(repo);
  const ref = `refs/tags/${tag}`;
  if (refs[ref]) throw conflict(`${ref} exists`);
  await wrote(repo, ref, sha);
  const failed = (await receivePack(remote, headers, concat([commandsOf([`${ZERO} ${sha} ${ref}`]), await packfile([])]), [`${ZERO} ${sha} ${ref}`])).find((l) => l.startsWith("ng "));
  if (failed) throw conflict(`git: ${failed}`);
}

// Moves ref (a full name: a branch or tag) from sha `from` to `to` (ZERO: deletes it), objects already in the repo. Throws
// {code: "conflict"} when the remote refuses, as when another push moved the ref off from meanwhile.
export async function moveRef(repo, ref, from, to) {
  const { remote, headers } = await connect(repo);
  const update = `${from} ${to} ${ref}`;
  const commands = commandsOf([update]);
  await wrote(repo, ref, to);
  const failed = (await receivePack(remote, headers, to === ZERO ? commands : concat([commands, await packfile([])]), [update])).find((l) => l.startsWith("ng "));
  if (failed) throw conflict(`git: ${failed}`);
}

// Commits changes onto branch at base (null: a new branch) of repo, an Artifacts repo capability, and pushes it with
// tag (a name) when given, merge (a sha) as its second parent; ours false leaves no ref_writes marker. Throws {code: "conflict"} when the branch is not at base.
// The push's own base sha makes the remote refuse a moved branch. Returns {sha, tree, timings: {token, tree, pack, push} in ms}.
export async function commit(repo, { branch, base, changes, message, author, committer = author, tag, merge, ours }) {
  const ref = `refs/heads/${branch}`;
  const timings = {};
  const timed = async (key, work) => {
    const start = performance.now();
    try { return await work(); } finally { timings[key] = performance.now() - start; }
  };
  const objects = [];
  const [{ remote, headers }, tree] = await Promise.all([
    timed("token", () => auth(repo, "write")),
    timed("tree", async () => {
      const baseTree = base && (await repo.readCommit(base))?.treeHash;
      if (base && !baseTree) throw new Error(`git: no commit ${base}`);
      return buildTree(repo, baseTree, changes.map((c) => ({ ...c, path: c.path.split("/") })), objects);
    }),
  ]);
  const root = tree ?? (await treeObject([]));
  if (!tree) objects.push(root);
  const treeSha = tree ?? root.sha;
  const [c, body, updates] = await timed("pack", async () => {
    const c = await commitObject({ tree: treeSha, parents: [base, merge].filter(Boolean), author, committer, message });
    objects.push(c);
    const updates = [`${base ?? ZERO} ${c.sha} ${ref}`];
    if (tag) {
      const t = await tagObject({ object: c.sha, tag, tagger: committer, message });
      objects.push(t);
      updates.push(`${ZERO} ${t.sha} refs/tags/${tag}`);
    }
    return [c, await packfile(objects), updates];
  });
  await wrote(repo, ref, c.sha, ours);
  // A tag cinder writes is marked with its commit's sha: the sha the agents bootstrap's own push event carries (pushes.js).
  if (tag) await wrote(repo, `refs/tags/${tag}`, c.sha, ours);
  const report = await timed("push", () => receivePack(remote, headers, concat([commandsOf(updates), body]), updates));
  const failed = report.find((l) => l.startsWith("ng "));
  // A refused branch update: another writer moved the branch off base.
  if (failed?.startsWith(`ng ${ref} `)) throw conflict(`git: ${failed}`);
  if (failed) throw new Error(`git: ${failed}`);
  return { sha: c.sha, tree: treeSha, timings };
}

// The HEAD branch the public smart-HTTP remote url advertises, or undefined when it advertises none.
export async function remoteHead(url) {
  const adv = await twice((signal) => fetch(`${url}/info/refs?service=git-upload-pack`, { signal }), READ_MS);
  if (!adv.ok) throw new Error(`git: ${url} advertised refs with ${adv.status}`);
  return /\bsymref=HEAD:refs\/heads\/(\S+)/.exec(pktLines(new Uint8Array(await adv.arrayBuffer())).join(" "))?.[1];
}

// Copies every branch and tag of the smart-HTTP remote url, read with token, into the empty repo at remote (written
// with secret). The source's packfile streams straight into receive-pack, so a large repo never sits in memory.
// Returns the source's HEAD branch, or undefined when it advertises none.
// lazy: runs inside one request, so a repo too big to copy in its wall time fails; move into a Workflow step then.
export async function mirror(url, token, remote, secret) {
  const auth = { Authorization: `Basic ${btoa(`x-access-token:${token}`)}` };
  const adv = await twice((signal) => fetch(`${url}/info/refs?service=git-upload-pack`, { headers: auth, signal }), READ_MS);
  if (!adv.ok) throw new Error(`git: ${url} advertised refs with ${adv.status}`);
  const lines = pktLines(new Uint8Array(await adv.arrayBuffer()));
  const head = /\bsymref=HEAD:refs\/heads\/(\S+)/.exec(lines.join(" "))?.[1];
  // Peeled "^{}" lines and HEAD are not refs to write; an empty source advertises only capabilities^{}.
  const refs = lines.map((l) => l.split("\0")[0].split(" ")).filter(([sha, name]) => /^[0-9a-f]{40}$/.test(sha) && /^refs\/(heads|tags)\/[^^]+$/.test(name));
  if (!refs.length) return head;
  await copyPack(url, auth, refs.map(([sha]) => sha), remote, { Authorization: `Basic ${btoa(`x:${secret}`)}` },
    refs.map(([sha, name]) => `${ZERO} ${sha} ${name}`));
  return head;
}

// Moves ref of repo `to` (and each of also, other full ref names) onto sha, a commit of repo `from` (both Artifacts repo
// capabilities), copying its objects across in one push.
// lazy: sends sha's whole history, not only what `to` lacks; send haves once a copy outgrows one request.
export async function copyRef(from, to, ref, sha, also = []) {
  const src = await auth(from, "read");
  const { remote, headers, refs } = await connect(to);
  const moved = [...new Set([ref, ...also])].filter((r) => refs[r] !== sha);
  if (!moved.length) return;
  for (const r of moved) await wrote(to, r, sha);
  await copyPack(src.remote, src.headers, [sha], remote, headers, moved.map((r) => `${refs[r] ?? ZERO} ${sha} ${r}`));
}

// Streams the packfile of wants from upload-pack at url straight into receive-pack at remote, with updates applied.
async function copyPack(url, auth, shas, remote, headers, updates) {
  const wants = [...new Set(shas)].map((sha) => pkt(`want ${sha}\n`)).join("");
  // The timeout covers the wait for the answer, not the pack that streams after it.
  const res = await twice((signal) => fetch(`${url}/git-upload-pack`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/x-git-upload-pack-request" },
    body: `${wants}0000${pkt("done\n")}`,
    signal,
  }), PUSH_MS);
  if (!res.ok) throw new Error(`git: fetch from ${url} answered ${res.status}`);
  // Without side-band the answer is "0008NAK\n" then the raw packfile.
  const src = res.body.getReader();
  let start = new Uint8Array(0);
  // The last 4 bytes are held back: Artifacts ends the answer with a flush-pkt ("0000") after the pack, which
  // receive-pack refuses as junk (500), so it's dropped. lazy: a pack whose checksum ends in "0000" (1 in 2^32) loses it.
  let held = new Uint8Array(0);
  const emit = (c, chunk) => {
    const all = concat([held, chunk]);
    held = all.subarray(Math.max(0, all.length - 4));
    if (all.length > 4) c.enqueue(all.subarray(0, all.length - 4));
  };
  const body = new ReadableStream({
    start(c) { c.enqueue(commandsOf(updates)); },
    async pull(c) {
      for (;;) {
        const { done, value } = await src.read();
        if (done) {
          if (start) return c.error(new Error(`git: ${url} sent no packfile`));
          if (new TextDecoder().decode(held) !== "0000") c.enqueue(held);
          return c.close();
        }
        if (!start) return emit(c, value);
        start = concat([start, value]);
        if (start.length < 12) continue;
        const nak = new TextDecoder().decode(start.subarray(0, 12));
        if (nak !== "0008NAK\nPACK") return c.error(new Error(`git: ${url} sent ${JSON.stringify(nak)}, not a packfile`));
        emit(c, start.subarray(8));
        start = null;
        return;
      }
    },
  });
  const failed = (await receivePack(remote, headers, body)).find((l) => l.startsWith("ng "));
  if (failed) throw new Error(`git: ${failed}`);
}
