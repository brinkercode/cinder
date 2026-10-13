import { useState } from "react";
import { useNavigate } from "react-router";
import { postJson } from "./client.js";

// Native dialog, open while mounted: unmounting closes it and drops what it held.
export const Modal = ({ title, onClose, foot, children }) => (
  <dialog className="dlg" ref={(d) => { if (d && !d.open) d.showModal(); }} onClose={onClose} aria-label={title}>
    <div className="panel-head"><h2>{title}</h2></div>
    <div className="pad form flush">{children}</div>
    <div className="dlg-foot"><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>{foot}</div>
  </dialog>
);

// Typed-name confirmation; also used by Repositories › Archived.
export function DeleteRepo({ name, onClose }) {
  const [typed, setTyped] = useState(""), [err, setErr] = useState(null);
  const navigate = useNavigate();
  const del = () => postJson(`/api/repos/${encodeURIComponent(name)}`, { confirm: typed }, "DELETE").then(() => navigate("/", { state: { deleted: name } }), (e) => setErr(e.message));
  return <Modal title={`Delete ${name}?`} onClose={onClose} foot={<button type="button" className="btn btn-danger" disabled={typed !== name} onClick={del}>Delete</button>}>
    <p>Deletes the repo, its history, changes, policy and webhooks. This can&apos;t be undone.</p>
    <label className="field"><span>Type <b>{name}</b> to confirm</span><input className="input mono w" aria-label="Repo name to confirm" value={typed} onChange={(e) => setTyped(e.target.value)} /></label>
    {err && <p className="meta" role="alert">{err}</p>}
  </Modal>;
}
