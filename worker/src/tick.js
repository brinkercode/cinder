// The periodic work, once per 10-minute slot. The cron (wrangler.jsonc) and DispatchDO's alarm both ask for the slot and
// whichever asks first runs it (DispatchDO.takeSlot), so the work still happens when Cron Triggers fail platform-wide.
import { syncAccounts } from "./accounts.js";
import { checkDrift } from "./drift.js";
import { cronFlows, timeOutFlowJobs } from "./flows.js";
import { ingestAdvisories } from "./mirror.js";
import { raiseBudgetNeeds } from "./needs.js";
import { scanDaily } from "./scans.js";
import { expireLeases } from "./scheduler.js";
import { pullUsage } from "./usage.js";
import { autoscale, pruneGone } from "./workers.js";

export const SLOT_MS = 10 * 60 * 1000;

// Accounts sync hourly: on the slot in each hour's first ten minutes.
// allSettled: under Promise.all one fast rejection (syncAccounts at :00) ended the tick before cron flows were enqueued.
export const runTick = (env, time) => Promise.allSettled([checkDrift(env), scanDaily(env), pullUsage(env).then(() => raiseBudgetNeeds(env)), ingestAdvisories(env),
  cronFlows(env, time), timeOutFlowJobs(env), expireLeases(env), pruneGone(env).then(() => autoscale(env)),
  ...(new Date(time).getUTCMinutes() < 10 ? [syncAccounts(env)] : [])])
  .then((rs) => rs.forEach((r) => r.status === "rejected" && console.error(`tick: ${r.reason?.message ?? r.reason}`)));
