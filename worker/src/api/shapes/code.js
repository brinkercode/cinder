// GET /api/repos/:name/tree?ref&path and /file?ref&path. ref is a branch or change id; sha is the commit read.
// File content is null when the file is over 1 MB (metadata only). The root tree (path "") has the repo's git remote.
function common(v, errors) {
  for (const k of ["ref", "sha"]) if (typeof v?.[k] !== "string" || !v[k]) errors.push(`${k}: expected non-empty string`);
  if (typeof v?.path !== "string") errors.push("path: expected string");
}

// A ref with no commits yet answers empty: true with sha null and no entries.
export function validateCodeTree(v) {
  const errors = [];
  if (v?.empty !== undefined && v.empty !== true) errors.push("empty: expected true or absent");
  if (v?.empty === true && (v.sha !== null || v.entries?.length)) errors.push("empty: expected sha null and no entries");
  common(v?.empty === true ? { ...v, sha: "none" } : v, errors);
  if (!Array.isArray(v?.entries)) errors.push("entries: expected array");
  else v.entries.forEach((e, i) => {
    for (const k of ["name", "path"]) if (typeof e?.[k] !== "string" || !e[k]) errors.push(`entries[${i}].${k}: expected non-empty string`);
    if (!["tree", "blob"].includes(e?.type)) errors.push(`entries[${i}].type: expected tree or blob`);
  });
  if (v?.remote !== undefined && (typeof v.remote !== "string" || !v.remote)) errors.push("remote: expected non-empty string");
  return { ok: errors.length === 0, errors };
}

export function validateCodeFile(v) {
  const errors = [];
  common(v, errors);
  if (!(Number.isInteger(v?.size) && v.size >= 0)) errors.push("size: expected integer >= 0");
  if (v?.content !== null && typeof v?.content !== "string") errors.push("content: expected string or null");
  return { ok: errors.length === 0, errors };
}

// GET /api/repos/:name/authorship?ref&path. lines[i] is line i+1: its commit, the merged change and agent@version
// from its Cinder trailers, or the person who wrote it. lines is null (202) until the blame job reports.
export function validateAuthorship(v) {
  const errors = [];
  common(v, errors);
  if (v?.lines !== null && !Array.isArray(v?.lines)) errors.push("lines: expected array or null");
  else v.lines?.forEach((l, i) => {
    if (typeof l?.commit !== "string" || !l.commit) errors.push(`lines[${i}].commit: expected non-empty string`);
    if (l?.change !== undefined && typeof l.change !== "string") errors.push(`lines[${i}].change: expected string`);
    if (!(typeof l?.agent === "string" && l.agent) === !(typeof l?.person === "string" && l.person)) errors.push(`lines[${i}]: expected one of agent or person`);
  });
  return { ok: errors.length === 0, errors };
}
