// The intent drawer on Changes: an intent's body, labels and target, who writes it, and Close intent / Start.
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { issueFor, suggestAgents } from "./api/work.js";
import { repoPost } from "./client.js";
import { Ic } from "./icons.jsx";
import { Pri } from "./who.jsx";
import { Tag, Untrusted } from "./ui.jsx";

// it: the intent's board item; can: the caller has repo.write; onStart(mode) claims it for "agent" or "race".
export function IntentDrawer({ repo, base, target, it, can, why, onStart, onClosed, onClose, children }) {
  const navigate = useNavigate();
  const [who, setWho] = useState("agent");
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  // Prefetched on open, so Who writes it names the best agent before Start.
  useEffect(() => {
    Promise.all([issueFor(repo, it.n), suggestAgents(repo, it.n)]).then(setData, (e) => setErr(e.message));
  }, [repo, it.n]);
  const [issue, [best, next] = []] = data ?? [];
  const start = () => (who === "me" ? navigate(`${base}/changes/new?head=&issue=${it.n}`) : onStart(who));
  const close = () => repoPost(repo, `/issues/${it.n}`, { state: "closed" }, "PATCH").then(onClosed, (e) => setErr(e.message));
  const pick = (v, off, title, sub, end) => <label className="row">
    <input type="radio" name="who" value={v} checked={who === v} disabled={off} onChange={() => setWho(v)} />
    <span><b>{title}</b><br /><span className="meta">{sub}</span></span><span className="end">{end}</span></label>;
  return <dialog ref={(d) => d && !d.open && d.showModal()} className="modal drawer-r" aria-label={`#${it.n} ${it.title}`} onClose={onClose}>
    <div className="modal-h"><span className="mono subtle">#{it.n}</span><h2>{it.title}</h2>
      <button type="button" className="iconbtn" aria-label="Close" onClick={onClose}><Ic name="x" /></button></div>
    <div className="idet"><div className="stack">
      <div className="row"><Pri p={it.priority} />{it.labels.map((l) => <Tag key={l}>{l}</Tag>)}<span className="meta">targets <span className="mono">{target}</span></span></div>
      <p>{issue?.body || <span className="subtle">No description.</span>}</p>
      <fieldset className="stack"><legend>Who writes it</legend>
        {pick("agent", !best, best?.agent ?? "No agent version yet", "The best agent on this repo",
          best && (best.trusted && best.p_merge !== null ? <span className="pill">p {best.p_merge.toFixed(2)}</span> : <Untrusted n={best.n} />))}
        {pick("race", !next, "Race two agents", next ? `${best.agent} vs ${next.agent}. The verifier keeps the better one.` : "Needs two agent versions",
          next && !next.trusted && <Untrusted n={next.n} />)}
        {pick("me", false, "I'll write it", "Opens a change you drive, on your branch")}
      </fieldset>
      {children}
      {err && <p className="err-line" role="alert">{err}</p>}
      {!can && <p className="meta">{why}</p>}
      <div className="row"><button type="button" className="btn btn-secondary" disabled={!can} title={can ? undefined : why} onClick={close}>Close intent</button>
        <button type="button" className="btn btn-primary end" disabled={!can && who !== "me"} title={can ? undefined : why} onClick={start}>Start</button></div>
    </div></div>
  </dialog>;
}
