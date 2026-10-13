// A flow run: header, stage graph, job tree and Summary. One viewport: .rp fills .main and each pane scrolls on its own.
import { Fragment, Suspense, useEffect, useEffectEvent, useRef, useState } from "react";
import { Await, Link, useAsyncError, useLoaderData, useParams, useRevalidator, useSearchParams } from "react-router";
import { cancelFlowRun, flowRunResults, flowRunTree, rerunFlowRun } from "./api/flow-runs.js";
import { listen } from "./client.js";
import { FlowLog } from "./flow-log.jsx";
import { dur } from "./flows.jsx";
import { Ic } from "./icons.jsx";
import { Bone, BonePill, BoneText, LoadingRegion, useShape } from "./skeleton.jsx";
import { ChangeId, EmptyState, ErrorState, Mid, Tile } from "./ui.jsx";
import "./styles/runs.css";

export function flowRunLoader({ params }) {
  const run = Promise.all([flowRunTree(params.repo, params.id), flowRunResults(params.repo, params.id)])
    .then(([tree, b]) => ({ tree, ...b }));
  run.catch(() => {}); // <Await> shows a failed load; this stops an unhandled rejection before it renders
  return { run };
}

// Status → [run-i tone, icon, label, pill dot tone].
export const ST = { queued: ["", "circle", "Queued", ""], running: ["running", "spin", "Running", "info"], passed: ["pass", "okc", "Passed", "ok"],
  failed: ["fail", "xc", "Failed", "bad"], skipped: ["", "circle", "Skipped", ""], cancelled: ["", "xc", "Cancelled", ""] };
const RETRY = ["failed", "skipped", "cancelled"];
export const icon = (s) => <span className={`run-i ${ST[s][0]}`}><Ic name={ST[s][1]} /></span>;
const runsHref = (repo) => `/${encodeURIComponent(repo)}/flows`;
export const took = (j) => (j.started_at && j.finished_at ? dur(Date.parse(j.finished_at) - Date.parse(j.started_at)) : "");
export const jobName = (j) => (j.leg ? `${j.name} (${j.leg})` : j.name);

// run.updated's stage and job statuses applied to the tree in place.
const restatus = (tree, stages) => ({ ...tree, stages: tree.stages.map((st) => {
  const u = stages.find((s) => s.id === st.id);
  return u ? { ...st, status: u.status, jobs: st.jobs.map((j) => ({ ...j, status: u.jobs.find((x) => x.key === j.key)?.status ?? j.status })) } : st;
}) });

// What the server does on POST rerun, shown before it answers: the scope's jobs queue as their next attempt.
const requeue = (tree, scope) => ({ ...tree, status: "queued", stages: tree.stages.map((st) => {
  const jobs = st.jobs.map((j) => (scope === "all" || RETRY.includes(j.status) ? { ...j, status: "queued", attempt: j.attempt + 1, started_at: null, finished_at: null } : j));
  return { ...st, jobs, status: jobs.some((j, i) => j !== st.jobs[i]) ? "queued" : st.status };
}) });

export function FlowRun() {
  const { run } = useLoaderData();
  return <Suspense fallback={<RunSkel />}><Await resolve={run} errorElement={<RunError />}>{(r) => <RunPage data={r} />}</Await></Suspense>;
}

function RunSkel() {
  const { repo } = useParams();
  const cols = useShape(`flow-run/${repo}/stages`, 3).n;
  return <LoadingRegion page="flow run" busy><div className="rp">
    <header className="rp-h"><div className="rp-r1"><BoneText large /><BonePill /></div><div className="rp-meta"><BoneText i={1} /><BoneText i={2} /></div></header>
    <div className="rg">{Array.from({ length: cols }, (_, i) => <div key={i} className="rg-c"><BoneText i={i} /><Bone w="100%" h={30} r="pill" /></div>)}</div>
  </div></LoadingRegion>;
}

function RunError() {
  const err = useAsyncError();
  const { repo } = useParams();
  const { revalidate } = useRevalidator();
  return <div className="rp"><div className="card">{err?.status === 404
    ? <EmptyState icon="play" title="Run not found" action={<Link className="btn btn-secondary" to={runsHref(repo)}>All runs</Link>}>It may have been removed, or the link is wrong.</EmptyState>
    : <ErrorState message={`Couldn't load this run: ${err?.message ?? err}`} onRetry={revalidate} />}</div></div>;
}

function RunPage({ data }) {
  const { repo } = useParams();
  const { revalidate } = useRevalidator();
  const [q, setQ] = useSearchParams();
  const [over, setOver] = useState(null); // {from, tree?, notes?}: optimistic and live edits, until the loader returns newer data
  const [err, setErr] = useState(null);
  const [graph, setGraph] = useState(true);
  const { tree, notes, tests, artifacts } = over?.from === data ? { ...data, ...over } : data;
  const edit = (f) => setOver((o) => { const keep = o?.from === data ? o : { from: data }; return { ...keep, ...f({ ...data, ...keep }) }; });
  useShape(`flow-run/${repo}/stages`, 3, data.tree.stages.length);
  const rerun = (scope) => {
    setErr(null);
    edit((d) => ({ tree: requeue(d.tree, scope) }));
    rerunFlowRun(repo, tree.id, scope).then(revalidate, (e) => { setOver(null); setErr(e.message); });
  };
  const rerunJob = (key) => { setErr(null); rerunFlowRun(repo, tree.id, "job", key).then(revalidate, (e) => setErr(e.message)); };
  const cancel = () => { setErr(null); cancelFlowRun(repo, tree.id).then(revalidate, (e) => setErr(e.message)); };
  // One socket per page: run events patch the tree and annotations in place; a reconnect (no event) refetches.
  const onEvent = useEffectEvent((e) => {
    if (!e) return revalidate();
    const m = JSON.parse(e.data);
    if (m.id !== tree.id) return;
    if (m.kind === "run.updated") edit((d) => ({ tree: restatus(d.tree, m.stages) }));
    if (m.kind === "run.annotation") edit((d) => ({ notes: [...d.notes, ...m.annotations] }));
    if (m.kind === "run.log" && m.key === job) logSink.current?.(m);
  });
  // No ?job= picks the first failed job, else the first running one, else Summary; ?job= (empty) is Summary.
  const jobs = tree.stages.flatMap((s) => s.jobs);
  const first = jobs.find((j) => j.status === "failed") ?? jobs.find((j) => j.status === "running");
  const job = q.has("job") ? q.get("job") || null : first?.key ?? null;
  const pick = (key) => setQ({ job: key ?? "" });
  const picked = jobs.find((j) => j.key === job);
  // The socket reopens per job: it subscribes to that job's run.log lines on open.
  const logSink = useRef(null);
  useEffect(() => listen(repo, onEvent, job && { type: "subscribe", run: tree.id, key: job }), [repo, job, tree.id]);
  const onKey = useEffectEvent((e) => {
    if ((e.key !== "[" && e.key !== "]") || ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.nodeName)) return;
    const i = jobs.findIndex((j) => j.key === job);
    const to = e.key === "]" ? i + 1 : (i < 0 ? jobs.length : i) - 1;
    pick(jobs[(to + jobs.length) % jobs.length].key);
  });
  useEffect(() => {
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  const live = tree.status === "queued" || tree.status === "running";
  const pools = [...new Set(tree.stages.flatMap((s) => s.jobs.map((j) => j.instance)).filter(Boolean))];
  return <div className="rp">
    <header className="rp-h">
      <div className="rp-r1">
        <Link className="iconbtn" to={runsHref(repo)} aria-label="All runs"><Ic name="chevL" /></Link>
        {icon(tree.status)}
        <h1><span className="mono">{tree.flow}</span> <span className="meta">#{tree.number}</span></h1>
        <span className="pill rp-st"><span className={`dot ${ST[tree.status][3]}`} />{ST[tree.status][2]}</span>
        {tree.change && <span className="rp-t"><Ic name="merge" /><Link className="mono" to={`/${encodeURIComponent(repo)}/changes/${encodeURIComponent(tree.change.id)}`}><ChangeId id={tree.change.id} /></Link>
          {tree.change.title && <span className="meta">{tree.change.title}</span>}</span>}
        <span className="rp-acts">
          {live ? <button type="button" className="btn btn-secondary" onClick={cancel}><Ic name="x" />Cancel run</button> : <>
            {tree.status === "failed" && <button type="button" className="btn btn-secondary" onClick={() => rerun("failed")}><Ic name="refresh" />Re-run failed jobs</button>}
            <button type="button" className="btn btn-secondary" onClick={() => rerun("all")}><Ic name="refresh" />Re-run all</button></>}
          <button type="button" className="iconbtn" aria-label={graph ? "Hide graph" : "Show graph"} aria-pressed={graph} onClick={() => setGraph(!graph)}><Ic name="graph" /></button>
        </span>
      </div>
      <div className="rp-meta">
        {tree.ref && <span><Ic name="branch" /><Mid text={tree.ref} /></span>}
        <span className="mono" title={tree.sha}>{tree.sha.slice(0, 7)}</span>
        {tree.actor && <span><Ic name="user" />{tree.actor}</span>}
        <span><Ic name="clock" />{tree.started_at ? `Started ${new Date(tree.started_at).toLocaleString()}` : "Not started"}</span>
        <span><Ic name="pulse" />{dur(tree.wall_ms)}</span>
        {pools.length > 0 && <span><Ic name="cpu" />{pools.join(", ")}</span>}
        <span><Ic name="book" />{repo}</span>
      </div>
      {err && <p className="strip" role="alert"><Ic name="tri" />{err}</p>}
    </header>
    {graph && <Graph stages={tree.stages} job={job} pick={pick} />}
    <div className="rp-b">
      <Tree stages={tree.stages} job={job} pick={pick} />
      {picked ? <section className="rp-log rp-lg" aria-label="Log">
        <FlowLog key={`${job}#${picked.attempt}`} repo={repo} run={tree.id} job={picked} stage={tree.stages.find((s) => s.jobs.includes(picked)).name} notes={notes} sink={logSink} onRerun={() => rerunJob(job)} />
      </section> : <section className="rp-log" aria-label="Summary"><Summary tree={tree} notes={notes} tests={tests} artifacts={artifacts} pick={pick} /></section>}
    </div>
  </div>;
}

// Summary, then each stage (collapsible) with its jobs; the selected job lists its steps.
function Tree({ stages, job, pick }) {
  const [shut, setShut] = useState([]);
  return <nav className="rp-tree" aria-label="Stages and jobs">
    <button type="button" className={`tr-x${job ? "" : " on"}`} aria-pressed={!job} onClick={() => pick(null)}><Ic name="chart" /><span>Summary</span></button>
    {stages.map((s) => {
      const open = !shut.includes(s.id);
      return <div key={s.id}>
        <button type="button" className="tr-sg" aria-expanded={open} onClick={() => setShut(open ? [...shut, s.id] : shut.filter((x) => x !== s.id))}>
          <Ic name={open ? "chevD" : "chevR"} />{icon(s.status)}<span>{s.name}</span><small>{s.jobs.length}</small></button>
        {open && s.jobs.map((j) => <Fragment key={j.key}>
          <button type="button" className={`tr-j${job === j.key ? " on" : ""}`} aria-pressed={job === j.key} onClick={() => pick(j.key)}>
            {icon(j.status)}<span>{jobName(j)}</span><small className="mono">{took(j)}</small></button>
          {job === j.key && <ol className="tr-steps">{j.steps.map((p) => <li key={p.idx}>{icon(p.status)}<span>{p.name}</span><small className="mono">{took(p)}</small></li>)}</ol>}
        </Fragment>)}
      </div>;
    })}
  </nav>;
}

function Summary({ tree, notes, tests, artifacts, pick }) {
  const jobs = tree.stages.flatMap((s) => s.jobs.map((j) => ({ ...j, stage: s.name })));
  const label = (key) => { const j = jobs.find((x) => x.key === key); return j ? `${j.stage} / ${jobName(j)}` : key; };
  const n = (level) => notes.filter((a) => a.level === level).length;
  const none = (cols, text) => <tr><td colSpan={cols} className="meta">{text}</td></tr>;
  return <div className="rs">
    <div className="tiles">
      <Tile label="Status" value={<span className="rs-st">{icon(tree.status)}{ST[tree.status][2]}</span>} />
      <Tile label="Wall time" value={dur(tree.wall_ms)} />
      <Tile label="Sandbox time" value={dur(tree.sandbox_ms)} sub={`${jobs.filter(took).length} jobs`} />
      <Tile label="Judge tokens" value={tree.judge_tokens ?? "—"} />
    </div>
    <section className="card"><div className="card-h"><h3>Annotations</h3><span className="meta">{n("error")} errors · {n("warning")} warnings</span></div>
      {notes.length ? notes.map((a, i) => <button type="button" key={i} className={`an an-${a.level}`} onClick={() => pick(a.job_key)}>
        <Ic name={{ error: "xc", warning: "tri", notice: "info" }[a.level]} /><span><b>{label(a.job_key)}</b> · {a.step}<small>{a.message}</small></span></button>)
        : <p className="meta rs-none">No annotations.</p>}
    </section>
    <section className="card"><div className="card-h"><h3>Jobs</h3></div><table className="tbl">
      <thead><tr><th>Job</th><th>Stage</th><th>Status</th><th>Pool</th><th className="num">Duration</th></tr></thead>
      <tbody>{jobs.map((j) => <tr key={j.key} tabIndex={0} onClick={() => pick(j.key)} onKeyDown={(e) => e.key === "Enter" && pick(j.key)}>
        <td><span className="rs-st">{icon(j.status)}{jobName(j)}</span></td><td className="meta">{j.stage}</td><td>{ST[j.status][2]}</td>
        <td className="mono meta">{j.instance ?? "—"}</td><td className="num mono">{took(j) || "—"}</td></tr>)}</tbody>
    </table></section>
    <section className="card"><div className="card-h"><h3>Steps</h3></div><table className="tbl">
      <thead><tr><th>Step</th><th>Job</th><th className="num">Duration</th></tr></thead>
      <tbody>{jobs.flatMap((j) => j.steps.map((p) => <tr key={`${j.key} ${p.idx}`}>
        <td><span className="rs-st">{icon(p.status)}{p.name}</span></td><td className="meta">{label(j.key)}</td><td className="num mono">{took(p) || "—"}</td></tr>))}</tbody>
    </table></section>
    <section className="card"><div className="card-h"><h3>Tests</h3></div><table className="tbl">
      <thead><tr><th>Suite</th><th>Job</th><th className="num">Passed</th><th className="num">Failed</th><th className="num">Skipped</th></tr></thead>
      <tbody>{tests.length ? tests.map((t) => <tr key={`${t.suite} ${t.job_key}`}><td>{t.suite}</td><td className="meta">{label(t.job_key)}</td>
        <td className="num mono">{t.passed}</td><td className="num mono">{t.failed}</td><td className="num mono">{t.skipped}</td></tr>) : none(5, "No test results.")}</tbody>
    </table></section>
    <section className="card"><div className="card-h"><h3>Artifacts</h3><span className="meta">kept 30 days</span></div><table className="tbl">
      <tbody>{artifacts.length ? artifacts.map((a) => <tr key={`${a.job_key} ${a.name}`}><td className="mono">{a.name}</td><td className="meta">{label(a.job_key)}</td>
        <td className="num mono">{(a.size / 1024).toFixed(1)} KB</td><td className="num"><a href={a.url} download>Download</a></td></tr>) : none(4, "No artifacts.")}</tbody>
    </table></section>
  </div>;
}

// Columns of stage → job chips; the bus between columns is measured after layout and redrawn on resize.
function Graph({ stages, job, pick }) {
  const box = useRef(null), chips = useRef(new Map());
  const [bus, setBus] = useState({ d: "" });
  useEffect(() => {
    const g = box.current;
    const draw = () => {
      const b = g.getBoundingClientRect();
      const at = (key) => { const r = chips.current.get(key).getBoundingClientRect(); return { l: r.left - b.left + g.scrollLeft, r: r.right - b.left + g.scrollLeft, y: r.top + r.height / 2 - b.top + g.scrollTop }; };
      let d = "";
      for (let i = 0; i + 1 < stages.length; i++) {
        const a = stages[i].jobs.map((j) => at(j.key)), c = stages[i + 1].jobs.map((j) => at(j.key));
        const mx = (Math.max(...a.map((p) => p.r)) + Math.min(...c.map((p) => p.l))) / 2, ys = [...a, ...c].map((p) => p.y), my = (Math.min(...ys) + Math.max(...ys)) / 2;
        for (const p of a) d += `M${p.r},${p.y} C${mx - 8},${p.y} ${mx - 8},${my} ${mx},${my} `;
        for (const p of c) d += `M${mx},${my} C${mx + 8},${my} ${mx + 8},${p.y} ${p.l},${p.y} `;
      }
      setBus({ d: d.trim(), w: g.scrollWidth, h: g.scrollHeight });
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(g);
    return () => ro.disconnect();
  }, [stages]);
  return <div className="rg" ref={box} role="group" aria-label="Stage graph">
    <svg className="rg-svg" width={bus.w} height={bus.h} aria-hidden="true"><path d={bus.d} /></svg>
    {stages.map((s) => <div key={s.id} className="rg-c">
      <div className="rg-h">{icon(s.status)}<b>{s.name}</b><span className="meta">{s.jobs.filter((j) => j.status === "passed").length}/{s.jobs.length}</span></div>
      {s.jobs.map((j) => <button type="button" key={j.key} ref={(el) => (el ? chips.current.set(j.key, el) : chips.current.delete(j.key))}
        className={`rg-j st-${j.status}${job === j.key ? " on" : ""}`} aria-pressed={job === j.key} onClick={() => pick(j.key)}>
        {icon(j.status)}<span>{jobName(j)}</span>
        <small className="mono">{took(j)}</small>
      </button>)}
    </div>)}
  </div>;
}
