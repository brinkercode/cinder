const OSV = "https://api.osv.dev/v1";
const ECOSYSTEMS = { npm: "npm", go: "Go" };

// Adds { osv: "clean" | "vulnerable" | "unchecked", vulns: [{ id, severity, fixed_in, also_fixes }] } to each dependency. Any OSV failure
// marks every dependency unchecked: a failed lookup proves nothing, so it never reads as clean.
// lazy: one GET per distinct vuln id and no querybatch paging; batch or cache if changes add hundreds of vulnerable deps.
export async function checkVulns(deps) {
  if (!deps.length) return deps;
  try {
    const res = await fetch(`${OSV}/querybatch`, {
      method: "POST",
      body: JSON.stringify({ queries: deps.map((d) => ({ package: { name: d.name, ecosystem: ECOSYSTEMS[d.ecosystem] ?? d.ecosystem }, version: d.version })) }),
    });
    if (!res.ok) throw new Error(`osv querybatch ${res.status}`);
    const { results } = await res.json();
    const ids = results.map((r) => (r.vulns ?? []).map((v) => v.id));
    const found = {};
    for (const id of new Set(ids.flat())) {
      const v = await fetch(`${OSV}/vulns/${encodeURIComponent(id)}`);
      if (!v.ok) throw new Error(`osv vuln ${id} ${v.status}`);
      found[id] = await v.json();
    }
    return deps.map((d, i) => {
      const vulns = ids[i].map((id) => ({ id, severity: severityOf(found[id].severity), fixed_in: fixedIn(found[id], d) }));
      // A bump to v.fixed_in also fixes each other vuln whose own fix is at or below it.
      for (const v of vulns) {
        v.also_fixes = vulns.filter((o) => o !== v && v.fixed_in && o.fixed_in && compareVersions(o.fixed_in, v.fixed_in) <= 0).length;
      }
      return { ...d, osv: ids[i].length ? "vulnerable" : "clean", vulns };
    });
  } catch {
    return deps.map((d) => ({ ...d, osv: "unchecked", vulns: [] }));
  }
}

// The lowest OSV "fixed" event above the dep's version, the end of the range that version is in; null if none is fixed.
function fixedIn(vuln, d) {
  const fixes = (vuln.affected ?? []).filter((a) => a.package?.name === d.name)
    .flatMap((a) => (a.ranges ?? []).filter((r) => r.type !== "GIT").flatMap((r) => (r.events ?? []).map((e) => e.fixed)))
    .filter((f) => typeof f === "string" && f && compareVersions(f, d.version) > 0);
  return fixes.sort(compareVersions)[0] ?? null;
}

// lazy: compares the numeric release parts only (v1.10.0 > 1.9.2); a prerelease equals its release. Use the ecosystem's rules if that misorders fixes.
function compareVersions(a, b) {
  const [pa, pb] = [a, b].map((v) => v.split(/[-+]/)[0].match(/\d+/g) ?? []);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = Number(pa[i] ?? 0) - Number(pb[i] ?? 0);
    if (diff) return diff;
  }
  return 0;
}

const WEIGHTS = {
  AV: { N: 0.85, A: 0.62, L: 0.55, P: 0.2 }, AC: { L: 0.77, H: 0.44 }, UI: { N: 0.85, R: 0.62 },
  PR: { N: 0.85, L: 0.62, H: 0.27 }, S: { U: 0, C: 0 }, C: { H: 0.56, L: 0.22, N: 0 }, I: { H: 0.56, L: 0.22, N: 0 }, A: { H: 0.56, L: 0.22, N: 0 },
};

// The highest CVSS v3 base severity among the vectors, or "unknown" when none parses (CVSS v4 included).
function severityOf(entries) {
  const scores = (Array.isArray(entries) ? entries : []).map((e) => cvss3(e?.score)).filter((s) => s !== null);
  if (!scores.length) return "unknown";
  const s = Math.max(...scores);
  return s === 0 ? "none" : s < 4 ? "low" : s < 7 ? "medium" : s < 9 ? "high" : "critical";
}

// CVSS v3.x base score (FIRST spec, section 7.1), or null if the vector is not a complete v3 vector.
function cvss3(vector) {
  const [head, ...parts] = typeof vector === "string" ? vector.split("/") : [];
  if (head !== "CVSS:3.0" && head !== "CVSS:3.1") return null;
  const m = Object.fromEntries(parts.map((p) => p.split(":")));
  if (!Object.keys(WEIGHTS).every((k) => Object.hasOwn(WEIGHTS[k], m[k] ?? ""))) return null;
  const changed = m.S === "C";
  const pr = changed && m.PR !== "N" ? { L: 0.68, H: 0.5 }[m.PR] : WEIGHTS.PR[m.PR];
  const iss = 1 - (1 - WEIGHTS.C[m.C]) * (1 - WEIGHTS.I[m.I]) * (1 - WEIGHTS.A[m.A]);
  const impact = changed ? 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15 : 6.42 * iss;
  if (impact <= 0) return 0;
  const exploit = 8.22 * WEIGHTS.AV[m.AV] * WEIGHTS.AC[m.AC] * pr * WEIGHTS.UI[m.UI];
  // The spec's Roundup: plain Math.ceil(x * 10) turns float noise like 4.000000001 into 4.1.
  const n = Math.round(Math.min((changed ? 1.08 : 1) * (impact + exploit), 10) * 100000);
  return n % 10000 === 0 ? n / 100000 : (Math.floor(n / 10000) + 1) / 10;
}
