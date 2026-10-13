import { changeDetail } from "../client.js";

// Change detail loads started by hovering or focusing a board card; the page's loader takes one, so a click lands on data in flight.
const ahead = new Map();
const FRESH = 10_000; // older than this, the click loads again rather than show a stale change

export function prefetchChange(repo, id) {
  const hit = ahead.get(id);
  if (hit && Date.now() - hit.at < FRESH) return;
  const detail = changeDetail(repo, id);
  detail.catch(() => {}); // the page shows the failure if it takes this load
  ahead.set(id, { at: Date.now(), detail });
}

// The prefetched load once, else a new one: a revalidation always loads again.
export function loadChange(repo, id) {
  const hit = ahead.get(id);
  ahead.delete(id);
  return hit && Date.now() - hit.at < FRESH ? hit.detail : changeDetail(repo, id);
}
