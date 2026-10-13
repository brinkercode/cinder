// Automation › Agents.
import { Suspense, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Await, Link, useAsyncError, useLoaderData, useNavigate, useParams, useRevalidator, useSearchParams } from "react-router";
import { agentHistory, agentVersion, agentVersions, moveChannel } from "./api/agents.js";
import { BudgetBanner } from "./budget.jsx";
import { Ring } from "./charts.jsx";
import { agentDetail, agentDiff, agentsPage, invalidate, modelAccess, modelCatalog, postJson, releaseDraft } from "./client.js";
import { Ic } from "./icons.jsx";
import { Markdown } from "./lib/markdown.jsx";
import "./styles/automation-agents.css";
import { ago } from "./repos.jsx";
import { Bone, BonePill, ListCardSkel, LoadingRegion, TableSkel, TileSkel, useShape } from "./skeleton.jsx";
import { ChangeId, Dialog, Dot, EmptyState, ErrorState, Tabs, Tag, Tile, Toggle, Untrusted, tok, Frame, Loaded } from "./ui.jsx";

const HARN = [["claude-code", "Claude Code", "Anthropic models only"], ["codex", "Codex", "OpenAI models with the Responses API"], ["opencode", "OpenCode", "Any provider"]];
const SRC = { credits: ["coins", "Cloudflare credits"], org: ["users", "Org key"], mine: ["key", "My key"] };
const GATEWAY = "https://dash.cloudflare.com/?to=/:account/ai/ai-gateway";
const DOCS = "https://developers.cloudflare.com/workers-ai/models/";
const TABS = [["runs", "Runs"], ["versions", "History"], ["settings", "Settings & prompt"], ["races", "Races"]];
const base = (name) => `/automation/agents/${encodeURIComponent(name)}`;
const prompt0 = (name) => `You are the ${name} agent. Take one intent, make the smallest change that satisfies it, and hand it to the verifier with a plan and the files you touched.\n`;
const Pill = ({ tone, children }) => <span className="pill">{tone !== undefined && <Dot tone={tone} />}{children}</span>;
const Chan = ({ ch }) => <Pill tone={ch === "stable" ? "ok" : "warn"}>{ch}</Pill>;
// name@vN links to that version on the Versions tab; anything else (a draft, a person) stays text.
const AgentRef = ({ id }) => {
  const m = /^([a-z0-9-]+)@v(\d+)$/.exec(id);
  return m ? <Link className="mono" to={`${base(m[1])}/versions?v=${m[2]}`}>{id}</Link> : <span className="mono">{id}</span>;
};
const rid = (id) => id.replace(/^inherited:/, "").slice(0, 8);
const usd = (n) => `$${n.toFixed(2)}`, k = (n) => (n == null ? "—" : tok(n));

// The version an agent shows (stable, else its newest), its canary and its decided races.
function view(a, fleet) {
  const at = (ch) => a.channels.find((c) => c.channel === ch)?.version;
  const n = at("stable") ?? Math.max(...a.versions.map((v) => v.version));
  const v = a.versions.find((x) => x.version === n);
  const f = fleet.agents.find((x) => x.name === a.name) ?? { role: "", tokens: 0, repos: 0, merged: 0, running: false, runs_24h: 0, tokens_24h: 0, cost_24h: 0, run: null };
  return { ...f, name: a.name, v, ch: at("stable") ? "stable" : "canary", canary: at("canary") !== n ? at("canary") : null, races: a.versions.reduce((s, x) => s + (x.races ?? 0), 0) };
}

// Win rate of the shown version: fewer than 20 decided races is untrusted, never a percentage.
const Win = ({ v }) => (v.races >= 20 ? <><b>{Math.round((v.wins / v.races) * 1000) / 10}%</b> <span>n={v.races}</span></> : <Untrusted n={v.races ?? 0} />);
const WinTile = ({ v }) => <Tile label="Win rate" value={v.races >= 20 ? `${Math.round((v.wins / v.races) * 1000) / 10}%` : "—"} sub={v.races >= 20 ? `n=${v.races}` : null} untrusted={v.races ?? 0} />;

const Failed = ({ what }) => <div className="card"><ErrorState message={`Couldn't load ${what}: ${useAsyncError().message}`} onRetry={useRevalidator().revalidate} /></div>;
// Loading, empty and error keep the index toolbar in place, disabled.
const OffBar = () => <div className="tb-in"><label className="q"><Ic name="search" /><input placeholder="Search agents" aria-label="Search agents" disabled /></label>
  <button type="button" aria-label="Refresh" disabled><Ic name="refresh" /></button></div>;
const NoAgents = ({ action }) => <div className="card"><EmptyState icon="robot" title="No agents registered" action={action}>Register an agent to let it pick up intents.</EmptyState></div>;
const NoRuns = <div className="card"><EmptyState icon="pulse" title="No runs yet">AI Gateway has logged no call for this agent.</EmptyState></div>;
function IndexSkel() {
  const { n } = useShape("agents//index", 4);
  return <LoadingRegion page="Agents" busy><OffBar />{n ? <div className="stack">{Array.from({ length: n }, (_, i) => <ListCardSkel key={i} />)}</div>
    : <NoAgents action={<button type="button" className="btn btn-primary" disabled><Ic name="plus" />New agent</button>} />}</LoadingRegion>;
}
const FleetSkel = () => <>
  <h2>Fleet</h2>
  <div className="grid2"><TileSkel label="Running" /><TileSkel label="Races · 24h" /></div>
  <div className="card"><div className="card-h"><h3>Tokens this period</h3></div><div className="card-b budget"><Ring pct={null} label="" /></div></div>
  <div className="card"><div className="card-b"><h3>Canary auto-promote</h3><p className="meta">Promote a canary to stable once it wins 60% of 30 races.</p></div></div>
</>;
function DetailSkel() {
  const { name, tab } = useParams(), navigate = useNavigate();
  const calls = useShape(`agents/${name}/calls`, 4);
  return <LoadingRegion page="Agent" busy>
    <div className="row"><span className="lc-ico"><Ic name="robot" /></span><Bone w={160} h={12} /><BonePill w={32} /><BonePill />
      <span className="push"><Tabs label="Agent views" options={TABS} value={TABS.some(([x]) => x === tab) ? tab : "runs"} onChange={(t) => navigate(`${base(name)}/${t}`)} /></span></div>
    <div className="tiles">{["Runs · 24h", "Tokens · 24h", "Cost · 24h", "Win rate"].map((l) => <TileSkel key={l} label={l} />)}</div>
    {calls.n ? <div className="card"><div className="tscroll"><TableSkel cols={[["Model", 140], ["Call"], ["Input", 56], ["Output", 56], ["Cost", 48], ["Latency", 40]]} rows={calls.n} widths={calls.widths} /></div></div> : NoRuns}
  </LoadingRegion>;
}
// Not awaited, so the head shows at once; <Await> renders a rejection, and the catch only stops an unhandled-rejection report.
const deferred = (data) => { data.catch(() => {}); return { data }; };
export const agentsLoader = () => deferred(agentsPage());
// A catalog that fails to load leaves the rest of the page up: the Settings tab shows its error with Retry.
export const agentLoader = ({ params }) => deferred(Promise.all([agentsPage(), agentDetail(params.name), Promise.all([modelCatalog(), modelAccess()]).catch((e) => e)]));

const intro = <div><h1>Agents<a className="docs" href={DOCS} target="_blank" rel="noreferrer">View docs</a></h1><p>Registered agents, their channels and how often they win races.</p></div>;

// The routes' hydrate fallbacks: the real head and aside, New agent disabled, then the skeleton.
export const AgentsLoading = () => <Frame className="ag" head={<>{intro}
  <div className="acts"><button type="button" className="btn btn-primary" disabled><Ic name="plus" />New agent</button></div></>} aside={<FleetSkel />}><IndexSkel /></Frame>;
export const AgentLoading = () => <Frame className="ag"><DetailSkel /></Frame>;

export function Agents() {
  const { data } = useLoaderData();
  const wizard = useRef(null), [msg, setMsg] = useState("");
  const add = <button type="button" className="btn btn-primary" onClick={() => wizard.current.open()}><Ic name="plus" />New agent</button>;
  return <Frame className="ag" head={<>{intro}
      <div className="acts"><Loaded data={data} reason="Available once the agents list loads">{add}</Loaded></div></>} aside={<Suspense fallback={<FleetSkel />}><Await resolve={data} errorElement={<></>}>{(d) => <Fleet d={d} />}</Await></Suspense>}>
      <BudgetBanner />
      {msg && <p className="meta" role="status">{msg}</p>}
      <Suspense fallback={<IndexSkel />}><Await resolve={data} errorElement={<><OffBar /><Failed what="agents" /></>}>{(d) => <Index d={d} add={add} />}</Await></Suspense>
    <Wizard ref={wizard} list={data} onCreated={setMsg} />
  </Frame>;
}

function Index({ d, add }) {
  const { revalidate } = useRevalidator(), [q, setQ] = useState("");
  useShape("agents//index", 4, d.agents.length);
  if (!d.agents.length) return <><OffBar /><NoAgents action={add} /></>;
  const shown = d.agents.map((a) => view(a, d.fleet)).filter((a) => `${a.name} ${a.role}`.includes(q.trim().toLowerCase()));
  return <>
    <div className="tb-in">
      <label className="q"><Ic name="search" /><input placeholder="Search agents" aria-label="Search agents" value={q} onChange={(e) => setQ(e.target.value)} /></label>
      <button type="button" aria-label="Refresh" onClick={() => { invalidate(); revalidate(); }}><Ic name="refresh" /></button>
    </div>
    <div className="stack">{shown.map((a) => <div className="lc" key={a.name}>
      <div className="lc-m"><span className="lc-ico"><Ic name="robot" /></span>
        <div className="grow"><div className="lc-t"><Link className="card-link mono" to={base(a.name)}>{a.name}</Link><Tag>v{a.v.version}</Tag><Chan ch={a.ch} />
          {a.canary && <Pill><Ic name="ur" />canary v{a.canary}</Pill>}</div>
          <div className="lc-s">{[a.role, a.v.harness, `${a.repos} repos`].filter(Boolean).join(" · ")}</div></div>
        <span className="lc-time">{a.paused ? <Pill tone="warn">paused · budget</Pill> : a.running ? <Pill tone="ok">running</Pill> : <Pill tone="">idle</Pill>}</span></div>
      <div className="lc-f">{a.paused && <span><Ic name="token" />Paused: budget reached · resumes {new Date(a.paused.resumes_at).toLocaleDateString("en", { month: "short", day: "numeric", timeZone: "UTC" })}</span>}
        <span><Ic name="chart" />Win rate <Win v={a.v} /></span>
        <span className="r"><span><Ic name="token" /><b>{tok(a.tokens)}</b> tokens</span><span><Ic name="merge" /><b>{a.merged}</b> merged</span><span><Ic name="bolt" /><b>{a.races}</b> races</span></span></div>
    </div>)}</div>
  </>;
}

function Fleet({ d }) {
  const { revalidate } = useRevalidator(), [err, setErr] = useState("");
  const all = d.agents.map((a) => view(a, d.fleet)), total = all.reduce((s, a) => s + a.tokens, 0), top = all.toSorted((a, b) => b.tokens - a.tokens)[0];
  const pct = total ? Math.round((top.tokens / total) * 100) : null, day = d.races.filter((r) => Date.now() - Date.parse(r.legs[0].started_at) < 864e5).length;
  const [auto, setAuto] = useState(d.fleet.canary_auto_promote);
  const toggle = (on) => { setAuto(on); postJson("/api/fleet", { canary_auto_promote: on }, "PUT").then(revalidate, (e) => { setAuto(!on); setErr(e.message); }); };
  return <>
    <h2>Fleet</h2>
    <div className="grid2"><Tile label="Running" value={String(all.filter((a) => a.running).length)} /><Tile label="Races · 24h" value={String(day)} /></div>
    <div className="card"><div className="card-h"><h3>Tokens this period</h3></div><div className="card-b budget"><Ring pct={pct} label={tok(total)} />
      <p className="meta">{pct == null ? "No agent tokens yet." : `${top.name} accounts for ${pct}% of agent tokens.`}</p></div></div>
    <div className="card"><div className="card-b"><h3>Canary auto-promote</h3><p className="meta">Promote a canary to stable once it wins 60% of 30 races.</p>
      <Toggle label="Canary auto-promote" checked={auto} onChange={toggle} />{err && <p className="meta" role="alert">{err}</p>}</div></div>
  </>;
}

// The credential an agent's runs would use for provider p, from My model access; undefined when none works.
const cred = (access, p) => access.providers.find((x) => x.id === p && ["connected", "unchecked"].includes(x.status));
export const Chip = ({ access, p, x = cred(access, p) }) => (x ? <Pill><Ic name={SRC[x.source]?.[0] ?? "key"} />{SRC[x.source]?.[1] ?? x.name}</Pill> : <Pill tone="bad">No credential</Pill>);
const forHarness = (catalog, h) => catalog.filter((m) => m.harnesses.includes(h)).toSorted((a, b) => b.hosted - a.hosted);

// @cf/@hf ids (and bare names) live under workers-ai/models/<name>; third-party provider/model ids under ai/models/<provider>/<model>.
const modelPage = (id) => (id.startsWith("@") || !id.includes("/") ? `${DOCS}${encodeURIComponent(id.split("/").pop())}/`
  : `https://developers.cloudflare.com/ai/models/${id.split("/").map(encodeURIComponent).join("/")}/`);

function ModelRows({ catalog, access, harness, value, onChange }) {
  return forHarness(catalog, harness).map((m) => <label key={m.id} className={cred(access, m.provider) ? "mrow" : "mrow off"}>
    <input type="radio" name="model" value={m.id} checked={m.id === value} onChange={() => onChange(m.id)} />
    <span className="grow"><b className="mono">{m.id}</b>{m.hosted && <> <Tag>suggested</Tag></>}
      <small>{m.hosted ? "Cloudflare-hosted" : access.providers.find((p) => p.id === m.provider)?.name ?? m.provider} · {m.context} context · {m.price} per M tokens</small></span>
    <Chip access={access} p={m.provider} />
    <span className="mlinks"><a href={modelPage(m.id)} target="_blank" rel="noreferrer">Catalog <Ic name="ur" /></a>
      {m.hosted && <a href="https://playground.ai.cloudflare.com/" target="_blank" rel="noreferrer">Try in playground <Ic name="ur" /></a>}</span>
  </label>);
}

// New agent: harness, then a model with a working credential, then limits. Create queues the agent's first release.
function Wizard({ ref, list, onCreated }) {
  const dlg = useRef(null), [step, setStep] = useState(0), [harness, setHarness] = useState("claude-code"), [model, setModel] = useState(null);
  const [models, setModels] = useState(null), [err, setErr] = useState("");
  // Opening reloads the catalog and credential status, so a key connected meanwhile counts; the model resets to the harness's first.
  const load = () => { setModels(null); Promise.all([modelCatalog(), modelAccess()]).then((r) => { setModels(r); setModel(forHarness(r[0], harness)[0]?.id ?? null); }, setModels); };
  useImperativeHandle(ref, () => ({ open: () => { setStep(0); setErr(""); load(); dlg.current.showModal(); } }));
  const ready = Array.isArray(models), m = ready && forHarness(models[0], harness).find((x) => x.id === model);
  const missing = !m || !cred(models[1], m.provider);
  const pickHarness = (h) => { setHarness(h); setModel(ready ? forHarness(models[0], h)[0]?.id ?? null : null); };
  const create = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget));
    // An existing name would ship this generic prompt as that agent's next version, so Create refuses it (and an unknown list).
    if ((await list.catch(() => null))?.agents.some((a) => a.name === f.name) !== false) return setErr(`${f.name} is already registered, or the agent list didn't load.`);
    const limits = { max_cost_usd: Number(f.spend.replace("$", "")), max_minutes: 120, max_repairs: Number(f.repairs) };
    releaseDraft(f.name, { harness, model, effort: "default", tools: [], limits, prompt: prompt0(f.name) }, f.channel)
      .then(() => { dlg.current.close(); onCreated(`Release of ${f.name}@1 queued. It shows here once a worker records it.`); }, (x) => setErr(x.message));
  };
  return <dialog className="dlg wiz" ref={dlg} aria-label="New agent">
    <form onSubmit={create}>
      <div className="modal-h"><h2>New agent</h2><div className="wsteps">{["Harness", "Model", "Limits"].map((s, i) => <span key={s} className={i === step ? "on" : i < step ? "done" : ""}>
        {i < step ? <Ic name="check" /> : <i>{i + 1}</i>}{s}</span>)}</div>
        <button type="button" className="iconbtn" aria-label="Close" onClick={() => dlg.current.close()}><Ic name="x" /></button></div>
      <div className="pad stack">
        <div className="hgrid" hidden={step !== 0}>{HARN.map(([h, l, s]) => <label key={h} className="hcard">
          <input type="radio" name="harness" checked={h === harness} onChange={() => pickHarness(h)} /><b>{l}</b><small>{s}</small></label>)}</div>
        {step === 1 && (models === null ? <Bone w="100%" h={240} /> : !ready ? <ErrorState message={`Couldn't load the model catalog: ${models.message}`} onRetry={load} /> : <>
          <div className="row"><span className="meta">Models for <b>{HARN.find(([h]) => h === harness)[1]}</b>, from the Cloudflare catalog</span>
            <a className="push" href={DOCS} target="_blank" rel="noreferrer">Browse all models <Ic name="ur" /></a></div>
          <div className="card mlist"><ModelRows catalog={models[0]} access={models[1]} harness={harness} value={model} onChange={setModel} /></div>
          {!m ? <p className="meta">No {HARN.find(([h]) => h === harness)[1]} models in the catalog.</p> : missing ? <div className="block"><Ic name="tri" /><span>No credential for {models[1].providers.find((p) => p.id === m?.provider)?.name ?? "this provider"}. Agents can&apos;t start without one.</span>
            <Link className="btn btn-secondary btn-sm push" to="/me/models">Connect in My model access</Link></div>
            : <div className="meta row">Runs will use <Chip access={models[1]} p={m.provider} /></div>}
        </>)}
        <div className="stack" hidden={step !== 2}><label className="field"><span>Name</span><input className="input mono" name="name" required pattern="[a-z0-9\-]{1,63}" defaultValue="patcher" /></label>
          <div className="grid2"><label className="field"><span>Max spend per run</span><input className="input" name="spend" required pattern="\$?\d+(\.\d+)?" defaultValue="$8" /></label>
            <label className="field"><span>Max repairs</span><input className="input" name="repairs" type="number" min="0" required defaultValue="2" /></label></div>
          <label className="field"><span>Channel</span><select className="input" name="channel"><option>canary</option><option>stable</option></select></label>
        </div>
        {err && <p className="meta" role="alert">{err}</p>}
        <div className="row"><button type="button" className="btn btn-secondary" disabled={step === 0} onClick={() => setStep(step - 1)}>Back</button>
          {/* Keyed apart: a reused node would turn Continue's click into a submit once it re-renders as Create. */}
          {step < 2 ? <button key="next" type="button" className="btn btn-primary push" disabled={step === 1 && (!ready || missing)} onClick={() => setStep(step + 1)}>Continue</button>
            : <button key="create" type="submit" className="btn btn-primary push" disabled={missing}>Create agent</button>}</div>
      </div>
    </form>
  </dialog>;
}

export const Agent = () => <Frame className="ag">
  <Suspense fallback={<DetailSkel />}><Await resolve={useLoaderData().data} errorElement={<Failed what="this agent" />}>{(d) => <Detail d={d} />}</Await></Suspense></Frame>;

function Detail({ d: [page, { agent, races }, models] }) {
  const { name, tab: t } = useParams();
  const tab = TABS.some(([x]) => x === t) ? t : "versions", navigate = useNavigate();
  const v = view(page.agents.find((x) => x.name === name) ?? agent, page.fleet);
  return <div className="stack">
    <div className="row"><span className="lc-ico"><Ic name="robot" /></span><h2 className="mono">{name}</h2><Tag>v{v.v.version}</Tag><Chan ch={v.ch} />
      <span className="push"><Tabs label="Agent views" options={TABS} value={tab} onChange={(t) => navigate(`${base(name)}/${t}`)} /></span></div>
    {tab === "runs" && <Runs v={v} />}
    {tab === "versions" && <Versions agent={agent} />}
    {tab === "settings" && <Settings agent={agent} v={v} models={models} />}
    {tab === "races" && <Races v={v} races={races} />}
  </div>;
}

function Runs({ v }) {
  const r = v.run, sum = (key) => r.calls.reduce((s, c) => s + c[key], 0);
  const { ref } = useShape(`agents/${useParams().name}/calls`, 4, r ? r.calls.length : 0);
  return <>
    <div className="tiles"><Tile label="Runs · 24h" value={String(v.runs_24h)} /><Tile label="Tokens · 24h" value={tok(v.tokens_24h)} />
      <Tile label="Cost · 24h" value={usd(v.cost_24h)} /><WinTile v={v.v} /></div>
    {r ? <div className="card"><div className="card-h"><h3>Run <span className="mono">{r.id}</span></h3>{r.agent_version && <span className="meta"><AgentRef id={r.agent_version} /></span>}
      {r.change_id && <><span className="meta">on</span><Link to={`/${encodeURIComponent(r.repo)}/changes/${encodeURIComponent(r.change_id)}`}><ChangeId id={r.change_id} /></Link>
        <Pill tone={r.state === "merged" ? "ok" : "info"}>{r.state}</Pill></>}
      <span className="push row">{r.change_id && <Link className="btn btn-secondary btn-sm" to={`/${encodeURIComponent(r.repo)}/changes/${encodeURIComponent(r.change_id)}`}><Ic name="pulse" />View trace</Link>}
        <a className="btn btn-secondary btn-sm" href={GATEWAY} target="_blank" rel="noreferrer"><Ic name="term" />View gateway log</a></span></div>
      <div className="tscroll"><table className="tbl" ref={ref}><thead><tr><th>Model</th><th>Call</th><th className="num">Input</th><th className="num">Output</th><th className="num">Cost</th><th className="num">Latency</th></tr></thead>
        <tbody>{r.calls.map((c, i) => <tr key={i}><td className="mono">{c.model}</td><td>{c.call}</td><td className="num mono">{k(c.input_tokens)}</td><td className="num mono">{k(c.output_tokens)}</td>
          <td className="num mono">{usd(c.cost_usd)}</td><td className="num mono">{(c.latency_ms / 1000).toFixed(1)}s</td></tr>)}</tbody>
        <tfoot><tr><td colSpan="2"><b>Total · from AI Gateway</b></td><td className="num mono">{k(sum("input_tokens"))}</td><td className="num mono">{k(sum("output_tokens"))}</td>
          <td className="num mono">{usd(sum("cost_usd"))}</td><td className="num mono">{(sum("latency_ms") / 1000).toFixed(1)}s</td></tr></tfoot></table></div>
    </div> : NoRuns}
  </>;
}

// Every version newest first: its channel, traffic, win rate (untrusted under 20 outcomes) and release time. The canary's
// slider sets its share of new runs; Promote and Roll back point stable at a version, after a confirm. Jobs already queued
// keep the version they recorded. Then the release history.
const HIST = { released: ["tag", (e) => `Released v${e.version}`], promoted: ["ar", (e) => `Promoted v${e.version} to stable`],
  rolled_back: ["chevL", (e) => `Rolled back stable to v${e.version}`], canary: ["ur", (e) => `Canary v${e.version} at ${e.share}%`] };
function Versions({ agent }) {
  const name = agent.name, dlg = useRef(null), open = Number(useSearchParams()[0].get("v")) || null;
  const [d, setD] = useState(null), [share, setShare] = useState(0), [ask, setAsk] = useState(null), [err, setErr] = useState("");
  const load = useCallback(() => {
    setD(null);
    Promise.all([agentVersions(name), agentHistory(name)]).then(([versions, history]) => {
      setShare(versions.find((v) => v.channel === "canary")?.share ?? 0);
      setD({ versions, history });
    }, setD);
  }, [name]);
  useEffect(load, [load]);
  if (d === null) return <LoadingRegion page="versions" busy><div className="card"><div className="tscroll"><TableSkel rows={3}
    cols={[["Version", 120], ["Channel"], ["Traffic", 140], ["Win rate"], ["Web"], ["Released", 48], ["By", 80], [""]]} /></div></div></LoadingRegion>;
  if (d instanceof Error) return <div className="card"><ErrorState message={`Couldn't load versions: ${d.message}`} onRetry={load} /></div>;
  const stable = d.versions.find((v) => v.channel === "stable"), canary = d.versions.find((v) => v.channel === "canary");
  const move = (channel, body) => { setErr(""); moveChannel(name, channel, body).then(load, (e) => setErr(e.message)); };
  const saveShare = () => canary && share !== canary.share && move("canary", { version: canary.version, share });
  const confirm = (title, action, body, version) => { setAsk({ title, action, body, version }); dlg.current.returnValue = ""; dlg.current.showModal(); };
  const promote = () => confirm(`Promote ${name}@v${canary.version} to stable?`, "Promote to stable", <>
    <p>Every new run uses v{canary.version}.{stable && ` v${stable.version} stays listed so you can roll back.`}</p>
    {canary.outcomes.n < 20 && <div className="block"><Ic name="tri" /><span>v{canary.version}&apos;s win rate is <Untrusted n={canary.outcomes.n} />. Promoting
      before 20 outcomes skips the evidence the canary was collecting.</span></div>}</>, canary.version);
  const rollback = (v) => confirm(`Roll back stable to v${v}?`, `Roll back to v${v}`, <p>Stable moves from v{stable.version} to v{v} for every new run.
    Runs already going finish on v{stable.version}.{canary && ` Canary v${canary.version} keeps ${share}%.`}</p>, v);
  return <>
    {open && <VersionView key={open} agent={agent} n={open} versions={d.versions} />}
    <div className="card"><div className="card-h"><h3>Versions</h3><span className="push meta">Win rate counts changes each version ran on that merged, out of those that ended</span></div>
      <div className="tscroll"><table className="tbl"><thead><tr><th>Version</th><th>Channel</th><th>Traffic</th><th>Win rate</th><th>Web</th><th>Released</th><th>By</th><th /></tr></thead>
        <tbody>{d.versions.toSorted((a, b) => b.version - a.version).map((v) => <tr key={v.version}>
          <td><AgentRef id={`${name}@v${v.version}`} /></td>
          <td>{v.channel ? <Chan ch={v.channel} /> : <span className="meta">—</span>}</td>
          <td className="mono">{v.channel === "canary" ? <span className="share"><input type="range" min="0" max="100" step="5" value={share} aria-label="Canary traffic share"
            onChange={(e) => setShare(Number(e.target.value))} onPointerUp={saveShare} onKeyUp={saveShare} /><output>{share}%</output></span>
            : v.channel === "stable" ? `${canary ? 100 - share : 100}%` : "0%"}</td>
          <td>{v.outcomes.n >= 20 ? <><b>{((v.outcomes.merged / v.outcomes.n) * 100).toFixed(1)}%</b> <span className="meta">n={v.outcomes.n}</span></> : <Untrusted n={v.outcomes.n} />}</td>
          <td>{v.web.mode}{v.web.converted > 0 && <span className="meta"> · {v.web.converted} converted · {tok(v.web.saved_bytes)} bytes saved</span>}</td>
          <td className="meta">{v.released_at ? `${ago(v.released_at)} ago` : "—"}</td>
          <td className="meta">{d.history.find((e) => e.kind === "released" && e.version === v.version)?.by ?? "cinder"}</td>
          <td>{v.channel === "canary" ? <button type="button" className="btn btn-primary btn-sm" onClick={promote}>Promote to stable</button>
            : v.channel === "stable" ? <span className="meta">serving</span>
              : stable && v.version < stable.version ? <button type="button" className="btn btn-secondary btn-sm" onClick={() => rollback(v.version)}><Ic name="chevL" />Roll back to v{v.version}</button> : null}</td>
        </tr>)}</tbody></table></div>
      {err && <p className="meta pad" role="alert">{err}</p>}</div>
    <div className="card"><div className="card-h"><h3>Release history</h3></div>
      {d.history.length ? <table className="tbl cm"><tbody>{d.history.map((e, i) => <tr key={i}>
        <td><Ic name={HIST[e.kind][0]} /></td><td className="msg"><b>{HIST[e.kind][1](e)}</b>{e.by && <span className="meta"> by {e.by}</span>}</td>
        <td className="num meta">{ago(e.at)} ago</td></tr>)}</tbody></table>
        : <EmptyState icon="tag" title="No releases yet">Released versions and channel moves show here.</EmptyState>}</div>
    <Dialog ref={dlg} title={ask?.title} action={ask?.action} onClose={(e) => e.currentTarget.returnValue === "ok" && move("stable", { version: ask.version })}>{ask?.body}</Dialog>
  </>;
}

// A version diff as lines: the prompt's, then each changed lock field's (egress host by host).
const show = (x) => (Array.isArray(x) ? x.join(", ") : String(x ?? "—"));
const diffLines = (diff) => [...diff.prompt, ...diff.fields.flatMap(({ field, from, to }) => (field === "egress"
  ? [...(from ?? []).filter((h) => !to?.includes(h)).map((h) => `-egress: ${h}`), ...(to ?? []).filter((h) => !from?.includes(h)).map((h) => `+egress: ${h}`)]
  : [`-${field}: ${show(from)}`, `+${field}: ${show(to)}`]))];
const DiffPre = ({ diff, empty }) => {
  const lines = diffLines(diff);
  return <pre className="draft-diff">{lines.some((l) => l[0] !== " ") ? lines.map((l, i) => <span key={i} className={{ "+": "a", "-": "d" }[l[0]]}>{l}{"\n"}</span>) : empty}</pre>;
};

// One released version (?v=N): its lock and prompt read from its release tag, a diff to another version (&vs=M), and
// Edit from this version, which saves its prompt and lock as the draft (after a confirm when a draft is saved).
function VersionView({ agent, n, versions }) {
  const name = agent.name, navigate = useNavigate(), [params, setParams] = useSearchParams(), vs = params.get("vs"), dlg = useRef(null);
  // Without a pick, the diff shows what this version changed from the one before it.
  const prev = versions.map((x) => x.version).filter((x) => x < n).sort((a, b) => b - a)[0];
  const [from, to] = vs ? [n, vs] : [prev, n];
  const [d, setD] = useState(null), [diff, setDiff] = useState(null), [raw, setRaw] = useState(false), [retry, setRetry] = useState(0), [err, setErr] = useState("");
  useEffect(() => {
    let live = true;
    setD(null);
    agentVersion(name, n).then((x) => live && setD(x), (e) => live && setD(e));
    return () => { live = false; };
  }, [name, n, retry]);
  useEffect(() => {
    let live = true;
    setDiff(null);
    if (from) agentDiff(name, from, to).then((x) => live && setDiff(x ?? { fields: [], prompt: [] }), (e) => live && setDiff(e));
    return () => { live = false; };
  }, [name, from, to, retry]);
  if (d === null) return <div className="card"><Bone w="100%" h={120} /></div>;
  if (d instanceof Error) return <div className="card"><ErrorState message={`Couldn't load ${name}@v${n}: ${d.message}`} onRetry={() => setRetry(retry + 1)} /></div>;
  const { harness, model, effort, tools, egress, web, limits, prompt } = d;
  const edit = () => postJson(`/api/agents/${encodeURIComponent(name)}/draft`, { harness, model, effort, tools, egress, web, limits, prompt }, "PUT")
    .then(() => navigate(`${base(name)}/settings`), (e) => setErr(e.message));
  const lock = [["Model", model], ["Harness", harness], ["Effort", effort], ["Tools", show(tools) || "none"],
    ["Limits", `${usd(limits.max_cost_usd)} · ${limits.max_minutes} min`], ["Egress", show(egress) || "none"], ["Web", web]];
  return <div className="card">
    <div className="card-h"><h3 className="mono">{name}@v{n}</h3>
      <span className="push row"><select className="input" aria-label="Compare with" value={vs ?? ""} onChange={(e) => setParams(e.target.value ? { v: n, vs: e.target.value } : { v: n })}>
        <option value="">Compare with…</option>{versions.filter((x) => x.version !== n).map((x) => <option key={x.version} value={x.version}>v{x.version}</option>)}</select>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => (agent.draft ? dlg.current.showModal() : edit())}><Ic name="edit" />Edit from this version</button>
        <button type="button" className="btn btn-ghost btn-sm" aria-label="Close version" onClick={() => setParams({})}><Ic name="x" /></button></span></div>
    <div className="card-b stack">
      {from ? <><p className="meta">Diff from v{from} to v{to}</p>{diff === null ? <Bone w="100%" h={80} />
        : diff instanceof Error ? <ErrorState message={`Couldn't load the diff: ${diff.message}`} onRetry={() => setRetry(retry + 1)} /> : <DiffPre diff={diff} empty="No differences" />}</> : <p className="meta">First version: nothing before it to compare with.</p>}
      <dl className="lock">{lock.map(([k, x]) => <div key={k}><dt>{k}</dt><dd className="mono">{x}</dd></div>)}</dl>
      <div className="row"><span className="mono meta">agents/{name}/prompt.md</span><label className="push row"><Toggle label="Raw prompt" checked={raw} onChange={setRaw} />Raw</label></div>
      {raw ? <pre className="prompt">{prompt}</pre> : <Markdown text={prompt} />}
      {err && <p className="meta" role="alert">{err}</p>}</div>
    <Dialog ref={dlg} title="Replace the saved draft?" action="Replace draft" onClose={(e) => e.currentTarget.returnValue === "ok" && edit()}>
      <p>The saved draft is replaced by v{n}&apos;s prompt and lock. Released versions are untouched.</p></Dialog>
  </div>;
}

// Picking a model or editing the prompt saves a draft on top of the saved draft (else the shown version); the draft runs nowhere until released.
function Settings({ agent, v, models }) {
  const { revalidate } = useRevalidator(), [err, setErr] = useState(""), [text, setText] = useState(null), [host, setHost] = useState("");
  const { harness, effort, tools, egress, limits, model: current } = v.v, model = agent.draft_model ?? current, draftEgress = agent.draft_egress;
  const base = agent.draft ?? { harness, model, effort, tools, egress: egress ?? undefined, limits, prompt: agent.prompt ?? prompt0(agent.name) };
  const save = (change) => postJson(`/api/agents/${encodeURIComponent(agent.name)}/draft`, { ...base, saved_at: undefined, ...change }, "PUT")
    .then(() => { setText(null); revalidate(); return true; }, (e) => setErr(e.message));
  const add = (e) => {
    e.preventDefault();
    const h = host.trim().toLowerCase();
    if (h && !draftEgress.includes(h)) save({ egress: [...draftEgress, h] }).then((ok) => ok && setHost(""));
  };
  const listed = !(models instanceof Error) && forHarness(models[0], harness).find((m) => m.id === model);
  return <>
    {agent.draft && <Draft key={agent.draft.saved_at} agent={agent} from={v.v.version} onDone={revalidate} />}
    {models instanceof Error ? <div className="card"><ErrorState message={`Couldn't load the model catalog: ${models.message}`} onRetry={revalidate} /></div>
      : <div className="card"><div className="card-h"><h3>Model</h3><span className="push">{listed
        ? <Chip access={models[1]} p={listed.provider} /> : <Pill tone="bad">Not available for this harness</Pill>}</span></div>
      <div className="mlist">{!listed && <label className="mrow off"><input type="radio" name="model" value={model} checked readOnly />
        <span className="grow"><b className="mono">{model}</b><small>Saved model, not available for this harness. Pick another to save a draft.</small></span></label>}
        <ModelRows catalog={models[0]} access={models[1]} harness={harness} value={model} onChange={(m) => save({ model: m })} /></div></div>}
    <div className="card"><div className="card-h"><h3>Network allowlist</h3><span className="meta">Hosts this agent may reach. Everything else is denied and shows in Watchtower.</span></div>
      <div className="card-b stack">
        {draftEgress.map((h) => <div className="row" key={h}><span className="mono">{h}</span>
          <button type="button" className="btn btn-ghost btn-sm push" aria-label={`Remove ${h}`} onClick={() => save({ egress: draftEgress.filter((x) => x !== h) })}><Ic name="x" /></button></div>)}
        {!draftEgress.length && <p className="meta">No hosts: every request is denied.</p>}
        <form className="row" onSubmit={add}><input className="input mono" aria-label="Add a host" placeholder="api.example.com or *.example.com" value={host}
          onChange={(e) => setHost(e.target.value)} /><button type="submit" className="btn btn-secondary btn-sm"><Ic name="plus" />Add</button></form>
        <p className="meta">Edits go into the draft version. Release it to apply them.</p></div></div>
    {err && <p className="meta" role="alert">{err}</p>}
    <div className="card"><div className="card-h"><h3>Prompt</h3><span className="push row"><span className="mono meta">agents/{agent.name}/prompt.md</span>
      {text === null && !agent.marketplace && <button type="button" className="btn btn-secondary btn-sm" onClick={() => setText(base.prompt)}><Ic name="edit" />Edit</button>}</span></div>
      {agent.marketplace && <p className="card-b meta">Installed from the marketplace; its prompt is locked.</p>}
      {text === null ? <pre className="card-b prompt">{agent.draft?.prompt ?? agent.prompt ?? "No prompt recorded for this version."}</pre>
        : <div className="card-b stack"><textarea className="input" aria-label="Prompt" rows="8" value={text} onChange={(e) => setText(e.target.value)} />
          <div className="row"><span className="meta">Edits save as a draft. Nothing runs it until you release it.</span>
            <span className="push row"><button type="button" className="btn btn-ghost btn-sm" onClick={() => setText(null)}>Cancel</button>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => save({ prompt: text })}>Save draft</button></span></div></div>}</div>
  </>;
}

// The saved draft as name@vN-draft: its prompt and allowlist diff to the shown version, Discard (confirmed) and Release to a channel.
function Draft({ agent, from, onDone }) {
  const name = agent.name, path = `/api/agents/${encodeURIComponent(name)}`, next = Math.max(...agent.versions.map((x) => x.version)) + 1;
  const [diff, setDiff] = useState(null), [n, setN] = useState(0), [channel, setChannel] = useState("canary"), [note, setNote] = useState(""), [err, setErr] = useState("");
  const discard = useRef(null), release = useRef(null);
  useEffect(() => {
    let live = true;
    setDiff(null);
    agentDiff(name, from, "draft").then((d) => live && setDiff(d ?? { fields: [], prompt: [] }), (e) => live && setDiff(e));
    return () => { live = false; };
  }, [name, from, n]);
  const ok = (e) => e.currentTarget.returnValue === "ok";
  const act = (p) => p.then(onDone, (e) => setErr(e.message));
  return <div className="card draft">
    <div className="card-h"><Pill><Ic name="edit" />Draft</Pill><h3 className="mono">{name}@v{next}-draft</h3>
      <span className="meta">Draft saved · {ago(agent.draft.saved_at)} ago · not running anywhere</span>
      <span className="push row"><button type="button" className="btn btn-ghost btn-sm" onClick={() => discard.current.showModal()}>Discard draft</button>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => release.current.showModal()}>Release v{next}…</button></span></div>
    <div className="card-b"><p className="meta">Diff to v{from}</p>
      {diff === null ? <Bone w="100%" h={80} /> : diff instanceof Error ? <ErrorState message={`Couldn't load the diff: ${diff.message}`} onRetry={() => setN(n + 1)} />
        : <DiffPre diff={diff} empty="No changes yet" />}
      {err && <p className="meta" role="alert">{err}</p>}</div>
    <Dialog ref={discard} title={`Discard v${next}-draft?`} action="Discard draft" onClose={(e) => ok(e) && act(postJson(`${path}/draft`, undefined, "DELETE"))}>
      <p>The draft prompt and allowlist edits are deleted. Released versions keep running.</p></Dialog>
    <Dialog ref={release} title={`Release ${name}@v${next}`} action={`Release v${next}`} onClose={(e) => ok(e) && act(postJson(`${path}/release`, { channel, note }))}>
      <fieldset className="stack"><legend>Channel</legend>
        <label className="row"><input type="radio" name="channel" checked={channel === "canary"} onChange={() => setChannel("canary")} />
          <span><b>canary</b> · replaces the current canary at its share of changes.</span></label>
        <label className="row"><input type="radio" name="channel" checked={channel === "stable"} onChange={() => setChannel("stable")} />
          <span><b>stable</b> · every new run uses v{next}. Skips canary evidence.</span></label></fieldset>
      <label className="field"><span>Release note</span><input className="input" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} /></label>
      <p className="meta">Tags agent/{name}/v{next} in the agents repo.</p></Dialog>
  </div>;
}

function Races({ v, races }) {
  const mine = (r) => r.legs.find((l) => l.leg.startsWith(`${v.name}@`)), legs = races.flatMap((r) => r.legs), last = races[0];
  const limited = legs.filter((l) => l.rpm != null && l.rpm >= l.rpm_limit && Date.now() - Date.parse(l.started_at) < 7 * 864e5).length;
  const Won = ({ won }) => (won === 1 ? <Pill tone="ok">won</Pill> : won === 0 ? <Pill>lost</Pill> : <Pill>pending</Pill>);
  return <>
    <div className="tiles"><Tile label="Races" value={String(races.length)} /><WinTile v={v.v} />
      <Tile label="Avg legs" value={races.length ? String(Math.round(legs.length / races.length)) : "—"} /><Tile label="Rate-limited legs · 7d" value={String(limited)} /></div>
    <div className="block info"><Ic name="info" /><span>Hosted models are limited to 20 requests a minute (50 with credits). A wide race can hit that, so each leg shows its rate.</span></div>
    {last ? <>
      <div className="card"><div className="card-h"><h3>Race <span className="mono">{rid(last.id)}</span></h3>
        {last.change && <span className="meta">{last.change.intent}</span>}<span className="push">{last.winner ? <Pill tone="ok">decided</Pill> : <Pill tone="info">running</Pill>}</span></div>
        <div className="tscroll"><table className="tbl"><thead><tr><th>Leg</th><th>Model</th><th className="num">Tokens</th><th className="num">Time</th><th className="num">Tests</th>
          <th className="num">p(merge)</th><th>Rate</th><th /></tr></thead>
          <tbody>{last.legs.map((l) => <tr key={l.change_id}><td><AgentRef id={l.leg} /></td><td className="mono">{l.model ?? "—"}</td><td className="num mono">{k(l.tokens)}</td>
            <td className="num mono">{l.duration_ms == null ? "—" : `${Math.floor(l.duration_ms / 6e4)}m ${String(Math.round(l.duration_ms / 1000) % 60).padStart(2, "0")}s`}</td>
            <td className="num mono">{l.tests_total == null ? "—" : `${l.tests_passed}/${l.tests_total}`}</td><td className="num mono">{l.p_merge?.toFixed(2) ?? "—"}</td>
            <td>{l.rpm == null ? <span className="meta">—</span> : <span className="rate"><Ic name="tri" />{l.rpm}/{l.rpm_limit} rpm</span>}</td><td><Won won={l.won} /></td></tr>)}</tbody></table></div></div>
      <div className="card"><div className="card-h"><h3>Recent races</h3></div><table className="tbl cm"><tbody>{races.slice(0, 5).map((r) => <tr key={r.id}>
        <td className="mono">{rid(r.id)}</td><td className="msg">{r.change?.intent ?? "imported history"}</td><td><Won won={r.winner ? mine(r)?.won : null} /></td>
        <td className="num meta">{ago(r.legs[0].started_at)} ago</td></tr>)}</tbody></table></div>
    </> : <div className="card"><EmptyState icon="bolt" title="No races yet">Race two versions on one intent to see which one should be stable.</EmptyState></div>}
  </>;
}
