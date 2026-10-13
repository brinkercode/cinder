import { validateSbom } from "./api/contract.js";
import { getDependencies } from "./dependencies.js";
import { error } from "./router.js";

const TYPES = { npm: "npm", go: "golang", cargo: "cargo", pypi: "pypi" };

// Package URL per the purl spec: each path segment percent-encoded (an npm scope's @ becomes %40, a Go module
// path keeps its slashes), and pypi names normalised to lowercase with dashes.
function purl({ ecosystem, name, version }) {
  const n = ecosystem === "pypi" ? name.toLowerCase().replace(/[-_.]+/g, "-") : name;
  return `pkg:${TYPES[ecosystem] ?? "generic"}/${n.split("/").map(encodeURIComponent).join("/")}@${encodeURIComponent(version)}`;
}

// GET /api/repos/:name/sbom?target=: the target's dependency inventory as a CycloneDX 1.5 JSON document.
export async function getSbom(request, env, params) {
  const url = new URL(request.url);
  url.searchParams.delete("filter");
  const res = await getDependencies(new Request(url), env, params);
  if (!res.ok) return res;
  const bom = {
    bomFormat: "CycloneDX", specVersion: "1.5", serialNumber: `urn:uuid:${crypto.randomUUID()}`, version: 1,
    metadata: { timestamp: new Date().toISOString(), component: { type: "application", name: params.name } },
    components: (await res.json()).map((d) => ({
      type: "library", name: d.name, version: d.version, purl: purl(d),
      ...(d.license && { licenses: [{ license: { name: d.license } }] }),
    })),
  };
  const { errors } = validateSbom(bom);
  if (errors.length) return error(500, "contract", errors.join("; "));
  return Response.json(bom);
}
