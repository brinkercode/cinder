import { useEffect, useEffectEvent, useState } from "react";
import { PiLockSimple } from "react-icons/pi";
import { cancelHandover, getHandover, requestHandover } from "./api/handover.js";
import { ChangeId } from "./ui.jsx";
import "./styles/lease-prompt.css";

// Shown above the editor's bottom bar when a submitted edit touches a symbol another change holds. lease is the
// holder's lease on the symbol (symbol, from, to, holder, expires_at, collision). onGo(choice) opens the change: "stack",
// "parallel", or "" once the holder handed the lease over; onKeep goes back to editing.
export function LeasePrompt({ lease, holder, intent, onGo, onKeep }) {
  const [pick, setPick] = useState("stack");
  const [req, setReq] = useState(null);
  const [declined, setDeclined] = useState(null);
  const [error, setError] = useState(null);
  const go = useEffectEvent(onGo);
  const id = <ChangeId id={lease.holder} />;
  const p = lease.collision;

  // Waiting for the holder: it hands over, declines, or the lease expires and the edit stacks.
  useEffect(() => {
    if (!req) return;
    const tick = async () => {
      if (Date.now() >= Date.parse(req.expires_at)) return end("stack");
      // A failed poll keeps waiting: the expiry above still ends the wait.
      const r = await getHandover(lease.holder, req.id).catch(() => null);
      if (r?.status === "accepted") end("");
      else if (r?.status === "declined") { setReq(null); setDeclined(r.reason); }
    };
    const t = setInterval(tick, 1000);
    const end = (choice) => { clearInterval(t); go(choice); };
    return () => clearInterval(t);
  }, [req, lease.holder]);

  const send = () => requestHandover(lease.holder, { symbol: `${lease.file}#${lease.symbol}`, intent }, lease.expires_at).then(setReq, (e) => setError(e.message));
  const cancel = () => cancelHandover(lease.holder, req.id).then(() => setReq(null), (e) => setError(e.message));
  const options = [
    ["stack", <>Stack on {id}</>, "Waits, then rebases after it merges."],
    ["parallel", "Run in parallel", `Both go ahead. ${p ? `p(collision) ${Math.round(p.p * 100)}%${p.judge.trusted ? "" : ` · untrusted: ${p.judge.count} outcomes`}` : "p(collision) not judged yet."}`],
    ["send", "Send to the lease holder", "Asks it to hand over. You stack if it doesn't answer before the lease expires."],
  ];
  return (
    <section className="lp" aria-label="Lease held">
      <p className="lp-head"><PiLockSimple /><span><code>{lease.symbol}</code> lines {lease.from}–{lease.to} is leased by <b>{holder}</b>
        {lease.expires_at ? <> · lease expires {new Date(lease.expires_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</> : null}</span></p>
      {req ? (
        <p role="status">Waiting for {id} to answer. You stack on it if it doesn&apos;t before the lease expires.
          <button type="button" className="btn btn-secondary btn-sm" onClick={cancel}>Cancel request</button></p>
      ) : declined ? (
        <>
          <p role="alert">{id} declined: {declined}</p>
          <div className="lp-bar"><button type="button" className="btn btn-primary" onClick={() => onGo("stack")}>Stack</button>
            <button type="button" className="btn btn-secondary" onClick={onKeep}>Keep editing</button></div>
        </>
      ) : (
        <>
          <fieldset className="lp-opts"><legend>What should your change do?</legend>
            {options.map(([v, title, sub]) => <label key={v} className="opt"><input type="radio" name="lease-choice" value={v} checked={pick === v} onChange={() => setPick(v)} />
              <span><b>{title}</b><small>{sub}</small></span></label>)}
          </fieldset>
          <div className="lp-bar"><button type="button" className="btn btn-primary" onClick={() => (pick === "send" ? send() : onGo(pick))}>Continue</button>
            <button type="button" className="btn btn-secondary" onClick={onKeep}>Back to editing</button></div>
        </>
      )}
      {error && <p className="meta" role="alert">{error}</p>}
    </section>
  );
}
