// Insights: the Overview and Usage lenses.
import { Suspense, useRef, useState } from "react";
import { Await, Link, useAsyncError, useLoaderData, useRevalidator, useRouteLoaderData, useSearchParams } from "react-router";
import { BarChart } from "./charts.jsx";
import { setTokenLimits } from "./api/agents.js";
import { getInsights, invalidate } from "./client.js";
import { Ic } from "./icons.jsx";
import { Bone, BoneText, ChartSkel, LoadingRegion, TileSkel, useShape } from "./skeleton.jsx";
import { EmptyState, Popover, State, Table, Tabs, Tag, Tile, tok, Untrusted, Frame } from "./ui.jsx";
import "./styles/insights.css";

const RANGES = { "Last 30 minutes": 0.5, "Last 6 hours": 6, "Last 24 hours": 24, "Last 7 days": 168, "Last 30 days": 720 };
const usd = (v) => `$${v.toFixed(2)}`;
const sum = (s, k) => s.reduce((n, b) => n + b[k], 0);
// Where a metric leads: the list or control that acts on it.
const Go = ({ to, children }) => <Link className="go" to={to}>{children} <Ic name="ar" /></Link>;

// rows: [[label, value, shown, outside]], largest first; outside rows are tagged like the Usage table's.
const HBars = ({ rows }) => rows.map(([k, v, shown, outside]) => <div className="hb" key={`${k} ${outside}`}><span className="mono">{k}{outside && <> <Tag>outside cinder</Tag></>}</span><span><i style={{ width: `${(v / (rows[0][1] || 1)) * 100}%` }} /></span><span className="mono">{shown}</span></div>);

// Bins of predicted p against the observed rate, over the dashed diagonal of perfect calibration.
export function Reliability({ bins }) {
  const S = 260, P = 28, x = (v) => P + v * (S - P * 1.4), y = (v) => S - P - v * (S - P * 1.6);
  const most = Math.max(...bins.map((b) => b.count));
  return (
    <svg className="reldiag" viewBox={`0 0 ${S} ${S}`} role="img" aria-label="Reliability diagram">
      <g stroke="var(--chart-grid)">{[0, 0.25, 0.5, 0.75, 1].map((t) => <line key={t} x1={x(0)} x2={x(1)} y1={y(t)} y2={y(t)} />)}</g>
      <line x1={x(0)} y1={y(0)} x2={x(1)} y2={y(1)} stroke="var(--text-inactive)" strokeDasharray="4 4" />
      <polyline fill="none" stroke="var(--chart)" strokeWidth="1.5" points={bins.map((b) => `${x(b.mean_p)},${y(b.observed)}`).join(" ")} />
      {bins.map((b) => <circle key={b.mean_p} cx={x(b.mean_p)} cy={y(b.observed)} r={3 + (2 * b.count) / most} fill="var(--chart)" />)}
      <g fill="var(--text-subtle)" fontSize="10">{[0, 0.5, 1].map((t) => <g key={t}><text x={x(t)} y={S - P + 16} textAnchor="middle">{t}</text><text x={P - 6} y={y(t) + 3} textAnchor="end">{t}</text></g>)}
        <text x={S / 2} y={S - 2} textAnchor="middle">predicted p(merge)</text></g>
    </svg>
  );
}

// A By agent version row's ⋯ menu; name is <agent>@v<n>. The dialog opens with the version's current token limits and saves them on it; empty means no limit.
function VersionMenu({ name, limits }) {
  const dlg = useRef(null);
  const [status, setStatus] = useState(null);
  const [agent, version] = name.split("@v");
  const page = `/automation/agents/${encodeURIComponent(agent)}`;
  const save = async (e) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const n = (k, unit) => (f.get(k) === "" ? null : Math.round(Number(f.get(k)) * unit));
    setStatus("Saving…");
    try {
      await setTokenLimits(agent, version, { max_tokens: n("run", 1e3), max_tokens_month: n("month", 1e6) });
      setStatus("Saved on the agent version");
    } catch (err) {
      setStatus(`Couldn't save the limit: ${err.message}`);
    }
  };
  const open = (e) => { e.currentTarget.parentElement.hidePopover(); setStatus(null); dlg.current.showModal(); };
  return <>
    <Popover title={`Actions for ${name}`} label={<Ic name="more" />}>
      <button type="button" className="btn btn-ghost" onClick={open}><Ic name="token" />Set a token limit</button>
      <Link className="btn btn-ghost" to={`${page}/settings`}><Ic name="robot" />Swap model</Link>
      <Link className="btn btn-ghost" to={page}><Ic name="ar" />Open agent</Link>
    </Popover>
    <dialog className="dlg" ref={dlg} aria-label={`Token limit for ${name}`}>
      <form onSubmit={save}>
        <div className="card-h"><span>Token limit · <span className="mono">{name}</span></span></div>
        <div className="card-b grid2">
          <label>Per run (k tokens)<input className="input" name="run" type="number" min="0.001" step="any" defaultValue={limits?.max_tokens == null ? "" : limits.max_tokens / 1e3} /></label>
          <label>Per month (M tokens)<input className="input" name="month" type="number" min="0.000001" step="any" defaultValue={limits?.max_tokens_month == null ? "" : limits.max_tokens_month / 1e6} /></label>
        </div>
        <div className="card-h"><span role="status">{status}</span>
          <span className="end"><button type="button" className="btn btn-secondary" onClick={() => dlg.current.close()}>Close</button><button className="btn btn-primary">Save limit</button></span></div>
      </form>
    </dialog>
  </>;
}

const UsageTable = ({ title, head, rows, merged = false }) => (
  <div className="card"><div className="card-h"><h3>{title}</h3></div>
    {rows.length ? <Table>
      <thead><tr><th>{head}</th><th className="num">Tokens</th><th className="num">Cost</th>{merged && <><th className="num">Merged</th><th><span className="sr-only">Actions</span></th></>}</tr></thead>
      <tbody>{rows.map((r) => <tr key={`${r.name} ${r.outside}`}><td className="mono">{r.name}{r.outside && <> <Tag>outside cinder</Tag></>}</td>
        <td className="num mono">{tok(r.tokens)}</td><td className="num mono">{usd(r.cost_usd)}</td>
        {merged && <><td className="num mono">{r.merged || "—"}</td><td>{!r.outside && r.name.includes("@v") && <VersionMenu name={r.name} limits={r.limits} />}</td></>}</tr>)}</tbody>
    </Table> : <div className="card-b"><EmptyState icon="chart" title="No usage in this range" /></div>}
  </div>
);

function Ready({ d, lens, range, repo, branch }) {
  const dlg = useRef(null);
  const { series: s, usage: u, calibration: c, lease_conflicts: lc, change_fail_rate: cfr } = d;
  const [merged, passed, failed] = [sum(s, "merged"), sum(s, "passed"), sum(s, "failed")];
  const active = Boolean(merged || passed || failed || u.tokens || c.count || lc.leases);
  useShape(`insights/${repo.name}/activity`, 1, Number(active));
  useShape(`insights/${repo.name}/agents`, 5, u.by_agent.length);
  if (!active) return noActivity;
  const labels = s.map((b) => b.at.slice(5, 16).replace("T", " "));
  const trusted = c.count >= 20;
  const base = `/${encodeURIComponent(repo.name)}`, on = `target=${encodeURIComponent(branch)}`;
  const mergedChart = (height) => <BarChart values={s.map((b) => b.merged)} labels={labels} height={height} title="Time (UTC)" />;
  return (
    <>
      <div className="lens" hidden={lens !== "over"}>
        <div className="tiles">
          <Tile label="Changes merged" value={String(merged)} spark={s.map((b) => b.merged)} />
          <Tile label="Verifier runs" value={(passed + failed).toLocaleString("en")} spark={s.map((b) => b.passed + b.failed)}><Go to={`${base}/flows?range=${RANGES[range]}&${on}`}>Open runs</Go></Tile>
          <Tile label="Agent tokens" value={tok(u.tokens)} spark={s.map((b) => b.tokens)} />
          <Tile label="Brier score" value={trusted ? c.brier.toFixed(3) : "—"} sub={trusted ? `n=${c.count}` : undefined} untrusted={c.count}><Go to="/automation/judges">Open judge</Go></Tile>
          <Tile label="Lease conflicts" value={String(lc.conflicts)} sub={`of ${lc.leases} leases`}><Go to={`${base}/changes/collisions?${on}`}>Open collisions</Go></Tile>
        </div>
        <div className="card"><div className="card-h"><span>Changes merged</span><Ic name="info" />
          <span className="end"><button type="button" className="ib" aria-label="Expand" onClick={() => dlg.current.showModal()}><Ic name="expand" /></button></span></div>
        <div className="card-b card-sub"><div className="leg"><span><span className="dot info" />{repo.name} → <span className="mono">{branch}</span> {merged}</span></div>{mergedChart(260)}</div></div>
        <dialog className="dlg full" ref={dlg} aria-label="Changes merged">
          <div className="card-h"><span>Changes merged</span><form method="dialog" className="end"><button className="ib" aria-label="Close"><Ic name="xc" /></button></form></div>
          <div className="card-b">{mergedChart(560)}</div>
        </dialog>
        <div className="grid2">
          <div className="card"><div className="card-h"><span>Verifier runs</span><Ic name="info" /></div>
            <div className="card-b card-sub"><div className="leg"><span><span className="dot info" />Passed {passed.toLocaleString("en")}</span><span><span className="dot bad" />Failed {failed.toLocaleString("en")}</span></div>
              <BarChart values={s.map((b) => b.passed)} fails={s.map((b) => b.failed)} labels={labels} height={180} /></div></div>
          <div className="card"><div className="card-h"><span>Calibration</span><Ic name="info" />
            <span className="end"><Go to="/automation/judges">Open judge</Go>{trusted ? <span className="pill">Brier {c.brier.toFixed(3)} · n={c.count}</span> : <Untrusted n={c.count} />}</span></div>
          <div className="card-b card-sub">{trusted ? <Reliability bins={c.bins} />
            : <EmptyState icon="chart" title="Not enough outcomes">Calibration shows once the verifier has 20 merged-or-rejected outcomes on this repo.</EmptyState>}</div></div>
        </div>
        <div className="card"><div className="card-h"><span>Tokens by agent</span><span className="end">{range.toLowerCase()}</span></div>
          <div className="card-b"><HBars rows={u.by_agent.map((a) => [a.name, a.tokens, tok(a.tokens), a.outside])} /></div></div>
      </div>
      <div className="lens" hidden={lens !== "usage"}>
        <div className="tiles">
          <Tile label="Tokens" value={tok(u.tokens)} spark={s.map((b) => b.tokens)} />
          <Tile label="Cost" value={usd(u.cost_usd)} spark={s.map((b) => b.cost_usd)} />
          <Tile label="Cost per merged change" value={merged ? usd(u.cost_usd / merged) : "—"} />
          <Tile label="Change failure rate" value={cfr.count >= 20 ? `${(cfr.value * 100).toFixed(1)}%` : "—"} sub={cfr.count >= 20 ? `n=${cfr.count}` : undefined} untrusted={cfr.count}><Go to={`${base}/changes?state=failed&${on}`}>View failing changes</Go></Tile>
        </div>
        <div className="toolbar">
          <span className="subtle">From AI Gateway. Includes agents run outside cinder that point at the gateway.</span>
          <div className="toolbar-end">
            <a className="btn btn-secondary" href="https://dash.cloudflare.com/?to=/:account/workers/observability" target="_blank" rel="noreferrer"><Ic name="pulse" />Observability › Agents</a>
            <a className="btn btn-secondary" href="https://dash.cloudflare.com/?to=/:account/ai/ai-gateway" target="_blank" rel="noreferrer"><Ic name="term" />AI Gateway › Logs</a>
          </div>
        </div>
        <div className="grid2">
          <UsageTable title="By agent version" head="Agent" rows={u.by_agent} merged />
          <UsageTable title="By person" head="Person" rows={u.by_person} />
        </div>
        <div className="card"><div className="card-h"><h3>By change</h3><span className="end">top 5 by cost</span></div>
          <div className="card-b"><HBars rows={u.by_change.map((r) => [r.change_id, r.cost_usd, usd(r.cost_usd)])} /></div></div>
      </div>
    </>
  );
}

function Failed() {
  const err = useAsyncError();
  const { revalidate } = useRevalidator();
  return (
    <State kind="error" title="Couldn't load insights" request={`GET ${err?.message ?? String(err)}`} onRetry={revalidate}>
      <p>The API didn't answer. Agents keep working and nothing is lost; this page just can't read its numbers right now.</p>
    </State>
  );
}

const noActivity = <div className="card"><EmptyState icon="chart" title="No activity in this range">Pick a longer range or another branch.</EmptyState></div>;

// The Overview lens with bones for data.
function Loading({ repo }) {
  const active = useShape(`insights/${repo}/activity`, 1).n, agents = useShape(`insights/${repo}/agents`, 5).n;
  if (!active) return noActivity;
  return <LoadingRegion page="insights" busy>
    <div className="lens">
      <div className="tiles">{["Changes merged", "Verifier runs", "Agent tokens", "Brier score", "Lease conflicts"].map((l) => <TileSkel key={l} label={l} />)}</div>
      <div className="card"><div className="card-h"><span>Changes merged</span></div><div className="card-b card-sub"><ChartSkel height={220} /></div></div>
      <div className="grid2">
        <div className="card"><div className="card-h"><span>Verifier runs</span></div><div className="card-b card-sub"><ChartSkel /></div></div>
        <div className="card"><div className="card-h"><span>Calibration</span></div><div className="card-b card-sub skel-cal"><Reliability bins={[]} /></div></div>
      </div>
      <div className="card"><div className="card-h"><span>Tokens by agent</span></div>
        <div className="card-b">{Array.from({ length: agents }, (_, i) => <div className="hb" key={i}><BoneText i={i} /><Bone w={`${92 - (i % 5) * 16}%`} h={8} row={i} /><BoneText i={i + 1} /></div>)}</div></div>
    </div>
  </LoadingRegion>;
}

export function Insights() {
  const { data } = useLoaderData();
  const repo = useRouteLoaderData("repo");
  const [search, setSearch] = useSearchParams();
  const { revalidate } = useRevalidator();
  const lens = search.get("lens") === "usage" ? "usage" : "over";
  const range = RANGES[search.get("range")] ? search.get("range") : "Last 24 hours";
  const branch = search.get("target") ?? repo.default_branch;
  // Lens, range and branch live in the URL, so a reload keeps them and the range and branch re-query.
  const set = (k, v) => setSearch((p) => { p.set(k, v); return p; });
  const pick = (k, v) => (e) => { e.currentTarget.parentElement.hidePopover(); set(k, v); };
  return (
    <Frame>
      <div className="toolbar">
        <Tabs label="Lens" options={[["over", "Overview"], ["usage", "Usage"]]} value={lens} onChange={(v) => set("lens", v)} />
        <div className="toolbar-end">
          <Popover label={<><Ic name="branch" /><span className="mono">{branch}</span></>}>
            {[...new Set([repo.default_branch, ...repo.branch_policy.integration])].map((b) => <button type="button" className="btn btn-ghost" key={b} onClick={pick("target", b)}>{b}</button>)}
          </Popover>
          <button type="button" className="ib bd" aria-label="Refresh" onClick={() => { invalidate(); revalidate(); }}><Ic name="refresh" /></button>
          <Popover label={<><Ic name="cal" />{range}</>}>
            {Object.keys(RANGES).map((r) => <button type="button" className="btn btn-ghost" key={r} onClick={pick("range", r)}>{r}</button>)}
          </Popover>
        </div>
      </div>
      <Suspense fallback={<Loading repo={repo.name} />}>
        <Await resolve={data} errorElement={<Failed />}>{(d) => <Ready d={d} lens={lens} range={range} repo={repo} branch={branch} />}</Await>
      </Suspense>
    </Frame>
  );
}

// Not awaited, so the page head shows at once and the body moves through loading, then ready, empty or error.
export const insightsLoader = ({ params, request }) => {
  const q = new URL(request.url).searchParams;
  const data = getInsights(params.repo, RANGES[q.get("range")] ?? 24, q.get("target"));
  // It can reject before <Await> subscribes, which reports an unhandled rejection; <Await> still renders the error.
  data.catch(() => {});
  return { data };
};
