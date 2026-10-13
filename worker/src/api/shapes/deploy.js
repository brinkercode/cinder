import { TARGET_CONFIG, targetErrors } from "./flow.js";

// The `deploy` section of .cinder.yml (docs/DESIGN.md §9). Errors name the key path, e.g. deploy.resources[1].type.
const str = (v) => typeof v === "string" && v.length > 0;
const RESOURCE_TYPES = ["d1", "kv", "queue", "r2"];
// A sync window's deny range, e.g. "Fri 17:00-Mon 09:00": day, hour and minute of its start and end.
export const DENY_WINDOW = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) ([01]\d|2[0-3]):([0-5]\d)-(Sun|Mon|Tue|Wed|Thu|Fri|Sat) ([01]\d|2[0-3]):([0-5]\d)$/;
const timeZone = (tz) => { try { return str(tz) && !!new Intl.DateTimeFormat("en-US", { timeZone: tz }); } catch { return false; } };

export function validateDeploy(v) {
  const errors = [];
  const need = (ok, path, desc) => { if (!ok) errors.push(`${path}: expected ${desc}`); };
  const envs = v?.environments;
  need(Array.isArray(envs) && envs.length > 0, "deploy.environments", "non-empty list");
  (Array.isArray(envs) ? envs : []).forEach((e, i) => {
    const p = `deploy.environments[${i}]`;
    need(str(e?.name), `${p}.name`, "non-empty string");
    need(str(e?.branch) !== (e?.from === "change"), p, "exactly one of branch or from: change");
    if (e?.auto_sync !== undefined) need(typeof e.auto_sync === "boolean", `${p}.auto_sync`, "true or false");
    if (e?.self_heal !== undefined) need(typeof e.self_heal === "boolean", `${p}.self_heal`, "true or false");
    if (e?.gradual !== undefined) {
      const g = e.gradual;
      need(Array.isArray(g) && g.length > 0 && g.at(-1) === 100
        && g.every((s, j) => Number.isInteger(s) && s > (j ? g[j - 1] : 0)), `${p}.gradual`,
      "rising integer percentages ending at 100");
    }
    if (e?.bake !== undefined) need(Number.isInteger(e.bake) && e.bake >= 0, `${p}.bake`, "whole seconds");
    if (e?.secrets !== undefined) need(Array.isArray(e.secrets) && e.secrets.every(str), `${p}.secrets`, "list of names");
    if (e?.max_error_rate !== undefined) {
      need(typeof e.max_error_rate === "number" && e.max_error_rate >= 0 && e.max_error_rate <= 1, `${p}.max_error_rate`, "ratio from 0 to 1");
    }
    if (e?.windows !== undefined) {
      need(Array.isArray(e.windows) && e.windows.every((w) => DENY_WINDOW.test(w?.deny) && timeZone(w?.tz)), `${p}.windows`,
        'list of {deny: "Fri 17:00-Mon 09:00", tz: <IANA time zone>}');
    }
    if (e?.health !== undefined) need(typeof e.health === "string" && e.health.startsWith("/"), `${p}.health`, "path starting with /");
    if (e?.routes !== undefined) need(Array.isArray(e.routes) && e.routes.every((r) => str(r?.pattern) && str(r?.zone)), `${p}.routes`, "list of { pattern, zone }");
    if (e?.target !== undefined) need(str(e.target), `${p}.target`, "target cloud");
    if (e?.custom_domain !== undefined) need(str(e.custom_domain), `${p}.custom_domain`, "hostname");
    if (e?.approvers !== undefined) need(str(e.approvers), `${p}.approvers`, "role name");
    for (const k of Object.keys(TARGET_CONFIG)) if (e?.[k] !== undefined) errors.push(...targetErrors(k, e[k], p));
    if (e?.crons !== undefined) need(Array.isArray(e.crons) && e.crons.every(str), `${p}.crons`, "list of cron expressions");
  });
  if (v?.preview !== undefined) need(typeof v.preview?.resources === "boolean", "deploy.preview.resources", "true or false");
  need(str(v?.worker), "deploy.worker", "non-empty string");
  need(v?.build === undefined || str(v.build), "deploy.build", "non-empty command");
  need((v?.build === undefined) === (v?.out === undefined) && (v?.out === undefined || str(v.out)), "deploy.out", "directory, set together with build");
  const res = v?.resources ?? [];
  need(Array.isArray(res), "deploy.resources", "list");
  (Array.isArray(res) ? res : []).forEach((r, i) => {
    const p = `deploy.resources[${i}]`;
    need(RESOURCE_TYPES.includes(r?.type), `${p}.type`, RESOURCE_TYPES.join(", "));
    need(str(r?.name), `${p}.name`, "non-empty string");
    if (r?.migrations !== undefined) need(r.type === "d1" && str(r.migrations), `${p}.migrations`, "directory, on d1 only");
  });
  return { ok: errors.length === 0, errors };
}
