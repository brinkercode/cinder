// New change (live intent box).
import { Suspense, useEffect, useRef, useState } from "react";
import { Await, Link, useAsyncError, useLoaderData, useLocation, useNavigate, useRevalidator, useSearchParams } from "react-router";
import { createChange, listen, previewChange, requestReviewer } from "./client.js";
import { Ic } from "./icons.jsx";
import { PRIORITIES } from "./labels.jsx";
import { PageActions } from "./shell.jsx";
import { Br, ChangeId, LiveLabel, Panel, Prob, State, Frame } from "./ui.jsx";
import { RowsSkel } from "./skeleton.jsx";
import { codePath } from "./lib/code-path.js";
import "./styles/new-change.css";

const MIN = 8;
const DONE = ["merged", "failed", "closed"];
const AGENT = /@([\w-]+@[\w.]+)/;
const LINKS = /#([\w-]+)/g;
const bullets = (t) => t.split("\n").filter((l) => /^\s*[-*]\s+/.test(l)).map((l) => l.replace(/^\s*[-*]\s+/, ""));
const clean = (s) => s.replace(/@[\w-]+@[\w.]+/g, "").replace(LINKS, "").replace(/\s+/g, " ").trim() || s;
const active = (map) => map.changes.filter((c) => !DONE.includes(c.state));
const stableOf = (agents) => agents.flatMap((a) => a.versions.filter((v) => v.channel === "stable").map((v) => `${a.name}@${v.version}`))[0];
const words = (s) => s.split(/[\s,]+/).filter(Boolean);

// The listbox under the caret: `@` suggests agent@version, `#` suggests active changes.
export function suggest(value, pos, [agents, map]) {
  const m = value.slice(0, pos).match(/(^|\s)([@#])([\w.@-]*)$/);
  if (!m) return null;
  const items = m[2] === "@"
    ? agents.flatMap((a) => a.versions.filter((v) => v.channel !== "retired").map((v) => ({ ins: `@${a.name}@${v.version}`, id: `${a.name}@${v.version}`, meta: v.channel })))
    : active(map).map((c) => ({ ins: `#${c.id}`, id: c.id, meta: c.intent }));
  const hits = items.filter((i) => i.ins.toLowerCase().includes(m[3].toLowerCase())).slice(0, 6);
  return hits.length ? { start: pos - m[3].length - 1, end: pos, items: hits, idx: 0 } : null;
}

function Prediction({ base, text, target, agent, count, preview, data: [agents, map, hints, { judges }, , board] }) {
  const t = text.trim();
  if (t.length < MIN) return <p className="pred-empty">Start typing an intent. Predicted leases, collisions and risk appear here as you write.</p>;
  // Live (no hints), the worker's preview predicts; fixtures keep the prototype's heuristic.
  if (!hints && !preview) return <p className="pred-empty">Predicting…</p>;
  const lower = t.toLowerCase();
  const symbols = hints ? [...new Set(hints.filter((h) => h.words.some((w) => lower.includes(w))).flatMap((h) => h.symbols))] : preview.symbols.map((s) => s.symbol);
  const changes = new Map(active(map).map((c) => [c.id, c]));
  const hits = hints ? map.leases.filter((l) => symbols.includes(l.symbol) && changes.has(l.holder))
    : preview.collisions.flatMap((c) => c.symbols.map((symbol) => ({ holder: c.change, symbol, mode: null })));
  const risk = hints ? Math.min(0.6, 0.06 + hits.length * 0.09 + Math.min(0.1, t.length / 3000)) : preview.risk.p;
  const clef = map.edges.find((e) => e.judge.name === "Clef")?.judge;
  const stable = stableOf(agents);
  const links = [...t.matchAll(LINKS)].map((m) => m[1]);
  const jev = judges.find((j) => j.id === "jev");
  const trusted = preview ? preview.risk.trusted : Boolean(jev?.trusted);
  const files = [...new Set(map.leases.filter((l) => symbols.includes(l.symbol)).map((l) => l.file))];
  // lazy: word overlap with every change on the board; ask the worker to search once boards pass a few hundred changes.
  const keys = clean(lower).split(/\W+/).filter((w) => w.length > 4);
  const similar = board.filter((c) => keys.some((w) => c.intent.toLowerCase().includes(w))).slice(0, 5);
  const owners = [...new Set(similar.filter((c) => c.agent).map((c) => (c.ver ? `${c.agent}@${c.ver}` : c.agent)))];
  return (
    <ul className="list">
      <li><b>Predicted leases</b>{symbols.length
        ? symbols.map((s) => <code key={s}>{s}</code>)
        : <span className="meta">No existing symbols matched. Likely new code only.</span>}</li>
      <li><b>Collisions with active changes</b>{hits.length
        ? hits.map((l) => (
          <div className="row" key={`${l.holder} ${l.symbol}`}>
            <Link to={`${base}/changes/${l.holder}`}><ChangeId id={l.holder} /></Link><code>{l.symbol}</code>
            <Prob p={l.mode && (l.mode === "seam" ? 0.35 : 0.62)} judge={clef} />
          </div>
        ))
        : <span className="meta">None predicted</span>}</li>
      <li><b>Risk</b><div className="row"><Prob p={risk} judge={jev} /><span className="meta">reverted or breaks {target} within 7 days</span>
        <span className="meta">{trusted ? "trusted" : "untrusted"}</span></div></li>
      <li><b>Similar changes</b>{similar.length
        ? similar.map((c) => (
          <span className="row" key={c.id}><Link to={`${base}/changes/${encodeURIComponent(c.key ?? c.id)}`}><ChangeId id={c.id} label={c.key} /></Link><span className="meta">{c.state}</span><span>{c.intent}</span></span>
        ))
        : <span className="meta">None found</span>}</li>
      <li><b>Suggested files</b>{files.length ? files.map((f) => <code key={f}>{f}</code>) : <span className="meta">None predicted</span>}</li>
      <li><b>Suggested owners</b>{owners.length ? owners.map((o) => <span className="mono" key={o}>{o}</span>) : <span className="meta">None found</span>}</li>
      <li><b>Agent</b><span className="mono">{(agent || t.match(AGENT)?.[1]) ?? (stable ? `${stable} (stable, default)` : "no stable agent")}</span></li>
      {links.length > 0 && <li><b>Linked changes</b>{links.map((id) => (
        <span className="row" key={id}><Link to={`${base}/changes/${encodeURIComponent(changes.get(id)?.key ?? id)}`}><ChangeId id={id} label={changes.get(id)?.key} /></Link><span className="meta">{changes.get(id)?.intent ?? "unknown change"}</span></span>
      ))}</li>}
      <li><b>Launch</b><span className="meta">{count} change{count > 1 ? "s" : ""} on <Br name={target} /></span></li>
    </ul>
  );
}

const Target = ({ repo, target, setTarget }) => (
  <label className="row end"><span className="meta">target</span>
    <select className="input mono" aria-label="Target branch" value={target} onChange={(e) => setTarget(e.target.value)}>
      {repo.branch_policy.integration.map((b) => <option key={b}>{b}</option>)}
    </select>
  </label>
);

// One request at a time: the ref blocks a second click before React re-renders the disabled button; busy is the draft flag of the pending request.
function useSend() {
  const sending = useRef(false);
  const [busy, setBusy] = useState(null);
  const [failed, setFailed] = useState("");
  const send = (asDraft, run) => async () => {
    if (sending.current) return;
    sending.current = true;
    setBusy(asDraft);
    setFailed("");
    try {
      await run(asDraft);
    } catch (err) {
      setFailed(err.message);
    } finally {
      sending.current = false;
      setBusy(null);
    }
  };
  return { busy, failed, setFailed, send };
}

function Describe({ repo, draft, data, rail }) {
  const { text, setText, target, setTarget, split, setSplit, form, setForm } = draft;
  const base = `/${encodeURIComponent(repo.name)}`;
  const navigate = useNavigate();
  const box = useRef(null);
  const [menu, setMenu] = useState(null);
  const { busy, failed, setFailed, send } = useSend();
  const [preview, setPreview] = useState(null);
  const t = text.trim();
  const lines = split ? bullets(t) : [];
  const titles = lines.length ? lines : [t.split("\n")[0]];
  const agents = data?.[0] ?? [];
  const agent = form.agent || t.match(AGENT)?.[1] || stableOf(agents) || "";
  const field = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const type = (e) => {
    setText(e.target.value);
    setMenu(data ? suggest(e.target.value, e.target.selectionStart, data) : null);
  };
  const pick = (i) => {
    const ins = `${menu.items[i].ins} `;
    const at = menu.start + ins.length;
    setText(text.slice(0, menu.start) + ins + text.slice(menu.end));
    setMenu(null);
    requestAnimationFrame(() => { box.current.focus(); box.current.setSelectionRange(at, at); });
  };
  const keys = (e) => {
    if (!menu) return;
    const n = menu.items.length;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setMenu({ ...menu, idx: (menu.idx + (e.key === "ArrowDown" ? 1 : n - 1)) % n });
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      pick(menu.idx);
    } else if (e.key === "Escape") setMenu(null);
  };
  // Live: re-ask the worker 300ms after typing stops; a newer draft drops the older answer.
  useEffect(() => {
    if (!data || data[2] || t.length < MIN) return;
    let stale = false;
    const timer = setTimeout(() => previewChange(repo.name, t, target)
      .then((p) => { if (!stale) { setPreview(p); setFailed(""); } }, (err) => { if (!stale) setFailed(err.message); }), 300);
    return () => { stale = true; clearTimeout(timer); };
  }, [data, repo.name, t, target, setFailed]);
  // A described change never carries a head branch: an agent writes it.
  const launch = (asDraft) => send(asDraft, async () => {
    const body = {
      target_branch: target, agent_version: agent || undefined, priority: form.priority, labels: words(form.labels),
      acceptance: form.criteria.split("\n").map((l) => l.trim()).filter(Boolean).map((content, i) => ({ path: `criteria-${i + 1}.md`, content })),
      links: [...[...t.matchAll(LINKS)].map((m) => m[1]), ...words(form.links)], draft: asDraft,
    };
    for (const title of titles) await createChange(repo.name, { intent: clean(title), ...body });
    const n = `${titles.length} change${titles.length > 1 ? "s" : ""}`;
    navigate(`${base}/changes`, { state: { toast: asDraft ? `${n} saved as draft` : `${n} handed to ${agent || "an agent"}` } });
  });
  const off = t.length < MIN || busy !== null;

  return (
    <div className="two">
      <div className="col-main">
        <Panel title="Intent" aside={<Target repo={repo} target={target} setTarget={setTarget} />}>
          <div className="pad ibox">
            <textarea ref={box} className="input" aria-label="Intent" aria-autocomplete="list" aria-expanded={Boolean(menu)} spellCheck
              placeholder="e.g. Strip hop-by-hop headers before cache lookup @patch@3.3.0 #c-1042" value={text} onChange={type} onKeyDown={keys}
              onBlur={() => setMenu(null)} />
            {menu && (
              <div className="sugg" role="listbox" aria-label="Suggestions">
                {menu.items.map((it, i) => (
                  <button type="button" role="option" aria-selected={i === menu.idx} key={it.ins} onMouseDown={(e) => { e.preventDefault(); pick(i); }}>
                    {it.ins.startsWith("#") ? <ChangeId id={it.id} /> : <span className="mono">{it.id}</span>}<span className="meta">{it.meta}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="pad row nc-opts">
            <label className="row"><input type="checkbox" checked={split} onChange={(e) => setSplit(e.target.checked)} /> One change per bullet line</label>
            <label className="row end"><span className="meta">agent</span>
              <select className="input mono" aria-label="Agent" value={agent} onChange={field("agent")}>
                {agents.flatMap((a) => a.versions.filter((v) => v.channel !== "retired").map((v) => {
                  const id = `${a.name}@${v.version}`;
                  // lazy: 20 races is a fixed floor for showing a win rate; read it from the judges' trust once they report one.
                  const win = v.races >= 20 && v.wins != null ? `${Math.round((v.wins / v.races) * 100)}% win` : "not enough races";
                  return <option key={id} value={id}>{`${id} · ${v.channel} · ${win}`}</option>;
                }))}
              </select>
            </label>
          </div>
          <details className="nc-det">
            <summary>Acceptance criteria, labels, priority</summary>
            <div className="pad">
              <textarea className="input" aria-label="Acceptance criteria" placeholder="Optional acceptance criteria, one per line" value={form.criteria} onChange={field("criteria")} />
              <div className="row">
                <input className="input" aria-label="Labels" placeholder="labels, comma separated" value={form.labels} onChange={field("labels")} />
                <label className="row"><span className="meta">priority</span>
                  <select className="input" aria-label="Priority" value={form.priority} onChange={field("priority")}>
                    {PRIORITIES.map((p) => <option key={p}>{p}</option>)}
                  </select>
                </label>
              </div>
              <input className="input" aria-label="Links" placeholder="Optional links: wiki pages or change ids" value={form.links} onChange={field("links")} />
            </div>
          </details>
          <div className="leg-foot">
            {failed && <span className="meta" role="alert">{failed}</span>}
            <Link className="btn btn-ghost end" to={`${base}/changes`}>Cancel</Link>
            <button type="button" className="btn btn-ghost" disabled={off} aria-busy={busy === true || undefined} onClick={launch(true)}>Save draft</button>
            <button type="button" className="btn btn-primary" disabled={off} aria-busy={busy === false || undefined} onClick={launch(false)}>Hand to agent</button>
          </div>
        </Panel>
      </div>
      <aside className="rail">
        {rail ?? (
          <Panel title="Prediction" aside={<LiveLabel />}>
            <div aria-live="polite"><Prediction base={base} text={text} target={target} agent={form.agent} count={split ? Math.max(1, lines.length) : 1} preview={preview} data={data} /></div>
          </Panel>
        )}
      </aside>
    </div>
  );
}

function Wrote({ repo, draft, data, rail }) {
  const { target, setTarget, head, setHead, mine, setMine } = draft;
  const base = `/${encodeURIComponent(repo.name)}`;
  const navigate = useNavigate();
  const { busy, failed, send } = useSend();
  // Until the branches load, the head picked in the URL is the only option.
  const heads = [...new Set([head, ...(data?.[6] ?? []).filter((b) => b.kind === "branch").map((b) => b.name)])].filter((b) => b && b !== target);
  const reviewers = [
    ...(data?.[0] ?? []).flatMap((a) => a.versions.filter((v) => v.channel === "stable").map((v) => ({ kind: "agent_version", id: `${a.name}@${v.version}` }))),
    ...(data?.[8] ?? []).map((p) => ({ kind: "person", id: p.email })),
  ];
  const picked = (r) => mine.reviewers.some((x) => x.id === r.id);
  const title = mine.title.trim();
  const diff = head && data?.[7] ? data[7].diff : undefined;
  const missing = !head ? "Pick a head branch" : !title ? "Add a title" : !mine.reviewers.length ? "Pick a reviewer" : "";
  const field = (k) => (e) => setMine({ ...mine, [k]: e.target.value });
  const open = (asDraft) => send(asDraft, async () => {
    const body = mine.body.trim();
    const change = await createChange(repo.name, {
      intent: body ? `${title}\n\n${body}` : title, target_branch: target, head_branch: head, draft: asDraft, agent_pushes: mine.pushes,
    });
    // Fixture mode creates nothing, so there is no detail page to open.
    if (!change) return navigate(`${base}/changes`, { state: { toast: "Opened a change" } });
    // The change exists either way, so a refused reviewer request is reported, not retried with a second change.
    const asked = await Promise.all(mine.reviewers.map((r) => requestReviewer(change.id, r.kind, r.id)))
      .then(() => "", (err) => ` · reviewers not requested: ${err.message}`);
    navigate(`${base}/changes/${change.id}`, { state: { toast: `Opened ${change.id} · you drive${asDraft ? " · draft" : ""}${asked}` } });
  });

  return (
    <div className="two">
      <div className="col-main">
        <Panel title="Your change" aside={<Target repo={repo} target={target} setTarget={setTarget} />}>
          <div className="pad nc-form">
            <label className="row"><span className="meta">head</span>
              <select className="input mono" aria-label="Head branch" value={head} onChange={(e) => setHead(e.target.value)}>
                <option value="">Pick a branch you pushed</option>
                {heads.map((b) => <option key={b}>{b}</option>)}
              </select>
              <span className="meta">or push to <code>refs/for/{target}</code></span>
            </label>
            {diff !== undefined && (
              <p className="nc-diff"><Ic name="branch" /><span className="mono">{head}</span>
                {diff ? <><span className="meta">{diff.ahead} commits · {diff.stats.files_changed} files</span>
                  <span className="mono end"><span className="add">+{diff.stats.additions}</span> <span className="del">−{diff.stats.deletions}</span></span></>
                  : <span className="meta">Comparing…</span>}
              </p>
            )}
            <input className="input" aria-label="Title" placeholder="Title" value={mine.title} onChange={field("title")} />
            <textarea className="input" aria-label="Description" placeholder="Why, and how to check it" value={mine.body} onChange={field("body")} />
            <div className="row" role="group" aria-label="Reviewers">
              <span className="meta">reviewers</span>
              {reviewers.map((r) => (
                <button type="button" key={r.id} className="btn btn-ghost btn-sm nc-rv" aria-pressed={picked(r)}
                  onClick={() => setMine({ ...mine, reviewers: picked(r) ? mine.reviewers.filter((x) => x.id !== r.id) : [...mine.reviewers, r] })}>
                  <Ic name={r.kind === "person" ? "user" : "robot"} />{r.id}
                </button>
              ))}
            </div>
            <label className="row"><input type="checkbox" checked={mine.pushes} onChange={(e) => setMine({ ...mine, pushes: e.target.checked })} />
              <span><b>Let agents push to it</b> <span className="meta">Off: only you push; agents can comment.</span></span></label>
          </div>
          <div className="leg-foot">
            {failed && <span className="meta" role="alert">{failed}</span>}
            <Link className="btn btn-ghost end" to={`${base}/changes`}>Cancel</Link>
            <button type="button" className="btn btn-ghost" disabled={Boolean(missing) || busy !== null} title={missing || undefined} aria-busy={busy === true || undefined} onClick={open(true)}>Open as draft</button>
            <button type="button" className="btn btn-primary" disabled={Boolean(missing) || busy !== null} title={missing || undefined} aria-busy={busy === false || undefined} onClick={open(false)}>Open change</button>
          </div>
        </Panel>
      </div>
      <aside className="rail">
        {rail}
        <Panel title="What happens">
          <ol className="nc-steps">
            <li><b>Verifier runs</b><span className="meta">Checks run on every push.</span></li>
            <li><b>Judges score it</b><span className="meta">p(merge) and risk, with how often they have been right.</span></li>
            <li><b>Reviewers approve</b><span className="meta">{mine.reviewers.length ? mine.reviewers.map((r) => r.id).join(", ") : "Pick at least one reviewer"}.</span></li>
            <li><b>Verifier merges</b><span className="meta">Through the merge queue into <Br name={target} />.</span></li>
          </ol>
        </Panel>
      </aside>
    </div>
  );
}

function LoadError() {
  const err = useAsyncError();
  const { revalidate } = useRevalidator();
  const msg = String(err?.message ?? err);
  return <State kind="error" title="Couldn't load the prediction" request={/^(GET|POST) /.test(msg) ? msg : `GET ${msg}`} onRetry={revalidate} />;
}

const MODES = [
  ["agent", "robot", "Describe it", "Plain prose; an agent picks it up, writes the code and the verifier merges it."],
  ["human", "user", "I wrote it", "Open your branch for review, like a pull request. You drive; reviewers and the verifier decide."],
];
const titleOf = (branch) => branch.split("/").pop().replace(/[-_]+/g, " ").replace(/^./, (c) => c.toUpperCase());

export function NewChange() {
  const { repo, data } = useLoaderData();
  const [params, setParams] = useSearchParams();
  // Judges, Reconcile and New change from intent hand an intent over in the link's state; there is no ?intent= prefill.
  const [text, setText] = useState(useLocation().state?.intent ?? "");
  // The target is the top bar's ?target=, so its switcher and this select stay in step.
  const target = params.get("target") ?? repo.default_branch;
  const setTarget = (b) => setParams((p) => { p.set("target", b); return p; }, { replace: true });
  // ?head= (even empty, from Changes › From a branch) opens I wrote it on that pushed branch.
  const head = params.get("head") ?? "";
  const [mode, setMode] = useState(params.has("head") ? "human" : "agent");
  const [split, setSplit] = useState(false);
  const [form, setForm] = useState({ agent: "", priority: "P2", labels: "", criteria: "", links: "" });
  // ?issue=n (the intent drawer's I'll write it) starts the title with #n, so the change links the intent.
  const [mine, setMine] = useState({ title: params.has("issue") ? `#${params.get("issue")} ` : titleOf(head), body: "", reviewers: [], pushes: false });
  const setHead = (b) => {
    setParams((p) => { p.set("head", b); return p; }, { replace: true });
    if (!mine.title.trim()) setMine({ ...mine, title: titleOf(b) });
  };
  const draft = { text, setText, target, setTarget, head, setHead, split, setSplit, form, setForm, mine, setMine };
  const Form = mode === "agent" ? Describe : Wrote;
  const base = `/${encodeURIComponent(repo.name)}`;
  const { revalidate } = useRevalidator();
  useEffect(() => listen(repo.name, revalidate), [repo.name, revalidate]);
  return (
    <Frame>
      <nav className="crumb" aria-label="Breadcrumb"><Link to={`${base}/changes`}>Changes</Link><span>/</span><span>New</span></nav>
      <PageActions><Link className="btn btn-secondary" to={codePath(repo.name, target)}>Edit in Code</Link></PageActions>
      <div className="nc-mode" role="radiogroup" aria-label="How this change gets written">
        {MODES.map(([m, icon, name, blurb]) => (
          <label className={`nc-m nc-${m}`} key={m}>
            <input type="radio" name="nc-mode" value={m} checked={mode === m} onChange={() => setMode(m)} />
            <span className="nc-mi"><Ic name={icon} /></span><span><b>{name}</b><small>{blurb}</small></span>
          </label>
        ))}
      </div>
      {/* Both drafts live here, so switching modes or the prediction loading keeps what was typed in each. */}
      <Suspense fallback={<Form repo={repo} draft={draft} rail={<RowsSkel label="prediction" />} />}>
        <Await resolve={data} errorElement={<Form repo={repo} draft={draft} rail={<LoadError />} />}>
          {(d) => <Form repo={repo} draft={draft} data={d} />}
        </Await>
      </Suspense>
    </Frame>
  );
}
