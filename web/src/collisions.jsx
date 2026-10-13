// Collisions: the feed page, the change detail's card and rail section, and the Code page's live warnings.
import { Fragment, createContext, useCallback, useContext, useEffect, useState } from "react";
import { Link, useParams, useRouteLoaderData, useSearchParams } from "react-router";
import { resolveCollision, useCollisions } from "./api/collisions.js";
import { ago } from "./changes.jsx";
import { getLeaseMap, listen } from "./client.js";
import { Ic } from "./icons.jsx";
import { LoadingRegion, ListCardSkel, TileSkel } from "./skeleton.jsx";
import { ChangeId as Id, EmptyState, IdText, ErrorState, Frame, Tag, Tile } from "./ui.jsx";
import "./styles/collisions.css";

// Every change here shows its repo key (PULSE-6), looked up in the lease map's changes; a change it doesn't list shows its id.
const Keys = createContext({});
const ChangeId = ({ id }) => <Id id={id} label={useContext(Keys)[id] ?? undefined} />;
const useBase = () => `/${encodeURIComponent(useParams().repo)}/changes`;
const name = (symbol) => symbol.split("#")[1] ?? symbol;
const LABEL = { seam: "Propose a seam", handover: "Hand over", reprioritize: "Reprioritize" };
const TILES = ["Open", "Resolved · 24h", "Conflict rate · 7 days", "Median time to resolve"];

// Live on this file: another change editing a symbol that a lease on file covers. The page's leases name symbols without their path.
export const warnings = (data, leases, file) => (data?.editing ?? []).flatMap((e) => {
  const held = leases.find((l) => l.file === file && e.symbol.split("#")[0] === file && l.holder !== e.change_id && (l.symbol === name(e.symbol) || l.symbol === file));
  return held ? [{ key: `${e.change_id} ${e.symbol}`, text: <><ChangeId id={e.change_id} /> is changing the {e.kind === "signature" ? "signature" : "body"} of {name(e.symbol)}, which <ChangeId id={held.holder} /> leases</> }] : [];
});

const kidsOf = (changes, leases, id) => [...new Set([...changes.filter((c) => c.stacked_on === id).map((c) => c.id),
  ...leases.filter((l) => l.holder === id).flatMap((l) => l.waiting)])];

// The four resolutions of f with what each does and the merge order after it, from the lease map's stacked_on and waiting.
function options(f, { changes, leases }) {
  const o = f.ours, t = f.theirs, s = name(f.symbol);
  // Text names changes by key; ids stay for the merge order.
  const k = (id) => changes.find((c) => c.id === id)?.key ?? id.slice(0, 8), O = k(o), T = k(t);
  const ok = kidsOf(changes, leases, o).filter((x) => x !== t);
  const tk = kidsOf(changes, leases, t).filter((x) => x !== o && !ok.includes(x));
  return [
    { k: "stack", icon: "merge", short: "Stack", t: `Stack ${O} on ${T}`, d: `${O} waits until ${T} merges, then rebases onto its ${s}.`,
      cost: `${O} lands later${ok.length ? `, and ${ok.map(k).join(", ")} after it` : ""}. Nothing is rewritten.`, order: [[t], [o], ...ok.map((x) => [x])] },
    { k: "seam", icon: "branch", short: "Seam", t: "Propose a seam", d: `An agent opens a small change that lands the new ${s} on its own. ${O} and ${T} both build on it.`,
      cost: "Adds one change. Both keep working in parallel.", order: [["seam"], [o, t]] },
    { k: "handover", icon: "hand", short: "Hand over", t: `Hand ${s} to ${O}`, d: `${T} gives up its lease on ${s}; ${O} takes it and carries on.`,
      cost: `${T} rebases onto ${O}'s ${s} when it lands.`, order: [[o], [t]] },
    { k: "reprioritize", icon: "trend", short: "Go first", t: `Let ${O} go first`, d: `${O} moves to P1 and goes ahead of ${T} in line for ${s}.`,
      cost: `${[T, ...tk.map(k)].join(" and ")} wait${tk.length ? "" : "s"}.`, order: [[o], ...ok.map((x) => [x]), [t], ...tk.map((x) => [x])] },
  ];
}

// Resolves every open collision of f.ours: pick one of four options, read its preview, then apply it. map is the lease map
// the merge order comes from (change detail has none, so its order skips the changes behind).
function Resolve({ f, map = { changes: [], leases: [] }, reload }) {
  const opts = options(f, map);
  const [k, setK] = useState(f.suggested?.action ?? "stack");
  const [err, setErr] = useState(null);
  const x = opts.find((o) => o.k === k) ?? opts[0];
  const go = async () => {
    setErr(null);
    try { await resolveCollision(f.ours, k); } catch (e) { setErr(e); if (e.status !== 409) return; }
    await reload();
  };
  return <div className="rb"><div className="lbl">Resolve</div>
    <div className="rchips" role="radiogroup" aria-label="Resolution">{opts.map((o) =>
      <button type="button" role="radio" aria-checked={o === x} key={o.k} className={o === x ? "rc on" : "rc"} onClick={() => setK(o.k)}>
        <Ic name={o.icon} />{o.short}{f.suggested?.action === o.k && <span className="sug-dot" aria-label="suggested" />}</button>)}</div>
    <div className="rprev"><p><b><IdText text={x.t} />.</b> <IdText text={x.d} /></p><div className="lbl">Merge order after</div>
      <ol className="mo" aria-label="Merge order after">{x.order.map((step) => <li key={step.join(" ")}>{step.map((id, i) => <Fragment key={id}>
        {i > 0 && <span className="subtle">in parallel</span>}
        {id === "seam" ? <span className="chip seam"><Ic name="branch" />seam change</span> : <span className={id === f.ours ? "chip ours" : "chip"}><ChangeId id={id} /></span>}
      </Fragment>)}</li>)}</ol>
      <p className="subtle"><IdText text={x.cost} /></p></div>
    {err?.status === 409 ? <div className="errst sm" role="alert"><Ic name="tri" /><div><b>Couldn't resolve</b>
      <div className="subtle"><ChangeId id={f.ours} /> is no longer in conflict: cinder or another person settled it. The page has refreshed.</div></div></div>
      : err && <p className="col-err" role="alert">{err.message}</p>}
    <button type="button" className="btn btn-primary" onClick={go}><IdText text={x.t} /></button>
    {f.suggested && <p><span className="sug">Suggested</span> <span className="subtle">{f.suggested.why}</span></p>}
    <p className="subtle">Applies to every open collision on <ChangeId id={f.ours} />.</p>
  </div>;
}

const Severity = ({ f }) => <Tag tone={f.severity === "high" ? "bad" : "warn"}>{f.severity} · p {f.p}</Tag>;

// The change detail's card for one of its collisions; first shows the controls, which resolve the change that ran into it (ours).
export function CollisionCard({ f, id, first, reload }) {
  const base = useBase();
  const other = f.ours === id ? f.theirs : f.ours;
  return <div className={f.resolution ? "col-card" : "col-card open"}>
    <div className="col-row"><Ic name="tri" /><b>Collides with <Link to={`${base}/${other}`}><ChangeId id={other} /></Link></b>
      <code>{name(f.symbol)}</code><span className="subtle">{f.symbol.split("#")[0]}</span><Tag>{f.kind === "signature" ? "signature change" : "body change"}</Tag><Severity f={f} /></div>
    <p className="subtle">Told the agent: <IdText text={f.message} /></p>
    <p className="subtle">The agent: {f.action}</p>
    {f.resolution ? <p className="subtle">Resolved with {LABEL[f.resolution] ?? <>Stack on <ChangeId id={other} /></>} · {ago(f.resolved_at)} ago</p>
      : first && <Resolve f={f} reload={reload} />}
    <Link to={`${base}/collisions`}>All collisions</Link>
  </div>;
}

// The rail's Symbols section: leased (with mode), touched (written in the last minutes) and collisions with their state.
export function Symbols({ id, leases, data }) {
  const mine = leases.filter((l) => l.holder === id);
  const touched = (data?.editing ?? []).filter((e) => e.change_id === id);
  const cols = (data?.feed ?? []).filter((f) => f.ours === id || f.theirs === id);
  return <div className="rail-sec"><div className="pl2">Symbols</div>
    <div className="subtle">Leased: {mine.length ? mine.map((l) => <span key={l.symbol}><code>{name(l.symbol)}</code> {l.mode} </span>) : "none"}</div>
    <div className="subtle">Touched: {touched.length ? touched.map((e) => <code key={e.symbol}>{name(e.symbol)} </code>) : "none"}</div>
    <div className="subtle">Collisions: {cols.length ? cols.map((f) => <span key={f.id}><code>{name(f.symbol)}</code> {f.resolution ? "resolved" : "open"} </span>) : "none"}</div>
  </div>;
}

const pk = (a, b) => [a, b].toSorted().join(" ");
const certain = (e) => e.judge.name === "lease";
const shown = (e) => e.calibrated ?? e.p;
const pct = (v) => `${Math.round(v * 100)}%`;
const rank = (e) => (certain(e) ? 2 : e.judge.trusted ? 1 : 0);

// One row per lease-map edge: overlapping leases first, then trusted by calibrated p, then untrusted (no % and no bar).
function Pairs({ edges, feed, leases, target }) {
  const rows = edges.toSorted((x, y) => rank(y) - rank(x) || shown(y) - shown(x));
  const why = (e) => {
    const f = feed.find((g) => pk(g.ours, g.theirs) === pk(e.a, e.b));
    if (f) return f.resolution ? <span className="ok-t"><Ic name="check" />collided · resolved</span> : <span className="bad-t"><Ic name="tri" />collided {ago(f.detected_at)} ago</span>;
    const w = leases.find((l) => (l.holder === e.a && l.waiting.includes(e.b)) || (l.holder === e.b && l.waiting.includes(e.a)));
    if (w) return <><ChangeId id={w.holder === e.a ? e.b : e.a} /> waits on <code>{w.symbol}</code></>;
    const fb = leases.filter((l) => l.holder === e.b).map((l) => l.file);
    const both = leases.find((l) => l.holder === e.a && fb.includes(l.file))?.file;
    return both ? <>both lease in <span className="mono">{both}</span></> : "no shared lease · predicted from intent";
  };
  const value = (e) => (certain(e) ? <span className="pill brandish"><Ic name="lock" />leases overlap</span>
    : e.judge.trusted ? <><span className={`pb ${shown(e) < 0.2 ? "lo" : shown(e) < 0.5 ? "mid" : "hi"}`}><i style={{ width: pct(shown(e)) }} /></span>
      <b className="mono" title={`raw ${pct(e.p)}, calibrated ${pct(shown(e))}`}>{pct(shown(e))}</b></>
      : <span className="untrusted">untrusted: {e.judge.count} outcomes</span>);
  return <section className="card"><div className="card-h"><h3>Pairs at risk</h3>
    {rows.length > 0 && <span className="subtle">{rows.length} · overlapping leases, then highest chance · untrusted last</span>}</div>
    {rows.length ? <ul className="prs" aria-label="Pairs at risk">{rows.map((e) => {
      const hit = feed.some((f) => !f.resolution && pk(f.ours, f.theirs) === pk(e.a, e.b));
      return <li key={pk(e.a, e.b)} className={hit ? "pr hit" : "pr"}>
        <div className="pr-ids"><ChangeId id={e.a} /><span className="subtle">×</span><ChangeId id={e.b} /></div>
        <div className="pr-bar">{value(e)}</div><div className="pr-why">{why(e)}</div>
        <span className="subtle mono">{certain(e) ? "lease map" : e.judge.name}</span></li>;
    })}</ul> : <EmptyState icon="check" title="No pairs at risk">No two open changes on <span className="mono">{target}</span> lease the same symbol, and no judge predicts a collision.</EmptyState>}
  </section>;
}

const MODE = { exclusive: "lock", shared: "users", seam: "branch" };

// Leases grouped by file: each symbol's holder (with its mode), then the changes waiting on it.
function Lanes({ leases, open }) {
  const files = [...new Set(leases.map((l) => l.file))].toSorted();
  return <section className="card"><div className="card-h"><h3>Leases by file</h3><span className="subtle">holder ← waiting</span>
    <span className="end lgs">{Object.entries(MODE).map(([m, ic]) => <span key={m} className="lg"><Ic name={ic} />{m}</span>)}</span></div>
    {files.length ? <ul className="lanes" aria-label="Leases">{files.map((file) => <li key={file}><div className="ln-f"><Ic name="file" /><span className="mono">{file}</span></div>
      {leases.filter((l) => l.file === file).map((l) => <div className="ln" key={`${l.holder} ${l.symbol}`}><code>{l.symbol}</code><span className="ln-h">
        <span className={`chip ${l.mode}`} title={l.mode}><Ic name={MODE[l.mode]} /><ChangeId id={l.holder} /></span>
        {l.waiting.map((w) => <Fragment key={w}><span className="ar">←</span><span className="chip wait"><ChangeId id={w} />{open.some((f) => f.ours === w) && <Ic name="tri" />}</span></Fragment>)}
      </span></div>)}</li>)}</ul>
      : <EmptyState icon="lock" title="No leases held">A lease appears when an agent starts writing a symbol.</EmptyState>}
  </section>;
}

function Head({ f }) {
  const base = useBase();
  return <div className="ci-h"><Ic name="tri" /><div><b><Link to={`${base}/${f.ours}`}><ChangeId id={f.ours} /></Link> changed the {f.kind} of <code>{name(f.symbol)}</code></b>
    <div className="subtle">leased by <Link to={`${base}/${f.theirs}`}><ChangeId id={f.theirs} /></Link> · <span className="mono">{f.symbol.split("#")[0]}</span> · {ago(f.detected_at)} ago</div></div>
    <Tag tone={f.severity === "high" ? "bad" : "warn"}>{f.severity}</Tag></div>;
}

const Told = ({ f }) => <dl className="told"><dt>Told <ChangeId id={f.ours} />&apos;s agent</dt><dd><IdText text={f.message} /></dd><dt>It</dt><dd>{f.action}</dd></dl>;

const DONE = { stack: "Stacked", seam: "Seam proposed", handover: "Handed over", reprioritize: "Went first" };

export function Collisions() {
  const { repo } = useParams();
  const row = useRouteLoaderData("repo");
  const [search] = useSearchParams();
  const target = search.get("target") ?? row.default_branch;
  const base = useBase();
  const { data, err, reload } = useCollisions(repo, target);
  const [map, setMap] = useState(null);
  const [mapErr, setMapErr] = useState(null);
  const [pick, setPick] = useState(null);
  const loadMap = useCallback(() => getLeaseMap(repo, target).then((m) => { setMap(m); setMapErr(null); }, (e) => setMapErr(e.message)), [repo, target]);
  useEffect(() => { loadMap(); return listen(repo, loadMap); }, [repo, loadMap]);
  const c = map?.conflicts;
  const feed = data?.feed ?? [];
  const open = feed.filter((f) => !f.resolution);
  const done = feed.filter((f) => f.resolution);
  const day = done.filter((f) => f.resolved_at && Date.now() - Date.parse(f.resolved_at) < 864e5);
  const took = (f) => (Date.parse(f.resolved_at) - Date.parse(f.detected_at)) / 6e4;
  const spans = done.filter((f) => f.resolved_at).map(took).toSorted((a, b) => a - b);
  const top = open.find((f) => f.id === pick) ?? open[0];
  const head = <><div><h1>Collisions</h1><p>Where two changes reach for the same symbol on <span className="mono">{target}</span>: predicted before it happens, and what each agent was told when it did.</p></div>
    <div className="acts"><span className="live"><span className="dot" />live</span><Link className="btn btn-secondary" to={base}><Ic name="merge" />Changes</Link></div></>;
  if (!data && !err && !map && !mapErr) return <Frame head={head}><LoadingRegion page="Collisions" busy>
    <div className="tiles">{TILES.map((l) => <TileSkel key={l} label={l} />)}</div>
    <div className="g-cb"><div className="stack">{[0, 1].map((i) => <ListCardSkel key={i} />)}</div><aside className="stack"><ListCardSkel /></aside></div>
  </LoadingRegion></Frame>;
  return <Keys.Provider value={Object.fromEntries((map?.changes ?? []).map((x) => [x.id, x.key]))}><Frame head={head}>
    <div className="tiles">
      <Tile label="Open" value={data ? String(open.length) : "—"} />
      <Tile label="Resolved · 24h" value={data ? String(day.length) : "—"} />
      <Tile label={`Conflict rate · ${c?.days ?? 7} days`} value={c?.merges ? `${Math.round((100 * c.conflicted) / c.merges)}%` : "—"} sub={c?.merges ? ` ${c.conflicted} of ${c.merges} merges` : undefined} />
      <Tile label="Median time to resolve" value={spans.length ? `${Math.round(spans[Math.floor(spans.length / 2)])} min` : "—"} untrusted={spans.length ? spans.length : undefined} />
    </div>
    <div className="g-cb"><div className="stack">
      {mapErr ? <div className="card"><ErrorState message={`Couldn't load leases: ${mapErr}`} onRetry={loadMap} /></div>
        : map ? <><Pairs edges={map.edges} feed={feed} leases={map.leases} target={target} /><Lanes leases={map.leases} open={open} /></> : <ListCardSkel />}
    </div>
    <aside className="stack" aria-label="Collision diagnostics">
      {err ? <div className="card"><ErrorState message={`Couldn't load collisions: ${err}`} onRetry={reload} /></div>
        : !data ? <ListCardSkel />
          : !feed.length ? <div className="card"><EmptyState icon="check" title="No collisions in the last 7 days">When an agent writes a symbol another change leases, the diagnostic it received shows here.</EmptyState></div>
            : <>
              {top ? <section className="card ci open" aria-label="Open collision"><Head f={top} /><Told f={top} /><Resolve key={top.id} f={top} map={map ?? undefined} reload={() => Promise.all([reload(), loadMap()])} /></section>
                : <div className="card"><EmptyState icon="check" title="Nothing open">Every collision in the last 7 days is resolved.</EmptyState></div>}
              {open.filter((f) => f !== top).map((f) => <section key={f.id} className="card ci"><Head f={f} /><Told f={f} />
                <div className="ci-a"><button type="button" className="btn btn-secondary btn-sm" onClick={() => setPick(f.id)}>Resolve…</button></div></section>)}
              {done.length > 0 && <section className="card"><div className="card-h"><h3>Resolved</h3><span className="end subtle">7 days</span></div>
                <div className="card-b stack">{done.map((f) => <div key={f.id} className="ci res"><Head f={f} /><Told f={f} />
                  <p className="ok-t"><Ic name="check" />{DONE[f.resolution]}: <ChangeId id={f.ours} /> on <ChangeId id={f.theirs} />
                    {f.resolved_by && ` · by ${f.resolved_by.type === "system" ? "cinder" : f.resolved_by.id}`}{f.resolved_at && ` · ${ago(f.resolved_at)} ago · took ${Math.round(took(f))} min`}</p></div>)}</div></section>}
            </>}
    </aside></div>
  </Frame></Keys.Provider>;
}
