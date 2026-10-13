// Automation › Workers: the managed Cloudflare
// pool, resized but never deleted, and bring-your-own pools with their runners' heartbeats. Settings › Keystore lists
// GET /api/workers, which never carries a token value or hash.
import { Suspense, useEffect, useRef, useState } from "react";
import { Await, useActionData, useAsyncError, useLoaderData, useRevalidator, useSubmit } from "react-router";
import { poolTokens } from "./api/pool-tokens.js";
import { ago } from "./changes.jsx";
import { invalidate, list, poolAct } from "./client.js";
import { Ic } from "./icons.jsx";
import { ListCardSkel, LoadingRegion, TableSkel, useShape } from "./skeleton.jsx";
import { Dot, ErrorState, Tag, Frame, Loaded } from "./ui.jsx";
import "./styles/workers.css";

// Cloudflare Containers instance types (POOL_SIZES): specs and what each suits.
const SIZES = { lite: ["1/16 vCPU · 256 MB · 2 GB disk", "Lint, small scripts"], basic: ["1/4 vCPU · 1 GB · 4 GB disk", "Most test suites"],
  "standard-2": ["1 vCPU · 6 GB · 12 GB disk", "Builds and agent runs"], "standard-4": ["4 vCPU · 12 GB · 20 GB disk", "Large monorepos"] };
const MAX_SANDBOXES = 64;
const WARM = [[0, "0s"], [60, "1m"], [300, "5m"], [900, "15m"]];
const PLACES = [["nearest", "Nearest to the repository"], ["weur", "Western Europe"], ["enam", "Eastern North America"], ["apac", "Asia Pacific"]];
const EGRESS = [["allowlist", "Allow list", "The hosts below, or the default registries and docs hosts when empty."], ["none", "None", "No outbound traffic beyond cinder."],
  ["open", "Open", "Any host."]];
const BLANK = { kind: "managed", name: "", labels: [], size: "standard-2", max_concurrent: 8, keep_warm_s: 60, placement: "nearest", cloud: "", region: "", egress: "allowlist", egress_allow: [], repos: "*" };

export const workersLoader = () => {
  const pools = Promise.all([list("/api/workers/pools"), list("/api/workers/byo-pools")]);
  pools.catch(() => {}); // <Await> renders the rejection; this only stops an unhandled-rejection report
  return { pools };
};

export async function workersAction({ request }) {
  const f = Object.fromEntries(await request.formData());
  try {
    if (f.intent === "undrain") await poolAct(`/pools/${encodeURIComponent(f.id)}/undrain`, {});
    return { ok: true };
  } catch (e) {
    return { error: e.message };
  }
}

const Pill = ({ tone, children }) => <span className="pill"><Dot tone={tone} />{children}</span>;

const EditBtn = ({ onEdit }) => <button type="button" className="btn btn-secondary" onClick={onEdit}><Ic name="edit" />Edit</button>;

function Managed({ p, onEdit }) {
  const submit = useSubmit();
  return <div className="lc">
    <div className="lc-m"><span className="lc-ico"><Ic name="cpu" /></span>
      <div><div className="lc-t">Managed · {p.name}{p.default && <Tag>default</Tag>}</div>
        <div className="lc-s">One sandbox per run, destroyed afterwards. Credentials are injected from outside the sandbox and never written to disk.</div></div>
      <span className="lc-time">{p.draining ? <><Pill tone="warn">draining</Pill>
        <button type="button" className="btn btn-secondary" onClick={() => submit({ intent: "undrain", id: p.id }, { method: "post" })}>Resume</button></>
        : p.workers ? <Pill tone={p.online ? "ok" : "bad"}>{p.online} of {p.workers} online</Pill> : <Pill tone="off">Idle, scales on demand</Pill>}</span><EditBtn onEdit={onEdit} /></div>
    <div className="lc-f"><span>Size <b>{p.size}</b></span>
      <span>Runs per hour <b>{p.runs_per_hour}</b></span>
      <span>Median start <b>{p.median_start_s === null ? "none yet" : `${p.median_start_s}s`}</b></span></div>
  </div>;
}

function Byo({ p, onEdit }) {
  return <div className="lc">
  <div className="lc-m"><span className="lc-ico"><Ic name="term" /></span>
    <div><div className="lc-t">{p.name}<Tag>bring your own</Tag></div>
      <div className="lc-s">For builds that need more than 4 vCPU or 20 GB of disk, or a GPU. Runs anywhere, including other clouds.</div></div>
    <span className="lc-time">{p.online ? <Pill tone="ok">{p.online} of {p.members} online</Pill> : <Pill tone="bad">offline</Pill>}
</span><EditBtn onEdit={onEdit} /></div>
  <div className="lc-f"><span><Ic name="globe" />{[p.cloud, p.region].filter(Boolean).join(" ") || "anywhere"}</span>
    <span>Labels {p.labels.map((l) => <Tag key={l}>{l}</Tag>)}</span>
    <span className="r"><span>Heartbeat <b>{p.last_heartbeat_at ? `${ago(p.last_heartbeat_at)} ago` : "never"}</b></span></span></div>
</div>;
}

function Skel() {
  const { n } = useShape("workers//pools", 2);
  return <LoadingRegion page="Workers" busy>{Array.from({ length: n }, (_, i) => <ListCardSkel key={i} />)}</LoadingRegion>;
}

function Pools({ managed, byo, onEdit }) {
  useShape("workers//pools", 2, managed.length + byo.length);
  return <>{managed.map((p) => <Managed key={p.id} p={p} onEdit={() => onEdit(p, "managed")} />)}{byo.map((p) => <Byo key={p.id} p={p} onEdit={() => onEdit(p, "byo")} />)}</>;
}

function Failed() {
  const { revalidate } = useRevalidator();
  return <div className="card"><ErrorState message={`Couldn't load runner pools: ${useAsyncError().message}`} onRetry={revalidate} /></div>;
}

const intro = <div><h1>Workers<a className="docs" href="https://developers.cloudflare.com/sandbox/" target="_blank" rel="noreferrer">View docs</a></h1>
  <p>Where runs execute. Managed runs get a fresh sandbox each time.</p></div>;

// The route's hydrate fallback: the real head, its action disabled, then the skeleton.
export const WorkersLoading = () => <Frame head={<>{intro}
  <div className="acts"><button type="button" className="btn btn-primary" disabled><Ic name="plus" />Add worker pool</button></div></>}><Skel /></Frame>;

export function Workers() {
  const { pools } = useLoaderData();
  const result = useActionData();
  const [edit, setEdit] = useState(null); // {pool, kind}; pool null = a new pool
  return <Frame head={<>
      {intro}
      <div className="acts"><Loaded data={pools} reason="Available once the worker pools load"><button type="button" className="btn btn-primary" onClick={() => setEdit({ pool: null, kind: "managed" })}><Ic name="plus" />Add worker pool</button></Loaded></div>
    </>}>
      {result?.error && <p className="meta" role="alert">{result.error}</p>}
      <Suspense fallback={<Skel />}>
        <Await resolve={pools} errorElement={<Failed />}>{([managed, byo]) => <Pools managed={managed} byo={byo} onEdit={(pool, kind) => setEdit({ pool, kind })} />}</Await>
      </Suspense>
      {edit && <PoolModal key={edit.pool?.id ?? "new"} {...edit} onDone={() => setEdit(null)} />}
  </Frame>;
}

// Create or edit one pool. The draft lives only while the modal is open: Esc, Cancel and Close drop it (onClose).
// The list reloads on close, not before: a revalidation remounts the page, which would drop an open modal.
function PoolModal({ pool, kind, onDone }) {
  const { revalidate } = useRevalidator();
  const dlg = useRef(null), nameRef = useRef(null), changed = useRef(false);
  const [saved, setSaved] = useState(pool); // a BYO pool just created stays open on its registration step
  const [d, setD] = useState({ ...BLANK, ...pool, kind, cloud: pool?.cloud ?? "", region: pool?.region ?? "", allow: (pool?.egress_allow ?? []).join("\n") });
  const [err, setErr] = useState({});
  const [repos, setRepos] = useState(null);
  const [armed, setArmed] = useState(false);
  const set = (k) => (e) => setD({ ...d, [k]: e.target.value });
  const managed = d.kind === "managed", scoped = d.repos !== "*";
  useEffect(() => {
    if (scoped && !repos) list("/api/repos").then(setRepos, (e) => setErr({ form: `Couldn't load repositories: ${e.message}` }));
  }, [scoped, repos]);
  const open = (el) => { dlg.current = el; if (el && !el.open) { el.showModal(); nameRef.current.focus(); } };
  const close = () => dlg.current.close();
  const addLabel = (e) => {
    if (e.key !== "Enter" && e.key !== ",") return;
    e.preventDefault();
    const v = e.target.value.trim();
    if (v && !d.labels.includes(v)) setD({ ...d, labels: [...d.labels, v] });
    e.target.value = "";
  };
  const act = async (path, body, method) => {
    try { await poolAct(path, body, method); changed.current = true; close(); } catch (e) { setErr({ form: e.message }); }
  };
  const save = async (e) => {
    e.preventDefault();
    const name = d.name.trim();
    if (!name) return setErr({ name: "Give the pool a name." });
    if (scoped && !d.repos.length) return setErr({ form: "Pick at least one repository, or allow all." });
    const shared = { labels: d.labels, egress: d.egress, egress_allow: d.allow.split(/[\s,]+/).filter(Boolean), repos: d.repos };
    const id = saved && encodeURIComponent(saved.id);
    try {
      if (managed) {
        const body = { ...shared, size: d.size, max_concurrent: d.max_concurrent, keep_warm_s: d.keep_warm_s, placement: d.placement };
        // The worker cap (max) is at most 20; sandboxes past it queue.
        // A refused PUT leaves the pool created: keep it so a retry only PUTs.
        const made = saved ?? await poolAct("/pools", { name, size: d.size, max: Math.min(d.max_concurrent, 20) });
        if (made && !saved) { changed.current = true; setSaved(made); }
        if (made) await poolAct(`/pools/${encodeURIComponent(made.id)}`, body, "PUT");
      } else {
        const body = { ...shared, name, cloud: d.cloud.trim() || null, region: d.region.trim() || null };
        const made = await poolAct(saved ? `/byo-pools/${id}` : "/byo-pools", body, saved ? "PUT" : "POST");
        changed.current = true;
        if (!saved && made) return setSaved(made);
      }
      changed.current = true;
      close();
    } catch (x) {
      setErr(x.code === "name_taken" ? { name: `A pool named ${name} already exists.` } : { form: x.message });
    }
  };
  return <dialog className="dlg wm" ref={open} aria-label={saved ? `Edit ${saved.name}` : "Add worker pool"}
    onClose={() => { if (changed.current) revalidate(); onDone(); }}>
    <form onSubmit={save}>
      <div className="modal-h"><Ic name={managed ? "cpu" : "term"} /><h2>{saved ? `Edit ${saved.name}` : "Add worker pool"}</h2>
        <button type="button" className="iconbtn" aria-label="Close" onClick={close}><Ic name="x" /></button></div>
      <div className="wm-b">
        {!saved && <div className="kc-g" role="radiogroup" aria-label="Kind">{[["managed", "cpu", "Managed", "Cloudflare Containers. A fresh sandbox per run; scales to zero."],
          ["byo", "term", "Bring your own", "Your machines, any cloud. Workers dial out; no inbound ports."]].map(([k, i, t, s]) =>
          <label key={k} className={`kc${d.kind === k ? " on" : ""}`}><input type="radio" name="kind" value={k} checked={d.kind === k} onChange={() => setD({ ...d, kind: k })} />
            <span className="kc-i"><Ic name={i} /></span><span><b>{t}</b><small>{s}</small></span></label>)}</div>}
        <section className="wm-s"><h3>Basics</h3><div className="grid2">
          <label className="field"><span>Name</span><input ref={nameRef} className="input mono" name="name" required value={d.name} onChange={set("name")}
            disabled={Boolean(saved) && managed} aria-invalid={Boolean(err.name)} aria-describedby="wm-nerr" />
            <span id="wm-nerr" className="wm-err" role="alert">{err.name}</span></label>
          <div className="field"><span>Labels</span><div className="chips">{d.labels.map((l) => <span key={l} className="pill">{l}
            <button type="button" className="iconbtn" aria-label={`Remove ${l}`} onClick={() => setD({ ...d, labels: d.labels.filter((x) => x !== l) })}><Ic name="x" /></button></span>)}
            <input aria-label="Add a label" placeholder={d.labels.length ? "" : "gpu, large-disk"} onKeyDown={addLabel} /></div>
            <small className="meta">Steps pick a pool with <code>runs-on: [labels]</code>. Enter or comma adds a label.</small></div>
        </div></section>
        {managed ? <>
          <section className="wm-s"><h3>Instance type</h3><div className="sz-g">{Object.entries(SIZES).map(([k, [spec, use]]) =>
            <label key={k} className={`sz${d.size === k ? " on" : ""}`}><input type="radio" name="size" value={k} checked={d.size === k} onChange={set("size")} />
              <b className="mono">{k}</b><span>{spec}</span><small>{use}</small></label>)}</div>
            {saved?.workers > 0 && d.size !== saved.size && <p className="meta" role="note">{saved.workers} running {saved.workers === 1 ? "worker" : "workers"} will
              finish {saved.workers === 1 ? "its" : "their"} current job and restart on {d.size}.</p>}</section>
          <section className="wm-s"><h3>Scaling</h3><div className="grid2">
            <label className="field"><span>Max sandboxes at once</span><span className="rng"><input type="range" min="1" max={MAX_SANDBOXES} value={d.max_concurrent}
              onChange={(e) => setD({ ...d, max_concurrent: Number(e.target.value) })} /><output className="mono">{d.max_concurrent}</output></span>
              <small className="meta">Runs past this queue. Idle pools cost nothing.</small></label>
            <label className="field"><span>Keep warm after a run</span><select className="input" value={d.keep_warm_s} onChange={(e) => setD({ ...d, keep_warm_s: Number(e.target.value) })}>
              {WARM.map(([s, l]) => <option key={s} value={s}>{l}</option>)}</select><small className="meta">A warm sandbox skips the cold start of a new one.</small></label></div>
            <label className="field"><span>Placement</span><select className="input" value={d.placement} onChange={set("placement")}>
              {(PLACES.some(([v]) => v === d.placement) ? PLACES : [...PLACES, [d.placement, d.placement]]).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label></section>
        </> : <>
          <section className="wm-s"><h3>Where it runs</h3><div className="grid2">
            <label className="field"><span>Cloud</span><input className="input" value={d.cloud} onChange={set("cloud")} placeholder="AWS" /></label>
            <label className="field"><span>Region</span><input className="input mono" value={d.region} onChange={set("region")} placeholder="eu-west-1" /></label></div></section>
          <Register pool={saved} />
        </>}
        <section className="wm-s"><h3>Network egress</h3><div className="eg-g">{EGRESS.map(([k, t, s]) =>
          <label key={k} className="mrow"><input type="radio" name="egress" value={k} checked={d.egress === k} onChange={set("egress")} />
            <span><b>{t}</b><small>{s} Watchtower still records every host.</small></span></label>)}</div>
          {d.egress === "allowlist" && <label className="field"><span>Allowed hosts</span><textarea className="input mono" rows="3" value={d.allow} onChange={set("allow")} /></label>}</section>
        <section className="wm-s"><h3>Who can use it</h3><div className="seg" role="tablist">
          <button type="button" role="tab" aria-selected={!scoped} onClick={() => setD({ ...d, repos: "*" })}>All repositories</button>
          <button type="button" role="tab" aria-selected={scoped} onClick={() => scoped || setD({ ...d, repos: [] })}>Selected</button></div>
          {scoped && <div className="needs">{[...new Set([...(repos ?? []).map((r) => r.name), ...d.repos])].map((r) => <label key={r}>
            <input type="checkbox" checked={d.repos.includes(r)} onChange={(e) => setD({ ...d, repos: e.target.checked ? [...d.repos, r] : d.repos.filter((x) => x !== r) })} />
            <span className="mono">{r}</span></label>)}</div>}</section>
        {pool && <section className="wm-s wm-dz"><h3>Danger zone</h3>{managed
          ? <div className="srow"><div><h3>{pool.draining ? "Resume pool" : "Drain pool"}</h3><p>{pool.draining ? "Start taking new runs again." : "Finish running work, take no new runs. The managed pool can't be deleted."}</p></div>
            <button type="button" className="btn btn-secondary end" onClick={() => act(`/pools/${encodeURIComponent(pool.id)}/${pool.draining ? "undrain" : "drain"}`, {})}>{pool.draining ? "Resume" : "Drain"}</button></div>
          : <div className="srow"><div><h3>Delete pool</h3><p>Its workers keep their tokens and leave the pool.</p></div>
            <button type="button" className="btn btn-danger end" onClick={() => (armed ? act(`/byo-pools/${encodeURIComponent(pool.id)}`, undefined, "DELETE") : setArmed(true))}>
              {armed ? "Click again to delete" : "Delete"}</button></div>}</section>}
      </div>
      <div className="wm-f"><span className="meta">{managed ? "Billed in sandbox seconds against the account's credits." : "Your machines; cinder bills nothing for them."}</span>
        <span className="wm-err" role="alert">{err.form}</span>
        <button type="button" className="btn btn-ghost" onClick={close}>Cancel</button>
        <button type="submit" className="btn btn-primary">{saved ? "Save changes" : "Create pool"}</button></div>
    </form>
  </dialog>;
}

// Bring-your-own registration: a one-time pool token (kept only in this component, so it is gone once the modal closes),
// the commands that use it, and the pool's heartbeat status, polled every 3 s while this step is shown.
function Register({ pool }) {
  const [token, setToken] = useState(null), [live, setLive] = useState(pool), [err, setErr] = useState("");
  useEffect(() => {
    if (!pool) return;
    const t = setInterval(() => {
      invalidate();
      list("/api/workers/byo-pools").then((all) => { setErr(""); setLive(all.find((p) => p.id === pool.id) ?? null); },
        (e) => setErr(`Couldn't refresh the status: ${e.message}`));
    }, 3000);
    return () => clearInterval(t);
  }, [pool]);
  const mint = () => poolAct(`/byo-pools/${encodeURIComponent(pool.id)}/tokens`, {}).then((r) => setToken(r?.token ?? null), (e) => setErr(e.message));
  return <section className="wm-s"><h3>Register workers</h3><ol className="wm-steps">
    <li><span>Mint a registration token. It is shown once and works for 24 hours.</span>
      {!pool ? <span className="meta">Create the pool first.</span> : token ? <div className="wm-tok"><code>{token}</code>
        {/* A denied clipboard leaves the token selectable. */}
        <button type="button" className="iconbtn" aria-label="Copy token" onClick={() => navigator.clipboard?.writeText(token).catch(() => {})}><Ic name="copy" /></button></div>
        : <button type="button" className="btn btn-secondary" onClick={mint}><Ic name="key" />Mint token</button>}</li>
    <li><span>On each machine, install the CLI and register into this pool:</span>
      <pre className="wm-pre">{`go install github.com/brinkercode/cinder/runner/cmd/cinder@latest
CINDER_URL=${window.location?.origin ?? ""} cinder runner register <machine> --kinds verify --pool-token ${token ?? "<token>"}`}</pre></li>
    <li><span aria-live="polite">{live?.online ? `${live.online} of ${live.members} online` : "Waiting for the first heartbeat…"}</span></li></ol>
    <span className="wm-err" role="alert">{err}</span>{pool && <Issued pool={pool} minted={token} />}</section>;
}

// The pool's issued tokens, loaded on their own so a failure stays here; Revoke takes a second click.
function Issued({ pool, minted }) {
  const [rows, setRows] = useState(null), [err, setErr] = useState(""), [armed, setArmed] = useState(null), [tick, setTick] = useState(0);
  useEffect(() => {
    setErr("");
    setRows(null);
    poolTokens(pool.id).then(setRows, (e) => setErr(`Couldn't load the tokens: ${e.message}`));
  }, [pool.id, minted, tick]);
  const revoke = (prefix) => (armed !== prefix ? setArmed(prefix)
    : poolAct(`/byo-pools/${encodeURIComponent(pool.id)}/tokens/${prefix}`, undefined, "DELETE").then(() => { setArmed(null); setTick((t) => t + 1); },
      (e) => setErr(`Couldn't revoke ${prefix}: ${e.message}`)));
  const cols = [["Token", 72], ["Created"], ["First used"], [""]];
  return <div className="wm-s"><h3>Issued tokens</h3>
    {err ? <p className="wm-err">{err} <button type="button" className="btn btn-secondary" onClick={() => setTick((t) => t + 1)}>Retry</button></p>
      : !rows ? <div className="tscroll"><TableSkel cols={cols} rows={2} /></div>
        : !rows.length ? <p className="meta">No tokens issued for this pool. Mint one above to register a worker.</p>
          : <><div className="tscroll"><table className="tbl"><thead><tr>{cols.map(([c]) => <th key={c}>{c}</th>)}</tr></thead><tbody>
            {rows.map((t) => <tr key={t.prefix}><td className="mono">{t.prefix} ••••</td><td className="meta">{ago(t.created_at)} ago · {t.created_by}</td>
              <td className={t.used_at ? "" : "meta"}>{t.used_at ? `${ago(t.used_at)} ago` : "never"}</td>
              <td><button type="button" className={armed === t.prefix ? "btn btn-danger" : "btn btn-secondary"} onClick={() => revoke(t.prefix)}>
                {armed === t.prefix ? "Click again to revoke" : "Revoke"}</button></td></tr>)}</tbody></table></div>
            <p className="meta">Revoking stops workers that registered with it at their next heartbeat. Running jobs finish.</p></>}
  </div>;
}
