// Settings › Keystore. Metadata only:
// values live in Cloudflare Secrets Store, GET /api/keystore never carries one, and a modal's password field is cleared as soon as it closes. Org model keys
// live in AI Gateway and personal keys in My model access; neither is listed here.
import { Suspense, useEffect, useRef, useState } from "react";
import { Await, Link, useAsyncError, useLoaderData, useRevalidator } from "react-router";
import { environmentsFor, flowsFor, get, list, postJson } from "./client.js";
import { Ic } from "./icons.jsx";
import { ago } from "./repos.jsx";
import { Bone, LoadingRegion, TableSkel, useShape } from "./skeleton.jsx";
import { Dialog, EmptyState, ErrorState, Tag, Frame, Loaded } from "./ui.jsx";
import "./styles/keystore.css";

const SCOPES = [["global", "org"], ["repo", "repo"], ["environment", "environment"], ["flow", "flow"]];
const KIND = { global: "api_key", repo: "api_key", environment: "environment_secret", flow: "flow_secret" };
const PROVIDER_KEYS = "https://dash.cloudflare.com/?to=/:account/ai/ai-gateway";
const scopeLabel = (scope) => SCOPES.find(([v]) => v === scope)?.[1] ?? scope;
const appliesTo = (s) => (s.scope === "global" ? "all repos" : [s.repo, s.environment ?? s.flow].filter(Boolean).join(" › "));

// Not awaited, so the page head shows at once and the cards move through loading, then ready or error. Usage is
// awaited apart: the secrets draw without it, and its line holds a bone until it answers.
export const keystoreLoader = () => {
  const data = get("/api/keystore");
  const usage = get("/api/keystore/usage");
  for (const p of [data, usage]) p.catch(() => {}); // <Await> renders the rejection
  return { data, usage };
};

// Loading, empty and error keep the toolbar's place, disabled.
const OffBar = () => <div className="tb"><div className="tb-in">
  <label className="q"><Ic name="search" /><input aria-label="Search secrets" placeholder="Search secrets" disabled /></label>
  <select aria-label="Scope" disabled><option>All scopes</option></select>
</div></div>;

const orgKeys = <div className="card"><div className="srow"><span className="act-i"><Ic name="key" /></span>
  <div><h3>Org model keys</h3><p>Provider keys for the org live in AI Gateway, not here. Personal keys live in <Link to="/me/models">My model access</Link>.</p></div>
  <a className="btn btn-secondary end" href={PROVIDER_KEYS} target="_blank" rel="noreferrer">AI Gateway › Provider Keys<Ic name="ur" /></a></div></div>;

const NoSecrets = ({ action }) => <div className="card"><EmptyState icon="key" title="No secrets stored" action={action}>Values live in Cloudflare Secrets Store and are never shown after saving.</EmptyState></div>;

function Skel() {
  const secrets = useShape("keystore//secrets", 6);
  return <LoadingRegion page="Keystore" busy>
    <p className="meta"><Bone w={320} h="1lh" /></p>
    <OffBar />
    {secrets.n ? <div className="card tscroll"><TableSkel cols={[["Name", 140], ["Scope"], ["Applies to"], ["Last used"], ["Changed by"], [""]]} rows={secrets.n} widths={secrets.widths} /></div>
      : <NoSecrets action={<button type="button" className="btn btn-secondary" disabled><Ic name="plus" />Add secret</button>} />}
    {orgKeys}
  </LoadingRegion>;
}

const SAME = ["scope", "repo", "environment", "flow"];

// Add secret: the target selects follow the scope, and a name already saved at that scope and target can't be added
// again (POST /api/keystore refuses it too). Its fields start over each time it opens (seed).
function AddSecret({ ref, seed, prefill, secrets, onClose }) {
  const blank = { name: prefill, scope: "environment", repo: "", target: "" };
  const [f, setF] = useState(blank);
  const [opened, setOpened] = useState(seed);
  if (opened !== seed) { setOpened(seed); setF(blank); }
  const [repos, setRepos] = useState(null);
  const [targets, setTargets] = useState({}); // "<scope> <repo>" → its environment or flow names
  const [failed, setFailed] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value, ...(k === "scope" || k === "repo" ? { target: "" } : {}) });
  const picks = f.scope === "environment" || f.scope === "flow";
  const key = `${f.scope} ${f.repo}`;
  useEffect(() => {
    if (seed && !repos) list("/api/repos").then(setRepos, (e) => setFailed(e.message));
  }, [seed, repos]);
  useEffect(() => {
    const repo = repos?.find((r) => r.name === f.repo);
    if (!picks || !repo || targets[key]) return;
    (f.scope === "environment" ? environmentsFor(repo.name).then((es) => es.map((e) => e.name)) : flowsFor(repo, repo.default_branch).then((x) => x.list.map((f) => f.flow)))
      .then((names) => setTargets((t) => ({ ...t, [key]: names })), (e) => setFailed(e.message));
  }, [picks, repos, f.repo, f.scope, key, targets]);
  const at = { scope: f.scope, repo: f.scope === "global" ? null : f.repo, environment: f.scope === "environment" ? f.target : null, flow: f.scope === "flow" ? f.target : null };
  const taken = secrets.some((s) => s.name === f.name && SAME.every((k) => s[k] === at[k]));
  const names = targets[key];
  return <Dialog ref={ref} title="Add secret" action="Add secret" disabled={taken} onClose={onClose}>
    <div className="form flush">
      <label className="field"><span>Name</span>
        <input className="input w mono" name="name" value={f.name} onChange={set("name")} aria-invalid={taken} aria-describedby="ks-name-hint" required />
        <span id="ks-name-hint" className={taken ? "ks-taken" : undefined}>{taken ? `${f.name} already exists for ${appliesTo(at)}. Replace it from its row, or pick another name.` : "Flows read it by this name."}</span></label>
      <label className="field"><span>Scope</span><select className="input w" name="scope" value={f.scope} onChange={set("scope")}>
        {SCOPES.map(([s, l]) => <option key={s} value={s}>{l}</option>)}</select></label>
      <p className="ks-note"><Ic name="shield" /><span><b>Agents never receive Keystore secrets</b>, at any scope. Flow steps and deploys get them at run time; agent sandboxes don&apos;t.</span></p>
      {f.scope === "global" ? <p className="meta">Applies to all repos.</p>
        : <label className="field"><span>Repo</span><select className="input w" name="repo" value={f.repo} onChange={set("repo")} required>
          <option value="">{repos ? "Choose a repo" : "Loading repos…"}</option>{(repos ?? []).map((r) => <option key={r.name}>{r.name}</option>)}</select></label>}
      {picks && <label className="field"><span>{f.scope === "environment" ? "Environment" : "Flow"}</span>
        <select className="input w" name={f.scope} value={f.target} onChange={set("target")} disabled={!names} required>
          <option value="">{!f.repo ? "Choose a repo first" : !names ? "Loading…" : names.length ? `Choose a ${f.scope}` : `No ${f.scope}s in ${f.repo}`}</option>
          {(names ?? []).map((n) => <option key={n}>{n}</option>)}</select></label>}
      {failed && <p className="meta" role="alert">Couldn&apos;t load targets: {failed}</p>}
      <label className="field"><span>Value</span><input className="input w" name="value" type="password" autoComplete="new-password" required /><span>Never shown again after saving.</span></label>
    </div>
  </Dialog>;
}

const intro = <div><h1>Keystore</h1><p>Stored secrets and where they apply. Values are never shown after saving.</p></div>;

// The route's hydrate fallback: the real head, its action disabled, then the skeleton.
export const KeystoreLoading = () => <Frame head={<>{intro}
  <div className="acts"><button type="button" className="btn btn-primary" disabled><Ic name="plus" />Add secret</button></div></>}><Skel /></Frame>;

export function Keystore() {
  const { data, usage } = useLoaderData();
  const { revalidate } = useRevalidator();
  const [err, setErr] = useState(null);
  const [target, setTarget] = useState(null);
  const [prefill, setPrefill] = useState("");
  const [seed, setSeed] = useState(0);
  const [known, setKnown] = useState([]); // the saved secrets, for the Add dialog's name check
  useEffect(() => { data.then((k) => setKnown(k.secrets), () => {}); }, [data]);
  const add = useRef(null), replace = useRef(null), remove = useRef(null);
  const open = (dlg) => { dlg.current.returnValue = ""; dlg.current.showModal(); };
  // A modal's form is sent on its primary action, then reset so the value never stays in the page.
  const onClose = (send) => (e) => {
    const form = e.currentTarget.querySelector("form");
    const fields = Object.fromEntries(new FormData(form));
    form.reset();
    if (e.currentTarget.returnValue !== "ok") return;
    setErr(null);
    send(fields).then(revalidate, (x) => setErr(x.message));
  };
  const onAdd = (name = "") => { setPrefill(name); setSeed((n) => n + 1); open(add); };
  const onReplace = (s) => { setTarget(s); open(replace); };
  const onRemove = (s) => { setTarget(s); open(remove); };
  // Secrets Store deletes are unrecoverable, so the DELETE waits for the confirm.
  const onRemoveClose = (e) => {
    if (e.currentTarget.returnValue !== "ok") return;
    setErr(null);
    postJson(`/api/keystore/${encodeURIComponent(target.id)}`, undefined, "DELETE").then(revalidate, (x) => setErr(x.message));
  };
  return <Frame head={<>
      {intro}
      <div className="acts"><Loaded data={data} reason="Available once the secrets list loads"><button type="button" className="btn btn-primary" onClick={() => onAdd()}><Ic name="plus" />Add secret</button></Loaded></div>
    </>}>
    {err && <p className="meta" role="alert">{err}</p>}
    <Suspense fallback={<Skel />}>
      <Await resolve={data} errorElement={<Failed />}>{({ secrets, wanted }) => <>
        <p className="meta"><Suspense fallback={<Bone w={320} h="1lh" />}><Await resolve={usage} errorElement={<UsageFailed />}>
          {(u) => `Secrets Store: ${u.used} of ${u.limit} secrets used (beta limit per account)`}</Await></Suspense></p>
        <Secrets secrets={secrets} onAdd={() => onAdd()} onReplace={onReplace} onRemove={onRemove} />
        {wanted.length > 0 && <div className="card">
          <div className="card-h"><h3>Wanted by flows</h3></div>
          <div className="tscroll"><table className="tbl"><tbody>{wanted.map((w) => <tr key={`${w.name} ${w.repo} ${w.flow} ${w.step}`}>
            <td className="mono">{w.name}</td>
            <td><Link to={`/${encodeURIComponent(w.repo)}/flows?flow=${encodeURIComponent(w.flow)}&run=${encodeURIComponent(w.run_id)}`}>{w.repo} › {w.flow} › {w.step}</Link></td>
            <td className="num"><button type="button" className="btn btn-secondary btn-sm" onClick={() => onAdd(w.name)}>Add</button></td>
          </tr>)}</tbody></table></div>
        </div>}
        {orgKeys}
      </>}</Await>
    </Suspense>
    <AddSecret ref={add} seed={seed} prefill={prefill} secrets={known} onClose={onClose(({ scope, ...f }) => postJson("/api/keystore", { ...f, scope, kind: KIND[scope] }))} />
    <Dialog ref={replace} title={`Replace ${target?.name ?? ""}`} action="Replace" onClose={onClose(({ value }) => postJson(`/api/keystore/${encodeURIComponent(target.id)}/rotate`, { value }))}>
      <div className="form flush">
        <p className="meta">Scope <Tag>{target && scopeLabel(target.scope)}</Tag> {target && appliesTo(target)}</p>
        <label className="field"><span>New value</span><input className="input w" name="value" type="password" autoComplete="new-password" required />
          <span>Rotates now. Runs that already started keep the old value.</span></label>
      </div>
    </Dialog>
    <Dialog ref={remove} title={`Remove ${target?.name ?? ""}?`} action="Remove" onClose={onRemoveClose}>
      <p>Applies to {target && appliesTo(target)}. It is deleted from Secrets Store and can't be undone.</p>
    </Dialog>
  </Frame>;
}

function Failed() {
  const { revalidate } = useRevalidator();
  return <><OffBar /><div className="card"><ErrorState message={`Couldn't load the keystore: ${useAsyncError().message}`} onRetry={revalidate} /></div></>;
}

const UsageFailed = () => `Couldn't load Secrets Store usage: ${useAsyncError().message}`;

function Secrets({ secrets, onAdd, onReplace, onRemove }) {
  const [q, setQ] = useState("");
  const [scope, setScope] = useState("");
  const { ref } = useShape("keystore//secrets", 6, secrets.length);
  if (!secrets.length) return <><OffBar /><NoSecrets action={<button type="button" className="btn btn-secondary" onClick={onAdd}><Ic name="plus" />Add secret</button>} /></>;
  const needle = q.trim().toLowerCase();
  const shown = secrets.filter((s) => (!scope || s.scope === scope) && `${s.name} ${appliesTo(s)}`.toLowerCase().includes(needle));
  return <>
    <div className="tb"><div className="tb-in">
      <label className="q"><Ic name="search" /><input aria-label="Search secrets" placeholder="Search secrets" value={q} onChange={(e) => setQ(e.target.value)} /></label>
      <select aria-label="Scope" value={scope} onChange={(e) => setScope(e.target.value)}>
        <option value="">All scopes</option>{SCOPES.map(([s, l]) => <option key={s} value={s}>{l}</option>)}</select>
    </div></div>
    <div className="card tscroll"><table className="tbl" ref={ref}>
      <thead><tr><th>Name</th><th>Scope</th><th>Applies to</th><th>Last used</th><th>Changed by</th><th /></tr></thead>
      <tbody>{shown.map((s) => <tr key={s.id}>
        <td className="mono">{s.name}</td>
        <td><Tag>{scopeLabel(s.scope)}</Tag></td>
        <td>{appliesTo(s)}</td>
        <td className="meta">{s.last_used ? `${ago(s.last_used)} ago` : "never"}</td>
        <td>{s.changed_by ? s.changed_by.split("@")[0] : "—"} <span className="meta">· {ago(s.rotated_at ?? s.created_at)} ago</span></td>
        <td className="num">
          <span className="meta">set ••••</span>{" "}
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => onReplace(s)}>Replace</button>{" "}
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => onRemove(s)}>Remove</button>{" "}
          <button type="button" className="ib" aria-label={`More for ${s.name}`} popoverTarget={`ks-${s.id}`} style={{ anchorName: `--ks-${s.id}` }}><Ic name="more" /></button>
          <div popover="auto" id={`ks-${s.id}`} className="menu" style={{ positionAnchor: `--ks-${s.id}` }}>
            <p className="meta">Kind <b className="mono">{s.kind}</b></p><p className="meta">Owner <b>{s.owner}</b></p>
            <p className="meta">Expires <b>{s.expires_at ? s.expires_at.slice(0, 10) : "never"}</b></p>
          </div>
        </td>
      </tr>)}</tbody>
    </table></div>
  </>;
}
