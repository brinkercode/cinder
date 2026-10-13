import { error, runnerOf } from "./router.js";

// GET /api/repos/:name/signing-key: the repo's public merge-signing key as one OpenSSH line, so
// `curl … > key.pub && cinder verify-commit <sha> --key key.pub` checks a merge offline.
export async function getSigningKey(request, env, { name }) {
  const repo = await env.DB.prepare("SELECT id FROM repos WHERE name = ?").bind(name).first();
  if (!repo) return error(404, "not_found", `no repo ${name}`);
  if (!env.MERGE_SIGNING_KEY) return noKey();
  const { blob } = await signingKey(env, repo.id);
  return new Response(`ssh-ed25519 ${b64(blob)}\n`, { headers: { "Content-Type": "text/plain" } });
}

// POST /api/work/jobs/:job/sign {commit} → {signature} (null without the key binding): an SSH signature (namespace git) over the commit object, by the
// repo's key, for the runner holding the merge job's lease. The private key never leaves the Worker.
export async function signMerge(request, env, { job: id }) {
  const runner = await runnerOf(request, env);
  const job = await env.DB.prepare("SELECT repo_id, payload FROM jobs WHERE id = ? AND runner_id = ? AND kind = 'merge' AND status = 'claimed' AND lease_expires_at > ?")
    .bind(id, runner.runner_id, new Date().toISOString()).first();
  if (!job) return error(403, "forbidden", `merge job ${id} is not leased to this runner`);
  const commit = (await request.json().catch(() => null))?.commit;
  if (typeof commit !== "string" || !commit.startsWith("tree ")) return error(400, "bad_request", "body must be {commit} holding a git commit object");
  // The key vouches only for a tree a verifier checked: one of the batch's verified trees (null means none).
  const tree = commit.split("\n")[0].slice(5);
  if (!(JSON.parse(job.payload ?? "{}").batch ?? []).some((b) => b.tree && b.tree === tree)) return error(409, "conflict", `tree ${tree} is not a verified tree of merge job ${id}`);
  // Until the binding lands, merges go through unsigned and the runner reports them so; signing never falls back.
  if (!env.MERGE_SIGNING_KEY) return Response.json({ signature: null });
  const { key, blob } = await signingKey(env, job.repo_id);
  // SSHSIG (openssh PROTOCOL.sshsig): sign the namespace and the message's SHA-512, then wrap it with the public key.
  const head = [str("git"), str(""), str("sha512"), str(new Uint8Array(await crypto.subtle.digest("SHA-512", new TextEncoder().encode(commit))))];
  const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", key, await bytes([MAGIC, ...head])));
  const file = await bytes([MAGIC, u32(1), str(blob), ...head.slice(0, 3), str(await bytes([str("ssh-ed25519"), str(sig)]))]);
  return Response.json({ signature: `-----BEGIN SSH SIGNATURE-----\n${b64(file).match(/.{1,70}/g).join("\n")}\n-----END SSH SIGNATURE-----\n` });
}

const noKey = () => error(503, "no_signing_key", "the Worker has no MERGE_SIGNING_KEY Secrets Store binding");

// signingKey derives the repo's Ed25519 key from the MERGE_SIGNING_KEY Secrets Store secret, so no key is ever stored:
// seed = HMAC-SHA256(secret, repo id). Returns the private CryptoKey and the public key's SSH wire blob.
async function signingKey(env, repoId) {
  const master = await crypto.subtle.importKey("raw", new TextEncoder().encode(await env.MERGE_SIGNING_KEY.get()), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const seed = new Uint8Array(await crypto.subtle.sign("HMAC", master, new TextEncoder().encode(repoId)));
  // PKCS#8 for Ed25519 is a fixed 16-byte header followed by the 32-byte seed (RFC 8410).
  const pkcs8 = await bytes([Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]), seed]);
  const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, true, ["sign"]);
  const pub = Uint8Array.from(atob((await crypto.subtle.exportKey("jwk", key)).x.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  return { key, blob: await bytes([str("ssh-ed25519"), str(pub)]) };
}

const MAGIC = new TextEncoder().encode("SSHSIG");
const u32 = (n) => new Uint8Array([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const str = (s) => { const b = typeof s === "string" ? new TextEncoder().encode(s) : s; return new Blob([u32(b.length), b]); };
const bytes = async (parts) => new Uint8Array(await new Blob(parts).arrayBuffer());
const b64 = (b) => btoa(String.fromCharCode(...b));
