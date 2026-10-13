// Settings › Access & people. Inviting or
// removing a person also adds or removes their email in the Access policy (the Worker does it); service tokens live in D1.
import { Suspense, useRef, useState } from "react";
import { Await, useAsyncError, useLoaderData, useRevalidator } from "react-router";
import { serviceTokens } from "./api/access.js";
import { list, postJson } from "./client.js";
import { DemoData } from "./demo-data.jsx";
import { Ic } from "./icons.jsx";
import { LoadingRegion, TableSkel, useShape } from "./skeleton.jsx";
import { Dialog, ErrorState, Tag, Frame, Loaded } from "./ui.jsx";
import "./styles/access.css";

const ROLES = [["owner", "Owner"], ["maintainer", "Maintainer"], ["contributor", "Contributor"]];
const SOURCES = ["Access group", "IdP group", "Cloudflare User Group"];
const ZERO_TRUST = "https://one.dash.cloudflare.com/";
const roleName = (role) => ROLES.find(([r]) => r === role)?.[1] ?? role;
const groupPath = (name) => `/api/groups/${encodeURIComponent(name)}`;
const personPath = (email) => `/api/people/${encodeURIComponent(email)}`;
const name = (p) => p.email.split("@")[0];
const tokenPath = (id) => `/api/service-tokens/${encodeURIComponent(id)}`;
export const ago = (at) => {
  const s = Math.max(0, (Date.now() - Date.parse(at)) / 1000);
  return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
};

// Not awaited, so the page head shows at once and the cards move through loading, then ready or error.
export const accessLoader = () => {
  const data = Promise.all([list("/api/groups"), list("/api/people"), serviceTokens()]);
  data.catch(() => {}); // <Await> renders the rejection
  return { data };
};

// Every repo ([]) or the comma-separated names typed under Selected.
const reposOf = ({ scope, repos }) => (scope === "some" ? (repos ?? "").split(/[\s,]+/).filter(Boolean) : []);
function RepoField() {
  const [some, setSome] = useState(false);
  return <fieldset className="field"><legend>Repositories</legend>
    <label><input type="radio" name="scope" value="all" checked={!some} onChange={() => setSome(false)} />All repositories</label>
    <label><input type="radio" name="scope" value="some" checked={some} onChange={() => setSome(true)} />Selected</label>
    {some && <input className="input w" name="repos" aria-label="Selected repositories" required placeholder="billing-api, ledger-ui" />}
  </fieldset>;
}

const RoleField = () => <label className="field"><span>Cinder role</span><select className="input w" name="role" defaultValue="contributor">{ROLES.map(([r, l]) => <option key={r} value={r}>{l}</option>)}</select></label>;

const intro = <div><h1>Access &amp; people</h1><p>Who can sign in and what they can do inside cinder.</p></div>;

// The route's hydrate fallback: the real head, its dialog buttons disabled, then the skeleton.
export const AccessLoading = () => <Frame className="access" head={<>{intro}<div className="acts">
  <a className="btn btn-secondary" href={ZERO_TRUST} target="_blank" rel="noreferrer">Zero Trust › Access<Ic name="ur" /></a>
  <button type="button" className="btn btn-secondary" disabled><Ic name="plus" />Add account</button>
  <button type="button" className="btn btn-primary" disabled><Ic name="plus" />Invite</button></div></>}><Skel /></Frame>;

export function Access() {
  const { data } = useLoaderData();
  const { revalidate } = useRevalidator();
  const [err, setErr] = useState(null);
  const invite = useRef(null), map = useRef(null), token = useRef(null), account = useRef(null);
  const open = (dlg) => { dlg.current.returnValue = ""; dlg.current.showModal(); };
  const act = (p) => { setErr(null); return p.then(revalidate, (e) => { setErr(e.message); throw e; }); };
  // A modal's form is sent on its primary action; Cancel and Esc send nothing.
  const onClose = (send) => (e) => {
    if (e.currentTarget.returnValue === "ok") act(send(Object.fromEntries(new FormData(e.currentTarget.querySelector("form"))))).catch(() => {});
  };
  return <Frame className="access" head={<>
      {intro}
      <div className="acts">
        <a className="btn btn-secondary" href={ZERO_TRUST} target="_blank" rel="noreferrer">Zero Trust › Access<Ic name="ur" /></a>
        <Loaded data={data} reason="Available once access loads"><button type="button" className="btn btn-secondary" onClick={() => open(account)}><Ic name="plus" />Add account</button></Loaded>
        <Loaded data={data} reason="Available once access loads"><button type="button" className="btn btn-primary" onClick={() => open(invite)}><Ic name="plus" />Invite</button></Loaded>
      </div>
    </>}>
    {err && <p className="meta" role="alert">{err}</p>}
    <Suspense fallback={<Skel />}>
      <Await resolve={data} errorElement={<Failed />}>{([groups, people, tokens]) => <Lists groups={groups} people={people} tokens={tokens} onInvite={() => open(invite)} onMap={() => open(map)} onToken={() => open(token)} act={act} />}</Await>
    </Suspense>
    <div className="card"><div className="srow"><div><h3>Cinder roles</h3>
      <p>Owner, Maintainer and Contributor control actions inside the app: merging overrides, lease takeovers, judge settings. Group mappings above assign them.</p></div></div></div>
    <DemoData />
    <Dialog ref={invite} title="Invite people" action="Send invites" onClose={onClose((f) => postJson("/api/invites", { emails: f.emails.split(/[\s,]+/).filter(Boolean), role: f.role, repos: reposOf(f) }))}>
      <div className="form flush">
        <label className="field"><span>Emails</span><textarea className="input w" name="emails" rows="3" required placeholder="priya@example.com, alex@example.com" /><span className="meta">Separate with commas or new lines.</span></label>
        <RoleField />
        <RepoField />
        <p className="meta">They sign in through Cloudflare Access. Cinder adds each email to the Access policy; anyone missing from it is blocked.</p>
      </div>
    </Dialog>
    <Dialog ref={account} title="Add account" action="Add account" onClose={onClose(({ name, slug, organization }) => postJson("/api/accounts", { name, slug, ...(organization.trim() && { organization }) }))}>
      <div className="form flush">
        <label className="field"><span>Name</span><input className="input w" name="name" required placeholder="Acme Labs" /></label>
        <label className="field"><span>Slug</span><input className="input w mono" name="slug" required pattern="[a-z0-9][a-z0-9\-]{0,62}" placeholder="acme-labs" /></label>
        <label className="field"><span>Organization</span><input className="input w" name="organization" placeholder="Acme" /><span className="meta">Optional. An existing organization by name, or a new one.</span></label>
      </div>
    </Dialog>
    <Dialog ref={token} title="Allow a service token" action="Allow" onClose={onClose(({ client_id, name }) => postJson(tokenPath(client_id), { name }, "PUT"))}>
      <div className="form flush">
        <label className="field"><span>Client ID</span><input className="input w mono" name="client_id" required /></label>
        <label className="field"><span>Name</span><input className="input w" name="name" required placeholder="ci-bot" /></label>
      </div>
    </Dialog>
    <Dialog ref={map} title="Map a group" action="Map group" onClose={onClose((f) => postJson("/api/groups", { name: f.name, source: f.source, role: f.role, repos: reposOf(f) }))}>
      <div className="form flush">
        <label className="field"><span>Source</span><select className="input w" name="source">{SOURCES.map((s) => <option key={s}>{s}</option>)}</select></label>
        <label className="field"><span>Group</span><input className="input w mono" name="name" required /></label>
        <RoleField />
        <RepoField />
        <p className="meta">Members get the role at their next sign-in. Groups come from Zero Trust; manage membership there.</p>
      </div>
    </Dialog>
  </Frame>;
}

const noMappings = <p className="card-b meta">No mappings yet. Map an Access group, IdP group or Cloudflare User Group to a cinder role.</p>;
const noTokens = <p className="card-b meta">No service tokens allowed. A service token acts as a person once its client ID is allowed here.</p>;

function Skel() {
  const groups = useShape("access//groups", 4), people = useShape("access//people", 6), tokens = useShape("access//tokens", 2);
  return <LoadingRegion page="Access & people" busy>
    <div className="card"><div className="card-h"><h3>Group → role mapping</h3><span className="end"><button type="button" className="btn btn-secondary btn-sm" disabled><Ic name="plus" />Map a group</button></span></div>
      {groups.n ? <div className="tscroll"><TableSkel cols={[["Source"], ["Group", 120], ["Cinder role"], ["Repos"], [""]]} rows={groups.n} widths={groups.widths} /></div> : noMappings}</div>
    <div className="card"><div className="card-h"><h3>People</h3><span className="end"><button type="button" className="btn btn-secondary btn-sm" disabled><Ic name="plus" />Invite</button></span></div>
      <div className="tscroll"><TableSkel cols={[["Name"], ["Email"], ["Role"], ["Last seen"], [""]]} rows={people.n} widths={people.widths} /></div></div>
    <div className="card"><div className="card-h"><h3>Service tokens</h3><span className="end"><button type="button" className="btn btn-secondary btn-sm" disabled><Ic name="plus" />Allow a token</button></span></div>
      {tokens.n ? <div className="tscroll"><TableSkel cols={[["Name"], ["Client ID", 120], [""]]} rows={tokens.n} widths={tokens.widths} /></div> : noTokens}</div>
  </LoadingRegion>;
}

function Failed() {
  const { revalidate } = useRevalidator();
  return <div className="card"><ErrorState message={`Couldn't load access: ${useAsyncError().message}`} onRetry={revalidate} /></div>;
}

function Lists({ groups, people, tokens, onInvite, onMap, onToken, act }) {
  // The select is uncontrolled: it shows the pick at once and goes back to the saved role if the save fails.
  const setRole = (g, sel) => act(postJson(groupPath(g.name), { ...g, role: sel.value }, "PUT")).catch(() => { sel.value = g.role; });
  // The guard matches the server's: the only owner can't be demoted or removed.
  const owners = [...people.filter((p) => p.owner || p.role === "owner"), ...groups.filter((g) => g.role === "owner" && !g.repos.length)];
  const only = (p) => owners.length === 1 && owners[0] === p;
  const guard = useRef(null), confirm = useRef(null);
  const [who, setWho] = useState(null);
  const ask = (dlg, p, what) => { setWho({ p, what }); dlg.current.returnValue = ""; dlg.current.showModal(); };
  const setPersonRole = (p, sel) => {
    if (only(p) && sel.value !== "owner") { sel.value = p.role ?? ""; ask(guard, p, `change ${name(p)}'s role`); return; }
    act(postJson(personPath(p.email), { role: sel.value }, "PATCH")).catch(() => { sel.value = p.role ?? ""; });
  };
  const remove = (p) => (only(p) ? ask(guard, p, `remove ${name(p)}`) : ask(confirm, p));
  const groupShape = useShape("access//groups", 4, groups.length), peopleShape = useShape("access//people", 6, people.length);
  const tokenShape = useShape("access//tokens", 2, tokens.length);
  return <>
    <div className="card">
      <div className="card-h"><h3>Group → role mapping</h3><span className="end"><button type="button" className="btn btn-secondary btn-sm" onClick={onMap}><Ic name="plus" />Map a group</button></span></div>
      {groups.length ? <div className="tscroll"><table className="tbl" ref={groupShape.ref}>
        <thead><tr><th>Source</th><th>Group</th><th>Cinder role</th><th>Repos</th><th /></tr></thead>
        <tbody>{groups.map((g, i) => <tr key={g.name}>
          <td className="meta">{g.source}</td>
          <td className="mono">{g.name}</td>
          <td><select className="input" aria-label={`Cinder role of ${g.name}`} defaultValue={g.role} onChange={(e) => setRole(g, e.target)}>
            {ROLES.map(([r, l]) => <option key={r} value={r}>{l}</option>)}</select></td>
          <td>{g.repos.length ? g.repos.join(", ") : "all repos"}</td>
          <td className="num">
            <button type="button" className="ib" aria-label={`More for ${g.name}`} popoverTarget={`grp-${i}`} style={{ anchorName: `--grp-${i}` }}><Ic name="more" /></button>
            <div popover="auto" id={`grp-${i}`} className="menu" style={{ positionAnchor: `--grp-${i}` }}>
              <button type="button" onClick={() => act(postJson(groupPath(g.name), undefined, "DELETE")).catch(() => {})}>Remove mapping</button>
            </div>
          </td>
        </tr>)}</tbody>
      </table></div> : noMappings}
    </div>
    <div className="card">
      <div className="card-h"><h3>People</h3><span className="end"><button type="button" className="btn btn-secondary btn-sm" onClick={onInvite}><Ic name="plus" />Invite</button></span></div>
      <div className="tscroll"><table className="tbl" ref={peopleShape.ref}>
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Last seen</th><th /></tr></thead>
        <tbody>{people.map((p, i) => <tr key={p.email}>
          <td><span className="who"><span className="av">{p.email[0].toUpperCase()}</span>{name(p)}</span></td>
          <td className="meta">{p.email}</td>
          {/* An owner listed in OWNERS stays owner whatever their role, so they get no controls. */}
          <td>{p.owner ? <Tag>Owner</Tag> : <select className="input" aria-label={`Role of ${p.email}`} defaultValue={p.role ?? ""} onChange={(e) => setPersonRole(p, e.target)}>
            {!ROLES.some(([r]) => r === p.role) && <option value={p.role ?? ""} disabled>{p.role ? roleName(p.role) : "No role"}</option>}
            {ROLES.map(([r, l]) => <option key={r} value={r}>{l}</option>)}</select>}</td>
          <td className="meta">{p.last_seen ? ago(p.last_seen) : p.invited === "access" ? "Invited in Cloudflare Access · not signed in" : "never"}</td>
          <td className="num">{!p.owner && <>
            <button type="button" className="ib" aria-label={`More for ${p.email}`} popoverTarget={`ppl-${i}`} style={{ anchorName: `--ppl-${i}` }}><Ic name="more" /></button>
            <div popover="auto" id={`ppl-${i}`} className="menu" style={{ positionAnchor: `--ppl-${i}` }}>
              <button type="button" onClick={() => remove(p)}>Remove {name(p)}</button>
            </div>
          </>}</td>
        </tr>)}</tbody>
      </table></div>
    </div>
    <div className="card">
      <div className="card-h"><h3>Service tokens</h3><span className="end"><button type="button" className="btn btn-secondary btn-sm" onClick={onToken}><Ic name="plus" />Allow a token</button></span></div>
      {tokens.length ? <div className="tscroll"><table className="tbl" ref={tokenShape.ref}>
        <thead><tr><th>Name</th><th>Client ID</th><th /></tr></thead>
        <tbody>{tokens.map((t) => <tr key={t.client_id}>
          <td>{t.name}@service-token</td>
          <td className="mono">{t.client_id}</td>
          <td className="num"><button type="button" className="btn btn-secondary btn-sm" onClick={() => act(postJson(tokenPath(t.client_id), undefined, "DELETE")).catch(() => {})}>Remove</button></td>
        </tr>)}</tbody>
      </table></div> : noTokens}
    </div>
    <dialog className="dlg" ref={guard}>
      <form method="dialog">
        <div className="panel-head"><h2>Can&apos;t {who?.what}</h2></div>
        <div className="pad"><p><b>{who && name(who.p)}</b> is the only owner. An account needs at least one owner to raise budgets, approve production and manage access. Make someone else an owner first.</p></div>
        <div className="dlg-foot"><button className="btn btn-primary" value="ok">OK</button></div>
      </form>
    </dialog>
    <Dialog ref={confirm} title={`Remove ${who ? name(who.p) : ""}?`} action="Remove"
      onClose={(e) => { if (e.currentTarget.returnValue === "ok") act(postJson(personPath(who.p.email), undefined, "DELETE")).catch(() => {}); }}>
      <p>{who && name(who.p)} loses their cinder role on every repo. Changes they drive stay open and go to their reviewers. If a group mapping still includes them, they get that group&apos;s role back at next sign-in.</p>
    </Dialog>
  </>;
}
