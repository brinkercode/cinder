import { useState } from "react";
import { giveBack, releaseLease, steer } from "./api/workspace.js";
import { ChangeId } from "./ui.jsx";
import { ChangeWho } from "./who.jsx";
import "./styles/workspace-strip.css";

// The agent's workspace controls above the grid: who is editing what, with Message agent and Release lease.
// driving mirrors the change's driver; setDriving keeps Code's editability in step with release and give back.
export function WorkspaceStrip({ ws, symbols, driving, setDriving }) {
  const [note, setNote] = useState(null); // { text, error }
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const run = (fn, ok, fail) => async () => {
    setBusy(true);
    try { await fn(); setNote({ text: ok }); } catch (e) { setNote({ text: `${fail}: ${e.message.replace(/^.*→ \d+ /, "")}`, error: true }); }
    setBusy(false);
  };
  const release = run(async () => { await releaseLease(ws.id); setDriving(true); },
    "Lease released. The agent is paused; give it back when you're done.", "Couldn't release the lease");
  const back = run(async () => { await giveBack(ws.id); setDriving(false); },
    "Given back. The agent re-requests its lease and continues.", "Couldn't give it back");
  const send = async (e) => {
    e.preventDefault();
    const text = msg.trim();
    if (!text) return;
    setBusy(true);
    try { await steer(ws.id, text); setNote({ text: `Sent “${text}”. The agent reads it before its next step.` }); setMsg(""); }
    catch (err) { setNote({ text: `Couldn't send: ${err.message.replace(/^.*→ \d+ /, "")}`, error: true }); }
    setBusy(false);
  };
  return (
    <section className="panel pad w4-ws" aria-label="Workspace controls">
      <div className="row">
        <span><ChangeWho change={ws} /> in <code><ChangeId id={ws.id} label={ws.key} /></code> · editing “{ws.intent}”</span>
        <span className="meta">{symbols.length ? <>leases {symbols.map((s) => <code key={s}>{s}</code>)}</> : "holds no lease"}</span>
        {driving
          ? <button type="button" className="btn btn-secondary btn-sm end" disabled={busy} onClick={back}>Give it back</button>
          : <button type="button" className="btn btn-secondary btn-sm end" disabled={busy} onClick={release}>Release lease</button>}
      </div>
      <form className="row" onSubmit={send}>
        <input className="input w" aria-label="Message agent" placeholder="Message agent" value={msg} onChange={(e) => setMsg(e.target.value)} />
        <button type="submit" className="btn btn-secondary btn-sm" disabled={busy || !msg.trim()}>Message agent</button>
      </form>
      {note && <p className="meta" role={note.error ? "alert" : "status"}>{note.text}</p>}
    </section>
  );
}
