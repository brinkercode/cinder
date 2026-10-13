// Settings › Access & people › Demo data: reset and reseed the deployment, or start the demo scenario, from the app.
// Shown to an owner where the seed routes are open (CINDER_ENV=nonprod).
import { useEffect, useRef, useState } from "react";
import { seedRun, startSeed } from "./api/demo-data.js";
import { getMe } from "./client.js";
import { Dialog } from "./ui.jsx";

const DONE = { seed: "Reseeded: the demo repos, people, agents and pools are back.", demo: "Demo started: pulse has its twelve demo intents." };

export function DemoData() {
  const [me, setMe] = useState(null), [run, setRun] = useState(null);
  const confirm = useRef(null);
  // A failed /api/me leaves the card hidden: it is only for a known owner.
  useEffect(() => { getMe().then(setMe, () => {}); }, []);
  if (!me?.owner || !me.nonprod) return null;
  const start = async (kind) => {
    setRun({ kind, status: "running", step: null });
    try {
      const { id } = await startSeed(kind);
      let r;
      while ((r = await seedRun(id)).status === "running") {
        setRun({ kind, ...r });
        await new Promise((ok) => setTimeout(ok, 2000));
      }
      setRun({ kind, ...r });
    } catch (e) {
      setRun({ kind, status: "failed", error: e.message });
    }
  };
  const busy = run?.status === "running";
  return <div className="card" id="demo-data"><div className="card-h"><h3>Demo data</h3></div>
    <div className="srow"><div><h3>Reset and reseed</h3><p>Empties this deployment, then seeds the demo repos, people, agents and pools again.</p></div>
      <button type="button" className="btn btn-danger end" disabled={busy} onClick={() => { confirm.current.returnValue = ""; confirm.current.showModal(); }}>Reset and reseed…</button></div>
    <div className="srow"><div><h3>Start the demo scenario</h3><p>Adds the pulse repo and files its twelve demo intents once a worker pool has indexed it.</p></div>
      <button type="button" className="btn btn-secondary end" disabled={busy} onClick={() => start("demo")}>Start the demo scenario</button></div>
    {run && <p className="card-b meta" role="status">{run.status === "running" ? `Running: ${run.step ?? "starting"}…`
      : run.status === "done" ? DONE[run.kind] : `Failed${run.step ? ` at ${run.step}` : ""}: ${run.error}`}</p>}
    <Dialog ref={confirm} title="Reset and reseed?" action="Reset and reseed" onClose={(e) => { if (e.currentTarget.returnValue === "ok") start("seed"); }}>
      <p>Erases every repo and its history, change, issue, release, wiki page, person, agent version, pool, log, model key and keystore secret.
        The owner, Access sign-in and the database schema stay. The seed then adds the demo data again.</p>
    </Dialog>
  </div>;
}
