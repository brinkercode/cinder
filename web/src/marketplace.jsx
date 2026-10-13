// Automation › Marketplace: agent templates to browse and install into an account, and Publish for this instance's agents.
import { Suspense, useState } from "react";
import { Await, useAsyncError, useLoaderData, useRevalidator } from "react-router";
import { install, marketplace, publish } from "./api/marketplace.js";
import { Chip } from "./automation-agents.jsx";
import { modelAccess, modelCatalog } from "./client.js";
import { Ic } from "./icons.jsx";
import { useGet } from "./use-get.js";
import { ListCardSkel, LoadingRegion } from "./skeleton.jsx";
import { Dialog, EmptyState, ErrorState, Frame, Tabs, Tag, Tile, tok } from "./ui.jsx";
import "./styles/marketplace.css";

const FILTERS = [["all", "All"], ["writers", "Writers"], ["reviewers", "Reviewers"], ["mine", "Published by you"]];
const reviews = (e) => /review/i.test(`${e.name} ${e.description}`);
const KEEP = { all: () => true, writers: (e) => !reviews(e), reviewers: reviews, mine: (e) => e.mine };
// A win rate is trusted from 20 decided races.
const Win = ({ e }) => (e.races >= 20 ? <b>{Math.round((e.wins / e.races) * 100)}%</b> : <span className="untrusted">untrusted: {e.races} outcomes</span>);
// Opens a dialog as soon as it mounts.
const modal = (d) => { if (d && !d.open) d.showModal(); };
const formOf = (ev) => Object.fromEntries(new FormData(ev.currentTarget.querySelector("form")));

// Not awaited, so the head shows at once; the catch only stops an unhandled-rejection report.
export const marketplaceLoader = () => { const data = marketplace(); data.catch(() => {}); return { data }; };

export function Marketplace() {
  const { data } = useLoaderData();
  const [msg, setMsg] = useState(null), [publishing, setPublishing] = useState(false);
  // Above the Suspense, so a revalidate after an install keeps each card's state.
  const [states, setStates] = useState({});
  const onState = (name, st) => setStates((m) => ({ ...m, [name]: st }));
  return <Frame kind="read" className="mk" head={<><div><h1>Marketplace</h1><p>Agents bundled with cinder and published on this instance. Install one into an account to use it there.</p></div>
    <div className="acts"><button type="button" className="btn btn-primary" onClick={() => setPublishing(true)}><Ic name="plus" />Publish an agent</button></div></>}>
    {msg && <p className="meta" role={msg.bad ? "alert" : "status"}>{msg.text}</p>}
    <Suspense fallback={<LoadingRegion page="marketplace" busy><div className="stack">{[0, 1, 2].map((i) => <ListCardSkel key={i} />)}</div></LoadingRegion>}>
      <Await resolve={data} errorElement={<Failed />}>{(d) => <Browse d={d} states={states} onState={onState} publishing={publishing} onPublished={() => setPublishing(false)} onMsg={setMsg} />}</Await>
    </Suspense>
    <div className="card"><div className="card-b"><h3>What an install shares</h3><p className="meta">The agent&apos;s prompt, model, tools and network allowlist, pinned to a version. Never the publisher&apos;s secrets, model keys or changes. Win rates are the publisher&apos;s; an install starts untrusted.</p></div></div>
  </Frame>;
}

function Failed() {
  const { revalidate } = useRevalidator();
  return <div className="card"><ErrorState message={`Couldn't load the marketplace. Installed agents keep running. ${useAsyncError()?.message ?? ""}`} onRetry={revalidate} /></div>;
}

function Browse({ d: [catalog, accounts, agents], states, onState, publishing, onPublished, onMsg }) {
  const { revalidate } = useRevalidator();
  const [filter, setFilter] = useState("all"), [q, setQ] = useState(""), [dlg, setDlg] = useState(null);
  const close = () => { setDlg(null); onPublished(); };
  const done = (text) => { close(); onMsg({ text }); revalidate(); };
  const failed = (e) => { close(); onMsg({ text: e.message, bad: true }); };
  const shown = catalog.filter(KEEP[filter]).filter((e) => `${e.name} ${e.description} ${e.publisher}`.toLowerCase().includes(q.trim().toLowerCase()));
  return <>
    <Tabs label="Marketplace filters" options={FILTERS} value={filter} onChange={setFilter} />
    <div className="tb-in"><label className="q"><Ic name="search" /><input placeholder="Search agents, roles or publishers" aria-label="Search agents, roles or publishers" value={q} onChange={(e) => setQ(e.target.value)} /></label></div>
    {shown.length ? <div className="stack">{shown.map((e) => <Card key={e.name} e={e} state={states[e.name]} onOpen={() => setDlg({ kind: "detail", e })} onInstall={() => setDlg({ kind: "install", e })} />)}</div>
      : <div className="card"><EmptyState icon="search" title={q.trim() ? `No agents match “${q.trim()}”` : "No agents here"}
        action={q && <button type="button" className="btn btn-secondary" onClick={() => setQ("")}>Clear search</button>}>Try a role like reviewer or docs, or publish your own agent so other accounts can install it.</EmptyState></div>}
    {dlg?.kind === "detail" && <Detail e={dlg.e} onClose={(ok) => setDlg(ok ? { kind: "install", e: dlg.e } : null)} />}
    {dlg?.kind === "install" && <Install e={dlg.e} accounts={accounts} onState={onState} onClose={close} onDone={done} onFail={failed} />}
    {publishing && <Publish agents={agents} onClose={close} onDone={done} onFail={failed} />}
  </>;
}

const INSTALL = { installing: "Installing…", installed: "Installed", failed: "Retry install" };

function Card({ e, state, onOpen, onInstall }) {
  return <div className="lc">
    <div className="lc-m"><span className="lc-ico"><Ic name="robot" /></span>
      <div className="grow"><div className="lc-t"><button type="button" className="card-link mono" onClick={onOpen}>{e.name}</button><Tag>v{e.versions.at(-1)}</Tag>{e.mine && <Tag>published by you</Tag>}</div>
        <div className="lc-s">{e.description} · by {e.publisher} · {e.harness} · <span className="mono">{e.model}</span></div></div>
      <span className="lc-time">{e.installs} installs</span>
      <button type="button" className={`btn btn-sm ${state === "installed" ? "btn-secondary" : "btn-primary"}`} disabled={state === "installing" || state === "installed"}
        aria-busy={state === "installing" || undefined} onClick={onInstall}>{state === "installed" && <Ic name="check" />}{INSTALL[state] ?? "Install"}</button></div>
    <div className="lc-f"><span><Ic name="chart" />Win rate <Win e={e} /></span>
      <span className="r"><Ic name="token" />{e.tokens_per_merge === null ? <span className="muted">no merged changes yet</span> : <><b>{tok(e.tokens_per_merge)}</b> tokens per merged change</>}</span></div>
  </div>;
}

// The model's credential chip from My model access; nothing while it loads or when the model isn't in the catalog.
function Cred({ model }) {
  const { data } = useGet(() => Promise.all([modelCatalog(), modelAccess()]));
  const p = data?.[0].find((m) => m.id === model)?.provider;
  return p ? <Chip access={data[1]} p={p} /> : null;
}

function Detail({ e, onClose }) {
  return <Dialog ref={modal} title={<><span className="mono">{e.name}</span> <small className="muted">by {e.publisher} · v{e.versions.at(-1)}</small></>} action="Install"
    onClose={(ev) => onClose(ev.currentTarget.returnValue === "ok")}>
    <p>{e.description}</p>
    <div className="tiles mk-tiles"><Tile label="Win rate" value={e.races >= 20 ? `${Math.round((e.wins / e.races) * 100)}%` : "—"} sub={e.races >= 20 ? ` n=${e.races}` : null}>{e.races < 20 && <span className="untrusted">untrusted: {e.races} outcomes</span>}</Tile>
      <Tile label="Tokens per merged change" value={e.tokens_per_merge === null ? "—" : tok(e.tokens_per_merge)} /><Tile label="Installs" value={String(e.installs)} /></div>
    <dl className="kv2"><dt>Harness</dt><dd>{e.harness}</dd><span /><dt>Model</dt><dd className="mono">{e.model}</dd><Cred model={e.model} />
      <dt>Tools</dt><dd>{e.tools.join(", ") || "none"}</dd><span /><dt>Network</dt><dd className="mono">{e.egress.join(", ")}</dd><span />
      <dt>Versions</dt><dd>{e.versions.toReversed().map((v, i) => `v${v}${i ? "" : " (latest)"}`).join(" · ")}</dd><span /></dl>
    <p className="meta">Runs with your account&apos;s model credentials.</p>
  </Dialog>;
}

function Install({ e, accounts, onState, onClose, onDone, onFail }) {
  const first = accounts.find((a) => a.can_install);
  const submit = (ev) => {
    if (ev.currentTarget.returnValue !== "ok") return onClose();
    const f = formOf(ev);
    onState(e.name, "installing");
    install(f.name, { template: e.name, account_id: f.account_id, version: Number(f.version), channel: f.channel })
      .then(() => { onState(e.name, "installed"); onDone(`Installing ${f.name} from ${e.name}@v${f.version} on ${f.channel}`); },
        (err) => { onState(e.name, "failed"); onFail(err); });
  };
  return <Dialog ref={modal} title={<>Install <span className="mono">{e.name}</span></>} action="Install" disabled={!first} onClose={submit}>
    <div className="stack">
      <div className="grid2"><label className="field"><span>Into account</span><select className="input" name="account_id" defaultValue={first?.id}>
        {accounts.map((a) => <option key={a.id} value={a.id} disabled={!a.can_install}>{a.name}{a.can_install ? "" : " (needs Git Admin)"}</option>)}</select></label>
        <label className="field"><span>Version</span><select className="input" name="version">{e.versions.toReversed().map((v, i) => <option key={v} value={v}>v{v}{i ? "" : " (latest)"}</option>)}</select></label></div>
      <label className="field"><span>Name</span><input className="input mono" name="name" required pattern="[a-z0-9\-]{1,63}" defaultValue={`${e.name}-${first?.slug ?? "copy"}`} /></label>
      <fieldset className="mk-set"><legend>Channel</legend>
        <label><input type="radio" name="channel" value="canary" defaultChecked /><span><b>canary</b> · while it earns outcomes here</span></label>
        <label><input type="radio" name="channel" value="stable" /><span><b>stable</b> · every matching change</span></label></fieldset>
      <p className="mk-note"><Ic name="info" /><span>The install pins the version you pick. Its win rate here starts at <span className="untrusted">untrusted: 0 outcomes</span>. It uses your account&apos;s model credentials and budget.</span></p>
      {!first && <p className="meta" role="alert">You need Git Admin on an account to install into it.</p>}
    </div>
  </Dialog>;
}

function Publish({ agents, onClose, onDone, onFail }) {
  const [name, setName] = useState(agents[0]?.name);
  const agent = agents.find((a) => a.name === name);
  const submit = (ev) => {
    if (ev.currentTarget.returnValue !== "ok") return onClose();
    const f = formOf(ev);
    publish(f.agent, { version: Number(f.version), description: f.description, visibility: f.visibility }).then(() => onDone(`Published ${f.agent}@v${f.version} to the marketplace`), onFail);
  };
  return <Dialog ref={modal} title="Publish an agent" action="Publish" disabled={!agent} onClose={submit}>
    <div className="stack">
      <div className="grid2"><label className="field"><span>Agent</span><select className="input" name="agent" value={name} onChange={(ev) => setName(ev.target.value)}>
        {agents.map((a) => <option key={a.name}>{a.name}</option>)}</select></label>
        <label className="field"><span>Version</span><select className="input" name="version" key={name}>{agent?.versions.toReversed().map((v) => <option key={v.version} value={v.version}>
          v{v.version}{agent.channels.filter((c) => c.version === v.version).map((c) => ` (${c.channel})`).join("")}</option>)}</select></label></div>
      <label className="field"><span>Listing description</span><input className="input" name="description" required maxLength={500} /></label>
      <fieldset className="mk-set"><legend>Visible to</legend>
        <label><input type="radio" name="visibility" value="organization" defaultChecked /><span>This organization</span></label>
        <label><input type="radio" name="visibility" value="instance" /><span>Everyone on the instance</span></label></fieldset>
      <fieldset className="mk-set"><legend>Shared</legend>
        <label><input type="checkbox" checked disabled readOnly /><span>Prompt, model, tools and network allowlist</span></label>
        <label><input type="checkbox" checked disabled readOnly /><span>Win rate and tokens per merged change</span></label>
        <label><input type="checkbox" disabled /><span>Secrets, model keys, limits and changes: never shared</span></label></fieldset>
      <p className="meta">Installs keep the version they pinned.</p>
    </div>
  </Dialog>;
}
