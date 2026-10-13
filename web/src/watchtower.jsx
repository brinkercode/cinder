// Watchtower: Overview, Dependencies and Network tabs.
import { Suspense, useEffect, useRef, useState } from "react";
import { Await, Form, Link, redirect, useAsyncError, useFetcher, useLoaderData, useNavigation, useParams, useRevalidator, useSearchParams } from "react-router";
import { DEFAULT_EGRESS } from "../../worker/src/api/contract.js";
import { agentVersions, releaseEgress } from "./api/egress.js";
import { ago, openDialog } from "./changes.jsx";
import { PropBar } from "./charts.jsx";
import { dismissFinding, downloadSbom, fixFinding, getDependencies, getEgress, getWatchtower, invalidate, list, pauseScans, poolAct, reopenFinding, setAutoFix, startScan } from "./client.js";
import { Ic } from "./icons.jsx";
import { Bone, BonePill, BoneText, LoadingRegion, TableSkel, TileSkel, useShape } from "./skeleton.jsx";
import { Dialog, Dot, EmptyState, ErrorState, Tabs, Tag, Tile, Toggle, Frame } from "./ui.jsx";
import "./styles/watchtower.css";

const TABS = [["overview", "Overview"], ["dependencies", "Dependencies"], ["network", "Network"]];
// OSV's CVSS severities, worst first, then clean; any other (unknown) counts as low, as on the findings.
const SEVERITIES = ["critical", "high", "medium", "low", "clean"];
const COLOUR = { critical: "var(--danger-fill)", high: "var(--danger)", medium: "var(--warning-fill)", low: "var(--chart)", clean: "var(--success-fill)" };
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const label = (sev) => (sev === "clean" ? "No advisories" : cap(sev));

const OSV = SEVERITIES.slice(0, 4);
const rank = (v) => (OSV.includes(v.severity) ? OSV.indexOf(v.severity) : 3);
// Each open advisory with its dependency, worst first (dismissed ones don't count).
const advisories = (deps) => deps.filter((d) => d.status === "vulnerable")
  .flatMap((d) => d.vulns.map((advisory) => ({ ...d, advisory, sev: SEVERITIES[rank(advisory)] }))).sort((a, b) => rank(a.advisory) - rank(b.advisory));

// A dependency with its worst advisory, or clean when none is open.
const row = (d) => advisories([d])[0] ?? { ...d, advisory: null, sev: "clean" };

const Sev = ({ sev }) => <span className="pill"><span className="sw" style={{ background: COLOUR[sev] }} />{label(sev)}</span>;

function LoadError() {
  const err = useAsyncError();
  const { revalidate } = useRevalidator();
  return <div className="card"><ErrorState message={`Couldn't load Watchtower: ${err?.message ?? String(err)}`} onRetry={revalidate} /></div>;
}

const Tab = ({ resolve, skel, children }) => <Suspense fallback={<LoadingRegion page="Watchtower" busy>{skel}</LoadingRegion>}><Await resolve={resolve} errorElement={<LoadError />}>{children}</Await></Suspense>;

function Head({ w, tab, onTab }) {
  const nav = useNavigation();
  const pending = ["queued", "running"].includes(w?.scans[0]?.status);
  const { revalidate } = useRevalidator();
  // Polls while a scan is queued or running, so the header shows the finished scan without a reload.
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => { invalidate(); revalidate(); }, 5000);
    return () => clearInterval(t);
  }, [pending, revalidate]);
  const busy = (nav.state === "submitting" && !nav.formData.get("act")) || pending;
  const last = w?.scans.find((s) => s.status !== "queued");
  const scan = (text) => <Form method="post"><button type="submit" className="btn btn-primary" disabled={busy}><Ic name="refresh" />{busy ? "Scanning…" : text}</button></Form>;
  return <>
    <div className="toolbar">
      <Tabs label="Watchtower" options={TABS} value={tab} onChange={onTab} />
      <div className="toolbar-end">
        {w?.scans[0]?.status === "queued" && !w.scan_worker_online && <span className="subtle" role="status">Waiting for a scan worker</span>}
        {last && <span className="subtle">Last scan {ago(last.ran_at)} ago</span>}{scan("Scan again")}
      </div>
    </div>
    {w?.scans[0]?.status === "failed" && <div className="banner danger" role="alert"><Dot tone="bad" /><span><b>The last scan failed.</b> Advisories are from the scan before it.</span>{scan("Retry")}</div>}
  </>;
}

function Overview({ w, deps, egress, repo, onDeps }) {
  const adv = advisories(deps);
  const finding = (d) => w.findings.find((f) => f.state === "open" && f.source === "dependency" && f.title === d.advisory.id && f.location === `${d.name}@${d.version}`);
  const segments = SEVERITIES.map((s) => ({ label: label(s), value: adv.filter((d) => d.sev === s).length, colour: COLOUR[s] })).filter((s) => s.value);
  useShape(`watchtower/${repo}/advisories`, 4, adv.length);
  return <>
    <div className="tiles">
      <Tile label="Dependencies" value={deps.length} />
      <Tile label="Open advisories" value={adv.length} />
      <Tile label="Auto-fix changes open" value={w.fix_changes_open} />
      <Tile label="Denied egress · 24h" value={egress.versions.reduce((n, v) => n + v.counts.denied, 0)} />
    </div>
    <section className="card"><div className="card-h">Open advisories by severity</div><div className="card-b"><PropBar segments={segments} /></div></section>
    <section className="card">
      <div className="card-h"><h3>Top advisories</h3><button type="button" className="btn btn-secondary btn-sm end" onClick={onDeps}>All dependencies <Ic name="ar" /></button></div>
      {adv.map((d) => [d, finding(d)]).map(([d, f]) => <div className="act" key={`${d.ecosystem}|${d.name}|${d.version}|${d.advisory.id}`}>
        <span className="sw" style={{ background: COLOUR[d.sev] }} />
        <span className="grow"><b>{d.name} <span className="mono subtle">{d.version}</span></b><small className="mono">{d.advisory.id} · fixed in {d.advisory.fixed_in ?? "—"}</small></span>
        <Sev sev={d.sev} />
        {f && <Form method="post"><input type="hidden" name="id" value={f.id} /><button type="submit" name="act" value="fix" className="btn btn-secondary btn-sm">Open fix change</button></Form>}
      </div>)}
      {!adv.length && noAdvisories}
    </section>
    <Findings w={w} deps={deps} repo={repo} />
    <section className="card"><div className="srow">
      <div><h3>Pause Watchtower scans</h3><p>Stops scheduled dependency and egress scans for {repo}. Open advisories stay listed.</p></div>
      <Form method="post" className="end"><input type="hidden" name="on" value={String(!w.paused)} />
        <button type="submit" name="act" value="pause" className="btn btn-danger">{w.paused ? "Resume scans" : "Pause scans"}</button></Form>
    </div></section>
  </>;
}

const SOURCES = [["all", "All"], ["dependency", "Dependencies"], ["secret", "Secrets"], ["code", "Code"]];
const GROUP = ["secret", "code", "dependency"];
const REASONS = [["false_positive", "False positive"], ["risk_accepted", "Risk accepted"], ["wont_fix", "Won't fix"], ["not_applicable", "Not applicable"], ["revoked", "Revoked"]];
const REMEDY = {
  secret: "Rotate the credential, then purge it from the git history. Mark it revoked once the old one no longer works.",
  code: "Change the code so the rule no longer matches, or dismiss the finding with a reason.",
};
const MORE = 5;

// The detail rail for ?finding=<id>: what and where, how to fix it, then Fix with an agent, Dismiss or Reopen.
function FindingRail({ f, fixedIn, repo }) {
  const id = <input type="hidden" name="id" value={f.id} />;
  return <aside className="rail card-b" aria-label="Finding detail">
    <div className="row"><b>{f.title}</b><Sev sev={f.severity} /></div>
    <div className="row"><Tag><span className="mono">{f.rule}</span></Tag>
      {f.state !== "open" && <Tag tone="info">{cap(f.state)}{f.dismiss_reason && ` · ${REASONS.find(([r]) => r === f.dismiss_reason)?.[1] ?? f.dismiss_reason}`}</Tag>}</div>
    <div className="rail-sec"><div className="subtle">Location</div><code className="mono">{f.line ? `${f.location}:${f.line}` : f.location}</code></div>
    <div className="rail-sec"><div className="subtle">Remediation</div>
      <p>{REMEDY[f.source] ?? (fixedIn ? `Upgrade ${f.location} to ${fixedIn}.` : "No fixed version is published yet.")}</p></div>
    {f.state === "open" && <div className="rail-sec row">
      {f.fix_change
        ? <Link className="btn btn-primary btn-sm" to={`/${encodeURIComponent(repo)}/changes/${f.fix_change}`}>Open fix change</Link>
        : <Form method="post">{id}<button type="submit" name="act" value="fix" className="btn btn-primary btn-sm">Fix with an agent</button></Form>}
      {f.source === "secret" && <Form method="post">{id}<input type="hidden" name="reason" value="revoked" />
        <button type="submit" name="act" value="dismiss" className="btn btn-secondary btn-sm">Mark revoked — credential rotated</button></Form>}
      <Form method="post" className="row">{id}
        <select className="input" name="reason" aria-label="Dismiss reason">{REASONS.slice(0, 4).map(([r, l]) => <option key={r} value={r}>{l}</option>)}</select>
        <button type="submit" name="act" value="dismiss" className="btn btn-secondary btn-sm">Dismiss</button>
      </Form>
    </div>}
    {f.state === "dismissed" && <Form method="post" className="rail-sec">{id}<button type="submit" name="act" value="reopen" className="btn btn-secondary btn-sm">Reopen</button></Form>}
  </aside>;
}

// Secrets, code and dependency findings, grouped (one group per package for dependencies), filtered by source,
// severity and text; fixed findings are history and stay out.
function Findings({ w, deps, repo }) {
  const [search, setSearch] = useSearchParams();
  const [more, setMore] = useState([]);
  const set = (key, value) => setSearch((q) => { if (value && value !== "all") q.set(key, value); else q.delete(key); return q; }, { replace: true });
  const source = search.get("source") ?? "all";
  const sev = search.get("fsev") ?? "";
  const text = (search.get("q") ?? "").toLowerCase();
  const listed = w.findings.filter((f) => f.state !== "fixed");
  const shown = listed.filter((f) => (source === "all" || f.source === source) && (!sev || f.severity === sev) && `${f.title} ${f.location}`.toLowerCase().includes(text))
    .sort((a, b) => GROUP.indexOf(a.source) - GROUP.indexOf(b.source) || OSV.indexOf(a.severity) - OSV.indexOf(b.severity));
  const groups = Object.entries(Object.groupBy(shown, (f) => (f.source === "dependency" ? f.location : f.source)));
  const fixedIn = (f) => (f.source === "dependency"
    ? deps.find((d) => `${d.name}@${d.version}` === f.location)?.vulns.find((v) => v.id === f.title)?.fixed_in : undefined);
  const sel = listed.find((f) => f.id === search.get("finding"));
  return <section className="card">
    <div className="card-h"><h3>Findings</h3></div>
    <div className="card-b toolbar">
      <Tabs label="Source" options={SOURCES.map(([s, l]) => [s, `${l} ${s === "all" ? listed.length : listed.filter((f) => f.source === s).length}`])} value={source} onChange={(v) => set("source", v)} />
      <select className="input" aria-label="Finding severity" value={sev} onChange={(e) => set("fsev", e.target.value)}>
        <option value="">All severities</option>{OSV.map((s) => <option key={s} value={s}>{cap(s)}</option>)}
      </select>
      <input className="input filter" type="search" aria-label="Search findings" placeholder="Search findings" value={search.get("q") ?? ""} onChange={(e) => set("q", e.target.value)} />
    </div>
    <div className={sel ? "two" : undefined}>
      <div className="tscroll">
        {groups.length ? <table className="tbl">
          <thead><tr><th>Severity</th><th>Finding</th><th>Fix</th><th>Age</th></tr></thead>
          {groups.map(([key, fs]) => <tbody key={key}>
            <tr><th colSpan="4">{key === "secret" ? "Secrets" : key === "code" ? "Code" : key} · {fs.length}{fs.some(fixedIn) && " · fix available"}</th></tr>
            {(more.includes(key) ? fs : fs.slice(0, MORE)).map((f) => <tr key={f.id} tabIndex={0} className={f === sel ? "sel" : undefined}
              onClick={() => set("finding", f.id)} onKeyDown={(e) => e.key === "Enter" && set("finding", f.id)}>
              <td><Sev sev={f.severity} /></td>
              <td><b>{f.title}</b> <span className="mono subtle">{f.location}</span>{f.state !== "open" && <> <Tag>{cap(f.state)}</Tag></>}</td>
              <td className="mono">{fixedIn(f) ?? (f.fix_change ? "Fix change open" : "—")}</td>
              <td>{f.first_seen ? ago(f.first_seen) : "—"}</td>
            </tr>)}
            {fs.length > MORE && !more.includes(key) && <tr><td colSpan="4">
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setMore([...more, key])}>Show {fs.length - MORE} more…</button></td></tr>}
          </tbody>)}
        </table> : <div className="card-b subtle">{listed.length ? "No findings match these filters." : "No findings yet. Scan again to check this repository."}</div>}
      </div>
      {sel && <FindingRail f={sel} fixedIn={fixedIn(sel)} repo={repo} />}
    </div>
  </section>;
}

// Skeletons: the tab's real layout with bones for data.
const noAdvisories = <div className="card-b subtle">No open advisories.</div>;

function OverviewSkel() {
  const { n } = useShape(`watchtower/${useParams().repo}/advisories`, 4);
  return <>
  <div className="tiles">{["Dependencies", "Open advisories", "Auto-fix changes open", "Denied egress · 24h"].map((l) => <TileSkel key={l} label={l} />)}</div>
  <section className="card"><div className="card-h">Open advisories by severity</div><div className="card-b"><div className="leg"><BoneText w="40%" /></div><Bone w="100%" h={32} /></div></section>
  <section className="card">
    <div className="card-h"><h3>Top advisories</h3><button type="button" className="btn btn-secondary btn-sm end" disabled>All dependencies <Ic name="ar" /></button></div>
    {n ? Array.from({ length: n }, (_, i) => <div className="act" key={i}><Bone w={10} h={10} row={i} /><span className="grow skel-lines"><BoneText i={i} /><BoneText i={i + 1} /></span><BonePill row={i} /></div>) : noAdvisories}
  </section>
</>;
}

function AutoFix({ dep }) {
  const f = useFetcher();
  const on = f.formData ? f.formData.get("on") === "true" : dep.auto_fix;
  return <Toggle label={`Auto-fix ${dep.name}`} checked={on} onChange={(v) => f.submit({ act: "auto", ecosystem: dep.ecosystem, name: dep.name, on: String(v) }, { method: "post" })} />;
}

const DepsBar = ({ sev, onSev, loading = false }) => <div className="toolbar">
  <Tabs label="Severity" options={[["all", "All"], ...SEVERITIES.map((s) => [s, cap(s)])]} value={sev} onChange={onSev} />
  <Form method="post" className="toolbar-end"><button type="submit" name="act" value="sbom" className="btn btn-secondary" disabled={loading}><Ic name="filter" />Export SBOM</button></Form>
</div>;

function DepsSkel(props) {
  const { n, widths } = useShape(`watchtower/${useParams().repo}/deps`, 8);
  return <>
    <DepsBar {...props} loading />
    <section className="card"><div className="card-h">Inventory</div><div className="tscroll">
      <TableSkel rows={n} widths={widths} cols={[["Package"], ["Version", 48], ["Advisory", 88], ["Severity"], ["Fixed in", 48], ["Auto-fix change"]]} />
    </div></section>
  </>;
}

function Dependencies({ deps, sev, onSev }) {
  const rows = deps.map(row).filter((d) => sev === "all" || d.sev === sev);
  // An empty table still draws its one "Nothing at this severity" row.
  const { ref } = useShape(`watchtower/${useParams().repo}/deps`, 8, Math.max(rows.length, 1));
  return <>
    <DepsBar sev={sev} onSev={onSev} />
    <section className="card">
      <div className="card-h">Inventory · {deps.length} packages</div>
      <div className="tscroll"><table className="tbl" ref={ref}>
        <thead><tr><th>Package</th><th>Version</th><th>Advisory</th><th>Severity</th><th>Fixed in</th><th>Auto-fix change</th></tr></thead>
        <tbody>
          {rows.map((d) => <tr key={`${d.ecosystem}|${d.name}|${d.version}`}>
            <td>{d.name}</td><td className="mono">{d.version}</td><td className="mono subtle">{d.advisory?.id ?? "—"}</td><td><Sev sev={d.sev} /></td>
            <td className="mono">{d.advisory?.fixed_in ?? "—"}</td><td>{d.advisory?.fixed_in ? <AutoFix dep={d} /> : "—"}</td></tr>)}
          {!rows.length && <tr><td colSpan="6" className="subtle">Nothing at this severity.</td></tr>}
        </tbody>
      </table></div>
    </section>
  </>;
}

// act: the row's Allow or Deny button, for an agent that can be released.
const Hosts = ({ title, hosts, bad = false, act }) => {
  const top = Math.max(...hosts.map((h) => h.count), 1);
  return <div className="card-b"><div className="subtle">{title}</div>
    {hosts.map((h) => <div className={`hbar${bad ? " bad" : ""}${act ? " act" : ""}`} key={h.host}><span className="mono host" title={h.host}>{h.host}</span><span className="track"><i style={{ width: `${h.count / top * 100}%` }} /></span><span className="mono">{h.count}</span>
      {act && <button type="button" className={`btn btn-sm ${bad ? "btn-secondary" : "btn-ghost"}`} onClick={() => act(h.host)}>{bad ? "Allow" : "Deny"}</button>}</div>)}
    {!hosts.length && <div className="subtle">None</div>}
  </div>;
};

const NET = <p className="subtle">Egress per agent version, last 24 hours. Hosts outside the allowlist are denied and logged.</p>;

const noEgress = <section className="card"><EmptyState icon="pulse" title="No agent egress">No agent has made a request in the last 24 hours.</EmptyState></section>;

function NetworkSkel() {
  const { n } = useShape(`watchtower/${useParams().repo}/network`, 3);
  return <>
  {NET}
  {!n && noEgress}
  {Array.from({ length: n }, (_, i) => <section className="card" key={i}>
    <div className="card-h"><BoneText i={i} w={160} /><span className="end"><BonePill row={i} /></span></div>
    <div className="grid2">{["Allowed", "Denied"].map((t) => <div className="card-b" key={t}><div className="subtle">{t}</div>
      {[0, 1].map((j) => <div className="hbar" key={j}><BoneText i={i + j} /><Bone w="100%" h={8} row={i} /><BoneText i={i + j + 1} /></div>)}</div>)}</div>
  </section>)}
</>;
}

// Egress rules ship with the agent version: Allow or Deny releases name@v(N+1) on a channel; no released version changes.
function Release({ dlg, pick, onDone }) {
  const [channel, setChannel] = useState(null);
  const { vers, err } = pick ?? {};
  const at = (ch) => vers?.find((v) => v.channel === ch);
  const ch = channel ?? (at("canary") ? "canary" : "stable");
  const next = vers && Math.max(0, ...vers.map((v) => v.version)) + 1;
  const allow = pick?.verdict === "allow";
  const onClose = (e) => {
    setChannel(null);
    if (e.currentTarget.returnValue !== "ok") return;
    const { name, host, verdict } = pick;
    releaseEgress(name, { host, verdict, channel: ch }).then(() => onDone(`Released ${name}@v${next} to ${ch} · ${host} ${allow ? "allowed" : "denied"}`),
      (x) => onDone(x.message, true));
  };
  const radio = (c, text) => <label className="mrow"><input type="radio" name="channel" value={c} checked={ch === c} disabled={!at(c)} onChange={() => setChannel(c)} />
    <span className="grow"><b>{c}</b> · {text}</span></label>;
  return <Dialog ref={dlg} title={pick && <>{allow ? "Allow" : "Deny"} <span className="mono">{pick.host}</span> for <span className="mono">{pick.name}</span>?</>}
    action={next ? `Release ${pick.name}@v${next} to ${ch}` : "Release"} disabled={!next || !at(ch)} onClose={onClose}>
    {err ? <p className="meta" role="alert">Couldn&apos;t load {pick.name}&apos;s versions: {err}</p> : !next ? <Bone w="100%" h={96} /> : <>
      <p>Egress rules ship with the agent, so this <b>releases a new version</b>: <span className="mono">{pick.name}@v{next}</span>, a copy of its {ch} version with <span className="mono">{pick.host}</span> {allow ? "added to" : "removed from"} its allowlist. Released versions don&apos;t change.</p>
      <div className="mlist" role="radiogroup" aria-label="Channel">
        {radio("canary", at("canary") ? `${at("canary").share}% of changes. Stable stays on v${at("stable")?.version ?? "its current version"} until you promote v${next}.` : "no canary version to replace")}
        {radio("stable", at("stable") ? "every change from its next run" : "no stable version")}
      </div>
      {allow && metadata(pick.host)}
    </>}
  </Dialog>;
}

const metadata = (host) => host.startsWith("169.254.") && <div className="banner danger" role="alert"><Ic name="tri" /><span>169.254.169.254 is the cloud metadata address. Allowing it lets the agent read worker credentials.</span></div>;

// The runner's default agent (@v0) reaches its pool's allowlist (worker/src/workers.js), so Allow adds the host to every
// allowlist pool serving the repo; an empty list means the defaults, which stay on it.
function PoolAllow({ dlg, pick, onDone }) {
  const { host, pools, err } = pick ?? {};
  const onClose = (e) => {
    if (e.currentTarget.returnValue !== "ok") return;
    Promise.all(pools.map((p) => poolAct(`/pools/${encodeURIComponent(p.id)}`, { egress_allow: [...new Set([...(p.egress_allow.length ? p.egress_allow : DEFAULT_EGRESS), host])] }, "PUT")))
      .then(() => onDone(`${host} allowed on ${pools.map((p) => p.name).join(", ")}`), (x) => onDone(x.message, true));
  };
  return <Dialog ref={dlg} title={pick && <>Allow <span className="mono">{host}</span>?</>} action="Allow" disabled={!pools?.length} onClose={onClose}>
    {err ? <p className="meta" role="alert">Couldn&apos;t load the pools: {err}</p> : !pools ? <Bone w="100%" h={96} />
      : !pools.length ? <p>No pool with an allowlist runs this repo.</p> : <>
        <p>Adds <span className="mono">{host}</span> to the egress allowlist of {pools.map((p) => <b key={p.id}>{p.name} </b>)}. Every repo on these pools can reach it.</p>
        {metadata(host)}
      </>}
  </Dialog>;
}

function Network({ egress }) {
  useShape(`watchtower/${useParams().repo}/network`, 3, egress.versions.length);
  const { repo } = useParams();
  const dlg = useRef(null), [pick, setPick] = useState(null), [done, setDone] = useState(null);
  const poolDlg = useRef(null), [poolPick, setPoolPick] = useState(null);
  const openPool = (host) => {
    const p = { host };
    setPoolPick(p);
    openDialog(poolDlg);
    list("/api/workers/pools").then((all) => setPoolPick((q) => q === p ? { ...p, pools: all.filter((x) => x.egress === "allowlist" && (x.repos === "*" || x.repos.includes(repo))) } : q),
      (e) => setPoolPick((q) => q === p ? { ...p, err: e.message } : q));
  };
  const open = (agent, verdict) => (host) => {
    const p = { name: agent.split("@")[0], host, verdict };
    setPick(p);
    openDialog(dlg);
    agentVersions(p.name).then((vers) => setPick((q) => q === p ? { ...p, vers } : q), (e) => setPick((q) => q === p ? { ...p, err: e.message } : q));
  };
  return <>
  {NET}
  {done && <p className="meta" role={done.bad ? "alert" : "status"}>{done.text}</p>}
  {!egress.versions.length && noEgress}
  {egress.versions.map((v) => <section className="card" key={v.agent}>
    <div className="card-h"><h3 className="mono">{v.agent}</h3><span className="end">
      <span className="pill"><Dot tone={v.counts.denied ? "bad" : "ok"} />{v.counts.denied ? `${v.counts.denied} denied` : "clean"}</span>
      {/* @v0 is the runner's built-in default (worker/src/work.js): no agent to edit, so no allowlist link. */}
      {!v.agent.endsWith("@v0") && <Link className="btn btn-secondary btn-sm" to={`/automation/agents/${encodeURIComponent(v.agent.split("@")[0])}/settings`}>Allowlist</Link>}
    </span></div>
    <div className="grid2"><Hosts title="Allowed" hosts={v.allowed} act={!v.agent.endsWith("@v0") && open(v.agent, "deny")} />
      <Hosts title="Denied" hosts={v.denied} bad act={v.agent.endsWith("@v0") ? openPool : open(v.agent, "allow")} /></div>
  </section>)}
  <Release dlg={dlg} pick={pick} onDone={(text, bad) => setDone({ text, bad })} />
  <PoolAllow dlg={poolDlg} pick={poolPick} onDone={(text, bad) => setDone({ text, bad })} />
</>;
}

export function Watchtower() {
  const { wt, deps, egress, overview } = useLoaderData();
  const { repo } = useParams();
  const [search, setSearch] = useSearchParams();
  const tab = TABS.some(([t]) => t === search.get("tab")) ? search.get("tab") : "overview";
  const sev = SEVERITIES.includes(search.get("sev")) ? search.get("sev") : "all";
  const set = (key, value, fallback) => setSearch((q) => { if (value === fallback) q.delete(key); else q.set(key, value); return q; }, { replace: true });
  const onTab = (t) => set("tab", t, "overview");
  const onSev = (s) => set("sev", s, "all");
  return (
    <Frame className="wt">
      <Suspense fallback={<Head tab={tab} onTab={onTab} />}>
        <Await resolve={wt} errorElement={<Head tab={tab} onTab={onTab} />}>{(w) => <Head w={w} tab={tab} onTab={onTab} />}</Await>
      </Suspense>
      {tab === "overview" && <Tab resolve={overview} skel={<OverviewSkel />}>{([w, d, e]) => <Overview w={w} deps={d} egress={e} repo={repo} onDeps={() => onTab("dependencies")} />}</Tab>}
      {tab === "dependencies" && <Tab resolve={deps} skel={<DepsSkel sev={sev} onSev={onSev} />}>{(d) => <Dependencies deps={d} sev={sev} onSev={onSev} />}</Tab>}
      {tab === "network" && <Tab resolve={egress} skel={<NetworkSkel />}>{(e) => <Network egress={e} />}</Tab>}
    </Frame>
  );
}

// Same rule as Repositories: a search-only change (tab, filters) keeps the loaded data; actions still reload it.
export const watchtowerRevalidate = ({ currentUrl, nextUrl, formMethod, defaultShouldRevalidate }) =>
  defaultShouldRevalidate && (!!formMethod || currentUrl.pathname !== nextUrl.pathname || currentUrl.search === nextUrl.search);

export function watchtowerLoader({ params }) {
  const [wt, deps, egress] = [getWatchtower(params.repo), getDependencies(params.repo), getEgress(params.repo, "24h")];
  const overview = Promise.all([wt, deps, egress]);
  // Each can reject before <Await> subscribes, which reports an unhandled rejection; <Await> still renders the error.
  [wt, deps, egress, overview].forEach((p) => p.catch(() => {}));
  return { wt, deps, egress, overview };
}

export async function watchtowerAction({ params, request }) {
  const { act, id, reason, ecosystem, name, on } = Object.fromEntries(await request.formData());
  // A failed request throws to the route's error page.
  if (act === "fix") {
    const change = await fixFinding(id);
    if (change) return redirect(`/${encodeURIComponent(params.repo)}/changes/${change.id}`);
  } else if (act === "dismiss") await dismissFinding(id, reason);
  else if (act === "reopen") await reopenFinding(id);
  else if (act === "auto") await setAutoFix(params.repo, ecosystem, name, on === "true");
  else if (act === "pause") await pauseScans(params.repo, on === "true");
  else if (act === "sbom") await downloadSbom(params.repo);
  else await startScan(params.repo);
  return null;
}
