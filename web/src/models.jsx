// My model access: where the viewer's agents
// get model credentials. A saved key is never shown again: the API only returns its method, and the form is reset on close.
import { Suspense, useRef, useState } from "react";
import { Await, useAsyncError, useLoaderData, useRevalidator } from "react-router";
import { ago } from "./access.jsx";
import { modelAccess, postJson } from "./client.js";
import { Ic } from "./icons.jsx";
import { BoneText, LoadingRegion, TableSkel, TileSkel, useShape } from "./skeleton.jsx";
import { Dialog, Dot, ErrorState, Tabs, Tag, Tile, tok, Frame } from "./ui.jsx";

const GATEWAY = "https://dash.cloudflare.com/?to=/:account/ai/ai-gateway";
const SRC = { credits: "Cloudflare credits", org: "Org key", mine: "My key" };
const METHOD = { key: "API key", login: "Subscription login" };
const TONE = { connected: "ok", failing: "bad" };
const keyPath = (id) => `/api/me/models/${encodeURIComponent(id)}`;

// Not awaited, so the page head shows at once and the cards move through loading, then ready or error.
export const modelsLoader = () => {
  const data = modelAccess();
  data.catch(() => {}); // <Await> renders the rejection
  return { data };
};

const intro = <div><h1>My model access</h1><p>Where your agents get model credentials. Keys are tied to your sign-in and never shown again after saving.</p></div>;

// The route's hydrate fallback: the real head, then the skeleton.
export const ModelsLoading = () => <Frame className="mm" head={intro}><Skel /></Frame>;

export function Models() {
  const { data } = useLoaderData();
  const { revalidate } = useRevalidator();
  const [err, setErr] = useState(null);
  const [method, setMethod] = useState("key");
  const dlg = useRef(null);
  const act = (p) => { setErr(null); return p.then(revalidate, (e) => setErr(e.message)); };
  // Connect and Replace preselect their provider; reset first so a reopened dialog never holds an earlier key.
  const open = (provider) => {
    const d = dlg.current;
    d.returnValue = "";
    d.querySelector("form").reset();
    if (provider) d.querySelector("select").value = provider;
    setMethod("key");
    d.showModal();
  };
  const onClose = (e) => {
    const form = e.currentTarget.querySelector("form");
    const { provider, value } = Object.fromEntries(new FormData(form));
    form.reset();
    if (e.currentTarget.returnValue === "ok") act(postJson(keyPath(provider), { method, value }, "PUT"));
  };
  return <Frame className="mm" head={intro}>
    {err && <p className="meta" role="alert">{err}</p>}
    <Suspense fallback={<Skel />}>
      <Await resolve={data} errorElement={<Failed />}>{(m) => <Access m={m} open={open} act={act} />}</Await>
    </Suspense>
    <Dialog ref={dlg} title="Add key or login" action="Save" onClose={onClose}>
      <div className="form flush">
        <Suspense><Await resolve={data} errorElement={<></>}>{(m) => <label className="field"><span>Provider</span><select className="input w" name="provider">
          {m.providers.filter((p) => p.id !== "cf").map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}</Await></Suspense>
        <div className="field"><span>Method</span><Tabs label="Method" options={Object.entries(METHOD)} value={method} onChange={setMethod} /></div>
        <label className="field"><span>{method === "key" ? "API key" : "Login token"}</span>
          <input className="input w" name="value" type="password" required autoComplete="off" placeholder="Paste once. It won't be shown again." /></label>
        <p className="meta">Stored against your sign-in identity. Agents you start on managed pools use it; BYO pools use the machine&apos;s own key, and nobody else&apos;s runs can.</p>
      </div>
    </Dialog>
  </Frame>;
}

function Skel() {
  const { n, widths } = useShape("models//providers", 5);
  return <LoadingRegion page="My model access" busy>
  <div className="card"><div className="card-h"><h3>Credential sources</h3><span className="end">Used in this order when an agent needs a provider</span></div>
    {[0, 1, 2].map((i) => <div className="srow" key={i}><div className="skel-lines"><BoneText i={i} large /><BoneText i={i + 1} /></div></div>)}</div>
  <div className="card"><div className="card-h"><h3>Providers</h3><span className="end"><button type="button" className="btn btn-secondary btn-sm" disabled><Ic name="plus" />Add key or login</button></span></div>
    <div className="tscroll"><TableSkel cols={[["Provider"], ["Source"], ["Status"], ["Last used"], [""]]} rows={n} widths={widths} /></div></div>
  <div className="usage"><h2>My usage this month</h2></div>
  <div className="tiles">{["Tokens", "Spend", "Agent runs", "Personal budget"].map((l) => <TileSkel key={l} label={l} />)}</div>
</LoadingRegion>;
}

function Failed() {
  const { revalidate } = useRevalidator();
  return <div className="card"><ErrorState message={`Couldn't load model access: ${useAsyncError().message}`} onRetry={revalidate} /></div>;
}

function Access({ m, open, act }) {
  const org = m.org_keys && m.providers.filter((p) => m.org_keys.includes(p.id)).map((p) => p.name);
  const sources = [
    ["credits", "Use Cloudflare credits", "default", `${m.account ? `Billed to ${m.account}. ` : ""}No key needed. Hosted models only.`],
    ["org", "Use org key", "read-only", <>{!org ? "The org's provider keys couldn't be read." : org.length ? <>The org has keys for <b>{org.join(", ")}</b>.</> : "The org has no provider keys."} Managed in <a href={GATEWAY} target="_blank" rel="noreferrer">AI › AI Gateway › Provider Keys</a>.</>],
    ["mine", "Add my own key or login", null, "Per provider: an API key, or a subscription login such as a Claude Code login token."],
  ];
  const remove = (p) => window.confirm(`Remove your ${p.name} credential?`) && act(postJson(keyPath(p.id), undefined, "DELETE"));
  const now = new Date();
  const day = (d) => d.toLocaleDateString("en-US", { month: "long", day: "numeric" });
  const { ref } = useShape("models//providers", 5, m.providers.length);
  return <>
    <div className="card">
      <div className="card-h"><h3>Credential sources</h3><span className="end">Used in this order when an agent needs a provider</span></div>
      {sources.map(([v, title, tag, text]) => <label className="srow" key={v}>
        <input type="radio" name="src" defaultChecked={m.source === v} onChange={() => act(postJson("/api/me/models", { source: v }, "PUT"))} />
        <div><h3>{title} {tag && <Tag>{tag}</Tag>}</h3><p>{text}</p></div>
      </label>)}
    </div>
    <div className="card">
      <div className="card-h"><h3>Providers</h3><span className="end"><button type="button" className="btn btn-secondary btn-sm" onClick={() => open()}><Ic name="plus" />Add key or login</button></span></div>
      <div className="tscroll"><table className="tbl" ref={ref}>
        <thead><tr><th>Provider</th><th>Source</th><th>Status</th><th>Last used</th><th /></tr></thead>
        <tbody>{m.providers.map((p) => <tr key={p.id}>
          <td><b>{p.name}</b>{p.method && <div className="meta">{METHOD[p.method]}</div>}</td>
          <td>{p.source ? SRC[p.source] : <span className="meta">—</span>}</td>
          <td><span className="pill"><Dot tone={TONE[p.status] ?? "off"} />{p.status}</span>{p.reason && <div className="why">{p.reason}</div>}</td>
          <td className="meta">{p.last_used_at ? ago(p.last_used_at) : "never"}</td>
          <td className="num">{p.source === "mine" ? <>
            <span className="mono meta">set ••••</span>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => open(p.id)}>Replace</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => remove(p)}>Remove</button>
          </> : p.source === "org" ? <a className="btn btn-secondary btn-sm" href={GATEWAY} target="_blank" rel="noreferrer">View in AI Gateway</a>
            : !p.source && <button type="button" className="btn btn-primary btn-sm" onClick={() => open(p.id)}>Connect</button>}</td>
        </tr>)}</tbody>
      </table></div>
    </div>
    <div className="usage"><h2>My usage this month</h2><span className="meta">{day(new Date(now.getFullYear(), now.getMonth(), 1))} – {day(new Date(now.getFullYear(), now.getMonth() + 1, 0))}</span></div>
    <div className="tiles">
      <Tile label="Tokens" value={tok(m.usage.tokens)} />
      <Tile label="Spend" value={`$${m.usage.cost_usd.toFixed(2)}`} />
      <Tile label="Agent runs" value={String(m.usage.runs)} />
      <div className="tile flat"><div className="l">Personal budget <Tag>proposed</Tag></div><div className="v off">Not set</div>
        <button type="button" className="btn btn-secondary btn-sm" disabled>Set a limit</button></div>
    </div>
  </>;
}
