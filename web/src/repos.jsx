// Repositories (home).
import { Suspense, useEffect, useState } from "react";
import { Await, Link, useAsyncError, useFetcher, useLoaderData, useLocation, useNavigate, useRevalidator, useRouteLoaderData, useSearchParams } from "react-router";
import { ALERT_THRESHOLDS, BRANCH_STRATEGIES } from "../../worker/src/api/contract.js";
import { getAccount } from "./api/budget.js";
import { BudgetSettings } from "./budget.jsx";
import { Ring } from "./charts.jsx";
import { createRepo, get, getOverview, invalidate, listen, putAccount, repoPost, sessionExpired } from "./client.js";
import { DeleteRepo } from "./delete-repo.jsx";
import { useGet } from "./use-get.js";
import { Ic } from "./icons.jsx";
import { BoneText, ListCardSkel, LoadingRegion, TileSkel, useShape } from "./skeleton.jsx";
import { EmptyState, ErrorState, Popover, State, Tag, Tile, Untrusted, tok, Frame } from "./ui.jsx";
import { codePath } from "./lib/code-path.js";

export const reposLoader = () => {
  const me = get("/api/me");
  const overview = getOverview(), budget = Promise.all([getAccount(), me]);
  // Marked handled: the Archived list, the list card and the budget settings render the rejections, which may land before their <Await> mounts.
  for (const p of [me, overview, budget]) p.catch(() => {});
  return { overview, me, budget };
};

// The New repository panel, a card's Archive, an archived row's Unarchive and the account card post here; the loaders
// then revalidate, so the page changes in place.
export async function reposAction({ request }) {
  const f = Object.fromEntries(await request.formData());
  try {
    if (f.intent === "archive" || f.intent === "unarchive") await repoPost(f.name, "/archive", undefined, f.intent === "archive" ? "POST" : "DELETE");
    else if (f.intent === "account") {
      // threshold: the Add budget alert dialog's new alert, added to the ones already set.
      await putAccount({ git_host: f.git_host, budget_tokens: f.budget_tokens && Number(f.budget_tokens), when_reached: f.when_reached,
        alerts: f.alerts && [...JSON.parse(f.alerts), ...(f.threshold ? [Number(f.threshold)] : [])] });
    } else {
      await createRepo({ name: f.name, default_branch: f.default_branch || undefined, strategy: f.strategy,
        import: f.url ? { url: f.url, branch: f.default_branch || undefined, token: f.token || undefined } : undefined });
    }
    return { ok: true };
  } catch (e) {
    return { error: e.message };
  }
}

// An inline panel that slides down under the page head (grid-rows transition; reduced motion turns it off in app.css).
function SlidePanel({ open, title, intent, submit, setOpen, onSubmit, children }) {
  const fetcher = useFetcher();
  useEffect(() => { if (fetcher.data?.ok) setOpen(null); }, [fetcher.data, setOpen]);
  return (
    <div className={`slide${open ? " open" : ""}`} inert={!open}>
      <div>
        <fetcher.Form method="post" className="panel form" role="dialog" aria-label={title} onSubmit={onSubmit}>
          <h2>{title}</h2>
          <input type="hidden" name="intent" value={intent} />
          <div className="form-grid">{children}</div>
          {fetcher.data?.error && <p className="meta" role="alert">{fetcher.data.error}</p>}
          <div className="actions">
            <button type="button" className="btn btn-secondary" onClick={() => setOpen(null)}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={fetcher.state !== "idle"}>{submit}</button>
          </div>
        </fetcher.Form>
      </div>
    </div>
  );
}

const Field = ({ label, ...input }) => <label className="field"><span>{label}</span><input className="input" {...input} /></label>;
export const ago = (at) => {
  const s = Math.max(0, (Date.now() - Date.parse(at)) / 1000);
  return s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
};
const SHOW = [["all", "Show all"], ["archived", "Archived"]];
const SORT = [["pushed", "Last pushed"], ["name", "Name"]];
// Menu items close their popover once picked.
const close = (fn) => (e) => { fn(); e.currentTarget.parentElement.hidePopover(); };

function RepoCard({ repo, o }) {
  const navigate = useNavigate();
  const fetcher = useFetcher();
  const root = `/${encodeURIComponent(repo.name)}`, code = codePath(repo.name, repo.default_branch);
  return (
    <div className="lc">
      <div className="lc-m">
        <span className="lc-ico"><Ic name="book" /></span>
        <div className="grow"><div className="lc-t"><Link className="card-link" to={code}>{repo.name}</Link></div>
          <div className="lc-s">{o.description}</div></div>
        <span className="lc-time">{ago(o.pushed_at)} ago</span>
        <Popover label={<Ic name="more" />} title={`More for ${repo.name}`}>
          <button type="button" className="btn btn-ghost" onClick={close(() => navigate(code))}>Open</button>
          <button type="button" className="btn btn-ghost" onClick={close(() => navigate(`${root}/settings`))}>Settings</button>
          <button type="button" className="btn btn-ghost" onClick={close(() => confirm(`Archive ${repo.name}? Pushes will be refused until it is unarchived.`) && fetcher.submit({ intent: "archive", name: repo.name }, { method: "post" }))}>Archive</button>
        </Popover>
      </div>
      <div className="lc-f">
        <span><Ic name="branch" /><span className="mono">{repo.default_branch}</span></span>{o.language && <span>{o.language}</span>}
        {fetcher.data?.error && <span className="meta" role="alert">{fetcher.data.error}</span>}
        <span className="r"><span><Ic name="merge" /><b>{o.active}</b> open</span><span><Ic name="shieldck" />{o.verifier.n >= 20 && o.verifier.pass != null ? `${o.verifier.pass}%` : <Untrusted n={o.verifier.n} />}</span>
          <span><Ic name="robot" /><b>{o.agents}</b> agent{o.agents === 1 ? "" : "s"}</span></span>
      </div>
    </div>
  );
}

function ReposList({ repos, overview }) {
  useShape("repos//list", 4, repos.length);
  const [params, setParams] = useSearchParams();
  const { revalidate } = useRevalidator();
  const [q, setQ] = useState("");
  const fetcher = useFetcher();
  const me = useGet(() => get("/api/me"), useLoaderData().me);
  const [del, setDel] = useState(null);
  // An unknown ?show= falls back to all.
  const [show, sort] = [SHOW.some(([v]) => v === params.get("show")) ? params.get("show") : "all", params.get("sort") ?? "pushed"];
  const set = (k, v) => setParams((p) => { p.set(k, v); return p; }, { replace: true });
  const needle = q.trim().toLowerCase();
  const shown = repos.map((repo) => ({ repo, o: overview.repos.find((x) => x.repo_id === repo.id) }))
    .filter(({ repo, o }) => o && show !== "archived" && `${repo.name} ${o.description}`.toLowerCase().includes(needle))
    .sort((a, b) => (sort === "name" ? a.repo.name.localeCompare(b.repo.name) : b.o.pushed_at.localeCompare(a.o.pushed_at)));
  const archived = show === "archived" ? overview.archived.filter((a) => a.name.includes(needle)) : [];
  const n = shown.length + archived.length;
  const select = (k, options, value) => (
    <Popover label={<>{options.find(([v]) => v === value)[1]}<Ic name="ud" /></>}>
      {options.map(([v, l]) => <button type="button" key={v} className="btn btn-ghost" aria-pressed={v === value} onClick={close(() => set(k, v))}>{l}</button>)}
    </Popover>
  );
  return (
    <>
      <div className="tb-in">
        <label className="q"><Ic name="search" /><input placeholder="Search repositories" aria-label="Search repositories" value={q} onChange={(e) => setQ(e.target.value)} /></label>
        {select("show", SHOW, show)}{select("sort", SORT, sort)}
        <button type="button" aria-label="Refresh" onClick={() => { invalidate(); revalidate(); }}><Ic name="refresh" /></button>
      </div>
      <div className="stack">{shown.map(({ repo, o }) => <RepoCard key={repo.id} repo={repo} o={o} />)}
        {archived.map((a) => (
          <div className="lc" key={a.name}><div className="lc-m">
            <span className="lc-ico"><Ic name="book" /></span>
            <div className="grow"><div className="lc-t">{a.name}<Tag>archived</Tag></div></div>
            <span className="lc-time">{ago(a.archived_at)} ago</span>
            <button type="button" className="btn btn-secondary" onClick={() => fetcher.submit({ intent: "unarchive", name: a.name }, { method: "post" })}>Unarchive {a.name}</button>
            {me.data?.owner && <button type="button" className="btn btn-danger" onClick={() => setDel(a.name)}>Delete…</button>}
          </div></div>
        ))}
        {me.error && show === "archived" && <p className="meta" role="alert">Couldn&apos;t check owner: {me.error.message}</p>}
        {del && <DeleteRepo name={del} onClose={() => setDel(null)} />}
        {fetcher.data?.error && <p className="meta" role="alert">{fetcher.data.error}</p>}</div>
      <div className="pager"><span>{n ? `Showing 1–${n} of ${n}` : "No repositories match"}</span>
        <div className="pg">{["«", "‹", "1", "›", "»"].map((l) => <button type="button" key={l} disabled className={l === "1" ? "on" : undefined}>{l}</button>)}</div></div>
    </>
  );
}

// Budget alerts are account-wide and always raise a Needs you item.
function AlertDialog({ alerts, onClose }) {
  const fetcher = useFetcher();
  const [at, setAt] = useState(90);
  useEffect(() => { if (fetcher.data?.ok) onClose(); }, [fetcher.data, onClose]);
  return <dialog className="dlg" ref={(d) => { if (d && !d.open) d.showModal(); }} onClose={onClose} aria-label="Add budget alert">
    <fetcher.Form method="post">
      <div className="panel-head"><h2>Add budget alert</h2></div>
      <div className="pad form flush">
        <input type="hidden" name="intent" value="account" /><input type="hidden" name="alerts" value={JSON.stringify(alerts)} />
        <label className="field"><span>Alert at <output className="mono">{at}%</output></span>
          <input type="range" name="threshold" min={ALERT_THRESHOLDS[0]} max={ALERT_THRESHOLDS.at(-1)} step="5" value={at} onChange={(e) => setAt(Number(e.target.value))} /></label>
        <p className="meta">Of the monthly token budget.{alerts.length > 0 && ` Existing alerts: ${alerts.map((t) => `${t}%`).join(", ")}.`}</p>
        <div className="field"><span>Scope</span><span>Whole account</span></div>
        <label className="field"><span>Notify</span><span><input type="checkbox" checked disabled /> Needs you (always)</span></label>
        {fetcher.data?.error && <p className="meta" role="alert">{fetcher.data.error}</p>}
      </div>
      <div className="dlg-foot"><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={fetcher.state !== "idle"}>Add alert</button></div>
    </fetcher.Form>
  </dialog>;
}

function Usage({ o }) {
  const [copied, setCopied] = useState(false), [editHost, setEditHost] = useState(false), [adding, setAdding] = useState(false), now = new Date();
  const fetcher = useFetcher();
  // The server refuses non-owners with 403; until /api/me answers, both stay disabled.
  const owner = useGet(() => get("/api/me"), useLoaderData().me).data?.owner === true;
  const day = (m, d, month = "long") => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + m, d)).toLocaleDateString("en", { month, day: "numeric", timeZone: "UTC" });
  const sum = (f) => o.repos.reduce((n, r) => n + f(r), 0);
  const { account, budget } = o;
  const pct = budget.tokens ? Math.round(budget.spent / budget.tokens * 100) : null;
  return (
    <>
      <h2>Usage</h2>
      <div className="card">
        <div className="card-h"><h3>Token budget</h3><Link className="btn btn-ghost" to="/insights" aria-label="Open insights"><Ic name="ar" /></Link></div>
        <div className="card-b">
          <div className="row"><span className="muted">Agent tokens (current period)</span>
            <button type="button" className="btn btn-ghost" disabled={!owner} onClick={() => setAdding(true)}><Ic name="plus" />Add budget alert</button></div>
          {adding && <AlertDialog alerts={budget.alerts} onClose={() => setAdding(false)} />}
          <div className="budget"><Ring pct={pct == null ? null : Math.min(pct, 100)} label={pct == null ? "—" : `${pct}%`} />
            <div><div className="v">{tok(budget.spent)}</div><div className="muted">{pct == null ? "no token budget set" : `of ${tok(budget.tokens)} tokens · resets ${day(1, 1, "short")}`}</div></div></div>
          {budget.alerts.length > 0 && <div className="row">{budget.alerts.map((t) => <Tag key={t}>alert at {t}%</Tag>)}</div>}
          <fetcher.Form method="post" className="row">
            <input type="hidden" name="intent" value="account" />
            <input className="input" name="budget_tokens" type="number" min="1" required aria-label="Monthly token budget" placeholder="Monthly token budget" defaultValue={budget.tokens ?? ""} />
            <button type="submit" className="btn btn-secondary" disabled={!owner}>Set budget</button>
          </fetcher.Form>
          {fetcher.data?.error && <p className="meta" role="alert">{fetcher.data.error}</p>}
        </div>
      </div>
      <div className="muted">{day(0, 1)} – {day(1, 0)}</div>
      <div className="grid2">
        <Tile label="Changes merged" value={sum((r) => r.merged)} /><Tile label="Verifier runs" value={sum((r) => r.verifier.n)} />
        <Tile label="Lease conflicts" value={sum((r) => r.conflicts)} /><Tile label="Calibration" untrusted={sum((r) => r.lead_judge?.count ?? 0)} /></div>
      <div className="card"><div className="card-b"><h3>Account details</h3>
        <dl className="kv2">
          <dt>Account</dt><dd>{account.name}</dd><span />
          <dt>Account ID</dt><dd className="mono">{account.id ?? "—"}</dd>
          {account.id ? <button type="button" className="btn btn-ghost" aria-label={copied ? "Copied" : "Copy account ID"} onClick={() => navigator.clipboard.writeText(account.id).then(() => setCopied(true))}><Ic name="copy" /></button> : <span />}
          <dt>Git host</dt><dd className="mono">{account.git_host}</dd>
          <button type="button" className="btn btn-ghost" aria-label="Edit Git host" aria-expanded={editHost} onClick={() => setEditHost((v) => !v)}><Ic name="edit" /></button>
        </dl>
        {editHost && (
          <fetcher.Form method="post" className="row" onSubmit={() => setEditHost(false)}>
            <input type="hidden" name="intent" value="account" />
            <input className="input mono" name="git_host" required aria-label="Git host" defaultValue={account.git_host} />
            <button type="submit" className="btn btn-secondary">Save Git host</button>
          </fetcher.Form>
        )}
      </div></div>
      <div className="card"><div className="card-b"><h3>Verifier owns every merge</h3><p className="muted">Block direct pushes to integration branches on every repository.</p>
        {/* Always on: only the verifier merges into integration branches (docs/DESIGN.md). */}
        <input type="checkbox" className="tg" checked readOnly disabled aria-label="Verifier owns every merge" />
      </div></div>
    </>
  );
}

const TILES = ["Changes merged", "Verifier runs", "Lease conflicts", "Calibration"];
// Skeleton, empty and error share these positions: the list's toolbar (disabled), then the first card.
const idleBar = <div className="tb-in"><label className="q"><Ic name="search" /><input placeholder="Search repositories" aria-label="Search repositories" disabled /></label>
  {[SHOW[0][1], SORT[0][1]].map((l) => <button type="button" key={l} disabled>{l}<Ic name="ud" /></button>)}<button type="button" aria-label="Refresh" disabled><Ic name="refresh" /></button></div>;
// No repositories is known from the root loader before this loads, so the list never draws as empty here.
function ListSkel() {
  const { n } = useShape("repos//list", 4);
  return <LoadingRegion page="repositories" busy>{idleBar}<div className="stack">{Array.from({ length: n }, (_, i) => <ListCardSkel key={i} />)}</div></LoadingRegion>;
}
const usageSkel = <>
  <h2>Usage</h2>
  <div className="card" aria-busy="true"><div className="card-h"><h3>Token budget</h3></div>
    <div className="card-b"><div className="budget"><Ring pct={null} label="" /><div className="skel-lines"><BoneText large /><BoneText i={1} /></div></div></div></div>
  <div className="grid2" aria-busy="true">{TILES.map((l) => <TileSkel key={l} label={l} />)}</div>
</>;

function ReposError() {
  const [err, { revalidate }] = [useAsyncError(), useRevalidator()];
  if (sessionExpired()) return <>{idleBar}<State kind="error" /></>;
  return <>{idleBar}<div className="card"><ErrorState message={`Couldn't load repositories: ${err instanceof Error ? err.message : String(err)}`} onRetry={revalidate} /></div></>;
}

// Repo events and running imports reload the page's data. Rendered in Repos' <Suspense>, which shows ListSkel until overview answers.
function ReposBody({ repos, overview, newRepo }) {
  const { revalidate } = useRevalidator();
  useEffect(() => {
    const stops = repos.map((r) => listen(r.name, revalidate));
    return () => stops.forEach((stop) => stop());
  }, [repos, revalidate]);
  // An import emits no event when it lands, so poll while one is running.
  const importing = repos.some((r) => r.status === "importing");
  useEffect(() => {
    if (!importing) return;
    const timer = setInterval(() => { invalidate(); revalidate(); }, 3000);
    return () => clearInterval(timer);
  }, [importing, revalidate]);
  return repos.length === 0 ? (
    <>{idleBar}<div className="card"><EmptyState icon="book" title="No repositories yet" action={newRepo}>
      Create an empty one, or import an existing one with <code>cinder repo add &lt;name&gt; --import &lt;git url&gt;</code>.
    </EmptyState></div></>
  ) : <Await resolve={overview} errorElement={<ReposError />}>{(o) => <ReposList repos={repos} overview={o} />}</Await>;
}

export function Repos() {
  const repos = useRouteLoaderData("root").repos;
  const { overview, budget } = useLoaderData();
  const [open, setOpen] = useState(null);
  const [sent, setSent] = useState(0);
  const deleted = useLocation().state?.deleted;
  const newRepo = <button type="button" className="btn btn-primary" aria-expanded={open === "new"} onClick={() => setOpen((o) => (o ? null : "new"))}><Ic name="plus" />New repository</button>;
  return (
    <Frame head={<>
        <div><h1>Repositories<a className="docs" href="https://github.com/brinkercode/cinder/blob/main/docs/DESIGN.md" target="_blank" rel="noreferrer">View docs</a></h1><p>Agents propose, the verifier merges. Every repository on this account.</p></div>
        <div className="acts">{newRepo}</div>
      </>} aside={<><Suspense fallback={usageSkel}><Await resolve={overview} errorElement={<></>}>{(o) => <Usage o={o} />}</Await></Suspense><BudgetSettings budget={budget} /></>}>
      {deleted && <p className="meta" role="status">Deleted {deleted}.</p>}
      {/* The token is for this request only: a new key empties its field once the form has been read. */}
      <SlidePanel open={open === "new"} title="New repository" intent="new" submit="Create repository" setOpen={setOpen} onSubmit={() => setSent((n) => n + 1)}>
        <Field label="Name" name="name" required pattern="[a-z0-9\-]{2,63}" placeholder="my-service" />
        <Field label="Default branch" name="default_branch" placeholder="main" />
        <label className="field"><span>Strategy</span>
          <select className="input" name="strategy" defaultValue="trunk">{BRANCH_STRATEGIES.map((s) => <option key={s} value={s}>{s}</option>)}</select>
        </label>
        <Field label="Import from (optional)" name="url" type="url" className="input mono" placeholder="https://git.example.com/org/repo.git" />
        <Field key={sent} label="Token (optional)" name="token" type="password" autoComplete="off" placeholder="kept encrypted in Keystore for re-imports; remove it there" />
      </SlidePanel>
        <Suspense fallback={<ListSkel />}>
          <Await resolve={repos} errorElement={<ReposError />}>{(r) => <ReposBody repos={r} overview={overview} newRepo={newRepo} />}</Await>
        </Suspense>
    </Frame>
  );
}
