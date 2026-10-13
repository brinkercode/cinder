import { useCallback, useEffect, useState } from "react";
import { validateCollisions } from "../../../worker/src/api/contract.js";
import collisions from "../../../worker/src/api/fixtures/collisions.json";
import { fetchJson, fixtures, listen, postJson } from "../client.js";

async function load(repo, target) {
  const path = `/api/repos/${encodeURIComponent(repo)}/collisions${target ? `?target=${encodeURIComponent(target)}` : ""}`;
  const body = fixtures() ? collisions : await fetchJson(path);
  const { ok, errors } = validateCollisions(body);
  if (!ok) throw new Error(`${path}: ${errors.join("; ")}`);
  return body;
}

// POST /api/changes/:id/collisions/resolve: action is stack, seam, handover or reprioritize.
export const resolveCollision = (id, action) => postJson(`/api/changes/${encodeURIComponent(id)}/collisions/resolve`, { action });

// The repo's collisions (only those into target when it's given), refetched on every live event. data is null while loading; err is the last failure's message
// (the previous data stays), so a page shows the failure beside what it has.
export function useCollisions(repo, target) {
  const key = `${repo}\n${target ?? ""}`;
  const [state, setState] = useState({ key: null, data: null, err: null });
  const reload = useCallback(() => load(repo, target).then(
    (data) => setState({ key, data, err: null }),
    (e) => setState((s) => ({ ...s, key, err: e.message })),
  ), [repo, target, key]);
  useEffect(() => { reload(); return listen(repo, reload); }, [repo, reload]);
  return { data: state.key === key ? state.data : null, err: state.key === key ? state.err : null, reload };
}
