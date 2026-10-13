// Labels and priority on an intent or a change: chips that × removes, + Add (a known label or a new one) and P0–P3.
import { useState } from "react";
import { Ic } from "./icons.jsx";
import { Popover } from "./ui.jsx";
import "./styles/labels.css";

export const PRIORITIES = ["P0", "P1", "P2", "P3"];

// save(body) PATCHes {labels} or {priority} and settles once it is stored; known: labels the picker offers.
export function LabelsEdit({ labels, priority, known = [], save }) {
  const [q, setQ] = useState("");
  const [err, setErr] = useState(null);
  const run = async (body) => {
    setErr(null);
    try { await save(body); } catch (e) { setErr(e.message); }
  };
  const pick = (l, e) => {
    setQ("");
    e.target.closest?.("[popover]")?.hidePopover();
    if (l && !labels.includes(l)) run({ labels: [...labels, l] });
  };
  const offer = known.filter((l) => !labels.includes(l) && l.toLowerCase().includes(q.trim().toLowerCase()));
  return <div className="lbl-edit">
    <div className="pl2">Labels</div>
    <div className="row">
      {labels.map((l) => <span className="tag" key={l}>{l}
        <button type="button" className="iconbtn" aria-label={`Remove ${l}`} onClick={() => run({ labels: labels.filter((x) => x !== l) })}><Ic name="x" /></button></span>)}
      {!labels.length && <span className="subtle">No labels</span>}
      <Popover label={<><Ic name="plus" />Add</>}><div className="lbl-menu">
        <input className="input" aria-label="Find or create a label" placeholder="Find or create a label" value={q} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && pick(q.trim(), e)} />
        {offer.map((l) => <button type="button" key={l} onClick={(e) => pick(l, e)}><span className="tag">{l}</span></button>)}
        {!offer.length && <p className="subtle">{q.trim() ? "Press Enter to create it" : "Type a label"}</p>}
      </div></Popover>
    </div>
    <label className="field"><span>Priority</span>
      <select className="input" aria-label="Priority" value={priority ?? ""} onChange={(e) => run({ priority: e.target.value })}>
        <option value="" disabled>None</option>{PRIORITIES.map((p) => <option key={p}>{p}</option>)}
      </select></label>
    <p className="subtle">Higher priority queues first and is picked up first by agents.</p>
    {err && <p className="err-line" role="alert">{err}</p>}
  </div>;
}
