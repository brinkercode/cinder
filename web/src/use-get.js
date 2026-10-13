import { useEffect, useRef, useState } from "react";

// Marks p settled the way React's use() marks a thenable, so any render after that (a server render too) reads it at once.
const track = (p) => {
  if (!p.status) {
    p.status = "pending";
    // Block bodies: returning p would make this chain adopt its rejection, unhandled.
    p.then((value) => { Object.assign(p, { status: "fulfilled", value }); }, (reason) => { Object.assign(p, { status: "rejected", reason }); });
  }
  return p;
};

// One GET, first started by the route loader: {data} or {error} once settled. retry re-runs load and keeps the last
// result meanwhile, so drafts built on it stay.
export function useGet(load, first) {
  const [p, setP] = useState(() => track(first ?? load()));
  const [, rerender] = useState(0);
  const last = useRef({});
  useEffect(() => {
    let live = true;
    const done = () => live && rerender((n) => n + 1);
    p.then(done, done);
    return () => { live = false; };
  }, [p]);
  if (p.status === "fulfilled") last.current = { data: p.value };
  if (p.status === "rejected") last.current = { error: p.reason };
  return { ...last.current, retry: () => setP(track(load())) };
}
