/* global FixedLengthStream -- Workers runtime global, not in the eslint globals sets */
// The flow tool cache: toolchain versions a flow step's `setup:` asks for, packed once by the worker that first needed one
// (cinder-verify, runner/cmd/cinder-verify/toolcache.go) and kept in R2 cinder-ci-cache under toolcache/ for the next job.
// The object is the upstream release archive as published, so a worker can check it against the upstream checksum.
// Both routes sit under /api/work/, so the router lets only runner tokens in.
import { SETUP_TOOLS, TOOL_VERSION } from "./api/shapes/flow.js";
import { error, hex, runnerOf } from "./router.js";

// The largest toolchain archive taken; a .NET SDK packs to about 250 MB.
export const MAX_TOOL_BYTES = 512 * 1024 * 1024;

const keyOf = ({ tool, version }) => SETUP_TOOLS.includes(tool) && TOOL_VERSION.test(version) && `toolcache/${tool}/${version}/release`;

// GET /api/work/toolcache/:tool/:version → the packed toolchain, or 404 when no worker has stored it yet.
export async function getTool(request, env, params) {
  const key = keyOf(params);
  if (!key) return error(400, "bad_request", `tool from ${SETUP_TOOLS.join(", ")} and a version matching ${TOOL_VERSION}`);
  const obj = await env.TOOL_CACHE.get(key);
  if (!obj) return error(404, "not_found", `no ${params.tool} ${params.version} in the tool cache`);
  return new Response(obj.body, { headers: { "Content-Type": "application/gzip", "Content-Length": String(obj.size) } });
}

// PUT /api/work/toolcache/:tool/:version (body: the release archive, with its Content-Length) → 204, storing its SHA-256
// beside it; 403 unless the runner holds a claimed flow job with a step that sets up that tool at that version.
export async function putTool(request, env, params) {
  const key = keyOf(params);
  if (!key) return error(400, "bad_request", `tool from ${SETUP_TOOLS.join(", ")} and a version matching ${TOOL_VERSION}`);
  const size = Number(request.headers.get("Content-Length"));
  if (!request.body || !(size > 0)) return error(411, "length_required", "send the archive with its Content-Length");
  if (size > MAX_TOOL_BYTES) return error(413, "too_large", `a tool archive is at most ${MAX_TOOL_BYTES} bytes`);
  const runner = await runnerOf(request, env);
  const holds = await env.DB.prepare(`SELECT 1 FROM jobs j, json_each(j.payload, '$.steps') s WHERE j.kind = 'flow' AND j.status = 'claimed'
    AND j.runner_id = ? AND json_extract(s.value, '$.setup.' || ?) = ?`).bind(runner.runner_id, params.tool, params.version).first();
  if (!holds) return error(403, "forbidden", `this runner holds no flow job that sets up ${params.tool} ${params.version}`);
  // Each chunk goes both to R2 and to the hash; workerd can't pipe a tee'd body into a DigestStream.
  const { readable, writable } = new FixedLengthStream(size);
  const digest = new crypto.DigestStream("SHA-256");
  const copy = async () => {
    const [out, hash] = [writable.getWriter(), digest.getWriter()];
    for await (const chunk of request.body) await Promise.all([out.write(chunk), hash.write(chunk)]);
    await Promise.all([out.close(), hash.close()]);
  };
  await Promise.all([env.TOOL_CACHE.put(key, readable), copy()]);
  await env.TOOL_CACHE.put(`${key}.sha256`, hex(new Uint8Array(await digest.digest)));
  return new Response(null, { status: 204 });
}
