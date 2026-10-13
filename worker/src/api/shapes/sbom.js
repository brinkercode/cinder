// GET /api/repos/:name/sbom returns this: the fields CycloneDX 1.5 requires, plus a purl and version on each library component.
export function validateSbom(v) {
  const errors = [];
  if (v?.bomFormat !== "CycloneDX") errors.push("bomFormat: expected CycloneDX");
  if (v?.specVersion !== "1.5") errors.push("specVersion: expected 1.5");
  if (!Number.isInteger(v?.version) || v.version < 1) errors.push("version: expected integer >= 1");
  if (!Array.isArray(v?.components)) errors.push("components: expected array");
  (Array.isArray(v?.components) ? v.components : []).forEach((c, i) => {
    if (c?.type !== "library") errors.push(`components[${i}].type: expected library`);
    for (const k of ["name", "version"]) if (typeof c?.[k] !== "string" || !c[k]) errors.push(`components[${i}].${k}: expected non-empty string`);
    if (typeof c?.purl !== "string" || !c.purl.startsWith("pkg:")) errors.push(`components[${i}].purl: expected pkg: URL`);
  });
  return { ok: errors.length === 0, errors };
}
