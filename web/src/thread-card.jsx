import { useState } from "react";
import { useRevalidator } from "react-router";
import { threadWrite } from "./api/threads.js";
import { ago } from "./changes.jsx";
import { Who } from "./who.jsx";
import "./styles/threads.css";

// One review thread on the Conversation tab. A resolved thread is a closed `details` row; each write re-runs the loader.
export function ThreadCard({ id, t, ro }) {
  const { revalidate } = useRevalidator();
  const [reply, setReply] = useState("");
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const send = async (action, body, then) => {
    if (busy) return;
    setBusy(true); setErr(null);
    try { await threadWrite(id, t.id, action, body); then?.(); revalidate(); } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  const first = t.comments[0];
  const list = t.comments.map((c, i) => <div className="th-c" key={i}><Who a={c.actor} /><span className="subtle">{ago(c.at)} ago</span><p>{c.body}</p></div>);
  const reopen = <button type="button" className="btn btn-ghost end" disabled={ro || busy} onClick={(e) => { e.preventDefault(); send("reopen"); }}>Reopen</button>;
  if (t.resolved) {
    return <details className="cmt-card th"><summary className="cmt-h">Resolved by {t.state_by} · {t.comments.length} {t.comments.length === 1 ? "comment" : "comments"}{reopen}</summary>
      <div className="cmt-b">{list}{t.applied_sha && <p className="subtle">Applied in <code>{t.applied_sha.slice(0, 7)}</code></p>}</div>
      {err && <p className="err-line" role="alert">{err}</p>}</details>;
  }
  return <div className="cmt-card th">
    <div className="cmt-h"><Who a={first.actor} /><span className="subtle">commented · {ago(first.at)} ago</span>
      <span className="end mono">{t.path ? `${t.path}:${t.line}` : "On the change"}</span>{t.outdated && <span className="tag t-warn">outdated</span>}</div>
    <div className="cmt-b">{list}
      {t.suggestion && <div className="th-s">
        <code>− {t.suggestion.from}</code><code>+ {t.suggestion.to}</code>
        {t.applied_sha ? <span className="subtle">Applied in <code>{t.applied_sha.slice(0, 7)}</code></span>
          : <button type="button" className="btn btn-secondary" disabled={ro || busy || t.outdated} onClick={() => send("apply")}>Apply suggestion</button>}
      </div>}
    </div>
    {!ro && <>
      <textarea rows={2} aria-label="Reply" placeholder="Reply" value={reply} onChange={(e) => setReply(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && reply.trim()) { e.preventDefault(); send("comments", { body: reply }, () => setReply("")); } }} />
      {err && <p className="err-line" role="alert">{err}</p>}
      <div className="cmt-h"><span className="end" /><button type="button" className="btn btn-secondary" disabled={busy} onClick={() => send("resolve")}>Resolve</button></div>
    </>}
  </div>;
}
