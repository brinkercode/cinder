import { Suspense, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Await, Link, matchRoutes, Outlet, UNSAFE_DataRouterContext, useLoaderData, useLocation, useMatches, useParams, useRevalidator, useRouteLoaderData, useSearchParams } from "react-router";
import { IconContext } from "react-icons";
import { branchesFor, branchLists, invalidate, NEEDS_CHANNEL, sessionExpired } from "./client.js";
import { PiBell, PiBookBookmark, PiBookOpen, PiBracketsAngle, PiCaretDown, PiCaretRight, PiCaretUpDown, PiCheck, PiCircleHalf, PiDatabase, PiGearSix, PiGitBranch, PiHouse, PiList, PiPulse, PiQuestion, PiRobot, PiShieldCheck, PiSidebarSimple, PiSignOut, PiSparkle, PiUsers, PiWarningCircle } from "react-icons/pi";
import { myAccounts, switchAccount } from "./api/accounts.js";
import { Branches } from "./branches.jsx";
import "./styles/account-pop.css";
import "./styles/branch-menu.css";
import { Ic } from "./icons.jsx";
import { ChangeId, Frame, Mid, State } from "./ui.jsx";
import { codePath } from "./lib/code-path.js";

// Every react-icons svg gets the .ico sizing and is hidden from screen readers.
const ICONS = { className: "ico", attr: { "aria-hidden": "true" } };
const repoPath = (name) => `/${encodeURIComponent(name)}`;

// The viewer's theme choice, kept per browser; main.jsx applies it before the first render.
export const THEME = "cinder.theme";

export function toggleTheme() {
  const go = () => localStorage.setItem(THEME, document.documentElement.classList.toggle("dark") ? "dark" : "light");
  if (document.startViewTransition) document.startViewTransition(go);
  else go();
}

// A page's actions, at the right end of a toolbar row, for pages with no toolbar of their own.
export const PageActions = ({ children }) => <div className="toolbar"><div className="toolbar-end">{children}</div></div>;

const Mark = () => <svg className="mark" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.6 16.95 8.55A7 7 0 1 1 7.05 8.55Z" /></svg>;

// The last repo a viewer opened, kept per browser; repo-scoped pages reached without a repo follow it.
export const LAST_REPO = "cinder.last_repo";
// globalThis: there's no localStorage outside a browser (tests).
export const lastRepo = (repos) => repos.find((r) => r.name === globalThis.localStorage?.getItem(LAST_REPO));
// Each repo's target branch for the session (BRANCH-DROPDOWN.md); every link into a repo carries it, as /code/:ref or ?target=.
const TARGET = "cinder.target.";
const remember = (repo, branch) => globalThis.sessionStorage?.setItem(TARGET + repo, branch);
const targetOf = (r) => globalThis.sessionStorage?.getItem(TARGET + r.name) ?? r.default_branch;
export const scopedPath = (r, page, t = targetOf(r)) => (page === "code" ? codePath(r.name, t)
  : `${repoPath(r.name)}/${t === r.default_branch ? page : `${page}?target=${encodeURIComponent(t)}`}`);

// [sub-section, icon, [[path, label]]]; a path without a leading "/" is repo-scoped. Needs you sits before Settings.
const GIT = [
  ["Code", <PiBookBookmark />, [["/", "Repositories"]]],
  ["Automation", <PiRobot />, [["/automation/agents", "Agents"], ["/automation/marketplace", "Marketplace"], ["/automation/judges", "Judges & calibration"],
    ["flows", "Flows"], ["environments", "Environments"], ["/automation/workers", "Workers"]]],
  ["Settings", <PiGearSix />, [["/settings/access", "Access & people"], ["/settings/keystore", "Keystore"]]],
];

// The repo's features, listed under it in the sidebar; Code is the default. Pages without an item of their own mark their parent's.
const FEATURES = [["code", "Code"], ["changes", "Changes"], ["watchtower", "Watchtower"], ["insights", "Insights"], ["settings", "Settings"]];
const FEAT_ALIAS = { releases: "code" };
const wikiPath = (r) => `/wiki/${encodeURIComponent(r.name)}`;

const menuProps = (id) => ({ popover: "auto", id, className: "menu", style: { positionAnchor: `--${id}` },
  onToggle: (e) => { if (e.newState === "open") e.currentTarget.querySelector("input")?.focus(); },
  onClick: (e) => { if (e.target.closest("a, button")) e.currentTarget.hidePopover(); } });
const has = (q) => (s) => s.toLowerCase().includes(q.trim().toLowerCase());

// The target-branch dropdown (BRANCH-DROPDOWN.md). Roles and ↑/↓ come from the branches API, which reads .cinder.yml:
// fetched once the browser is idle, then again on each open while the last list stays drawn.
function BranchMenu({ repo, target, at, code, onAll, trigger }) {
  const { pathname } = useLocation();
  const [q, setQ] = useState("");
  const [info, setInfo] = useState(() => branchLists.get(repo.name) ?? null);
  const load = () => branchesFor(repo.name).then((bs) => { branchLists.set(repo.name, bs); setInfo(bs); }, setInfo);
  useEffect(() => {
    // Safari has no requestIdleCallback; a zero timeout also waits for the page's own work.
    const [later, cancel] = globalThis.requestIdleCallback ? [requestIdleCallback, cancelIdleCallback] : [setTimeout, clearTimeout];
    const id = later(load);
    return () => cancel(id);
  }, []); // the menu is keyed by repo, so this runs once per repo
  const props = menuProps("branch-menu");
  const loaded = Array.isArray(info);
  const integration = loaded ? info.filter((i) => i.role === "integration").map((i) => i.name) : repo.branch_policy.integration;
  const shown = [...new Set([repo.default_branch, ...integration])];
  const row = (name, icon, role, x) => (
    <Link key={name} to={at(name)} onClick={() => remember(repo.name, name)} className={name === target ? "bm-r on" : "bm-r"} role="menuitemradio" aria-checked={name === target}>
      <Ic name={icon} /><span className="bm-n mono">{name}</span><span className="bm-role">{role}</span>
      <span className="bm-ab mono">{x && name !== repo.default_branch && `↑${x.ahead} ↓${x.behind}`}</span>
      <span className="chkw">{name === target && <Ic name="check" />}</span></Link>
  );
  const sections = [
    ["Integration", shown.filter(has(q)).map((b) => row(b, "lock", b === repo.default_branch ? "default" : "integration", loaded && info.find((i) => i.name === b)))],
    ["Branches", loaded ? info.filter((i) => i.kind === "branch" && !shown.includes(i.name) && has(q)(i.name)).map((i) => row(i.name, "branch", "", i)) : []],
    ["Tags", loaded ? info.filter((i) => i.kind === "tag" && has(q)(i.name)).map((i) => row(i.name, "tag", "", null)) : []],
  ].filter(([, rows]) => rows.length);
  const section = ([label, rows]) => <div key={label} className="bm-s" role="group" aria-label={label}><p className="lbl">{label}</p>{rows}</div>;
  // Arrow keys walk the rows (from the search field too); Enter follows the focused row's link; Escape hands focus back to the trigger.
  const onKeyDown = (e) => {
    if (e.key === "Escape") { e.preventDefault(); e.currentTarget.hidePopover(); trigger.current?.focus(); return; }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const rows = [...e.currentTarget.querySelectorAll(".bm-r")];
    const i = rows.indexOf(document.activeElement);
    rows[e.key === "ArrowDown" ? Math.min(i + 1, rows.length - 1) : Math.max(i - 1, 0)]?.focus();
  };
  return (
    <div {...props} className="menu bm" onKeyDown={onKeyDown} onToggle={(e) => { props.onToggle(e); if (e.newState === "open") load(); }}>
      <div className="bm-h"><b>Target branch</b><span>Every page in {repo.name} follows it</span></div>
      <input className="input" aria-label="Find a branch" placeholder="Find a branch or change" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="menu-scroll" role="menu" aria-label="Branches">
      {info instanceof Error && <p className="lbl" role="alert">Couldn't load branches <button type="button" onClick={(e) => { e.stopPropagation(); load(); }}>Retry</button></p>}
      {sections.map(section)}
      {info === null && <p className="lbl" role="status">Loading branches and tags…</p>}
      {code && <Suspense key={pathname}><Await resolve={code} errorElement={<></>}>{(p) => <Await resolve={p.wide ?? p} errorElement={<></>}>{(w) => {
        const rows = w.changes.filter((c) => c.state === "draft" && has(q)(`${c.id} ${c.key ?? ""} ${c.title ?? ""}`)).map((c) => (
          <Link key={c.id} to={at(c.id)} className={c.id === target ? "bm-r ws on" : "bm-r ws"} role="menuitemradio" aria-checked={c.id === target}>
            <Ic name="merge" /><span className="bm-n"><ChangeId id={c.id} label={c.key} /><small>{c.title}</small></span><span className="chkw">{c.id === target && <Ic name="check" />}</span></Link>));
        return rows.length > 0 && section(["Change workspaces", rows]);
      }}</Await>}</Await></Suspense>}
      {/* Hidden by CSS while a workspace section (which arrives on its own) is listed. */}
      {sections.length === 0 && <p className="bm-none">No branches match</p>}
      </div>
      <div className="bm-f">
        <button type="button" onClick={onAll}><Ic name="branch" />All branches<span className="kbd">B</span></button>
        <button type="button" onClick={onAll}><Ic name="plus" />New branch</button>
      </div>
    </div>
  );
}

// Dashboard deep links: Cloudflare resolves ":account" to the viewer's account.
const dash = (path) => `https://dash.cloudflare.com/?to=/:account/${path}`;
const CINDER = "workers/services/view/cinder/production";
const ZERO_TRUST = "one/access/apps";
// The Cloudflare resource behind each page (ARCHITECTURE-CLOUDFLARE.md §2), keyed by repo feature or global path; Environments links per environment.
const BACKED = {
  code: (r) => ["Artifacts repo", `workers/artifacts/cinder/${encodeURIComponent(r.name)}`],
  changes: () => ["Durable Objects", "workers/durable-objects"],
  flows: () => ["Workflow", "workers/workflows/cinder-pipeline"],
  insights: () => ["AI Gateway logs", "ai/ai-gateway/cinder/logs"],
  "/automation/judges": () => ["Workers AI", "ai/workers-ai"],
  "/automation/workers": () => ["Containers", "workers/containers"],
  "/settings/access": () => ["Zero Trust app", ZERO_TRUST],
  "/settings/keystore": () => ["Secrets Store", "secrets-store"],
};

// The platform's items: [icon, label, has submenu, pill, dashboard path], each opening cinder's own resource.
const STUBS = [
  [null, [[<PiHouse />, "Account home", 0, null, "home"], [<PiPulse />, "Observability", 1, "New", `${CINDER}/observability`]]],
  ["Build", [[<PiBracketsAngle />, "Compute", 1, null, CINDER], [<PiSparkle />, "AI", 1, null, "ai/ai-gateway/cinder"],
    [<PiDatabase />, "Storage & databases", 1, null, "workers/d1"]]],
  ["Protect & connect", [[<PiShieldCheck />, "Zero Trust", 0, null, ZERO_TRUST]]],
];
const Stub = ({ icon, label, more, pill, path }) => (
  <a className="stub" href={dash(path)} target="_blank" rel="noreferrer">{icon}<span>{label}</span>{pill && <span className="pill">{pill}</span>}{more ? <PiCaretRight /> : null}</a>
);

// Before the root loader answers (a first load), the shell draws with no repos and a pending Needs you count.
const LOADING = { repos: [], needs: new Promise(() => {}), me: new Promise(() => {}) };
// Access gives cinder only an email, so the name is its local part; the OWNER_TOKEN has no email.
const nameOf = (me) => me.email?.split("@")[0] ?? "Owner token";
const hide = (e) => e.currentTarget.closest("[popover]").hidePopover();

// The sidebar account popover: the organization's accounts, then the one outside it. A switch marks the pick at once
// and re-runs the loaders; if it fails, the previous account comes back with a toast.
export function AccountPop({ id }) {
  const [list, setList] = useState(null);
  const [picked, setPicked] = useState(null);
  const [toast, setToast] = useState(null);
  const { revalidate } = useRevalidator();
  useEffect(() => { myAccounts().then(setList, setList); }, []);
  const accounts = list && !(list instanceof Error) ? [...list.accounts, ...(list.personal ? [list.personal] : [])] : [];
  const cur = picked ?? accounts.find((a) => a.current)?.id;
  const pick = (a) => {
    setPicked(a.id);
    setToast(null);
    switchAccount(a.id).then(revalidate, () => { setPicked(cur ?? null); setToast(`Couldn't switch to ${a.name}`); });
  };
  const row = (a) => <button type="button" key={a.id} onClick={() => pick(a)}>
    <span className="rp-av">{a.name[0].toUpperCase()}</span>
    <span>{a.name}<small>Git {a.git_role[0].toUpperCase() + a.git_role.slice(1)}{a.implicit && " · via organization"} · {a.repos} repos</small></span>
    {a.id === cur && <PiCheck aria-label="current account" />}
  </button>;
  return <>
    <button type="button" className="acct" popoverTarget={`${id}acct-menu`} style={{ anchorName: `--${id}acct-menu` }}>
      <span className="acct-name">{accounts.find((a) => a.id === cur)?.name ?? "Account"}</span><PiCaretUpDown />
    </button>
    <div popover="auto" id={`${id}acct-menu`} className="menu acct-pop" style={{ positionAnchor: `--${id}acct-menu` }}>
      {list instanceof Error ? <p className="lbl" role="alert">Couldn&apos;t load your accounts</p> : list && <>
        {list.organization && <p className="lbl">{list.organization.name} · Organization</p>}
        {list.accounts.map(row)}
        {list.personal && <><p className="lbl">Outside an organization</p>{row(list.personal)}</>}
      </>}
      <hr />
      <Link to="/settings/access" onClick={hide}><PiUsers />Members</Link>
      <Link to="/settings/access" onClick={hide}><PiGearSix />Account settings</Link>
    </div>
    {toast && <p className="toast" role="status">{toast}</p>}
  </>;
}

// The repo list loads after first paint: until it answers, or if it fails, the shell draws with no repos around the page.
// In the browser the page stays in one tree while the list loads: a Suspense fallback is a second tree, so the page would
// remount (dropping an open dialog) when the list lands. A static render runs no effects, so it waits in a boundary instead.
const unsubscribed = () => () => {};
export function Shell({ children }) {
  const data = useLoaderData() ?? LOADING;
  const server = useSyncExternalStore(unsubscribed, () => false, () => true);
  const [list, setList] = useState({ repos: [] });
  useEffect(() => {
    let live = true;
    Promise.resolve(data.repos).then((repos) => live && setList({ repos }), () => live && setList({ repos: [], failed: true }));
    return () => { live = false; };
  }, [data.repos]);
  const body = (repos) => <ShellBody {...data} repos={repos}>{children}</ShellBody>;
  if (server) return <Suspense fallback={body([])}><Await resolve={data.repos} errorElement={<ShellFailed body={body([])} />}>{body}</Await></Suspense>;
  return list.failed ? <ShellFailed body={body([])} /> : body(list.repos);
}

// A 401 on the repo list leaves nothing to show but signing in again.
const ShellFailed = ({ body }) => (sessionExpired() ? <main><Frame><State kind="error" /></Frame></main> : body);

function ShellBody({ repos, needs, me = LOADING.me, children }) {
  const repo = useRouteLoaderData("repo");
  const { pathname, state } = useLocation();
  const [search] = useSearchParams();
  const { ref, "*": path } = useParams();
  const code = useMatches().at(-1).loaderData?.page;
  const [all, setAll] = useState(false);
  const drawer = useRef(null);
  const branchBtn = useRef(null);
  // Hovering or focusing a sidebar link loads its page's chunk ahead of the click; the router reuses the cached import.
  const routes = useContext(UNSAFE_DataRouterContext)?.router.routes ?? [];
  const prefetch = (e) => {
    const href = e.target.closest("a[href]")?.getAttribute("href");
    // A failed prefetch is dropped: the click loads the chunk again and the router reports a failure there.
    if (href) for (const { route } of matchRoutes(routes, href) ?? []) route.lazy?.().catch(() => {});
  };
  const { revalidate } = useRevalidator();
  // An item resolved in another tab reloads the Needs you count here.
  useEffect(() => {
    const channel = new BroadcastChannel(NEEDS_CHANNEL);
    channel.onmessage = () => { invalidate(); revalidate(); };
    return () => channel.close();
  }, [revalidate]);
  useEffect(() => { if (repo) localStorage.setItem(LAST_REPO, repo.name); }, [repo]);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "b" || e.ctrlKey || e.metaKey || e.altKey || e.target.closest?.("input, textarea, select, [contenteditable]") || document.querySelector("dialog[open]")) return;
      const el = document.getElementById("branch-menu");
      if (!el) return;
      e.preventDefault();
      el.showPopover();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // Written during render, so this render's repo links already carry the URL's target; the write is idempotent.
  if (repo && search.get("target")) remember(repo.name, search.get("target"));
  const target = repo && (ref ?? search.get("target") ?? repo.default_branch);
  // This repo's links follow the URL's target; on Code the ref can be a change workspace, so they follow the last pick.
  const own = repo && !ref ? target : undefined;
  const at = (b) => (ref ? codePath(repo.name, b, path) : `${pathname}?target=${encodeURIComponent(b)}`);
  // A repo's wiki folder sits outside the repo's routes, so its repo comes from the URL.
  const wikiOf = repos.find((r) => pathname === wikiPath(r) || pathname.startsWith(`${wikiPath(r)}/`));
  const cur = repo ?? wikiOf ?? lastRepo(repos) ?? repos[0];
  const page = (repo && pathname.slice(repoPath(repo.name).length + 1).split("/")[0]) || "code";
  const to = (p) => (p[0] === "/" ? p : cur ? scopedPath(cur, p) : `/${p}`);
  // A repo feature page marks its sub-item under Code ▸ <repo>, ahead of any Git item at the same path.
  const feature = repo && FEATURES.find(([t]) => t === (FEAT_ALIAS[page] ?? page))?.[0];
  const inWiki = pathname === "/wiki" || pathname.startsWith("/wiki/");
  // The active item is the longest one the URL sits under; other repo pages sit under Code ▸ Repositories.
  let active;
  let best = 0;
  for (const [, , list] of feature ? [] : GIT) {
    for (const [p] of list) {
      const t = to(p).split("?")[0];
      if ((pathname === t || pathname.startsWith(`${t}/`)) && t.length > best) [active, best] = [p, t.length];
    }
  }
  if (!active && repo && !feature) active = "/";
  const where = GIT.find(([, , list]) => list.some(([p]) => p === active));
  const backed = (repo ? BACKED[feature ?? active]?.(repo) : BACKED[active]?.());
  const crumb = where ? [where[0], where[2].find(([p]) => p === active)[1]] : [pathname === "/needs" ? "Needs you" : null];
  // One sub-section open at a time: the route's own, until a header click picks another (or none).
  const home = feature ? "Code" : where?.[0] ?? null;
  const [openSection, setOpenSection] = useState(home);
  useEffect(() => setOpenSection(home), [home, pathname]);
  // id prefix: the drawer renders a second copy of the sidebar, and ids must stay unique.
  const section = (id) => ([name, icon, list]) => {
    const open = openSection === name;
    return (
      <div className="sec" key={name}>
        <button className="sec-head" aria-expanded={open} aria-controls={`${id}${name}`} onClick={() => setOpenSection(open ? null : name)}>
          {icon}<span>{name}</span><PiCaretRight />
        </button>
        <div className="sec-body" id={`${id}${name}`} inert={!open}><div>
          {name !== "Code" ? list.map(([p, label]) => <Link key={p} to={to(p)} aria-current={p === active ? "page" : undefined}>{label}</Link>) : <>
            {cur && <>
              <div className="ctx">
                <button id={`${id}repo-row`} className="ctx-r" popoverTarget={`${id}repo-menu`} style={{ anchorName: `--${id}repo-menu` }} title="Switch repository">
                  <span className="rp-av">{cur.name[0].toUpperCase()}</span><b title={cur.name}>{cur.name}</b><PiCaretUpDown />
                </button>
                <button className="ctx-b" popoverTarget="branch-menu" disabled={!repo} title="Target branch">
                  <PiGitBranch /><Mid text={repo ? target : targetOf(cur)} /><PiCaretDown />
                </button>
              </div>
              <div {...menuProps(`${id}repo-menu`)}>
                {repos.map((r) => <Link key={r.name} to={scopedPath(r, page, r.name === repo?.name ? own : undefined)}>
                  <span className="rp-av">{r.name[0].toUpperCase()}</span><span>{r.name}</span>{r.name === cur.name && <PiCheck aria-label="current repository" />}</Link>)}
              </div>
              {FEATURES.map(([t, label]) => <Link key={t} to={scopedPath(cur, t, own)} aria-current={t === feature ? "page" : undefined}>{label}</Link>)}
              <span className="sb-subsep" aria-hidden="true" />
            </>}
            <Link to="/" aria-current={active === "/" ? "page" : undefined}>All repositories<span className="count">{repos.length}</span></Link>
          </>}
          <span className="sec-line" aria-hidden="true" />
        </div></div>
      </div>
    );
  };
  const side = (id) => (
    <aside className="side" onMouseOver={prefetch} onFocus={prefetch}>
      <div className="sb-header"><Mark /><AccountPop id={id} /></div>
      <div className="sb-viewport">
        <div className="sb-menu">
          {STUBS.map(([group, items]) => [
            group && <div className="slabel" key={group}>{group}</div>,
            items.map(([icon, label, more, pill, path]) => <Stub key={label} icon={icon} label={label} more={more} pill={pill} path={path} />),
          ])}
          <div className="slabel">Git<span className="pill">Beta</span></div>
          <nav className="nav" aria-label="Git">
            {section(id)(GIT[0])}
            {/* One wiki per organization, opened at its folder list. */}
            <Link to="/wiki" aria-current={inWiki ? "page" : undefined}><PiBookOpen /><span>Wiki</span></Link>
            {section(id)(GIT[1])}
            <Link to="/needs" aria-current={pathname === "/needs" ? "page" : undefined}><PiWarningCircle /><span>Needs you</span>
              <Suspense><Await resolve={needs} errorElement={<span className="count" title="Couldn't load Needs you">!</span>}>
                {(n) => n.length > 0 && <span className="count">{n.length}</span>}
              </Await></Suspense>
            </Link>
            {section(id)(GIT[2])}
          </nav>
        </div>
      </div>
      <div className="sb-footer" aria-disabled="true" title="Collapse sidebar"><PiSidebarSimple /></div>
    </aside>
  );
  return (
    <IconContext.Provider value={ICONS}><div className="app">
      <div className="app-col">
      <header className="top">
        <button className="iconbtn menu-btn" aria-label="Open navigation" onClick={() => drawer.current.showModal()}><PiList /></button>
        {repo ? <nav className="crumb" aria-label="Breadcrumb">
          {/* Repo-scoped Automation pages (Flows, Environments) lead with their section. */}
          {where && active !== "/" && <><span>{crumb[0]}</span><PiCaretRight /><span>{crumb[1]}</span><PiCaretRight /></>}
          <PiBookBookmark /><span className="cur">{repo.name}</span><PiCaretRight />
          <button ref={branchBtn} className="switch" popoverTarget="branch-menu" style={{ anchorName: "--branch-menu" }} title="Target branch">
            <PiGitBranch /><span className="k hide-s">target</span>{ref && code
              // A missing ref opens the default branch, and the trigger names the branch shown.
              ? <Suspense key={pathname} fallback={<Mid text={target} />}><Await resolve={code} errorElement={<Mid text={target} />}>{(p) => <Mid text={p.missing ? p.ref : target} />}</Await></Suspense> : <Mid text={target} />}<PiCaretDown />
          </button>
        </nav> : inWiki && cur ? <nav className="crumb" aria-label="Breadcrumb">
          <PiBookOpen /><span className="cur">Wiki</span><PiCaretRight />
          <button className="switch" popoverTarget="wiki-repo-menu" style={{ anchorName: "--wiki-repo-menu" }} title="Switch repository">
            <PiBookBookmark /><span>{cur.name}</span><PiCaretDown />
          </button>
          <div {...menuProps("wiki-repo-menu")}>{repos.map((r) => <Link key={r.name} to={wikiPath(r)}>{r.name}</Link>)}</div>
        </nav> : <nav className="crumb" aria-label="Breadcrumb">
          {crumb[0] && <span>{crumb[0]}</span>}{crumb[1] && <><PiCaretRight /><span className="cur">{crumb[1]}</span></>}
        </nav>}
        {repo && <BranchMenu key={repo.name} repo={repo} target={target} at={at} code={ref && code} onAll={() => setAll(true)} trigger={branchBtn} />}
        {all && <Branches repo={repo} target={target} to={at} onTarget={(b) => remember(repo.name, b)} onClose={() => setAll(false)} />}
        <div className="top-right">
          {backed && <a className="switch hide-s" href={dash(backed[1])} target="_blank" rel="noreferrer">Backed by {backed[0]}</a>}
          <button className="switch hide-s" popoverTarget="help-menu" style={{ anchorName: "--help-menu" }}><PiQuestion />Support</button>
          <div popover="auto" id="help-menu" className="menu" style={{ positionAnchor: "--help-menu" }}>
            <p className="lbl">Keyboard shortcuts</p><p className="lbl">Branch menu <span className="kbd">B</span></p>
          </div>
          <Link className="iconbtn bell" to="/needs" aria-label="Notifications"><PiBell />
            <Suspense><Await resolve={needs} errorElement={<></>}>{(n) => n.length > 0 && <span className="bell-dot" />}</Await></Suspense>
          </Link>
          <button className="iconbtn" aria-label="Toggle light/dark" onClick={toggleTheme}><PiCircleHalf /></button>
          <button className="avatar" aria-label="Account" popoverTarget="user-menu" style={{ anchorName: "--user-menu" }}>
            <Suspense><Await resolve={me} errorElement={<></>}>{(m) => nameOf(m).slice(0, 1).toUpperCase()}</Await></Suspense>
          </button>
          <div popover="auto" id="user-menu" className="menu" style={{ positionAnchor: "--user-menu" }}>
            <Suspense><Await resolve={me} errorElement={<p className="lbl" role="alert">Couldn't load your account</p>}>
              {(m) => <p className="lbl"><strong>{nameOf(m)}</strong>{m.email && <><br />{m.email}</>}</p>}
            </Await></Suspense>
            <Link to="/me/models" onClick={hide}><Ic name="key" />My model access<span className="tag">new</span></Link>
            <button type="button" onClick={toggleTheme}><PiCircleHalf />Toggle theme</button>
            <Link to="/settings/access" onClick={hide}><PiShieldCheck />Access &amp; people</Link>
            <a href="/cdn-cgi/access/logout"><PiSignOut />Sign out</a>
          </div>
        </div>
      </header>
      <main className="main">{children ?? <Outlet />}</main>
      {/* A page that navigates here after an action confirms it with { state: { toast } }. */}
      {state?.toast && <p className="toast" role="status">{state.toast}</p>}
      </div>
      {side("sec-")}
      <dialog className="drawer" ref={drawer} aria-label="Navigation"
        onClick={(e) => { if (e.target === e.currentTarget || e.target.closest("a")) e.currentTarget.close(); }}>
        {side("drawer-sec-")}
      </dialog>
    </div></IconContext.Provider>
  );
}
