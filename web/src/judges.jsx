// Automation › Judges & calibration.
import { Suspense, useRef, useState } from "react";
import { Await, Link, Navigate, useAsyncError, useLoaderData, useParams, useRevalidator, useSearchParams } from "react-router";
import { JUDGMENT_KINDS } from "../../worker/src/api/contract.js";
import { setJudgeAirlock } from "./api/judges.js";
import { getJudges } from "./client.js";
import { f3, Hist, pct, Rel, Spark, Trend } from "./charts.jsx";
import { Ic } from "./icons.jsx";
import { Bone, ListCardSkel, LoadingRegion, useShape } from "./skeleton.jsx";
import { Dot, EmptyState, ErrorState, Table, Tabs, Toggle, Frame } from "./ui.jsx";
import "./styles/judges.css";

const TONE = { healthy: "ok", degraded: "warn", failing: "bad" };

// The API's trusted decides; past 20 outcomes the shared Untrusted line hides itself, so this one never does. An untrusted
// judge is still answering and being scored in shadow: it learns toward the outcomes it needs to be trusted. Trust counts every
// outcome, whatever the window: total is all time (absent in fixtures, where count is).
const total = (j) => j.total ?? j.count;
const untrusted = (j) => <span className="untrusted">{`learning: ${total(j)}${j.min_outcomes ? ` of ${j.min_outcomes}` : ""} outcome${(j.min_outcomes ?? total(j)) === 1 ? "" : "s"}, all time`}</span>;

// The pinned models a judge can run (worker/src/s1/client.js), with the credential each call uses.
// lazy: systemone-http needs a base URL and stat fits on outcomes, so neither is offered; add them when a judge needs one.
const MODELS = [
  ["clef", "clef@2", "Workers AI · Clef", "coins", "Cloudflare credits"],
  ["clef-flash", "clef-flash@2", "Workers AI · Clef Flash", "coins", "Cloudflare credits"],
  ["clef", "clef@1", "Workers AI · Llama 3.3 70B", "coins", "Cloudflare credits"],
  ["clef-flash", "clef-flash@1", "Workers AI · Llama 3.1 8B", "coins", "Cloudflare credits"],
  ["jev", "jev@1", "TypeSafe, hosted", "key", "Keystore: TYPESAFE_API_KEY"],
];
const VECTORIZE = "https://dash.cloudflare.com/?to=/:account/ai/vectorize";

// Judges live in .cinder.yml's judges map, so adding or swapping one opens a change for an agent to make that edit;
// it takes effect when the change merges. Fields left null are left out. The intent rides in the link's state.
const ymlChange = (repo, kind, fields) => ({ to: `/${encodeURIComponent(repo)}/changes/new`, state: { intent: `Set judges.${kind} in .cinder.yml to { ${
  Object.entries(fields).filter(([, v]) => v != null).map(([k, v]) => `${k}: ${v}`).join(", ")} }` } });

const noJudges = <div className="card"><EmptyState icon="shieldck" title="No judges yet">Judges are added when a repo is imported. Each one predicts an outcome and is scored once the outcome is known.</EmptyState></div>;

function Skel() {
  const { n } = useShape("judges//list", 3);
  return n ? <LoadingRegion page="Judges" busy><div className="g2">{["Reliability", "Brier over 12 weeks"].map((t) => <div key={t} className="card"><div className="card-h"><h3>{t}</h3></div>
    <div className="card-b"><Bone w="100%" h={240} /></div></div>)}</div>{Array.from({ length: n }, (_, i) => <ListCardSkel key={i} />)}</LoadingRegion> : noJudges;
}

// One model (or person or agent reviewer) answering one kind, across every repo it runs on: one leaderboard row.
const series = (j) => `${j.kind}:${j.backend}@${j.model_version}`;
const WORST = ["failing", "degraded", "healthy"];
const SER = ["var(--chart)", "var(--success-fill)", "var(--chart-2)"];
const col = (j, i) => (j.trusted ? SER[i % 3] : "var(--neutral-fill)");
const sum = (xs, k = "count") => xs.reduce((n, x) => n + (x[k] ?? 0), 0);
// Count-weighted mean of x[k] over the xs that have it; null when none do.
const wavg = (xs, k) => { const ys = xs.filter((x) => x[k] != null && x.count); return ys.length ? ys.reduce((n, x) => n + x[k] * x.count, 0) / sum(ys) : null; };
const name = (j) => (/^(human|agent):/.test(j.backend) ? j.backend : `${j.backend}@${j.model_version}`);
// [lo, hi] for a Brier axis around every non-null point.
const range = (pts) => { const v = pts.filter((x) => x != null); return [Math.max(0, Math.floor((Math.min(...v) - 0.01) * 100) / 100), Math.ceil((Math.max(...v) + 0.01) * 100) / 100]; };
// The week index the current series started in, when it replaced an earlier model inside the window; -1 otherwise.
const swapAt = (j, trend) => (j.since && j.history?.length ? trend.findLastIndex((t) => t.week <= j.since.slice(0, 10)) : -1);

// The bin furthest from the diagonal.
export const worstBin = (bins) => bins.reduce((w, b) => (Math.abs(b.observed - b.mean_p) > Math.abs(w.observed - w.mean_p) ? b : w), bins[0]);

// One backend@model_version across repos: counts summed; bins (by lo), Brier and each week's Brier count-weighted.
// A week is null only when every repo's is.
export function pool(series) {
  if (series.length === 1) return series[0];
  const bins = Object.values(Object.groupBy(series.flatMap((j) => j.bins), (b) => b.lo))
    .map((bs) => ({ lo: bs[0].lo, hi: bs[0].hi, count: sum(bs), mean_p: wavg(bs, "mean_p"), observed: wavg(bs, "observed") })).toSorted((a, b) => a.lo - b.lo);
  const trend = Object.entries(Object.groupBy(series.flatMap((j) => j.trend ?? []), (t) => t.week)).toSorted(([a], [b]) => (a < b ? -1 : 1))
    .map(([week, ts]) => ({ week, count: sum(ts), brier: wavg(ts, "brier") }));
  const worst = series.toSorted((a, b) => WORST.indexOf(a.health) - WORST.indexOf(b.health))[0];
  return { ...worst, count: sum(series), total: series.reduce((n, j) => n + total(j), 0), trusted: series.every((j) => j.trusted), brier: wavg(series, "brier"), bins, trend,
    recent: series.flatMap((j) => j.recent ?? []).toSorted((a, b) => (b.made_at ?? "").localeCompare(a.made_at ?? "")).slice(0, 10), fallbacks: sum(series, "fallbacks"), min_outcomes: series.every((j) => j.min_outcomes) ? sum(series, "min_outcomes") : null };
}

// One question per tab: every judge answering the selected kind on one reliability chart, one Brier trend and a leaderboard.
function Ready({ data: { judges } }) {
  const [params, setParams] = useSearchParams();
  const byKind = Object.groupBy(judges, (j) => j.kind), kinds = JUDGMENT_KINDS.filter((k) => byKind[k]);
  const q = params.get("kind");
  const kind = kinds.includes(q) ? q : kinds.find((k) => byKind[k].some((j) => !j.trusted || j.health !== "healthy")) ?? (byKind.risk ? "risk" : kinds[0]);
  // A row's link names exactly it: the one repo's series id, or the kind and model pooled across repos.
  const rows = Object.values(Object.groupBy(byKind[kind] ?? [], series)).map((s) => ({ ...pool(s), href: s.length === 1 ? s[0].id : series(s[0]) }))
    .toSorted((a, b) => b.trusted - a.trusted || (a.brier ?? 1) - (b.brier ?? 1));
  useShape("judges//list", 3, rows.length);
  if (!kinds.length) return noJudges;
  const pts = (j) => (j.trend ?? []).map((t) => t.brier), all = rows.flatMap(pts), [lo, hi] = range(all);
  const labels = (rows.find((j) => j.trend?.length)?.trend ?? []).map((t) => t.week.slice(5));
  const marks = rows.flatMap((j) => { const i = swapAt(j, j.trend ?? []); return i < 0 ? [] : [{ i, label: `Swapped to ${j.model_version}` }]; });
  return <>
    <Tabs label="Question" options={kinds.map((k) => [k, <><span className="mono">{k}</span> <span className="ct">{byKind[k].length}</span></>])} value={kind} onChange={(k) => setParams({ kind: k, ...(params.has("window") && { window: params.get("window") }) })} />
    {byKind[kind][0].question && <p className="q">{byKind[kind][0].question}</p>}
    <div className="g2">
      <div className="card"><div className="card-h"><h3>Reliability</h3><span className="end lgs">{rows.map((j, i) =>
        <span key={i} className={j.trusted ? "lg" : "lg dash"}><i style={{ background: col(j, i) }} /><span className="mono">{name(j)}</span></span>)}</span></div>
        <div className="card-b"><Rel series={rows.map((j, i) => ({ bins: j.bins, color: col(j, i), dash: !j.trusted, dim: !j.trusted }))} axes band size={300} label={`Reliability, ${kind} judges overlaid`} />
          <p className="subtle">Shaded band: within 10 points of the diagonal. Dot size = outcomes in that bin.{rows.some((j) => !j.trusted) && " Dashed = untrusted, shown for shape only."}</p></div></div>
      <div className="card"><div className="card-h"><h3>Brier over {labels.length || 12} weeks</h3><span className="end subtle">lower is better</span></div>
        <div className="card-b">{all.some((v) => v != null) ? <Trend series={rows.map((j, i) => ({ pts: pts(j), color: col(j, i), dash: !j.trusted, label: j.trusted ? name(j) : `${name(j)} (untrusted)` }))}
          labels={labels} lo={lo} hi={hi} marks={marks} endLabels every={3} /> : <p className="big">—</p>}</div></div>
    </div>
    <div className="card"><Table><thead><tr><th /><th>Judge</th><th className="hide-m">Model</th><th>Brier</th><th className="num hide-m">Outcomes</th><th className="hide-m">{labels.length || 12} weeks</th>
      <th className="hide-m">Largest miss</th><th>Health</th><th /></tr></thead>
      <tbody>{rows.map((j, i) => {
        const w = j.trusted && worstBin(j.bins), spark = pts(j);
        return <tr key={i} className={j.trusted ? undefined : "un"}><td><span className="sw" style={{ background: col(j, i) }} /></td>
          <td><Link className="mono" to={`/automation/judges/${encodeURIComponent(j.href)}${keep(params)}`}>{name(j)}</Link>{j.type && <div className="subtle">{j.type}</div>}</td>
          <td className="mono hide-m">{j.model_version}</td>
          <td>{j.trusted && j.brier != null ? <div className="bv"><span className="mono">{f3(j.brier)}</span><i style={{ width: `${Math.min(1, j.brier / 0.15) * 100}%` }} /></div> : untrusted(j)}</td>
          <td className="num mono hide-m">{j.count}</td>
          <td className="hide-m">{spark.some((v) => v != null) ? <Spark pts={spark} color={col(j, i)} /> : "—"}</td>
          <td className="hide-m">{w ? `said ${pct(w.mean_p)}, happened ${pct(w.observed)}` : "—"}</td>
          <td><Dot tone={TONE[j.health]} /> Model {j.health}{j.reason && <div className="subtle">{j.reason}</div>}{j.fallbacks > 0 && <span className="pill fb">{j.fallbacks} default verdicts</span>}</td>
          <td><Ic name="chevR" /></td></tr>;
      })}</tbody></Table>
      {rows.length === 1 && <p className="card-note subtle">The only judge answering this question, so nothing to rank it against.</p>}</div>
  </>;
}

// One leaderboard row's judge: a repo series id (repo:kind:backend@model) opens that repo's judge; kind:backend@model opens the
// model pooled across its repos, with no per-repo Swap, Airlock or Settings. id arrives decoded, ":" and "@" included.
function Detail({ judges, id }) {
  const one = judges.find((j) => j.id === id), js = judges.filter((j) => series(j) === id);
  if (!one && !js.length) return <div className="card"><EmptyState icon="shieldck" title="Judge not found"><Link to="/automation/judges">All judges</Link></EmptyState></div>;
  return <One key={id} j={one ?? (js.length === 1 ? js[0] : { ...pool(js), name: name(js[0]), config: null })} />;
}

const day = (t) => new Date(t).toLocaleDateString("en", { month: "short", day: "numeric", timeZone: "UTC" });
const ran = (since, until) => (since ? `${day(since)} ${until ? `– ${day(until)}` : "→"}` : "—");
// The ?window= the list and detail load: weeks of outcomes sent as ?weeks=, 0 for all time. The detail opens on 90d, the list on All.
const WINDOW = [["30d", 5], ["90d", 13], ["All", 0]];
const windowOf = (params, id) => { const w = params.get("window"); return WINDOW.some(([k]) => k === w) ? w : id ? "90d" : "All"; };
// A link's search that keeps the chosen window.
const keep = (params) => (params.has("window") ? `?window=${params.get("window")}` : "");

// One repo's judge: its head (with Swap and Airlock), health, calibration beside Brier over time, its models, recent verdicts
// and settings. Airlock is one state for the head and Settings.
function One({ j }) {
  const recent = j.recent ?? [], h = j.history?.[0], c = j.config, w = j.trusted && worstBin(j.bins);
  const [air, setAir] = useState(c?.airlock), [err, setErr] = useState(""), [params, setParams] = useSearchParams(), win = windowOf(params, j.id);
  const { revalidate } = useRevalidator();
  const toggle = (on) => { setAir(on); setErr(""); setJudgeAirlock(j.repo, j.kind, on).then(revalidate, (e) => { setAir(!on); setErr(e.message); }); };
  // All shows the API's default 12 weeks of trend rather than asking for 52.
  const trend = j.trend ?? [], sw = swapAt(j, trend), pts = trend.map((t) => t.brier);
  const [lo, hi] = range(pts), when = recent.some((r) => r.made_at);
  return (
    <>
      <div className="card jd"><div className="card-h"><div><div className="subtle mono">{j.kind}</div><h2 className="mono">{j.name}</h2>{j.question && <p className="subtle">{j.question}</p>}
        <div className="meta-row">{j.type && <span>{j.type}</span>}<span className="lc-s mono">{j.model_version}</span>
          <span>{j.trusted ? <><Dot tone="ok" />trusted · n={total(j)} all time{j.inherited > 0 && ` (${j.inherited} inherited)`}</> : untrusted(j)}</span></div></div>
        <span className="end">{c && <><Swap j={j} id="swap-head" /><label className="tgl">Airlock <Toggle label="Airlock" checked={air} onChange={toggle} /></label></>}
          <Link to={`/automation/judges${keep(params)}`}>All judges</Link></span></div>
        {j.health !== "healthy" && <div className="block" role="alert"><Ic name="tri" /><span><b>Model {j.health}.</b> {j.reason}</span>
          <span className="end">{/vectorize|index/i.test(j.reason ?? "") ? <a className="btn btn-secondary btn-sm" href={VECTORIZE} target="_blank" rel="noreferrer">Bind index <Ic name="ur" /></a> : c && <Swap j={j} id="swap-fix" />}</span></div>}</div>
      <div className="g-da">
        <div className="card"><div className="card-h"><h3>Calibration</h3>{j.trusted && <span className="end pill">Brier {f3(j.brier)} · n={j.count}</span>}</div>
          {j.trusted ? <div className="card-b rel-wrap"><div>
            <Rel series={[...(h?.bins?.length ? [{ bins: h.bins, color: "var(--neutral-fill)", dash: true, dim: true }] : []), { bins: j.bins, color: SER[0] }]} axes band size={340} label="Reliability diagram" />
            <Hist bins={j.bins} size={340} />
            <div className="lgs"><span className="lg"><i style={{ background: SER[0] }} /><span className="mono">{j.model_version}</span> now</span>
              {h?.bins?.length > 0 && <span className="lg dash"><i /><span className="mono">{h.model_version}</span> before swap</span>}</div></div>
            <ul className="read"><li><span className="lbl">Brier</span><span className="big mono">{f3(j.brier)}</span>{h?.trusted && <span className="subtle">was {f3(h.brier)} on {h.model_version}</span>}</li>
              {w && <li><span className="lbl">Largest miss</span><span>{w.lo}–{w.hi}: said <b>{pct(w.mean_p)}</b>, happened <b>{pct(w.observed)}</b></span><span className="subtle">{w.count} outcomes</span></li>}
              <li><span className="lbl">Within 10 points</span><span>{j.bins.filter((b) => Math.abs(b.observed - b.mean_p) <= 0.1).length} of {j.bins.length} bins</span></li></ul></div>
            : <div className="card-b"><EmptyState icon="chart" title="Not enough outcomes" action={j.min_outcomes && <div className="prog"><div className="trk"><i style={{ width: `${Math.min(1, total(j) / j.min_outcomes) * 100}%` }} /></div>
              <span className="mono">{total(j)} of {j.min_outcomes}, all time</span></div>}>The reliability curve shows once this judge is trusted. It answers and is scored on every change meanwhile; its verdict doesn&apos;t count yet.</EmptyState></div>}</div>
        <div className="stack">
          <div className="card"><div className="card-h"><h3>Brier over time</h3>{!j.trusted && untrusted(j)}<span className="end"><Tabs label="Window" options={WINDOW.map(([k]) => [k, k])} value={win} onChange={(k) => setParams({ window: k })} /></span></div>
            <div className="card-b">{pts.some((v) => v != null) ? <Trend labels={trend.map((t) => t.week.slice(5))} lo={lo} hi={hi} every={3}
              series={sw < 0 ? [{ pts, color: col(j, 0), dash: !j.trusted }] : [{ pts: pts.map((v, i) => (i <= sw ? v : null)), color: "var(--neutral-fill)", dash: true }, { pts: pts.map((v, i) => (i >= sw ? v : null)), color: SER[0] }]}
              marks={sw < 0 ? [] : [{ i: sw, label: `Swapped to ${j.model_version}` }]} /> : <p className="big">—</p>}
              <p className="subtle">Weekly, over the outcomes resolved that week. Lower is better. Weeks with no outcomes leave a gap.</p></div></div>
          <div className="card"><div className="card-h"><h3>Models</h3></div>
            <Table><thead><tr><th>Model</th><th className="num">Outcomes</th><th className="num">Brier</th><th className="hide-m">Ran</th></tr></thead>
              <tbody>{[{ ...j, until: null }, ...(j.history ?? [])].map((m, i) => <tr key={m.backend + m.model_version}><td className="mono">{m.backend}@{m.model_version}{i === 0 && <> <span className="pill">now</span></>}</td>
                <td className="num mono">{m.count}</td><td className="num mono">{m.trusted ? f3(m.brier) : "learning"}</td><td className="hide-m">{ran(m.since, m.until)}</td></tr>)}</tbody></Table></div>
        </div>
      </div>
      <div className="card"><div className="card-h"><h3>Recent verdicts</h3></div>
        {recent.length ? <Table><thead><tr><th>Repo</th><th>Change</th><th className="num">p</th><th>Outcome</th>{when && <th className="num">When</th>}</tr></thead>
          <tbody>{recent.map((r, i) => <tr key={i}><td className="mono">{r.repo}</td><td className="mono">{r.change_id ?? "inherited"}{r.agent && ` · ${r.agent}`}</td>
            <td className="num mono">{r.p}</td><td>{r.correct == null ? "pending" : r.correct ? "correct" : "wrong"}</td>{when && <td className="num">{r.made_at ? day(r.made_at) : "—"}</td>}</tr>)}</tbody></Table>
          : <div className="card-b"><EmptyState icon="shieldck" title="No recent verdicts" /></div>}</div>
      {c && <Settings key={j.id} j={j} air={air} toggle={toggle} err={err} />}
    </>
  );
}

// Swap model: a menu of the other models, each opening the .cinder.yml change.
// id is unique on the page (one judge renders) and a valid CSS ident for the anchor.
function Swap({ j, id }) {
  const c = j.config;
  return <>
    <button type="button" className="btn btn-secondary btn-sm" popoverTarget={id} style={{ anchorName: `--${id}` }}>Swap model<Ic name="chevD" /></button>
    <div popover="auto" id={id} className="menu" style={{ positionAnchor: `--${id}` }}>
      {MODELS.filter(([b, m]) => !(b === j.backend && m === j.model_version)).map(([b, m]) => <Link key={m} className="mono"
        {...ymlChange(j.repo, j.kind, { backend: b, model_version: m, min_outcomes: c.min_outcomes, min_confidence: c.min_confidence })}>{m}</Link>)}
    </div>
  </>;
}

// The running judge of its kind: its model, trust threshold and airlock (One owns airlock's state). Airlock applies at once;
// the model and threshold are .cinder.yml edits.
function Settings({ j, air, toggle, err }) {
  const c = j.config, [n, setN] = useState(c.min_outcomes ?? "");
  const threshold = Number.isInteger(+n) && +n >= 1;
  return <details className="card jd"><summary className="card-h"><h3>Settings</h3><span className="end subtle">Model, trust threshold, airlock</span><Ic name="chevD" /></summary>
    <div className="srow"><span><b>Model</b><br /><span className="mono">{j.model_version}</span></span><span className="end"><Swap j={j} id="swap-model" /></span></div>
    <div className="srow"><label><b>Trust threshold</b><br /><span className="subtle">Outcomes before its verdict counts; empty uses the repo&apos;s.</span><br />
      <input className="input" type="number" min="1" aria-label="Trust threshold" value={n} onChange={(e) => setN(e.target.value)} /></label>
      <span className="end">{n === "" || threshold ? <Link className="btn btn-secondary btn-sm" {...ymlChange(j.repo, j.kind, { backend: j.backend, model_version: j.model_version,
        min_outcomes: n === "" ? null : +n, min_confidence: c.min_confidence })}>Save as a change</Link> : <button type="button" className="btn btn-secondary btn-sm" disabled>Save as a change</button>}</span></div>
    <div className="srow"><span><b>Airlock</b><br /><span className="subtle" role={err ? "alert" : undefined}>{err || "Scores every change, but its verdict doesn't count."}</span></span>
      <span className="end"><Toggle label="Airlock" checked={air} onChange={toggle} /></span></div>
  </details>;
}

// Add judge: the repo, the kind it answers, a model and a minimum confidence, opened as a .cinder.yml change.
function AddJudge({ repos }) {
  const dlg = useRef(null), [repo, setRepo] = useState(repos[0] ?? ""), [kind, setKind] = useState(JUDGMENT_KINDS[0]);
  const [model, setModel] = useState(MODELS[0]), [conf, setConf] = useState(0.7);
  return <>
    <button type="button" className="btn btn-primary" disabled={!repos.length} onClick={() => dlg.current.showModal()}><Ic name="plus" />Add judge</button>
    <dialog className="dlg wiz jd" ref={dlg} aria-label="Add judge">
      <div className="modal-h"><h2>Add judge</h2><button type="button" className="iconbtn" aria-label="Close" onClick={() => dlg.current.close()}><Ic name="x" /></button></div>
      <div className="pad stack">
        <div className="grid2"><label className="field"><span>Repo</span><select className="input" value={repo} onChange={(e) => setRepo(e.target.value)}>{repos.map((r) => <option key={r}>{r}</option>)}</select></label>
          <label className="field"><span>Question it answers</span><select className="input" value={kind} onChange={(e) => setKind(e.target.value)}>{JUDGMENT_KINDS.map((k) => <option key={k}>{k}</option>)}</select></label></div>
        <div className="field"><span>Judge id</span><output className="mono">{`${repo}:${kind}:${model[0]}@${model[1]}`}</output></div>
        <div className="card mlist" role="radiogroup" aria-label="Model">{MODELS.map((m) => <label key={m[1]} className="mrow">
          <input type="radio" name="judge-model" value={m[1]} checked={m === model} onChange={() => setModel(m)} />
          <span className="grow"><b className="mono">{m[1]}</b><small>{m[2]}</small></span><span className="pill"><Ic name={m[3]} />{m[4]}</span></label>)}</div>
        <label className="field"><span>Minimum confidence <output className="mono">{conf.toFixed(2)}</output></span>
          <input type="range" min="0.5" max="0.95" step="0.05" value={conf} onChange={(e) => setConf(+e.target.value)} />
          <small className="subtle">Below this probability the judge abstains instead of scoring.</small></label>
        <div className="block info"><Ic name="info" /><span>New judges start in <b>airlock</b>: they score every change, but their verdict doesn&apos;t count until you turn airlock off.</span></div>
        <div className="row"><span className="subtle">Saved to <code>.cinder.yml</code> as a change.</span>
          <Link className="btn btn-primary push" {...ymlChange(repo, kind, { backend: model[0], model_version: model[1], min_confidence: conf })}>Add judge</Link></div>
      </div>
    </dialog>
  </>;
}

const addOff = <button type="button" className="btn btn-primary" disabled><Ic name="plus" />Add judge</button>;

function Failed() {
  const err = useAsyncError();
  const { revalidate } = useRevalidator();
  return <div className="card"><ErrorState message={`Couldn't load judges: ${err?.message ?? String(err)}`} onRetry={revalidate} /></div>;
}

const intro = <div><h1>Judges &amp; calibration</h1><p>Who scores changes before the verifier merges, and how well their probabilities match outcomes.</p></div>;

// The route's hydrate fallback: the real head, Add judge disabled, then the skeleton.
export const JudgesLoading = () => <Frame head={<>{intro}<div className="acts">{addOff}</div></>}><div className="stack"><Skel /></div></Frame>;

export function Judges() {
  const { data } = useLoaderData();
  const { id } = useParams();
  // A kind alone (an older link) opens the list on that kind's tab.
  if (JUDGMENT_KINDS.includes(id)) return <Navigate replace to={`/automation/judges?kind=${id}`} />;
  return (
    <Frame head={<>
        {intro}
        <div className="acts"><Suspense fallback={addOff}><Await resolve={data} errorElement={addOff}>{(d) => <AddJudge repos={d.repos ?? []} />}</Await></Suspense></div>
      </>}>
      <div className="stack">
        <Suspense fallback={<Skel />}>
          <Await resolve={data} errorElement={<Failed />}>{(d) => (id ? <Detail judges={d.judges} id={id} /> : <Ready data={d} />)}</Await>
        </Suspense>
      </div>
    </Frame>
  );
}

// Not awaited, so the page head shows at once and the body moves through loading, then ready, empty or error.
export const judgesLoader = ({ request, params }) => ({ data: getJudges(WINDOW.find(([k]) => k === windowOf(new URL(request.url).searchParams, params.id))[1]) });
