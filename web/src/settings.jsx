// Repo Settings: one page of section cards, each loading and failing on its own.
import { Fragment, useEffect, useState } from "react";
import { Link, useLoaderData, useLocation, useNavigate, useRouteLoaderData } from "react-router";
import { validateBranchPolicy, validateBranchDeploy, validateRepoRole, validateRepoSettings, validateRole, validateWebhook } from "../../worker/src/api/contract.js";
import { ago } from "./access.jsx";
import { DeleteRepo, Modal } from "./delete-repo.jsx";
import { flakes, releaseFlake, sinceDay } from "./api/flakes.js";
import { getRouting, putRouting } from "./api/labels.js";
import { branchesFor, fetchJson, get, getValid, list, postJson } from "./client.js";
import { Ic } from "./icons.jsx";
import { BonePill, BoneText, TableSkel, useShape } from "./skeleton.jsx";
import { ErrorState, Frame, Popover, Seg, Tag, Toggle } from "./ui.jsx";
import { codePath } from "./lib/code-path.js";
import { useGet } from "./use-get.js";
import "./styles/settings.css";

const STRATEGIES = ["trunk", "gitflow", "release", "custom"].map((s) => [s, s]);
const STRATEGY_LABELS = [["trunk", "Trunk"], ["gitflow", "Gitflow"], ["release", "Release branches"], ["custom", "Custom"]];
const EVENTS = ["change", "verdict", "judgment"];
const NEW_RULE = { queue: true, judges: 1, risk: 10, route: "" };
const SECTIONS = [["about", "About"], ["repository", "Repository"], ["branch-policy", "Branch policy"], ["repo-roles", "Repo roles"], ["routing", "Label routing"],
  ["flaky-checks", "Flaky checks"], ["webhooks", "Webhooks"], ["environments", "Environments"], ["mirror", "Mirror"], ["import", "Import"],
  ["danger-zone", "Danger zone"]];

// Every card's GET, by name.
const reads = (name) => {
  const api = `/api/repos/${encodeURIComponent(name)}`;
  return {
    settings: () => getValid(`${api}/settings`, validateRepoSettings), branches: () => branchesFor(name), policy: () => getValid(`${api}/policy`, validateBranchPolicy),
    groups: () => list("/api/groups"), people: () => getValid(`${api}/people`, validateRepoRole),
    everyone: () => list("/api/people"), roles: () => getValid("/api/roles", validateRole), webhooks: () => getValid(`${api}/webhooks`, validateWebhook),
    me: () => get("/api/me"), promotions: () => getValid(`${api}/branch-deploys`, validateBranchDeploy), flakes: () => flakes(name), routing: () => getRouting(name),
  };
};

// Starts every card's GET without awaiting any, so each card loads and fails on its own.
export const settingsLoader = ({ params }) => Object.fromEntries(Object.entries(reads(params.repo)).map(([k, load]) => {
  const p = load();
  p.catch(() => {}); // the card renders the rejection
  return [k, p];
}));

// qs: [[query, what, path], ...]. The first failure shows the card error, any pending one the skeleton.
function Body({ qs, skel, children }) {
  const failed = qs.find(([q]) => q.error);
  if (failed) return <ErrorState message={`Couldn't load ${failed[1]}: GET ${failed[2]}`} onRetry={failed[0].retry} />;
  if (qs.some(([q]) => q.data === undefined)) return <div aria-busy="true">{skel}</div>;
  return children(...qs.map(([q]) => q.data));
}

// A table card's body: n bones from the last shape (0 draws the empty line), then its rows or the empty line.
function List({ qs, rows, shape, cols, empty, children }) {
  const none = <p className="card-b meta">{empty}</p>;
  const table = (body) => <div className="tscroll"><table className="tbl" ref={shape.ref}><thead><tr>{cols.map(([c]) => <th key={c}>{c}</th>)}</tr></thead><tbody>{body}</tbody></table></div>;
  const skel = shape.n ? <div className="tscroll"><TableSkel cols={cols} rows={shape.n} widths={shape.widths} /></div> : none;
  return <Body qs={qs} skel={skel}>{() => (rows.length ? table(rows.map(children)) : none)}</Body>;
}

const Card = ({ id, title, end, className = "card", children }) =>
  <div id={id} className={className}><div className="card-h"><h3>{title}</h3>{end && <span className="end">{end}</span>}</div>{children}</div>;

// An inline "Saved." (role=status; ok null shows nothing) or the server's message (role=alert). run resolves true on success.
function useSaved() {
  const [msg, setMsg] = useState(null);
  const run = (p, ok = "Saved.") => { setMsg(null); return p.then(() => { setMsg(ok && { role: "status", text: ok }); return true; }, (e) => { setMsg({ role: "alert", text: e.message }); return false; }); };
  return [run, msg && <span className="meta" role={msg.role}>{msg.text}</span>];
}

// items: [[text, onClick], ...]; one Remove when left out.
const More = ({ label, onRemove, items = [["Remove", onRemove]] }) =>
  <Popover label={<Ic name="more" />} title={`More for ${label}`}>{items.map(([t, f]) => <button key={t} type="button" className="btn btn-ghost" onClick={f}>{t}</button>)}</Popover>;

function About({ name, s, path }) {
  const [description, setDescription] = useState(s.description), [language, setLanguage] = useState(s.language ?? "");
  const [saved, setSaved] = useState([s.description, s.language ?? ""]);
  const [run, msg] = useSaved();
  const save = async () => { if (await run(postJson(path, { description, language: language.trim() || null }, "PUT"))) setSaved([description, language]); };
  return <div className="form">
    <label className="field"><span>Name</span><input className="input mono w" readOnly value={name} /></label>
    <label className="field"><span>Description</span><input className="input w" maxLength={280} value={description} onChange={(e) => setDescription(e.target.value)} /></label>
    <label className="field"><span>Language</span><input className="input w" maxLength={40} value={language} onChange={(e) => setLanguage(e.target.value)} /></label>
    <div className="row"><button type="button" className="btn btn-primary" disabled={description === saved[0] && language === saved[1]} onClick={save}>Save about</button>{msg}</div>
  </div>;
}

function Repository({ s, branches, path, onSaved }) {
  const [branch, setBranch] = useState(s.default_branch), [strategy, setStrategy] = useState(s.strategy);
  const [saved, setSaved] = useState([s.default_branch, s.strategy]);
  const [run, msg] = useSaved();
  const save = async () => { if (await run(postJson(path, { default_branch: branch, strategy }, "PUT"))) { setSaved([branch, strategy]); onSaved(branch); } };
  const integration = branches.filter((b) => b.role === "integration");
  return <div className="form">
    <label className="field"><span>Default branch</span><select className="input mono" value={branch} onChange={(e) => setBranch(e.target.value)}>
      {branches.filter((b) => b.kind === "branch").map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}</select></label>
    <div className="field"><span>Branching strategy</span><Seg label="Branching strategy" options={STRATEGIES} value={strategy} onChange={setStrategy} /></div>
    <div className="field"><span>Integration branches</span><span className="row">{integration.length
      ? integration.map((b) => <span key={b.name} className="pill mono"><Ic name="lock" />{b.name}</span>) : <span className="meta">None</span>}</span>
      <span className="meta">Only the verifier merges into these.</span></div>
    <p>Verifier owns every merge on integration branches.</p>
    <div className="field"><span>Created</span><span>{new Date(s.created_at).toLocaleDateString("en")}</span></div>
    <div className="row"><button type="button" className="btn btn-primary" disabled={branch === saved[0] && strategy === saved[1]} onClick={save}>Save repository</button>{msg}</div>
  </div>;
}

const draftOf = (p) => ({ rules: p.rules.map((r) => ({ ...r, route: r.route.join(", ") })), release: p.release, check: p.check });
const bodyOf = (d) => ({ integration: d.rules.map((r) => r.branch), release: d.release, check: d.check,
  rules: d.rules.map((r) => ({ ...r, route: r.route.split(",").map((g) => g.trim()).filter(Boolean) })) });

// Branch | Role | Promotes to, for integration branches and release patterns.
function BranchTable({ caption, integration, release, promotions }) {
  // lazy: a pattern matches on a trailing * only, like release/*; use policy.js glob() if patterns grow.
  const to = (b) => promotions.filter((x) => (b.endsWith("*") ? x.branch.startsWith(b.slice(0, -1)) : x.branch === b)).map((x) => x.environment).join(", ") || "—";
  return <div className="tscroll"><table className="tbl" aria-label={caption}><caption className="meta">{caption}</caption>
    <thead><tr><th>Branch</th><th>Role</th><th>Promotes to</th></tr></thead>
    <tbody>{[...integration.map((b) => [b, "integration"]), ...release.map((b) => [b, "release"])].map(([b, role]) =>
      <tr key={`${role} ${b}`}><td className="mono">{b}</td><td><Tag>{role}</Tag></td><td className="meta">{to(b)}</td></tr>)}</tbody></table></div>;
}

const tablesOf = (d) => JSON.stringify([d.rules.map((r) => r.branch), d.release]);
const labelOf = (s) => STRATEGY_LABELS.find(([v]) => v === s)[1];

function Policy({ p, path, settingsPath, strategy, promotions, branch, onReload }) {
  const [d, setD] = useState(() => draftOf(p));
  const [add, setAdd] = useState({ branch: "", release: "" });
  const [msg, setMsg] = useState(null);
  // pick: the strategy being previewed; preview: {strategy, policy} or {strategy, error} once its GET settles.
  const [pick, setPick] = useState(null), [preview, setPreview] = useState(null);
  const shown = strategy === "custom" || tablesOf(d) !== tablesOf(draftOf(p)) ? "custom" : strategy;
  // Custom has no tables of its own: it only shows that they were edited by hand.
  const choose = (s) => {
    setPick(s === shown || s === "custom" ? null : s);
    if (s === shown || s === "custom") return;
    setPreview(null);
    fetchJson(`${path}/preview?strategy=${s}`).then((r) => {
      const { ok, errors } = validateBranchPolicy(r?.policy);
      if (!ok) throw new Error(`${path}/preview: ${errors.join("; ")}`);
      setPreview({ strategy: s, policy: r.policy });
    }).catch((e) => setPreview({ strategy: s, error: e.message }));
  };
  const ready = preview?.strategy === pick && preview.policy;
  const apply = () => { setMsg(null); postJson(settingsPath, { strategy: pick, apply: true }, "PUT").then(() => {
    setMsg({ ok: `Applied ${labelOf(pick)}: committed .cinder.yml to ${branch}.` }); setD(draftOf(ready)); setPick(null); onReload(); },
  (e) => setMsg(e.status === 409 ? { moved: true } : { err: e.message })); };
  const set = (k, v) => setD({ ...d, [k]: v });
  const rule = (i, k, v) => set("rules", d.rules.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const drop = (k, i) => set(k, d[k].filter((_, j) => j !== i));
  const typed = (k) => ({ value: add[k], onChange: (e) => setAdd({ ...add, [k]: e.target.value }) });
  const dirty = JSON.stringify(bodyOf(d)) !== JSON.stringify(bodyOf(draftOf(p)));
  const save = () => { setMsg(null); postJson(path, { ...bodyOf(d), base_sha: p.base_sha }, "PUT").then((r) => { setMsg({ ok: `Committed .cinder.yml · ${r.sha.slice(0, 7)}` }); onReload(); },
    (e) => setMsg(e.status === 409 ? { moved: true } : { err: e.message })); };
  const src = (k) => <Tag>{p.sources[k] ?? "default"}</Tag>;
  const none = (n, text) => <tr><td colSpan={n} className="meta">{text}</td></tr>;
  return <>
    <div className="form">
      <div className="field"><span>Branching strategy</span><Seg label="Branch policy strategy" options={STRATEGY_LABELS} value={pick ?? shown} onChange={choose} />
        {shown === "custom" && <span className="meta">Custom: the tables were edited by hand. Pick a strategy to preview what it would replace them with.</span>}</div>
      {pick && <div className="form" role="region" aria-label={`Preview: ${labelOf(pick)}`}>
        <p><b>Preview: {labelOf(pick)}</b> <span className="meta">replaces the tables below</span></p>
        {preview?.strategy === pick && preview.error ? <ErrorState message={`Couldn't preview ${labelOf(pick)}: ${preview.error}`} onRetry={() => choose(pick)} />
          : !ready ? <div aria-busy="true"><TableSkel cols={[["Branch", 120], ["Role"], ["Promotes to"]]} rows={2} /></div>
            : <>
              <BranchTable caption={`Now (${labelOf(shown)})`} integration={d.rules.map((r) => r.branch)} release={d.release} promotions={promotions} />
              <BranchTable caption={`After (${labelOf(pick)})`} integration={ready.integration} release={ready.release} promotions={promotions} />
            </>}
        {pick === "gitflow" && <p className="meta">Gitflow merges <code>develop</code> into <code>{branch}</code> as an ordinary change from develop into {branch}: the verifier checks and merges it like any other.</p>}
        <div className="row"><button type="button" className="btn btn-secondary" onClick={() => setPick(null)}>Keep mine</button>
          <button type="button" className="btn btn-primary" disabled={!ready} onClick={apply}>Apply {labelOf(pick)}</button></div>
      </div>}
    </div>
    <div className="tscroll"><table className="tbl">
      <thead><tr><th>Branch</th><th>Merge queue</th><th>Trusted judges needed</th><th>Auto-merge if risk ≤</th><th>Route to a person</th><th>Source</th><th /></tr></thead>
      <tbody>{d.rules.length ? d.rules.map((r, i) => <tr key={r.branch}>
        <td className="mono">{r.branch}</td>
        <td><Toggle label={`Merge queue on ${r.branch}`} checked={r.queue} onChange={(v) => rule(i, "queue", v)} /></td>
        <td><input className="input mono num" type="number" min="1" max="4" aria-label={`Trusted judges needed on ${r.branch}`} value={r.judges} onChange={(e) => rule(i, "judges", Number(e.target.value))} /></td>
        <td><span className="row"><input className="input mono num" type="number" min="1" max="50" aria-label={`Auto-merge risk on ${r.branch}`} value={r.risk} onChange={(e) => rule(i, "risk", Number(e.target.value))} />%
          <span className="meta">trusted risk judge only</span></span></td>
        <td><input className="input mono w" placeholder="none" aria-label={`Route to a person on ${r.branch}`} value={r.route} onChange={(e) => rule(i, "route", e.target.value)} /></td>
        <td>{src("integration")}</td><td><More label={r.branch} onRemove={() => drop("rules", i)} /></td>
      </tr>) : none(7, "No integration branches.")}</tbody>
    </table></div>
    <div className="row pad"><input className="input mono" aria-label="New integration branch" {...typed("branch")} />
      <button type="button" className="btn btn-secondary btn-sm" disabled={!add.branch.trim() || d.rules.some((r) => r.branch === add.branch.trim())}
        onClick={() => { set("rules", [...d.rules, { branch: add.branch.trim(), ...NEW_RULE }]); setAdd({ ...add, branch: "" }); }}>Add</button></div>
    <div className="tscroll"><table className="tbl"><thead><tr><th>Release branches</th><th>Source</th><th /></tr></thead>
      <tbody>{d.release.length ? d.release.map((g, i) => <tr key={g}><td className="mono">{g}</td><td>{src("release")}</td><td><More label={g} onRemove={() => drop("release", i)} /></td></tr>)
        : none(3, "No release branches.")}</tbody></table></div>
    <div className="row pad"><input className="input mono" placeholder="release/*" aria-label="New release branch pattern" {...typed("release")} />
      <button type="button" className="btn btn-secondary btn-sm" disabled={!add.release.trim() || d.release.includes(add.release.trim())} onClick={() => { set("release", [...d.release, add.release.trim()]); setAdd({ ...add, release: "" }); }}>Add</button></div>
    <div className="form">
      <label className="field"><span>Check command {src("check")}</span><input className="input mono w" required value={d.check} onChange={(e) => set("check", e.target.value)} /></label>
    </div>
    <div className="srow"><p>Saving commits <code>.cinder.yml</code> to {branch} as you.</p>
      {msg?.ok && <span className="meta" role="status">{msg.ok}</span>}
      {msg?.err && <span className="meta" role="alert">{msg.err}</span>}
      {msg?.moved && <span className="meta" role="alert">{branch} moved since this page loaded. <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setMsg(null); onReload(); }}>Reload</button></span>}
      <button type="button" className="btn btn-primary end" disabled={!dirty} onClick={save}>Save policy</button></div>
  </>;
}

function Flaky({ s, path }) {
  const [pct, setPct] = useState(String(Math.round(s.flake_quarantine * 100)));
  const [auto, setAuto] = useState(s.auto_quarantine);
  const [run, msg] = useSaved();
  const [runAuto, autoMsg] = useSaved();
  const toggle = (v) => { setAuto(v); runAuto(postJson(path, { auto_quarantine: v }, "PUT")).then((ok) => ok || setAuto(!v)); };
  return <>
    <div className="srow"><div><h3>Quarantine automatically</h3><p className="meta">A test over the flake rate below leaves the verdict until someone releases it.</p></div>
      <span className="end row"><Toggle label="Quarantine automatically" checked={auto} onChange={toggle} />{autoMsg}</span></div>
    <div className="srow"><h3>Quarantine a check when its flake rate exceeds</h3>
    <span className="end row"><input className="input mono num" type="number" min="0" max="100" aria-label="Flake rate" value={pct} onChange={(e) => setPct(e.target.value)} />%
      <button type="button" className="btn btn-secondary" disabled={pct === ""} onClick={() => run(postJson(path, { flake_quarantine: Number(pct) / 100 }, "PUT"))}>Save</button>{msg}</span></div>
  </>;
}

function Quarantined({ repo, api, list }) {
  const [run, msg] = useSaved();
  const held = list.data?.filter((f) => f.quarantined_since);
  const shape = useShape(`settings/${repo}/quarantined`, 1, held?.length);
  return <>
    <List qs={[[list, "flaky tests", `${api}/flakes`]]} rows={held} shape={shape} cols={[["Quarantined test"], ["Flake rate"], ["Since"], ["By"], [""]]}
      empty="No tests are quarantined. Every test counts in the verdict.">
      {(f) => <tr key={f.test}><td className="mono">{f.test}</td><td className="mono">{Math.round(f.rate * 100)}% <span className="meta">{f.flakes}/{f.runs}</span></td>
        <td className="meta">{sinceDay(f.quarantined_since)}</td><td>{f.quarantined_by}</td>
        <td><button type="button" className="btn btn-secondary btn-sm" onClick={() => run(releaseFlake(repo, f.test), null).then((ok) => ok && list.retry())}>Release from quarantine</button></td></tr>}
    </List>
    {msg && <p className="card-b">{msg}</p>}
  </>;
}

function Mirror({ s, path }) {
  const [url, setUrl] = useState(s.mirror_url ?? "");
  const [run, msg] = useSaved();
  return <div className="srow"><h3>Push merged changes to a mirror</h3>
    <span className="end row"><input className="input mono" type="url" placeholder="https://" aria-label="Mirror URL" value={url} onChange={(e) => setUrl(e.target.value)} />
      <button type="button" className="btn btn-secondary" onClick={() => run(postJson(path, { mirror_url: url.trim() }, "PUT"))}>Save</button>{msg}</span></div>;
}

function RepoRoles({ repo, api, people, everyone, roles }) {
  const [add, setAdd] = useState({ email: "", role: "" });
  const [run, msg] = useSaved();
  const shape = useShape(`settings/${repo}/people`, 2, people.data?.length);
  const at = (email) => `${api}/people/${encodeURIComponent(email)}`;
  const names = roles.data?.map((r) => r.name) ?? [];
  const held = new Set(people.data?.map((p) => p.email));
  const free = everyone.data?.filter((p) => !held.has(p.email)) ?? [];
  const roleSelect = (label, value, onChange) => <select className="input" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
    {value === "" && <option value="">Role</option>}{names.map((r) => <option key={r} value={r}>{r}</option>)}</select>;
  const ready = people.data && everyone.data && roles.data;
  return <Card id="repo-roles" title="Repo roles">
    <List qs={[[people, "repo roles", `${api}/people`], [everyone, "people", "/api/people"], [roles, "roles", "/api/roles"]]} rows={people.data} shape={shape}
      cols={[["Who"], ["Role"], ["From"], [""]]} empty="No repo roles. Everyone has their own role here.">
      {(p) => <tr key={p.email}>
        <td><span className="who"><span className="av">{p.email[0].toUpperCase()}</span>{p.email.split("@")[0]}</span> <span className="meta">{p.email}</span></td>
        <td>{roleSelect(`Repo role of ${p.email}`, p.role, (role) => run(postJson(at(p.email), { role }, "PUT")).then((ok) => ok && people.retry()))}</td>
        <td className="meta">{p.set_by ?? "—"} · {p.at ? ago(p.at) : "—"}</td>
        <td><More label={p.email} onRemove={() => confirm(`Remove ${p.email}'s repo role?`) && run(postJson(at(p.email), undefined, "DELETE"), null).then((ok) => ok && people.retry())} /></td>
      </tr>}
    </List>
    <div className="row pad">
      <select className="input" aria-label="Person" value={add.email} disabled={!ready} onChange={(e) => setAdd({ ...add, email: e.target.value })}>
        <option value="">Person</option>{free.map((p) => <option key={p.email} value={p.email}>{p.email}</option>)}</select>
      {roleSelect("New repo role", add.role, (role) => setAdd({ ...add, role }))}
      <button type="button" className="btn btn-secondary" disabled={!ready || !add.email || !add.role}
        onClick={() => run(postJson(at(add.email), { role: add.role }, "PUT"), null).then((ok) => { if (ok) { setAdd({ email: "", role: "" }); people.retry(); } })}>Add role</button>
      {msg}
    </div>
    <p className="card-b meta">A repo role adds to the person&apos;s own role. It never removes access.</p>
  </Card>;
}

const ROUTE_TO = [["agent", "Agent"], ["driver", "Person"], ["reviewer", "Reviewer"]];

// The repo's label rules in match order: each saves the whole list (PUT), then the card reloads it.
function LabelRouting({ repo, api, routing }) {
  const [add, setAdd] = useState({ label: "", to: "agent", who: "" });
  const [run, msg] = useSaved();
  const rules = routing.data?.rules;
  const shape = useShape(`settings/${repo}/routing`, 1, rules?.length);
  const save = (next) => run(putRouting(repo, next), null).then((ok) => { if (ok) routing.retry(); return ok; });
  return <Card id="routing" title="Label routing">
    <List qs={[[routing, "label routing", `${api}/routing`]]} rows={rules} shape={shape} cols={[["When a change or intent gets"], ["Route to"], ["Who"], [""]]} empty="No rules yet.">
      {(r, i) => {
        const [k, l] = ROUTE_TO.find(([k]) => r[k]);
        return <tr key={i}><td><Tag>{r.label}</Tag></td><td>{l}</td><td className="mono">{r[k]}</td>
          <td><button type="button" className="iconbtn" aria-label={`Remove rule ${i + 1}`} onClick={() => save(rules.filter((_, j) => j !== i))}><Ic name="x" /></button></td></tr>;
      }}
    </List>
    <div className="row pad">
      <input className="input" aria-label="Rule label" placeholder="Label" value={add.label} onChange={(e) => setAdd({ ...add, label: e.target.value })} />
      <select className="input" aria-label="Route to" value={add.to} onChange={(e) => setAdd({ ...add, to: e.target.value })}>
        {ROUTE_TO.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
      <input className="input mono" aria-label="Who" placeholder={add.to === "agent" ? "developer@stable" : "name@example.com"} value={add.who} onChange={(e) => setAdd({ ...add, who: e.target.value })} />
      <button type="button" className="btn btn-secondary" disabled={!rules || !add.label.trim() || !add.who.trim()}
        onClick={() => save([...rules, { label: add.label.trim(), [add.to]: add.who.trim() }]).then((ok) => ok && setAdd({ label: "", to: "agent", who: "" }))}><Ic name="plus" />Add rule</button>
      {msg}
    </div>
    <p className="card-b meta">Agent: it picks the intent up. Person: assigned to drive it. Reviewer: requested on the change. First matching rule wins.</p>
  </Card>;
}

// Add webhook and Rotate end on the same secret view: shown once, gone when the modal closes.
function HookModal({ api, modal, onClose, onDone }) {
  const [url, setUrl] = useState(""), [events, setEvents] = useState(modal.hook?.events ?? EVENTS);
  const [secret, setSecret] = useState(null), [err, setErr] = useState(null);
  const send = (p) => { setErr(null); p.then((r) => { onDone(); if (r?.secret) setSecret(r.secret); else onClose(); }, (e) => setErr(e.message)); };
  const hook = modal.hook && `${api}/webhooks/${encodeURIComponent(modal.hook.id)}`;
  const alert = err && <p className="meta" role="alert">{err}</p>;
  if (secret) {
    return <Modal title="Signing secret" onClose={onClose} foot={<button type="button" className="btn btn-primary" onClick={onClose}>Done</button>}>
      <label className="field"><span>Signing secret</span><span className="row"><input className="input mono w" readOnly value={secret} />
        <button type="button" className="ib" aria-label="Copy secret" onClick={() => navigator.clipboard.writeText(secret)}><Ic name="copy" /></button></span></label>
      <p className="meta">Shown once. Store it where your receiver reads it.</p>
    </Modal>;
  }
  if (modal.kind === "rotate") {
    return <Modal title="Rotate secret?" onClose={onClose} foot={<button type="button" className="btn btn-primary" onClick={() => send(postJson(`${hook}/rotate`))}>Rotate</button>}>
      <p>The old secret stops working at once.</p>{alert}</Modal>;
  }
  if (modal.kind === "delete") {
    return <Modal title="Delete webhook?" onClose={onClose} foot={<button type="button" className="btn btn-danger" onClick={() => send(postJson(hook, undefined, "DELETE"))}>Delete</button>}>
      <p className="mono">{modal.hook.url}</p>{alert}</Modal>;
  }
  const boxes = EVENTS.map((ev) => <label key={ev} className="row"><input type="checkbox" checked={events.includes(ev)}
    onChange={(e) => setEvents(e.target.checked ? [...events, ev] : events.filter((x) => x !== ev))} />{ev}</label>);
  if (modal.kind === "events") {
    return <Modal title="Edit events" onClose={onClose}
      foot={<button type="button" className="btn btn-primary" disabled={!events.length} onClick={() => send(postJson(hook, { events }, "PATCH"))}>Save</button>}>
      <p className="mono">{modal.hook.url}</p>{boxes}{alert}</Modal>;
  }
  return <Modal title="Add webhook" onClose={onClose}
    foot={<button type="button" className="btn btn-primary" disabled={!url.startsWith("https://") || !events.length} onClick={() => send(postJson(`${api}/webhooks`, { url, events }))}>Add</button>}>
    <label className="field"><span>URL</span><input className="input mono w" type="url" required placeholder="https://" value={url} onChange={(e) => setUrl(e.target.value)} /></label>
    {boxes}{alert}
  </Modal>;
}

function Webhooks({ repo, api, hooks }) {
  const shape = useShape(`settings/${repo}/webhooks`, 1, hooks.data?.length);
  const [modal, setModal] = useState(null);
  const delivery = (d) => (!d ? <span className="pill">never</span>
    : <><span className="pill"><span className={`dot ${d.ok ? "ok" : "bad"}`} />{d.ok ? "delivered" : "failing"}</span> <span className="meta">{d.status ?? d.error} · {ago(d.at)}</span></>);
  return <Card id="webhooks" title="Webhooks" end={<button type="button" className="btn btn-secondary btn-sm" disabled={!hooks.data} onClick={() => setModal({ kind: "add" })}>Add webhook</button>}>
    <List qs={[[hooks, "webhooks", `${api}/webhooks`]]} rows={hooks.data} shape={shape} cols={[["URL"], ["Events"], ["Last delivery"], ["Created"], [""]]}
      empty="No webhooks. Add one to receive signed change, verdict and judgment events.">
      {(h) => <tr key={h.id}><td className="mono">{h.url}</td><td>{h.events.map((e) => <Tag key={e}>{e}</Tag>)}</td><td>{delivery(h.last_delivery)}</td>
        <td className="meta">{ago(h.created_at)}</td>
        <td className="num"><button type="button" className="btn btn-secondary btn-sm" onClick={() => setModal({ kind: "rotate", hook: h })}>Rotate secret</button>
          <More label={h.url} items={[["Edit events", () => setModal({ kind: "events", hook: h })], ["Delete", () => setModal({ kind: "delete", hook: h })]]} /></td></tr>}
    </List>
    {modal && <HookModal api={api} modal={modal} onClose={() => setModal(null)} onDone={hooks.retry} />}
  </Card>;
}

function Reimport({ repo, onClose, onStarted }) {
  const [f, setF] = useState({ url: "", branch: "", token: "" });
  const [err, setErr] = useState(null);
  const field = (k) => ({ value: f[k], onChange: (e) => setF({ ...f, [k]: e.target.value }) });
  const send = () => {
    setErr(null);
    // The token is used for this request only: the field empties whatever the outcome.
    postJson(`/api/repos/${encodeURIComponent(repo)}/import`, { url: f.url, branch: f.branch || undefined, token: f.token || undefined })
      .then(() => onStarted(f.url), (e) => setErr(e.message));
    setF({ ...f, token: "" });
  };
  return <Modal title={`Re-import ${repo}`} onClose={onClose} foot={<button type="button" className="btn btn-primary" disabled={!f.url} onClick={send}>Re-import</button>}>
    <label className="field"><span>Clone URL</span><input className="input mono w" type="url" required {...field("url")} /></label>
    <label className="field"><span>Branch</span><input className="input mono w" placeholder="optional" {...field("branch")} /></label>
    <label className="field"><span>Token</span><input className="input mono w" type="password" aria-label="Token" placeholder="kept encrypted in Keystore for re-imports; remove it there" {...field("token")} /></label>
    {err && <p className="meta" role="alert">{err}</p>}
  </Modal>;
}

function Danger({ repo, me }) {
  const [modal, setModal] = useState(null), [err, setErr] = useState(null);
  const navigate = useNavigate();
  const archive = () => postJson(`/api/repos/${encodeURIComponent(repo)}/archive`).then(() => navigate("/"), (e) => setErr(e.message));
  return <Card id="danger-zone" title="Danger zone" className="card dng">
    <div className="srow"><div><h3>Archive this repo</h3><p>It leaves Repositories and refuses pushes. Restore it from Repositories › Archived.</p></div>
      <button type="button" className="btn btn-danger end" onClick={() => setModal("archive")}>Archive</button></div>
    <Body qs={[[me, "owner check", "/api/me"]]} skel={null}>{(m) => m.owner && <div className="srow"><div><h3>Delete this repo</h3>
      <p>Deletes the repo, its history, changes, policy and webhooks. This can&apos;t be undone.</p></div>
      <button type="button" className="btn btn-danger end" onClick={() => setModal("delete")}>Delete…</button></div>}</Body>
    {modal === "archive" && <Modal title={`Archive ${repo}?`} onClose={() => setModal(null)} foot={<button type="button" className="btn btn-danger" onClick={archive}>Archive</button>}>
      <p>It leaves Repositories and refuses pushes until restored.</p>{err && <p className="meta" role="alert">{err}</p>}</Modal>}
    {modal === "delete" && <DeleteRepo name={repo} onClose={() => setModal(null)} />}
  </Card>;
}

export function Settings() {
  const repo = useRouteLoaderData("repo");
  return <Page key={repo.name} repo={repo} />;
}

function Page({ repo }) {
  const api = `/api/repos/${encodeURIComponent(repo.name)}`;
  const path = { settings: `${api}/settings`, policy: `${api}/policy` };
  const first = useLoaderData(), r = reads(repo.name);
  // A fixed list, so the hooks run in the same order every render.
  const [settings, branches, policy, groups, people, everyone, roles, hooks, me, promotions, flaky, routing] =
    ["settings", "branches", "policy", "groups", "people", "everyone", "roles", "webhooks", "me", "promotions", "flakes", "routing"].map((k) => useGet(r[k], first[k]));
  const [branch, setBranch] = useState(repo.default_branch);
  const [importing, setImporting] = useState(null), [reimport, setReimport] = useState(false);
  const { hash } = useLocation();
  useEffect(() => { if (hash) document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView(); }, [hash]);
  // The nav marks the first section crossing the top third of the viewport.
  const [inView, setInView] = useState(SECTIONS[0][0]);
  useEffect(() => {
    const io = new IntersectionObserver((es) => { const e = es.find((x) => x.isIntersecting); if (e) setInView(e.target.id); }, { rootMargin: "0px 0px -66% 0px" });
    for (const [id] of SECTIONS) { const el = document.getElementById(id); if (el) io.observe(el); }
    return () => io.disconnect();
  }, []);
  const s = [settings, "settings", path.settings];
  const mine = groups.data?.filter((g) => !g.repos.length || g.repos.includes(repo.name));
  const groupShape = useShape(`settings/${repo.name}/groups`, 3, mine?.length);
  const policyShape = useShape(`settings/${repo.name}/policy`, [1, 1], policy.data && [policy.data.rules.length, policy.data.release.length]);
  // A .cinder.yml the parser rejects comes back as its message: show it with the Code link, since Retry would fail the same way.
  const unreadable = /→ \d+ (\.cinder\.yml:.*?)(?: · req|$)/.exec(policy.error?.message ?? "")?.[1];
  const codeLink = <Link to={codePath(repo.name, branch, ".cinder.yml")}>Edit <code>.cinder.yml</code> in Code ↗</Link>;
  const p = policy.data;
  return <Frame className="rs" head={<div><h1>Settings</h1><p>Configuration for {repo.name}. Branch policy and judges also live in <code>.cinder.yml</code>.</p></div>}>
    <div className="set">
    <nav className="set-nav" aria-label="Settings sections">{SECTIONS.map(([id, label]) =>
      <a key={id} href={`#${id}`} aria-current={inView === id ? "true" : undefined} onClick={() => setInView(id)}>{label}</a>)}</nav>
    <div className="stack">
    <Card id="about" title="About"><Body qs={[s]} skel={<div className="form"><BoneText /><BoneText i={1} /></div>}>{(d) => <About name={repo.name} s={d} path={path.settings} />}</Body></Card>
    <Card id="repository" title="Repository"><Body qs={[s, [branches, "branches", `${api}/branches`]]} skel={<div className="form"><BoneText /><BoneText i={1} /><BonePill /><BoneText i={2} /></div>}>
      {(d, b) => <Repository s={d} branches={b} path={path.settings} onSaved={(next) => { setBranch(next); policy.retry(); }} />}</Body></Card>
    {p?.defaulted && <div className="card"><div className="srow"><Ic name="info" /><p>No <code>.cinder.yml</code> yet. These are the defaults; saving commits one to {branch}.</p></div></div>}
    <Card id="branch-policy" title="Branch policy" end={p && <span className="pill">{p.defaulted ? "defaults" : <>from <code>.cinder.yml</code></>}</span>}>
      {unreadable ? <div className="err" role="alert"><span>{unreadable}</span>{codeLink}</div>
        : <Body qs={[[policy, "branch policy", path.policy], s, [promotions, "branch deploys", `${api}/branch-deploys`]]} skel={<>{policyShape.n.map((n, i) => (n ? <TableSkel key={i} cols={[["Branch", 120], ["Source"]]} rows={n} /> : null))}</>}>
          {(d, st, pr) => <Policy p={d} path={path.policy} settingsPath={path.settings} strategy={st.strategy} promotions={pr} branch={branch}
            onReload={() => { policy.retry(); settings.retry(); }} />}</Body>}
    </Card>
    <Card title={<>Also read from <code>.cinder.yml</code></>}>
      <Body qs={[[policy, "branch policy", path.policy]]} skel={<div className="card-b"><BoneText /></div>}>{(d) => <dl className="card-b kv2">
        {[["Stages", d.stages && Object.entries(d.stages).map(([k, v]) => `${k}: ${v}`).join(", ")], ["Overlap", d.overlap],
          ["Unresolved threads block merge", d.review?.require_resolved && "yes"], ["Wiki context", d.wiki?.context && "on"]]
          .map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd className="mono">{v || <span className="subtle">not set</span>}</dd><span /></Fragment>)}
      </dl>}</Body>
      <p className="card-b">{codeLink}</p>
    </Card>
    <RepoRoles repo={repo.name} api={api} people={people} everyone={everyone} roles={roles} />
    <LabelRouting repo={repo.name} api={api} routing={routing} />
    <Card title="Groups with access" end={<Link to="/settings/access">Settings › Access &amp; people →</Link>}>
      <List qs={[[groups, "groups", "/api/groups"]]} rows={mine} shape={groupShape} cols={[["Source"], ["Group"], ["Role"], ["Scope"]]}
        empty="No group grants this repo. Map one in Access & people.">
        {(g) => <tr key={g.name}><td className="meta">{g.source}</td><td className="mono">{g.name}</td><td><Tag>{g.role}</Tag></td><td>{g.repos.length ? "this repo" : "all repos"}</td></tr>}
      </List>
    </Card>
    <Card id="flaky-checks" title="Flaky checks"><Body qs={[s]} skel={<div className="srow"><BoneText /></div>}>{(d) => <Flaky s={d} path={path.settings} />}</Body>
      <Quarantined repo={repo.name} api={api} list={flaky} /></Card>
    <Webhooks repo={repo.name} api={api} hooks={hooks} />
    <Card id="environments" title="Environments">
      <p className="card-b">Environments come from <code>.cinder.yml</code> under <code>deploy</code>. Manage them in <Link to={`/${encodeURIComponent(repo.name)}/environments`}>Automation › Environments</Link>.</p>
    </Card>
    <Card id="mirror" title="Mirror"><Body qs={[s]} skel={<div className="srow"><BoneText /></div>}>{(d) => <Mirror s={d} path={path.settings} />}</Body></Card>
    <Card id="import" title="Import"><Body qs={[s]} skel={<div className="srow"><BoneText /></div>}>{(d) => <div className="srow">
      <div><h3>Re-import this repo</h3><p>Replaces a repo that holds nothing but <code>.cinder.yml</code>, keeping the policy.</p>
        {!d.can_reimport && <p className="meta">This repo has files, so it can&apos;t be re-imported.</p>}
        {importing && <p className="meta" role="status">Importing from {importing}. Code shows the files once it lands.</p>}</div>
      <button type="button" className="btn btn-secondary end" disabled={!d.can_reimport} onClick={() => setReimport(true)}>Re-import…</button></div>}</Body>
      {reimport && <Reimport repo={repo.name} onClose={() => setReimport(false)} onStarted={(url) => { setReimport(false); setImporting(url); }} />}
    </Card>
    <Danger repo={repo.name} me={me} />
    </div></div>
  </Frame>;
}
