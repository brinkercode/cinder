import { judge, stateHash } from "./judgments.js";

const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";
const TOP_K = 3;
const QUESTIONS = { resembles_vuln: { kind: "noul", prompt: "Does this function resemble the vulnerable side of a known vulnerability fix?",
  guide: "The state holds a function this change added or edited, and matches: the nearest known vulnerability fixes, each with its advisory " +
    "and the vulnerable lines the fix removed. Answer yes when the function repeats the pattern a fix removed: the same unsafe call, missing " +
    "check or injection path. Answer no when it already has the fix's check, or the likeness is only the library, names or style." } };

// fns: [{ path, name, body }] changed functions. Embeds them with Workers AI (env.AI), takes the nearest
// vulnerability-fix diffs from the Vectorize index env.VULN_INDEX and asks the resembles_vuln judge once per function.
// Returns { "path:name": { answer, p, trusted, match } }, match the nearest advisory's id. Missing bindings or a failed embed/query give the untrusted safe default.
export async function judgeResemblesVuln(env, repo, fns, change) {
  const out = Object.fromEntries(fns.map((f) => [`${f.path}:${f.name}`, { answer: null, p: null, trusted: false }]));
  if (!fns.length || !env.AI || !env.VULN_INDEX) return out;
  let states;
  try {
    const { data } = await env.AI.run(EMBED_MODEL, { text: fns.map((f) => f.body) }, { gateway: { id: env.AI_GATEWAY_ID, metadata: { repo, ...(change && { change }) } } });
    states = await Promise.all(fns.map(async (f, i) => {
      const { matches } = await env.VULN_INDEX.query(data[i], { topK: TOP_K, returnMetadata: "all" });
      return { function: f, matches: matches.map((m) => ({ id: m.id, score: m.score, ...m.metadata })) };
    }));
  } catch (err) {
    console.warn(`judge resembles_vuln: ${err.message}`);
    return out;
  }
  for (const s of states) {
    const judged = (await judge(env, repo, "resembles_vuln", s, QUESTIONS, change)).resembles_vuln;
    out[`${s.function.path}:${s.function.name}`] = { ...judged, match: s.matches[0]?.id ?? null };
    // judge() returns no id, so the judgment it just recorded for this state is found by its hash.
    if (change && judged.answer) {
      await env.DB.prepare("INSERT OR IGNORE INTO judgment_paths (judgment_id, path) SELECT id, ? FROM judgments WHERE change_id = ? " +
        "AND kind = 'resembles_vuln' AND state_hash = ? ORDER BY made_at DESC LIMIT 1").bind(s.function.path, change, await stateHash(s)).run();
    }
  }
  return out;
}

const OSV = "https://api.osv.dev/v1";
const FIX_COMMIT = /^https:\/\/github\.com\/[^/]+\/[^/]+\/commit\/[0-9a-f]{7,40}$/;

// Cron: each advisory a done scan has seen (scan_deps) and the index doesn't hold yet is embedded and upserted: its
// summary and details plus the removed (vulnerable) lines of its GitHub fix commit, when OSV links one.
// lazy: one OSV GET per advisory; batch if the backlog outgrows a day of runs.
export async function ingestAdvisories(env) {
  if (!env.AI || !env.VULN_INDEX) return;
  const { results } = await env.DB.prepare("SELECT DISTINCT json_extract(v.value, '$.id') AS id FROM scan_deps s, json_each(s.deps) d, " +
    "json_each(d.value, '$.vulns') v ORDER BY id").all();
  const ids = results.map((r) => r.id).filter(Boolean);
  try {
    // getByIds takes at most 20 ids; each run embeds the first 20 the index lacks.
    const todo = [];
    for (let i = 0; i < ids.length && todo.length < 20; i += 20) {
      const have = new Set((await env.VULN_INDEX.getByIds(ids.slice(i, i + 20))).map((v) => v.id));
      todo.push(...ids.slice(i, i + 20).filter((id) => !have.has(id)));
    }
    // An advisory OSV doesn't serve is skipped, not fatal: it costs one GET a run but never blocks the others.
    const docs = (await Promise.all(todo.slice(0, 20).map(async (id) => {
      const res = await fetch(`${OSV}/vulns/${encodeURIComponent(id)}`);
      if (!res.ok) return console.warn(`ingest advisories: osv vuln ${id} ${res.status}`);
      const v = await res.json();
      const fix = (v.references ?? []).find((r) => r.type === "FIX" && FIX_COMMIT.test(r.url));
      const diff = fix ? await fetch(`${fix.url}.diff`).then((r) => (r.ok ? r.text() : "")) : "";
      const removed = diff.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---")).map((l) => l.slice(1));
      return { id, summary: v.summary ?? "", text: [v.summary, v.details, ...removed].filter(Boolean).join("\n") };
    }))).filter(Boolean);
    if (!docs.length) return;
    const { data } = await env.AI.run(EMBED_MODEL, { text: docs.map((d) => d.text) }, { gateway: { id: env.AI_GATEWAY_ID } });
    await env.VULN_INDEX.upsert(docs.map((d, i) => ({ id: d.id, values: data[i], metadata: { cve: d.id, summary: d.summary } })));
  } catch (err) {
    // Nothing is upserted, so the next run retries the same advisories.
    console.warn(`ingest advisories: ${err.message}`);
  }
}
