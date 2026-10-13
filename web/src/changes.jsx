// Changes: one board and table for intents and the changes that carry them, over GET /api/repos/:name/work.
import { createContext, Suspense, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Await, Link, useAsyncError, useLoaderData, useNavigate, useRevalidator, useSearchParams } from "react-router";
import { validateWorkItem } from "../../worker/src/api/contract.js";
import { repairing } from "../../worker/src/api/lanes.js";
import { useCollisions } from "./api/collisions.js";
import { prefetchChange } from "./api/changes.js";
import { editIntent } from "./api/labels.js";
import { claimIntent, suggestAgents, unclaimIntent } from "./api/work.js";
import { BudgetBanner } from "./budget.jsx";
import { changeAct, invalidate, listen, repoPost } from "./client.js";
import { Ic } from "./icons.jsx";
import { IntentDrawer } from "./intent-drawer.jsx";
import { isAgent, Pri } from "./who.jsx";
import { LabelsEdit, PRIORITIES } from "./labels.jsx";
import { BoardColSkel, LoadingRegion, SkelFallback, TileSkel, useShape } from "./skeleton.jsx";
import { Dot, EmptyState, ErrorState, ChangeId, Dialog, IdText, Mid, Popover, Table, Tabs, Tag, Tile, Untrusted, tok, Frame } from "./ui.jsx";
import "./styles/changes.css";
import "./styles/repairs.css";

// [lane, label, dot tone], the server's lanes (worker/src/api/lanes.js).
export const COLUMNS = [["intent", "Intents", ""], ["progress", "In progress", "info"], ["verify", "Verifying", "info"], ["review", "Needs review", "warn"],
  ["queue", "Merge queue", "ok"], ["merged", "Merged · 24h", "ok"]];

// A failed change whose last allowed round failed too.
export const exhausted = (c) => c.state === "failed" && Boolean(c.repair) && c.repair.round === c.repair.max;
export const outOfRounds = (r) => `All ${r.max} rounds used and ${r.check ?? "the check"} still fails. It needs a person.`;
export const CLOSE_CONFIRM = "Close this change? Its leases release, the agent stops, and closing can't be undone.";
export const PAST = "Past In progress, only the verifier moves work.";
export const OWNED = "An agent already committed; the verifier owns it now.";
export const NO_WRITE = "Moving intents needs repo.write on this repo.";

export function ago(iso) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
}

// d is the work item's diff summary; a closed change, off the work list, shows the adds and dels of its changes-list row.
const Diff = ({ d, c }) => {
  const [adds, dels] = d ? [d.additions, d.deletions] : c?.adds != null ? [c.adds, c.dels] : [];
  return adds != null && <span className="mono"><span className="adds">+{adds}</span> <span className="dels">−{dels}</span></span>;
};
const tokens = (c) => c.tok[0] + c.tok[1];
// An empty ?head= opens New change on I wrote it with no branch picked yet.
const fromBranch = (base, target) => `${base}/changes/new?target=${encodeURIComponent(target)}&head=`;
const NewChange = ({ base }) => <Link className="btn btn-primary" to={`${base}/changes/new`}><Ic name="plus" />Describe a change</Link>;

// Close change…: a confirm with an optional reason, shown on the change. Closing is final.
export function CloseDialog({ dlg, c, onClose }) {
  const [why, setWhy] = useState("");
  return <Dialog ref={dlg} title={<>Close <ChangeId id={c.id} label={c.key} />?</>} action="Close change" onClose={(e) => e.currentTarget.returnValue === "ok" && onClose(why.trim())}>
    <p>Its leases release, its agent stops working on it and nothing merges. This can't be undone: a closed change can't be reopened, but you can start a new change from the same intent.</p>
    <label className="field"><span>Reason <span className="subtle">optional, shown on the change</span></span>
      <input className="input w" aria-label="Reason" maxLength={500} value={why} onChange={(e) => setWhy(e.target.value)} /></label>
  </Dialog>;
}
export const openDialog = (dlg) => { dlg.current.returnValue = ""; dlg.current.showModal(); };
export async function retryVerify(id) {
  try { await changeAct(id, "retry"); } catch (e) { throw new Error(`Retry didn't start: ${e.message}. The change stays failed.`, { cause: e }); }
}

// A failed card's Retry verify and Close…; clicks stay off the card, which opens the change.
function FailedActs({ c }) {
  const { revalidate } = useRevalidator();
  const dlg = useRef(null);
  const [err, setErr] = useState(null);
  const run = async (call) => {
    setErr(null);
    try { await call(); revalidate(); } catch (e) { setErr(e.message); }
  };
  return <div className="chg-acts" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
    <button type="button" className="btn btn-secondary" onClick={() => run(() => retryVerify(c.id))}><Ic name="refresh" />Retry verify</button>
    <button type="button" className="btn btn-ghost" onClick={() => openDialog(dlg)}>Close…</button>
    {err && <p className="err-line" role="alert">{err}</p>}
    <CloseDialog dlg={dlg} c={c} onClose={(reason) => run(() => changeAct(c.id, "close", { reason }))} />
  </div>;
}

// The open collisions of the board's repo; a card names the one its change ran into.
const OpenCollisions = createContext([]);

// A new intent has no n until POST /issues answers.
const key = (it) => it.change_id ?? (it.n ? `#${it.n}` : `new:${it.updated_at}`);
// An issue's change in progress has no commit yet (the server's laneOf): it is still the claimed intent #n.
const claimed = (it) => it.kind === "change" && it.n !== null && it.lane === "progress";
// An intent claimed by an agent is the agent's; a change is its author's.
const byAgent = (it) => isAgent(it.kind === "intent" ? it.assignee ?? "" : it.author);

// p(merge) of the change's agent version: its merged over its decided (merged, failed, closed) changes.
// lazy: counts this repo's changes only and scans them per card; read p_merge from /work once it serves one.
function pMerge(cards, c) {
  if (!c?.ver) return null;
  const done = cards.filter((x) => x.agent === c.agent && x.ver === c.ver && ["merged", "failed", "closed"].includes(x.state));
  return { n: done.length, p: done.filter((x) => x.state === "merged").length / done.length };
}
// Under 20 outcomes the number isn't shown, so a handful never reads 0% or 100%.
const PMerge = ({ pm }) => (!pm ? <span className="meta">—</span> : pm.n < 20 ? <Untrusted n={pm.n} />
  : <span className="pill" title="Probability the verifier merges this">p {pm.p.toFixed(2)}</span>);

// An open or claimed intent: it drags between Intents and In progress, and an open one opens the drawer.
// legs: the claimed changes carrying #n (a race has two); move(n, lane) claims, releases or refuses.
function IntentCard({ it, legs, can, move, open }) {
  const off = !can || !it.n;
  const opens = it.lane === "intent" && it.n ? open : undefined;
  const claim = it.lane === "progress" && (it.claim ?? (legs > 1 ? `racing ${legs}` : it.author));
  const stop = (e) => e.stopPropagation();
  return <article className="chg intent" tabIndex={0} draggable={!off} title={can ? undefined : NO_WRITE} onClick={opens}
    onKeyDown={(e) => opens && e.target === e.currentTarget && e.key === "Enter" && opens()} onDragStart={(e) => e.dataTransfer.setData("text/plain", String(it.n))}>
    <div className="chg-h"><span className="meta"><Ic name="issue" />{it.n && `#${it.n}`}</span><Pri p={it.priority} />
      {claim && <span className="pill end"><Ic name="robot" />{claim}</span>}</div>
    <h4 title={it.title}>{it.title}</h4>
    {it.labels.length > 0 && <div className="row">{it.labels.map((l) => <Tag key={l}>{l}</Tag>)}</div>}
    <div className="chg-f" onClick={stop} onKeyDown={stop}><span className="meta">by {it.author} · {ago(it.updated_at)}</span>
      <select className="input end" aria-label={`Move #${it.n} to…`} value="" disabled={off} title={can ? undefined : NO_WRITE} onChange={(e) => move(it.n, e.target.value)}>
        <option value="" disabled>Move to…</option>{COLUMNS.filter(([k]) => k !== it.lane).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
      {it.lane === "intent" && <button type="button" className="btn btn-secondary" disabled={off} title={can ? undefined : NO_WRITE} onClick={() => move(it.n, "progress")}>
        <Ic name="robot" />Hand to agent</button>}</div>
  </article>;
}

// c is the change's board card (tokens, repair); null until the changes list has it.
function ChangeCard({ it: { c, pm, live, ...it }, open, warm }) {
  const { revalidate } = useRevalidator();
  const hit = useContext(OpenCollisions).find((f) => f.ours === it.change_id);
  const [err, setErr] = useState(null);
  // The card opens on click and Enter, so its own buttons keep theirs.
  const act = (name) => async (e) => {
    e.stopPropagation();
    if (name === "close" && !confirm(CLOSE_CONFIRM)) return;
    setErr(null);
    try { await changeAct(it.change_id, name); revalidate(); } catch (x) { setErr(x.message); }
  };
  const why = it.why ?? c?.blocked;
  return (
    <article className={`chg ${it.lane}`} tabIndex={0} draggable={false} onClick={open} onMouseOver={warm} onFocus={warm} onKeyDown={(e) => e.target === e.currentTarget && e.key === "Enter" && open()}>
      <div className="chg-h"><span className="meta"><ChangeId id={it.change_id} label={c?.key} />{it.n && <span className="mono subtle"> #{it.n}</span>} · <span className="mono">{it.author}</span> · {ago(it.updated_at)}</span>
        {it.lane === "merged" ? <span className="pill">merged</span> : <PMerge pm={pm} />}</div>
      <h4 title={it.title}>{it.title}</h4>
      {(it.labels.length > 0 || it.priority) && <div className="chg-l">{it.labels.map((l) => <Tag key={l}>{l}</Tag>)}<Pri p={it.priority} /></div>}
      {live && <div className="wc-live"><Dot tone="info" /><span>{live}</span></div>}
      {hit && <div className="why"><Ic name="tri" />Collides with <ChangeId id={hit.theirs} /> on {hit.symbol.split("#")[1] ?? hit.symbol}</div>}
      {c && repairing(c) && <div className="repairing"><Ic name="spin" />Repairing · round {c.repair.round} of {c.repair.max}{c.repair.check && ` · fixing ${c.repair.check}`}</div>}
      {c && exhausted(c) ? <>
        <div className="why"><Ic name="tri" />{outOfRounds(c.repair)}</div>
        <div className="row"><button type="button" className="btn btn-secondary" onClick={act("retry")}>Retry verify</button>
          <button type="button" className="btn btn-ghost" onClick={act("close")}>Close…</button></div>
        {err && <p className="err-line" role="alert">{err}</p>}
      </> : <>
        {why && <div className="why"><Ic name="tri" /><IdText text={why} /></div>}
        {c?.state === "failed" && <FailedActs c={c} />}
      </>}
      <div className="chg-f"><span className="end"><Diff d={it.diff} c={c} /></span></div>
      <div className="chg-m">
        {it.diff && <span><Ic name="file" />{it.diff.files_changed}</span>}
        {c?.ver ? <span><Ic name="token" />{tokens(c) ? tok(tokens(c)) : "—"}</span> : <span><Ic name="user" />written by hand</span>}
        {c?.risk_judge && <span><Ic name="shieldck" />{c.risk_judge.name}</span>}
      </div>
    </article>
  );
}

function Board({ repo, items, href, navigate, adding, setAdding, add, can, move, setOpen }) {
  const keys = (e) => {
    if (e.key === "Escape") setAdding(false);
    if (e.key === "Enter" && e.target.value.trim()) { add(e.target.value.trim()); e.target.value = ""; }
  };
  return (
    <div className="board">
      {COLUMNS.map(([lane, label, dot]) => {
        const col = items.filter((it) => it.lane === lane);
        return (
          <section className="col" aria-label={label} key={lane} onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); move(Number(e.dataTransfer.getData("text/plain")), lane); }}>
            <header className="col-h"><Dot tone={dot} />{label}<span className="n">{col.length}</span>
              {lane === "intent" && <button type="button" className="ib" aria-label="New intent" onClick={() => setAdding(true)}><Ic name="plus" /></button>}</header>
            <div className="cards">
              {lane === "intent" && adding && <input className="input" aria-label="Intent title" placeholder="What should change? Enter to add" onKeyDown={keys} />}
              {col.map((it, i) => {
                // A race's legs share the one intent card.
                const legs = col.filter((x) => claimed(x) && x.n === it.n);
                if (claimed(it) && legs[0] !== col[i]) return null;
                return it.kind === "intent" || claimed(it) ? <IntentCard key={key(it)} it={it} legs={legs.length} can={can} move={move} open={() => setOpen(it.n)} />
                  : <ChangeCard key={key(it)} it={it} open={() => navigate(href(it))} warm={() => prefetchChange(repo, it.c?.key ?? it.change_id)} />;
              })}
              {!col.length && !(lane === "intent" && adding) && <p className="col-empty">Nothing here</p>}
            </div>
          </section>
        );
      })}
    </div>
  );
}

const WorkTable = ({ items, href, navigate }) => (
  <div className="card"><Table>
    <thead><tr><th>Item</th><th>Title</th><th>Stage</th><th>Who</th><th>p(merge)</th><th className="num">Diff</th><th className="num">Tokens</th><th className="num">Age</th></tr></thead>
    <tbody>
      {items.map((it) => (
        <tr key={key(it)} className={it.change_id ? "link-row" : undefined} onClick={it.change_id ? () => navigate(href(it)) : undefined}>
          <td>{it.change_id && <Link to={href(it)}><ChangeId id={it.change_id} label={it.c?.key} /></Link>}{it.n && <span className="mono subtle"> #{it.n}</span>}</td>
          <td>{it.title}</td><td>{COLUMNS.find(([k]) => k === it.lane)?.[1] ?? "Closed"}</td><td className="mono">{it.author}</td>
          <td>{it.kind === "change" && it.lane !== "merged" ? <PMerge pm={it.pm} /> : <span className="meta">—</span>}</td>
          <td className="num"><Diff d={it.diff} c={it.c} /></td><td className="num mono">{it.c && tokens(it.c) ? tok(tokens(it.c)) : "—"}</td><td className="num meta">{ago(it.updated_at)}</td>
        </tr>
      ))}
    </tbody>
  </Table></div>
);

const TILES = ["Intents waiting", "In flight", "Needs review", "Merged · 24h", "Verifier pass rate"];
// Cards per lane while loading.
const SKEL_CARDS = [2, 2, 2, 1, 2, 2];

const SORTS = [["lane", "Lane order"], ["priority", "Priority, P0 first"], ["age", "Oldest first"]];
const PRI_RANK = (p) => (p ? PRIORITIES.indexOf(p) : PRIORITIES.length);

// A toolbar menu whose button shows the current choice; disabled without options (loading, error).
function Menu({ label, icon, children }) {
  const face = <>{icon && <Ic name={icon} />}{label}<Ic name="chevD" /></>;
  return children ? <Popover label={face}><div className="lbl-menu">{children}</div></Popover> : <button type="button" className="btn btn-secondary" disabled>{face}</button>;
}

// Without setQ (loading, error) the filters stay in place, disabled. f: {label, priority, sort}; labels: the board's labels.
function Filters({ q = "", setQ, who = "all", setWho = () => {}, needs = 0, f = { label: null, priority: null, sort: "lane" }, setF, labels = [], base }) {
  const { revalidate } = useRevalidator();
  const [lq, setLq] = useState("");
  const off = !setQ;
  const set = (patch) => (e) => { setF((x) => ({ ...x, ...patch })); e.target.closest?.("[popover]")?.hidePopover(); };
  const opt = (patch, on, body) => <button type="button" aria-pressed={on} onClick={set(patch)}>{body}{on && <Ic name="check" />}</button>;
  const matching = labels.filter((l) => l.toLowerCase().includes(lq.trim().toLowerCase()));
  return (
    <div className="toolbar" role="search">
      <input className="input filter" type="search" placeholder="Search intents and changes, #number or c-id" aria-label="Search work" disabled={off} value={q} onChange={(e) => setQ(e.target.value)} />
      <Menu icon="tag" label={f.label ?? "Label"}>{!off && (labels.length ? <>
        <input className="input" aria-label="Filter labels" placeholder="Filter labels" value={lq} onChange={(e) => setLq(e.target.value)} />
        {opt({ label: null }, !f.label, "Any label")}
        {matching.map((l) => <span key={l}>{opt({ label: l }, f.label === l, <Tag>{l}</Tag>)}</span>)}
        {!matching.length && <p className="subtle">No label matches</p>}
      </> : <div className="lbl-empty"><b>No labels yet</b><p className="subtle">Labels you add to intents and changes show here. Route them to agents or people in Settings › Label routing.</p>
        <Link className="btn btn-secondary btn-sm" to={`${base}/settings#routing`}>Open Settings</Link></div>)}</Menu>
      <Menu label={f.priority ?? "Priority"}>{!off && <>{opt({ priority: null }, !f.priority, "Any priority")}
        {PRIORITIES.map((p) => <span key={p}>{opt({ priority: p }, f.priority === p, p)}</span>)}</>}</Menu>
      <Menu icon="ud" label={`Sort: ${SORTS.find(([k]) => k === f.sort)[1].toLowerCase()}`}>{!off && SORTS.map(([k, l]) => <span key={k}>{opt({ sort: k }, f.sort === k, l)}</span>)}</Menu>
      <Tabs label="Who" value={who} onChange={setWho} options={[["all", "All"], ["agents", "Agents"], ["people", "People"], ["you", `Needs you ${needs}`]]} />
      <button type="button" className="btn btn-secondary" aria-label="Refresh" disabled={off} onClick={() => { invalidate(); revalidate(); }}><Ic name="refresh" /></button>
    </div>
  );
}

// updates: [write, item] pairs the load may not hold; put adds one, settle(since) drops those written before the load started. state (?state=failed, from Insights) keeps only changes in that state.
function Ready({ data: [work, cards], updates, put, since, settle, live, repo, base, target, view, state, f, setF }) {
  const navigate = useNavigate();
  const { revalidate } = useRevalidator();
  const [q, setQ] = useState("");
  const [who, setWho] = useState("all");
  const [adding, setAdding] = useState(false);
  const [pending, setPending] = useState([]);
  const [err, setErr] = useState(null);
  const [toast, setToast] = useState(null);
  const [open, setOpen] = useState(null);
  // A change opens by its key (PULSE-6) when it has one.
  const href = (it) => `${base}/changes/${encodeURIComponent(it.c?.key ?? it.change_id)}`;
  useEffect(() => settle(since), [work, since, settle]);
  // An update replaces its item in place; a change carrying #n replaces the intent #n, and the intent #n (released) its changes.
  const items = updates.map(([, u]) => u).reduce((all, u) => {
    const rest = all.filter((i) => !(u.n !== null && i.n === u.n && i.kind !== u.kind));
    return rest.some((i) => key(i) === key(u)) ? rest.map((i) => (key(i) === key(u) ? u : i)) : [...rest, u];
  }, [...pending, ...work.items]);
  const count = (...lanes) => items.filter((i) => lanes.includes(i.lane)).length;
  useShape(`changes${base}/board`, SKEL_CARDS, COLUMNS.map(([k]) => count(k)));

  const add = async (title) => {
    const tmp = { kind: "intent", n: null, change_id: null, title, lane: "intent", priority: null, labels: [], author: "you", assignee: null, why: null, updated_at: new Date().toISOString() };
    setPending((p) => [tmp, ...p]);
    setErr(null);
    try {
      const i = await repoPost(repo, "/issues", { title });
      put({ ...tmp, n: i.number, author: i.author, labels: i.labels, priority: i.priority ?? null, updated_at: i.updated_at });
    } catch (e) { setErr(`Couldn't add the intent: ${e.message}`); }
    setPending((p) => p.filter((x) => x !== tmp));
  };

  // Optimistic: the card moves now and its items come back if the claim or release fails.
  const move = async (n, lane, mode = "agent") => {
    if (!["intent", "progress"].includes(lane)) {
      setToast(PAST);
      setTimeout(() => setToast(null), 4000);
      return;
    }
    const legs = items.filter((i) => i.n === n && (i.kind === "intent" || claimed(i)));
    if (!work.can_write || !legs.length || legs[0].lane === lane) return;
    setErr(null);
    put({ ...legs[0], kind: "intent", change_id: null, lane, claim: lane === "progress" ? (mode === "race" ? "racing 2" : "claiming…") : undefined });
    try {
      if (lane === "intent") await unclaimIntent(repo, n);
      else {
        const top = (await suggestAgents(repo, n)).map((a) => a.agent).slice(0, mode === "race" ? 2 : 1);
        put(await claimIntent(repo, n, { mode, ...(top.length && { agents: top }) }));
      }
    } catch (e) {
      legs.forEach(put);
      setErr(e.code === "verifier_owned" ? OWNED : `Couldn't move #${n}: ${e.message}`);
    }
  };
  const drawn = open && items.find((i) => i.kind === "intent" && i.n === open);

  const byId = new Map(cards.map((c) => [c.id, c]));
  const needle = q.trim().toLowerCase();
  // Closed changes are off the board (no lane matches) and listed in the table.
  const closed = cards.filter((c) => c.state === "closed").map((c) => ({ kind: "change", n: null, change_id: c.id, title: c.title, lane: "closed", labels: [],
    author: c.ver ? `${c.agent}@${c.ver}` : c.agent, updated_at: c.closed_at ?? c.updated_at }));
  const shown = [...items, ...closed].filter((it) => (who === "all" || (who === "you" ? it.lane === "review" : (who === "agents") === byAgent(it)))
    && (!state || byId.get(it.change_id)?.state === state) && (!f.label || it.labels.includes(f.label)) && (!f.priority || it.priority === f.priority)
    && (!needle || [it.title, it.n && `#${it.n}`, it.change_id, it.author, ...it.labels].some((s) => s && s.toLowerCase().includes(needle))))
    .map((it) => { const c = byId.get(it.change_id) ?? null; return { ...it, c, pm: pMerge(cards, c), live: live[it.change_id] }; })
    .sort((a, b) => (f.sort === "priority" ? PRI_RANK(a.priority) - PRI_RANK(b.priority) : 0)
      || (f.sort === "age" ? a.updated_at.localeCompare(b.updated_at) : b.updated_at.localeCompare(a.updated_at)));
  const labels = [...new Set(items.flatMap((i) => i.labels))].sort();
  // A label or priority edit is stored, then the card takes the saved values at once.
  const saveIntent = async (body) => {
    const i = await editIntent(repo, drawn.n, body);
    put({ ...drawn, labels: i.labels, priority: i.priority, updated_at: i.updated_at });
  };
  const v = work.tiles.verifier;
  return (
    <>
      <div className="tiles">
        <Tile label="Intents waiting" value={String(count("intent"))} />
        <Tile label="In flight" value={String(count("progress", "verify", "queue"))} />
        <Tile label="Needs review" value={String(count("review"))} />
        <Tile label="Merged · 24h" value={String(count("merged"))} />
        <Tile label="Verifier pass rate" value={v.trusted && v.n ? `${Math.round((100 * v.pass) / v.n)}%` : "—"} sub={v.trusted && v.n ? `n=${v.n}` : undefined}>
          {!v.trusted && <span className="untrusted">{v.n ? `untrusted: ${v.n} outcome${v.n === 1 ? "" : "s"}` : "no outcomes yet"}</span>}
        </Tile>
      </div>
      <Filters q={q} setQ={setQ} who={who} setWho={setWho} needs={count("review")} f={f} setF={setF} labels={labels} base={base} />
      {err && <p className="err-line" role="alert">{err}</p>}
      {!work.can_write && <p className="meta">{NO_WRITE}</p>}
      {toast && <p className="toast" role="status">{toast}</p>}
      {drawn && <IntentDrawer repo={repo} base={base} target={target} it={drawn} can={work.can_write} why={NO_WRITE} onClose={() => setOpen(null)}
        onStart={(mode) => { setOpen(null); move(drawn.n, "progress", mode); }} onClosed={() => { setOpen(null); revalidate(); }}>
        <LabelsEdit labels={drawn.labels} priority={drawn.priority} known={labels} save={saveIntent} />
      </IntentDrawer>}
      {!items.length && !adding ? <NoWork base={base} target={target} onIntent={() => setAdding(true)} />
        : view === "board" ? <Board repo={repo} items={shown} href={href} navigate={navigate} adding={adding} setAdding={setAdding} add={add}
          can={work.can_write} move={move} setOpen={setOpen} />
          : <WorkTable items={shown} href={href} navigate={navigate} />}
    </>
  );
}

function LoadError() {
  const err = useAsyncError();
  const { revalidate } = useRevalidator();
  // fetchJson's full request line already starts with the method; its bare form ("<path>: HTTP 503") does not.
  const msg = String(err?.message ?? err);
  return <>
    <div className="tiles">{TILES.map((l) => <Tile key={l} label={l} value="—" />)}</div>
    <Filters />
    <div className="card"><ErrorState message={`Couldn't load changes: ${msg.startsWith("GET ") ? "" : "GET "}${msg}`} onRetry={revalidate} /></div>
  </>;
}

const NoWork = ({ base, target, onIntent }) => <div className="card"><EmptyState icon="merge" title="Nothing in flight"
  action={<><button type="button" className="btn btn-secondary" disabled={!onIntent} onClick={onIntent}><Ic name="issue" />New intent</button><NewChange base={base} /></>}>
  Write an intent and an agent picks it up, or push to <span className="mono">refs/for/{target}</span> to open a change from git.</EmptyState></div>;

function Loading({ base, target }) {
  const { n } = useShape(`changes${base}/board`, SKEL_CARDS);
  return <LoadingRegion page="Changes" busy>
    <div className="tiles">{TILES.map((l) => <TileSkel key={l} label={l} />)}</div>
    <Filters />
    {n.some(Boolean) ? <div className="board">{COLUMNS.map(([k, label], i) => <BoardColSkel key={k} name={label} cards={n[i]} progress={k === "verify"} />)}</div>
      : <NoWork base={base} target={target} />}
  </LoadingRegion>;
}

let writes = 0;
const starts = new WeakMap();

export function Changes() {
  const { repo, data } = useLoaderData();
  const [search] = useSearchParams();
  const { revalidate } = useRevalidator();
  const [updates, setUpdates] = useState([]);
  const [live, setLive] = useState({});
  // Above the Suspense, so a reload or a live update redraws the board under the same filters.
  const [f, setF] = useState({ label: null, priority: null, sort: "lane" });
  // Each update carries its write number; a load drops only the updates written before it started,
  // so a load that started before a claim's answer doesn't undo it.
  const put = useCallback((item) => { const n = ++writes; setUpdates((u) => [...u, [n, item]]); }, []);
  const settle = useCallback((since) => setUpdates((u) => u.filter(([n]) => n > since)), []);
  // Stamped on the first render with this load's data, as it starts: that render may suspend and be thrown away.
  if (!starts.has(data)) starts.set(data, writes);
  const since = starts.get(data);
  // One socket per page; with live off, listen() revalidates every 15 s.
  useEffect(() => listen(repo.name, (e) => {
    const m = e ? JSON.parse(e.data) : {};
    if (m.kind === "work.activity") setLive((l) => ({ ...l, [m.change_id]: [m.activity, m.path].filter(Boolean).join(" ") }));
    else if (m.kind === "work.updated" && validateWorkItem(m.item).ok) put(m.item);
    else revalidate();
  }), [repo.name, revalidate, put]);
  const target = search.get("target") ?? repo.default_branch;
  const open = (useCollisions(repo.name, target).data?.feed ?? []).filter((f) => !f.resolution);
  // Board is F4 (columns scroll, the page doesn't); Table is F3.
  const [view, setView] = useState("board");
  const base = `/${encodeURIComponent(repo.name)}`;
  return (
    <OpenCollisions.Provider value={open}><Frame className={view === "board" ? "f-board" : undefined}>
      <BudgetBanner />
      <div className="toolbar">
        <Tabs label="View" value={view} onChange={setView} options={[["board", "Board"], ["table", "Table"]]} />
        <span className="subtle">Into <Mid text={target} /></span>
        <div className="toolbar-end"><Link className="btn btn-secondary" to={`${base}/changes/collisions`}><Ic name="tri" />Collisions{open.length > 0 && ` · ${open.length}`}</Link><Link className="btn btn-secondary" to={fromBranch(base, target)}><Ic name="branch" />From a branch</Link><NewChange base={base} /></div>
      </div>
      <Suspense fallback={<SkelFallback skel={<Loading base={base} target={target} />} onRetry={revalidate} />}>
        <Await resolve={data} errorElement={<LoadError />}>
          {(loaded) => <Ready data={loaded} updates={updates} put={put} since={since} settle={settle} live={live} repo={repo.name} base={base} target={target} view={view} state={search.get("state")} f={f} setF={setF} />}
        </Await>
      </Suspense>
    </Frame></OpenCollisions.Provider>
  );
}
