// The Code page.
import { Fragment, Suspense, lazy, startTransition, use, useCallback, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Await, Form, Link, redirect, useActionData, useAsyncError, useAsyncValue, useBeforeUnload, useBlocker, useLoaderData, useLocation, useParams, useRevalidator, useRouteLoaderData, useSearchParams, useSubmit } from "react-router";
import { README, codeFor, commitFiles, commitsFor, editFile, forgetTrees, hasRef, listen, proposeFiles, refNames, refreshCode, searchCode, takeOver } from "./client.js";
import { PiDownloadSimple, PiFile, PiFolderSimple, PiGitBranch, PiLockSimple, PiPlus, PiTerminalWindow, PiTrash } from "react-icons/pi";
import { useCollisions } from "./api/collisions.js";
import { latestTag } from "./api/tags.js";
import { ago } from "./changes.jsx";
import { WorkspaceStrip } from "./workspace-strip.jsx";
import { warnings } from "./collisions.jsx";
import { Ic } from "./icons.jsx";
import { LeasePrompt } from "./lease-prompt.jsx";
import { leaseHits } from "./lib/lease-hits.js";
import "./styles/clone-pop.css";
import "./styles/collisions.css";
import "./styles/code.css";
import "./styles/quick-setup.css";
import { codePath, parseCodePath } from "./lib/code-path.js";
import { Markdown } from "./lib/markdown.jsx";
import { viewStyle } from "./lib/code-metrics.js";
import { langOf, tokenize } from "./lib/tokenize.js";
import { Bone, BoneText, LoadingRegion, useShape } from "./skeleton.jsx";
import { ChangeId, Diff, LiveLabel, Panel, Popover, Prob, Region, Seg, State, Tag, Frame } from "./ui.jsx";
import { ChangeWho } from "./who.jsx";

const TONE = { conflict: "bad", failed: "bad", waiting: "warn", resolving: "warn", merged: "ok" };
const StateTag = ({ state }) => <Tag tone={TONE[state] ?? "info"}>{state.replace("_", " ")}</Tag>;
// Fixture change ids are c-<n>; the worker's are UUIDs.
const isWs = (ref) => /^(c-\d+|[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12})$/.test(ref);
const sortKey = (p) => p.split("/").map((x, i, a) => (i < a.length - 1 ? "0" : "1") + x).join("/"); // directories first

// toks: the line as Shiki colours it (lib/highlight.js), once its grammar loads; until then the light highlighter.
const Src = ({ line, lang, toks }) => (
  <span className="src">{(toks ?? tokenize(line, lang)).map(([c, t], k) => (c ? <span key={k} className={c}>{t}</span> : t))}{!line && " "}</span>
);

// Blocks a navigation away from unsaved work unless the person confirms leaving; lost() names that work ("edits", "staged files") or is falsy.
export const leaveGuard = (lost) => () => { const what = lost(); return !!what && !confirm(`Leave without proposing? Your ${what} will be lost.`); };

// A transparent textarea over the highlighted text with the same font metrics, so colours follow every keystroke.
// Tab indents and Enter keeps the line's indent; Escape then Tab moves focus on, so the page stays keyboard reachable.
export function Editor({ path, text, setText }) {
  const esc = useRef(false);
  const keys = (e) => {
    const t = e.target;
    const indent = e.key === "Tab" && !e.shiftKey && !esc.current ? "  "
      : e.key === "Enter" ? `\n${t.value.slice(0, t.selectionStart).split("\n").at(-1).match(/^[ \t]*/)[0]}` : null;
    esc.current = e.key === "Escape";
    if (indent === null) return;
    e.preventDefault();
    t.setRangeText(indent, t.selectionStart, t.selectionEnd, "end");
    setText(t.value);
  };
  return (
    <div className="ed">
      <pre aria-hidden="true">{text.split("\n").map((l, i) => <Fragment key={i}><Src line={l} lang={langOf(path)} />{"\n"}</Fragment>)}</pre>
      <textarea name="content" aria-label={`Edit ${path}`} spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={keys} />
    </div>
  );
}

// Monaco (~2MB) loads on first use so the tree and rail paint first, or as soon as Edit is hovered or focused;
// the hidden input carries the edited text into the form.
const loadMonaco = () => import("./monaco.jsx");
const Monaco = lazy(loadMonaco);
export function CodeEditor({ path, text, setText, leases }) {
  return (
    <div className="mon">
      <input type="hidden" name="content" value={text} />
      <Suspense fallback={<div className="codev"><div className="codev-in" style={viewStyle}>{text.split("\n").map((l, i) =>
        <div key={i} className="cl"><span className="ln">{i + 1}</span><Src line={l} lang={langOf(path)} /></div>)}</div></div>}>
        <Monaco path={path} value={text} onChange={(v) => setText(v ?? "")} leases={leases} options={{ ariaLabel: `Edit ${path}` }} />
      </Suspense>
    </div>
  );
}

// A new file committed straight onto the branch at head.
// On an empty repo head is null: the commit creates the branch. Quick setup opens it prefilled through the link's state.
function NewFile({ head, failed, put }) {
  const { state } = useLocation();
  const [name, setName] = useState(state?.path ?? "");
  const [text, setText] = useState(state?.text ?? "");
  return (
    <Form method="post" className="pad">
      <input type="hidden" name="base_sha" value={head ?? ""} />
      <input className="input w mono" name="path" aria-label="New file path" placeholder="path/to/file" required value={name} onChange={(e) => setName(e.target.value)} />
      <CodeEditor path={name} text={text} setText={setText} />
      <input className="input w" name="intent" aria-label="Commit message" placeholder="Short message: what does this file do?" required />
      {failed && <p className="meta" role="alert">{failed}</p>}
      <button type="submit" name="op" value="commit" className="btn btn-primary">Commit new file</button>
      <button type="button" className="btn btn-secondary" disabled={!name} onClick={() => put({ path: name, content: text })}>Stage</button>
      {/* lazy: text files only, the commit API takes string content; send base64 once it takes binary. */}
      <label className="btn btn-secondary">Upload<input type="file" multiple hidden aria-label="Upload files"
        onChange={async (e) => { for (const file of e.target.files) put({ path: name.replace(/[^/]*$/, "") + file.name, content: await file.text() }); }} /></label>
    </Form>
  );
}

// Clone, credentials, branch push and proposing a change. The browser never holds a git token: the CLI fetches one.
export function ClonePop({ repo, remote, target }) {
  const [toast, setToast] = useState(null);
  const url = useRef(null);
  // A denied or missing clipboard selects the URL instead, to copy by hand.
  const copy = async () => {
    try { await navigator.clipboard.writeText(remote); setToast("Copied the clone URL"); } catch { setToast(null); getSelection()?.selectAllChildren(url.current); }
  };
  const p = repo.branch_policy ?? { integration: [repo.default_branch], release: [] };
  return (
    <div popover="auto" id="clone-pop" className="menu pop-cmd clonep" style={{ positionAnchor: "--clone" }} onToggle={(e) => e.newState === "closed" && setToast(null)}>
      <div className="lbl">Clone over HTTPS</div>
      {remote ? <div className="cl-url"><code ref={url}>{remote}</code><button type="button" className="iconbtn" aria-label="Copy clone URL" onClick={copy}><Ic name="copy" /></button></div>
        : <p className="meta">Nothing to clone yet.</p>}
      <p className="meta">Git asks for a password: type any username, and the token this prints as the password.</p>
      <pre className="code">cinder repo credentials {repo.name}</pre>
      <div className="lbl">Push a branch</div><pre className="code">{"git switch -c my-branch\ngit push origin my-branch"}</pre>
      <p className="meta">Direct pushes to {[...p.integration, ...p.release].join(", ")} roll back: they change only through a change and the verifier.</p>
      <div className="lbl">Propose straight from git</div><pre className="code">git push origin HEAD:refs/for/{target}</pre>
      {toast && <p className="toast" role="status">{toast}</p>}
    </div>
  );
}

// The latest tag is read once the browser is idle, so the toolbar never waits on it; no tags, or a failed read, leaves the chip off.
function ReleasesLink({ repo, to }) {
  const [tag, setTag] = useState(null);
  useEffect(() => {
    // Safari has no requestIdleCallback.
    const [later, cancel] = globalThis.requestIdleCallback ? [requestIdleCallback, cancelIdleCallback] : [setTimeout, clearTimeout];
    const id = later(() => latestTag(repo).then(setTag, () => setTag(null)));
    return () => cancel(id);
  }, [repo]);
  return <Link className="btn btn-secondary" to={to} title="Releases and tags"><Ic name="tag" />Releases{tag && <span className="bcount mono">{tag.name}</span>}</Link>;
}

// pending: the page of the file at opening is loading; this one stays drawn, dimmed and aria-busy, until it lands.
// The tree's selection and the heading move to opening at once.
function CodeView({ repo, page, at: ref, path, staged, setStaged, pending, opening = path }) {
  const { files, leases, changes, history, risk_judge: riskJudge, head, hits } = page;
  const [search, setSearch] = useSearchParams();
  const col = useCollisions(repo.name, isWs(ref) ? undefined : ref);
  const [filter, setFilter] = useState("");
  // Taking over persists on the change (driver), so a reload keeps the workspace editable.
  const [driving, setDriving] = useState(() => !!changes.find((c) => c.id === ref)?.driver);
  const tree = useRef(null);
  useEffect(() => { if (path && matchMedia("(max-width: 720px)").matches) tree.current.open = false; }, [path]);

  const root = `/${encodeURIComponent(repo.name)}`;
  const base = codePath(repo.name, ref);
  const byId = Object.fromEntries(changes.map((c) => [c.id, c]));
  const link = (id) => <Link to={`${root}/changes/${encodeURIComponent(byId[id]?.key ?? id)}`}><ChangeId id={id} label={byId[id]?.key} /></Link>;
  const ws = isWs(ref) ? byId[ref] : null;
  const mode = search.get("v") ?? "code";
  const md = /\.md$/i.test(path);
  // Live history and blame arrive after the content as page.late: Code never waits on them, Blame and History do.
  const late = page.late && (mode === "history" || mode === "blame") ? use(page.late) : null;
  const found = files.find((x) => (path ? x.path === path : README.test(x.path)));
  const f = found && late ? { ...found, ...late } : found;
  const src = f ? f.ws[ref] ?? f.text : "";
  const lines = src.split("\n");
  // Shiki colours the lines after paint with the grammar Edit uses; a failed load keeps the light highlighting.
  const [colored, setColored] = useState(null);
  useEffect(() => {
    if (!path) return;
    let on = true;
    import("./lib/highlight.js").then((m) => m.tokens(path, src)).then((toks) => on && setColored({ path, src, toks }), (e) => console.warn("highlighting failed", e));
    return () => { on = false; };
  }, [path, src]);
  const toks = colored?.src === src && colored.path === path ? colored.toks : [];
  useShape(`code/${repo.name}/files`, 12, files.length);
  useShape(`code/${repo.name}/lines`, 24, lines.length);
  // Active in repo and Live on this file: one lease per change, its symbol lease before a file-level one (symbol is the file path).
  const perChange = (ls) => ls.filter((l, i) => ls.findIndex((x) => x.holder === l.holder) === i)
    .map((l) => ls.find((x) => x.holder === l.holder && x.symbol !== x.file) ?? l);
  const active = perChange(leases);
  useShape(`code/${repo.name}/active`, 3, Math.min(active.length, ACTIVE));
  // A lease's colour follows its holder: an agent (with a version) or a person.
  const kindOf = (l) => (byId[l.holder]?.ver ? "agent" : "human");
  // A lease names its symbol bare or scoped (Order.Place, the index names it Place), or the whole file (symbol is the path).
  const here = leases.filter((l) => l.file === path);
  const leaseOf = (sym) => here.find((l) => l.symbol === sym || l.symbol.endsWith(`.${sym}`));
  // A file lease is one more symbol spanning the file, so it bands every line and any edit, rename or delete asks.
  const syms = [...(here.some((l) => l.symbol === l.file) ? [{ name: path, from: 1, to: lines.length }] : []), ...(f?.syms ?? [])];
  const strip = (name, l) => <div className="lrow"><PiLockSimple /><code>{name}</code>
    <span>leased by <b>{link(l.holder)}</b> · <ChangeWho change={byId[l.holder]} /> · {l.mode}{l.waiting.length > 0 && ` · ${l.waiting.length} waiting`}</span></div>;
  // Live files carry the sha they were read at (null when too large to load); fixtures carry none, so they can't be edited.
  const result = useActionData();
  const failed = result?.error;
  if (result?.driving && !driving) setDriving(true); // stays set when a later failed save replaces the action data
  // A workspace is editable once the person drives its change.
  const editable = !!f?.sha && (!isWs(ref) || driving);
  // A staged edit or rename of this file is what the editor reopens.
  const mine = staged.find((s) => (s.from ?? s.path) === path);
  const [text, setText] = useState(mine?.content ?? f?.text ?? "");
  const [to, setTo] = useState(path);
  const [msg, setMsg] = useState("");
  const [dest, setDest] = useState("propose");
  const [leasing, setLeasing] = useState(false);
  const [stgLease, setStgLease] = useState(null); // the Staged submit's message while its lease prompt is open
  const submit = useSubmit();
  // One entry per path: staging a path again replaces it, and a rename replaces the entry at its old path,
  // including an earlier rename of that path.
  const put = (entry) => setStaged((s) => [...s.filter((x) => x.path !== entry.path && x.path !== (entry.from ?? entry.path) && x.from !== (entry.from ?? entry.path)), entry]);
  const [shut, setShut] = useState(() => new Set());
  const saving = useRef(false);
  useEffect(() => { saving.current = false; }, [result, mode]); // a refused save, or a new mode, guards the edit again
  const editing = mode === "edit" && editable;
  const dirty = editing && !mine?.delete && (text !== (mine?.content ?? f.text) || to !== path);
  // Cancel returns to View; with unsaved edits it asks first, in the page, and a discard skips the leave guard.
  const [asking, setAsking] = useState(false);
  // The view stays mounted across files: a new path starts its edit state afresh.
  const [opened, setOpened] = useState(path);
  if (opened !== path) {
    setOpened(path);
    setText(mine?.content ?? f?.text ?? "");
    setTo(path);
    setMsg("");
    setDest("propose");
    setLeasing(false);
    setAsking(false);
  }
  if (asking && mode !== "edit") setAsking(false);
  const discard = () => {
    setAsking(false);
    setText(mine?.content ?? f.text);
    setTo(path);
    saving.current = true;
    setSearch({}, { preventScrollReset: true });
  };
  const cancel = () => (dirty ? setAsking(true) : discard());
  // Edit's editor stops at 560 px, which clamps the page's scroll: leaving Edit puts back where View was on this file.
  const scrolled = useRef(null);
  const keepScroll = () => { scrolled.current = { path, top: document.querySelector(".main")?.scrollTop }; };
  useLayoutEffect(() => {
    if (mode === "edit") return;
    const s = scrolled.current, main = document.querySelector(".main");
    scrolled.current = null;
    if (main && s?.path === path) main.scrollTop = s.top;
  }, [mode, path]);
  const onKey = useEffectEvent((e) => {
    if (e.key === "Escape" && !e.defaultPrevented && mode === "edit" && editable && !document.activeElement?.closest("dialog, [role=dialog], [popover]")) cancel();
  });
  useEffect(() => {
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  // Staged files live while the person moves between files on this ref; leaving the ref drops them.
  const blocker = useBlocker(({ nextLocation: next }) => leaveGuard(() => !saving.current && (dirty ? "edits" : staged.length > 0 && next.pathname !== base && !next.pathname.startsWith(`${base}/`) && "staged files"))());
  useEffect(() => { if (blocker.state === "blocked") blocker.reset(); }, [blocker]);
  useBeforeUnload(useCallback((e) => { if (dirty || staged.length) e.preventDefault(); }, [dirty, staged.length]));

  const toolbar = (
    <div className="toolbar code-bar">
      <Form role="search"><input className="input w" type="search" name="q" aria-label="Search code" placeholder="Search in code" minLength={2} defaultValue={search.get("q") ?? ""} /></Form>
      <ReleasesLink key={repo.name} repo={repo.name} to={`${root}/releases`} />
      {head && !isWs(ref) && <Link className="btn btn-secondary" to={`${base}?v=new`}><PiPlus />Add file</Link>}
      <button type="button" className="btn btn-secondary" popoverTarget="clone-pop" style={{ anchorName: "--clone" }}><PiTerminalWindow />Clone</button>
      <Link className="btn btn-primary" to={`${root}/changes/new`}><PiPlus />New change</Link>
      <ClonePop repo={repo} remote={page.remote} target={isWs(ref) ? repo.default_branch : ref} />
    </div>
  );

  if (!files.length && mode !== "new") return <QuickSetup repo={repo} remote={page.remote} base={base} />;
  if (path && !f) {
    return (<>{toolbar}
      <State title={`File ${path} not found`}>
        <p>It may have been merged and archived, or the link is wrong.</p><Link className="btn btn-secondary" to={base}>Back to files</Link>
      </State></>
    );
  }

  // An edit to a symbol another change leases asks before it opens a change (LeasePrompt). A rename or delete moves
  // every symbol of the file; a staged entry keeps the leases it touches for the Staged submit.
  const touched = (after) => leaseHits(f.text.split("\n"), after, syms, leaseOf);
  let body;
  if (hits) {
    body = (
      <ul className="list">{hits.map((h) => <li key={`${h.path}:${h.line}`}><Link className="mono" to={`${base}/${h.path}`}>{h.path}:{h.line}</Link><code>{h.text}</code></li>)}
        {!hits.length && <li className="meta">No matches.</li>}</ul>
    );
  } else if (page.commits?.files) {
    // One commit's diff, a file per Diff; lines are lineDiff's (" ", "-", "+" prefixes), null when too large.
    const c = page.commits;
    body = (<>
      <div className="pad row"><Link className="btn btn-secondary btn-sm" to="?v=commits">All commits</Link><code>{c.sha.slice(0, 7)}</code>
        <span>{c.message.split("\n")[0]}</span><span className="meta">{c.author ?? "unknown"}</span></div>
      {c.files.map((f) => {
        let o = 0, n = 0;
        const lines = (f.lines ?? []).map((l) => (l[0] === "+" ? ["a", "", ++n, "", l.slice(1)] : l[0] === "-" ? ["d", ++o, "", "", l.slice(1)] : ["c", ++o, ++n, "", l.slice(1)]));
        return <Diff key={f.path} file={f.path} adds={lines.filter((l) => l[0] === "a").length} dels={lines.filter((l) => l[0] === "d").length} lines={lines}>
          <Tag>{f.status}</Tag>{!f.lines && <span className="meta">Too large to show.</span>}</Diff>;
      })}
      {!c.files.length && <p className="meta pad">No file changes.</p>}
    </>);
  } else if (mode === "commits" && page.log) body = <Await resolve={page.log} errorElement={logFailed}>{(log) => <CommitList log={log} repo={repo.name} root={root} />}</Await>;
  else if (mode === "new" && (head || !files.length) && !isWs(ref)) body = <NewFile head={head} failed={failed} put={put} />;
  else if (!path || (md && mode === "code")) body = f && <Markdown text={src} url={(u, kind) => repoUrl(repo.name, ref, base, f.path, u, kind)} />;
  else if (mode === "edit" && editable) {
    // The bottom bar's summary: lines that differ from what the editor opened with, else a rename.
    const was = (mine?.content ?? f.text).split("\n"), now = text.split("\n");
    let changed = 0;
    for (let i = 0; i < Math.max(was.length, now.length); i++) if (was[i] !== now[i]) changed++;
    const summary = changed ? `${changed} line${changed > 1 ? "s" : ""} changed` : to !== path ? "Renamed" : "No edits yet";
    const hits = dest === "propose" && !isWs(ref) ? touched(to !== path ? [] : now) : [];
    const payload = JSON.stringify(to !== path ? [{ path, delete: true }, { path: to, content: text }] : [{ path, content: text }]);
    const go = (choice) => {
      saving.current = true;
      submit({ op: dest, base_sha: f.sha, content: text, changes: payload, intent: msg, ...(choice && { choice }) }, { method: "post" });
    };
    const integ = !isWs(ref) && (repo.branch_policy?.integration ?? [repo.default_branch]).includes(ref);
    body = (
      <Form method="post" onSubmit={(e) => { if (hits.length) { e.preventDefault(); setLeasing(true); } else saving.current = true; }}>
        <input type="hidden" name="base_sha" value={f.sha} />
        <CodeEditor path={path} text={text} setText={setText} leases={syms.flatMap((s) => {
          const l = syms.find((x) => x.from === s.from) === s && leaseOf(s.name);
          return l ? [{ from: s.from, to: s.to, cls: `${l.mode} ${kindOf(l)}`, strip: strip(s.name, l) }] : [];
        })} />
        <div className="ed-foot">
          <input type="hidden" name="changes" value={payload} />
          <div className="ed-grid">
            <div className="ed-msgw">
              <label className="field"><span>Message</span><input className="input" name="intent" aria-label="Change message" placeholder="Short message: what does this change do?" required
                value={msg} onChange={(e) => setMsg(e.target.value)} /><span className="meta">Becomes the change&apos;s intent. Judges and reviewers read it first.</span></label>
            </div>
            <fieldset className="ed-dest"><legend>Where it goes</legend>
              {[["propose", "Open a change · you drive", <>Like a pull request. Reviewers approve, the verifier merges. Agents don&apos;t push to it unless you let them.</>],
                ["agent", "Hand to an agent", "Your edit is the starting point and the message becomes the intent."],
                ["commit", isWs(ref) ? <>Commit to workspace <ChangeId id={ref} label={ws?.key} /></> : <>Commit directly to <span className="mono">{ref}</span></>,
                  isWs(ref) ? "Adds a commit to this change. The verifier re-runs on the new head." : integ ? "Unavailable: the verifier owns every merge into integration branches." : "Writes one commit straight onto this branch."]]
                .map(([v, title, sub]) => <label key={v} className="opt"><input type="radio" name="op" value={v} checked={dest === v} disabled={v === "commit" && integ} onChange={() => setDest(v)} />
                  <span><b>{title}</b><small>{sub}</small></span></label>)}
            </fieldset>
          </div>
          {perChange(leases.filter((l) => l.file === path && kindOf(l) === "agent")).map((l) => <p key={l.symbol} className="ed-lease"><PiLockSimple />
            <span><code>{l.symbol}</code> is leased by <b>{link(l.holder)}</b> · <ChangeWho change={byId[l.holder]} />. If your edit touches it, your change waits for the lease or asks its holder to hand over.</span></p>)}
          {failed && <p className="meta" role="alert">{failed}</p>}
          {leasing && hits.length > 0 && <LeasePrompt key={hits[0].holder} lease={hits[0]} holder={<>{link(hits[0].holder)} “{byId[hits[0].holder].intent}” · <ChangeWho change={byId[hits[0].holder]} /></>}
            intent={msg} onGo={go} onKeep={() => setLeasing(false)} />}
          <div className="ed-bar"><span className="meta">{summary}</span>
            {dest === "agent" && !msg.trim() && <span className="meta">Add a message: it becomes the agent&apos;s intent</span>}<div className="end">
            <button type="button" className="btn btn-secondary" onClick={cancel}>Cancel</button>
            <button type="button" className="btn btn-secondary" disabled={!to} title="Collect several files into one change" onClick={() => put({ path: to, content: text, ...(to !== path && { from: path }), hits: touched(to !== path ? [] : now) })}>Stage</button>
            <button type="submit" className="btn btn-primary" disabled={!dirty || !msg.trim()} title={!dirty ? "Make an edit first" : !msg.trim() ? "Add a message first" : undefined}>
              {dest === "agent" ? "Hand to agent" : dest === "commit" ? (isWs(ref) ? "Commit to workspace" : `Commit to ${ref}`) : "Open change"}</button>
          </div></div>
        </div>
      </Form>
    );
  } else if (late?.error) body = <p className="meta pad" role="alert">Couldn't load {mode}: {late.error}</p>;
  else if (mode === "history") {
    // Live files carry their commits; fixtures derive history from the changes in the blame.
    const hist = f.history ?? [...new Set(f.blame.map((b) => b.change))].reverse().map((id) => history.find((h) => h.change === id)).filter(Boolean);
    body = (
      <ul className="list">{hist.map((h) => (
        <li key={h.sha}>
          <div className="row"><code>{h.sha}</code>{h.change && link(h.change)}<span className="meta"><ChangeWho change={h} /></span><span className="meta end">{h.age ?? (h.date && ago(h.date))}</span></div>
          <span>{h.intent}</span>
          {h.risk != null ? <div className="row meta">verified · risk was <Prob p={h.risk} judge={riskJudge} /></div> : h.risk === null && <span className="meta">imported history</span>}
        </li>
      ))}</ul>
    );
  } else {
    // Live blame is null until the runner's blame job reports.
    const blamed = mode === "blame" && !!f.blame;
    // A hunk's age is its commit's in the file's history (live, by sha) or its change's (fixtures).
    const age = (b) => { const h = (f.history ?? history).find((x) => (b.commit ? b.commit.startsWith(x.sha) : x.change === b.change)); return h ? h.age ?? (h.date && ago(h.date)) : null; };
    body = (<>
      {mode === "blame" && !f.blame && <p className="meta pad" role="status">Blame not computed yet. It is queued and fills in when the blame job finishes.</p>}
      <div className={blamed ? "codev blame" : "codev"} role="region" aria-label={path} tabIndex={0}><div className="codev-in" style={viewStyle}>{lines.map((ln, i) => {
        const n = i + 1;
        const top = syms.find((s) => s.from === n);
        const hl = top && leaseOf(top.name);
        const inS = syms.find((s) => n >= s.from && n <= s.to);
        const l = inS && leaseOf(inS.name);
        const b = blamed && f.blame.find((x) => n >= x.from && n <= x.to);
        return (
          <Fragment key={n}>
            {hl && strip(top.name, hl)}
            <div className={l ? `cl leased ${l.mode} ${kindOf(l)}` : "cl"}>
              <span className="ln">{n}</span>{b !== false && <span className="bl">{b?.from === n && <>{b.change === b.commit ? <code>{b.commit.slice(0, 7)}</code> : link(b.change)} <ChangeWho change={b} />{age(b) && <> <span className="meta">{age(b)}</span></>}</>}</span>}
              <Src line={ln} lang={langOf(path)} toks={toks[i]} />
            </div>
          </Fragment>
        );
      })}</div></div>
    </>);
  }
  // Live on this file is a chip in the file header: Free to edit, or the lease count with a dot per holder. It opens the
  // list; collision warnings stay out of the popover, in a banner over the code.
  const live = perChange(leases.filter((l) => l.file === path));
  const warns = path ? warnings(col.data, leases, path) : [];
  const leaseChip = (
    <Popover className={live.length ? `lchip held${warns.length ? " warn" : ""}` : "lchip free"}
      title={`Live on this file: ${live.length ? `${live.length} lease${live.length > 1 ? "s" : ""}` : "no leases"}`}
      label={live.length ? <>{live.map((l) => <span key={l.holder} className={`dot ${kindOf(l)}`} />)}{live.length} lease{live.length > 1 && "s"}</> : <><span className="dot ok" />Free to edit</>}>
      <div className="lpop">
        <div className="lpop-h"><b>Live on this file</b><LiveLabel /></div>
        <Region><ul className="list">
          {live.map((l) => (
            <li key={l.symbol}>
              <div className="row">{link(l.holder)}<StateTag state={byId[l.holder].state} /></div><span>{byId[l.holder].intent}</span>
              <span className="meta"><code>{l.symbol}</code> · <ChangeWho change={byId[l.holder]} /> · {l.mode}
                {col.data?.editing.some((e) => e.change_id === l.holder && e.symbol.split("#")[0] === path) && " · editing now"}</span>
            </li>
          ))}
          {!live.length && <li className="meta">No one holds a lease here. Edit freely; your change takes the leases it needs.</li>}
        </ul></Region>
      </div>
    </Popover>
  );
  const main = (
    <section className={editing ? "panel fcard editing" : "panel fcard"} aria-busy={pending || undefined}>
      <div className="panel-head"><PiFile />{editing ? <>
        <input className="input mono ed-path" aria-label="Rename or move to" list="code-dirs" value={to} onChange={(e) => setTo(e.target.value)} />
        <datalist id="code-dirs">{[...new Set(files.flatMap((x) => x.path.split("/").slice(0, -1).map((_, i, a) => `${a.slice(0, i + 1).join("/")}/`)))].map((d) => <option key={d} value={d} />)}</datalist>
      </> : <h2 className="mono">{hits ? `Matches for ${search.get("q")}` : page.commits || mode === "commits" ? `Commits on ${ref}` : mode === "new" ? "New file"
        : (opening || f?.path || "").split("/").map((s, i, a) => (i < a.length - 1 ? <span key={i}>{`${s}/`}</span> : <span key={i} className="cur">{s}</span>))}</h2>}
        {!path && !hits && !page.commits && mode !== "new" && mode !== "commits" && editable && <Link className="btn btn-secondary btn-sm" to={`${codePath(repo.name, ref, f.path)}?v=edit`} onMouseEnter={loadMonaco} onFocus={loadMonaco}>Edit</Link>}{path && <><span className="meta">{pending ? "…" : lines.length} lines</span>{leaseChip}
        <div className="toolbar">{editing ? <><span className="pill brand">Editing</span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => put({ path, delete: true, hits: touched([]) })}><PiTrash />Stage delete</button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={cancel}>Cancel</button></> : <>
          <Seg label="View" options={md ? [["code", "Preview"], ["source", "Source"], ["history", "History"]] : [["code", "Code"], ["blame", "Blame"], ["history", "History"]]} value={mode} onChange={(v) => setSearch({ v })} />
          {editable && <Link className="btn btn-secondary btn-sm" to="?v=edit" onMouseEnter={loadMonaco} onFocus={loadMonaco} onClick={keepScroll}>Edit</Link>}
          <button type="button" className="iconbtn" aria-label="Copy file" onClick={() => Promise.resolve().then(() => navigator.clipboard.writeText(src)).catch((e) => console.warn("copy failed", e))}><Ic name="copy" /></button></>}</div></>}</div>
      {asking && <div className="ask pad row" role="alert"><span>Discard your edits to <b className="mono">{path.split("/").at(-1)}</b>?</span>
        <button type="button" className="btn btn-secondary btn-sm end" onClick={() => setAsking(false)}>Keep editing</button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={discard}>Discard</button></div>}
      {warns.length > 0 && <ul className="lwarn">{warns.map((w) => <li key={w.key} className="col-warn" role="status"><Ic name="tri" />{w.text}</li>)}</ul>}
      {body}
    </section>
  );

  // A rename is a delete at its old path plus the file at its new one, in the same commit.
  const commitChanges = staged.flatMap((s) => (s.delete ? [{ path: s.path, delete: true }] : [...(s.from ? [{ path: s.from, delete: true }] : []), { path: s.path, content: s.content }]));
  const count = `${staged.length} file${staged.length > 1 ? "s" : ""}`;
  const stgHits = isWs(ref) ? [] : staged.flatMap((s) => s.hits ?? []);
  const send = (choice) => {
    saving.current = true;
    submit({ op: "submit", base_sha: head ?? "", changes: JSON.stringify(commitChanges), intent: stgLease, ...(choice && { choice }) }, { method: "post" });
  };
  const stagedPanel = staged.length > 0 && (
    <section className="panel stg" aria-label="Staged files">
      <div className="panel-head"><h2>Staged</h2><Tag>{count}</Tag><span className="meta end">On <code>{ref}</code> · nothing leaves your browser until you open a change</span></div>
      {staged.map((s) => (
        <div key={s.path} className="stg-r">{s.delete ? <PiTrash /> : <PiFile />}<Link className="mono" to={codePath(repo.name, ref, s.from ?? s.path)}>{s.path}</Link>
          {s.from && <span className="meta mono">← {s.from}</span>}
          <Tag>{s.delete ? "delete" : s.from ? "rename" : files.some((x) => x.path === s.path) ? "edit" : "add"}</Tag>
          <button type="button" className="btn btn-secondary btn-sm end" onClick={() => setStaged((all) => all.filter((x) => x !== s))}>Unstage</button></div>
      ))}
      <Form method="post" className="stg-f" onSubmit={(e) => {
        if (stgHits.length) { e.preventDefault(); setStgLease(new FormData(e.currentTarget).get("intent")); } else saving.current = true;
      }}>
        <input type="hidden" name="base_sha" value={head ?? ""} />
        <input type="hidden" name="changes" value={JSON.stringify(commitChanges)} />
        <input className="input" name="intent" aria-label="Submit message" placeholder="Short message: what do these files change?" required />
        <button type="button" className="btn btn-secondary" onClick={() => setStaged(() => [])}>Discard all</button>
        <button type="submit" name="op" value="submit" className="btn btn-primary">Open change · {count}</button>
        {failed && <p className="meta" role="alert">{failed}</p>}
      </Form>
      {stgLease !== null && stgHits.length > 0 && <LeasePrompt key={stgHits[0].holder} lease={stgHits[0]} holder={<>{link(stgHits[0].holder)} “{byId[stgHits[0].holder].intent}” · <ChangeWho change={byId[stgHits[0].holder]} /></>}
        intent={stgLease} onGo={send} onKeep={() => setStgLease(null)} />}
    </section>
  );

  // Only the repo root has a rail: a file's leases are its header chip.
  const rail = !path && (
    <Panel title={`Active in ${repo.name}`} aside={<LiveLabel />}>
      <Region><ul className="list">
        {active.slice(0, ACTIVE).map((l) => (
          <li key={`${l.holder} ${l.symbol}`}>
            <Link to={`${root}/changes/${l.holder}`}>{byId[l.holder].intent}</Link>
            <span className="meta"><ChangeWho change={byId[l.holder]} /> · <code>{l.file}</code> · <code>{l.symbol}</code></span>
          </li>
        ))}
        {!active.length && <li className="meta">No active leases.</li>}
        {active.length > ACTIVE && <li><Link to={`${root}/changes`}>See all {active.length}</Link></li>}
      </ul></Region>
    </Panel>
  );

  const rows = [];
  const seen = new Set();
  const toggle = (dir) => setShut((s) => { const n = new Set(s); if (!n.delete(dir)) n.add(dir); return n; });
  for (const p of files.map((x) => x.path).filter((x) => x.toLowerCase().includes(filter.trim().toLowerCase())).sort((a, b) => sortKey(a).localeCompare(sortKey(b)))) {
    const parts = p.split("/");
    const dirs = parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
    dirs.forEach((dir, i) => {
      if (!seen.has(dir) && !dirs.slice(0, i).some((d) => shut.has(d))) {
        rows.push(<li key={dir}><button type="button" className="dir" aria-expanded={!shut.has(dir)} onClick={() => toggle(dir)}
          style={{ paddingLeft: i * 12 + 8 }}><PiFolderSimple />{parts[i]}</button></li>);
      }
      seen.add(dir);
    });
    if (dirs.some((d) => shut.has(d))) continue;
    const held = leases.find((l) => l.file === p);
    const sg = staged.find((s) => s.path === p || s.from === p);
    rows.push(
      <li key={p}><Link to={codePath(repo.name, ref, p)} style={{ paddingLeft: (parts.length - 1) * 12 + 8 }} aria-current={p === opening ? "page" : undefined}><PiFile /><span>{parts.at(-1)}</span>
        {sg && <span className="tr-s" title="Staged">{sg.delete ? "D" : "M"}</span>}
        {held && <span className={`tr-l ${kindOf(held)}`} title={`Leased by ${held.holder}`} aria-hidden="true" />}</Link></li>,
    );
  }

  return (
    <>
      {toolbar}
      {page.missing && <div className="panel pad row" role="status"><PiGitBranch /><span>Branch not found: <code>{page.missing}</code>. Showing {ref}; pick another branch above.</span></div>}
      {page.log && <Suspense key={page.head}><Await resolve={page.log} errorElement={logFailed}>{(log) => <Commits log={log} repo={repo.name} at={ref} label={ws?.key} root={root} />}</Await></Suspense>}
      {ws && (
        <div className="panel pad row ws-note"><PiGitBranch /><span>Workspace of {link(ws.id)} · <ChangeWho change={ws} /> · <StateTag state={ws.state} /></span>
          {driving ? <span className="meta">You are driving; the agent is paused.</span>
            : <><span className="meta">The agent is driving. Take over to edit here, or message it.</span>{failed && <span className="meta" role="alert">{failed}</span>}
              <Form method="post" className="end"><button type="submit" name="op" value="takeover" className="btn btn-secondary btn-sm">Take over</button></Form></>}
        </div>
      )}
      {ws && <WorkspaceStrip key={ws.id} ws={ws} symbols={leases.filter((l) => l.holder === ws.id).map((l) => l.symbol)} driving={driving} setDriving={setDriving} />}
      <div className={rail ? "code-wrap" : "code-wrap norail"}>
        <nav className="panel ftree-wrap" aria-label="Files">
          <details className="ft-d" open ref={tree}>
            <summary className="panel-head"><h2>Files</h2><span className="meta">{isWs(ref) ? <ChangeId id={ref} label={ws?.key} /> : ref}</span></summary>
            <div className="pad"><input className="input w" placeholder="Find a file" aria-label="Find a file" value={filter} onChange={(e) => setFilter(e.target.value)} /></div>
            <ul className="ftree">{rows.length ? rows : <li className="meta pad">No files match.</li>}</ul>
          </details>
        </nav>
        <div className="col-main">{stagedPanel}{main}</div>
        {rail && <aside className="rail">{rail}</aside>}
      </div>
    </>
  );
}

// A markdown file's relative link or image, resolved from the file's folder: an image reads the file's bytes, a link opens it in Code.
export function repoUrl(repo, ref, base, from, u, kind) {
  const [, rel, rest] = u.match(/^([^?#]*)(.*)$/);
  const dir = from.split("/").slice(0, -1).join("/");
  const path = decodeURIComponent(new URL(rel, `http://x/${dir && `${dir}/`}`).pathname.slice(1));
  return kind === "src" ? `/api/repos/${encodeURIComponent(repo)}/raw?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(path)}` : `${base}/${path}${rest}`;
}

// The repo root's rail lists this many leases, then See all.
const ACTIVE = 3;

// Row 2: the ref's commits, 10 a page; open state and page persist for the session.
const OPEN = "cinder.code.commits.open";
const pageKey = (repo) => `cinder.code.commits.page.${repo}`;
const changeOf = (msg) => /^Cinder-Change: (\S+)$/m.exec(msg)?.[1];
function Commits({ log, repo, at, label, root }) {
  const [open, setOpen] = useState(() => globalThis.sessionStorage?.getItem(OPEN) === "1");
  return (
    <details className="panel cmd" open={open} onToggle={(e) => { setOpen(e.target.open); sessionStorage.setItem(OPEN, e.target.open ? "1" : "0"); }}>
      <summary className="panel-head"><h2>Commits</h2>{isWs(at) ? <ChangeId id={at} label={label} /> : <span className="mono">{at}</span>}
        {log.latest && <span className="cm-last">Latest: <span className="mono">{log.latest.sha.slice(0, 7)}</span> {log.latest.message.split("\n")[0]}</span>}
        <span className="end">{log.total} {log.total === 1 ? "commit" : "commits"}</span></summary>
      <CommitList log={log} repo={repo} root={root} />
    </details>
  );
}

// The rows and pager, in the Commits card and as the All commits view.
function CommitList({ log, repo, root }) {
  const { revalidate } = useRevalidator();
  const pages = Math.max(1, Math.ceil(log.total / 10));
  const go = (n) => { sessionStorage.setItem(pageKey(repo), n); revalidate(); };
  // name: the arrows' labels; a numbered page is named by its number.
  const btn = (label, n, name) => <button type="button" aria-label={name} aria-current={!name && n === log.page ? "page" : undefined}
    disabled={n < 1 || n > pages || (!!name && n === log.page)} onClick={() => go(n)}>{label}</button>;
  return (<>
      <div className="panel-scroll"><table className="tbl cm"><tbody>{log.commits.map((c) => {
        const msg = c.message.split("\n")[0];
        const change = changeOf(c.message);
        return <tr key={c.sha}><td className="mono"><Link to={`?v=commits&sha=${c.sha}`}>{c.sha.slice(0, 7)}</Link></td><td className="msg" title={msg}>{msg}</td>
          <td>{c.author ?? "unknown"}</td><td>{change && <Link to={`${root}/changes/${change}`}><ChangeId id={change} /></Link>}</td></tr>;
      })}</tbody></table></div>
      <div className="pager"><span>Showing {log.total && (log.page - 1) * 10 + 1}–{Math.min(log.page * 10, log.total)} of {log.total}</span>
        <div className="pg">{btn("«", 1, "First page")}{btn("‹", log.page - 1, "Previous page")}
          {Array.from({ length: pages }, (_, i) => <Fragment key={i}>{btn(i + 1, i + 1)}</Fragment>)}{btn("›", log.page + 1, "Next page")}{btn("»", pages, "Last page")}</div></div>
  </>);
}

const logFailed = <p className="panel pad meta" role="alert">Couldn't load commits.</p>;

// The Commits card's page: the latest commit and total from the log's first page, then the rows of the stored page.
// The log serves 50 a page, so a card page reads the log page holding it.
async function commitLog(repo, ref) {
  const first = await commitsFor(repo, ref, 1);
  const total = first.total ?? first.commits.length;
  const page = Math.min(Number(globalThis.sessionStorage?.getItem(pageKey(repo))) || 1, Math.max(1, Math.ceil(total / 10)));
  // Not "from": runner/internal/decl's scanner reads `from /` as the start of a regex.
  const skip = (page - 1) * 10;
  const at = Math.floor(skip / 50) + 1;
  const rows = at > 1 ? (await commitsFor(repo, ref, at)).commits : first.commits;
  return { page, total, latest: first.commits[0] ?? null, commits: rows.slice(skip % 50, skip % 50 + 10) };
}

// Skeleton and error share these positions: the toolbar (disabled), then the first card.
const idleBar = (
  <div className="toolbar code-bar">
    <form role="search"><input className="input w" type="search" aria-label="Search code" placeholder="Search in code" disabled /></form>
    <button type="button" className="btn btn-secondary" disabled><PiPlus />Add file</button>
    <button type="button" className="btn btn-secondary" disabled><PiTerminalWindow />Clone</button>
    <button type="button" className="btn btn-primary" disabled><PiPlus />New change</button>
  </div>
);
// An empty repo: push from a machine, or commit the first file here. The token comes from the CLI, as in ClonePop.
function QuickSetup({ repo, remote, base }) {
  const [note, setNote] = useState(null);
  const b = repo.default_branch;
  const copy = async (t) => {
    try { await navigator.clipboard.writeText(t); setNote("Copied"); } catch { setNote("Couldn't copy: select the text and copy it by hand"); }
  };
  const cmd = (title, lines) => <div className="qs-cmd"><div className="qs-ch"><h3>{title}</h3>
    <button type="button" className="iconbtn" aria-label={`Copy: ${title}`} onClick={() => copy(lines.join("\n"))}><Ic name="copy" /></button></div>
    <pre className="code">{lines.join("\n")}</pre></div>;
  return (
    <section className="panel qs" aria-labelledby="qs-t">
      <div className="panel-head"><Ic name="book" /><div><h2 id="qs-t">Quick setup</h2><p className="meta">{repo.name} is empty. Push an existing project, or create the first file here.</p></div></div>
      <div className="pad qs-b">
        {remote ? <>
          <div className="cl-url"><code>{remote}</code><button type="button" className="iconbtn" aria-label="Copy clone URL" onClick={() => copy(remote)}><Ic name="copy" /></button></div>
          <p className="meta">Git asks for a password when you push: use any username and the token from <code>cinder repo credentials {repo.name}</code>.</p>
          {cmd("Create a new repository on the command line", [`echo "# ${repo.name}" >> README.md`, "git init", "git add README.md", 'git commit -m "first commit"', `git branch -M ${b}`, `git remote add origin ${remote}`, `git push -u origin ${b}`])}
          {cmd("Push an existing repository from the command line", [`git remote add origin ${remote}`, `git branch -M ${b}`, `git push -u origin ${b}`])}
        </> : <p className="meta" role="alert">The clone URL isn&apos;t available right now; reload to try again.</p>}
        {note && <p className="meta" role="status">{note}</p>}
        <div className="qs-or"><span>or start in the browser</span></div>
        <div className="row"><Link className="btn btn-primary" to={`${base}?v=new`} state={{ path: "README.md", text: `# ${repo.name}\n` }}><PiPlus />Create a README</Link>
          <Link className="btn btn-secondary" to={`${base}?v=new`}><PiFile />Add a file</Link></div>
        <p className="meta">The first push to <code>{b}</code> lands directly. After that it is an integration branch: work arrives as changes on <code>refs/for/{b}</code> and the verifier merges.</p>
      </div>
    </section>
  );
}
const DEPTH = [0, 1, 2, 2, 1, 2, 2, 0, 1, 1, 0, 0];
const ViewerSkel = ({ lines }) => <div className="codev"><div className="codev-in" style={viewStyle}>{Array.from({ length: lines }, (_, i) =>
  <div key={i} className="cl"><span className="ln"><Bone w={16} h={10} row={i} /></span><span className="src"><BoneText i={i * 3} /></span></div>)}
</div></div>;
function CodeSkel({ repo, path }) {
  const files = useShape(`code/${repo.name}/files`, 12).n, lines = useShape(`code/${repo.name}/lines`, 24).n, active = useShape(`code/${repo.name}/active`, 3).n;
  if (!files) return <LoadingRegion page="code" busy><section className="panel qs"><div className="panel-head"><h2>Quick setup</h2></div>
    <div className="pad qs-b">{[0, 1, 2, 3].map((i) => <BoneText key={i} i={i} />)}</div></section></LoadingRegion>;
  return <LoadingRegion page="code" busy>
    {idleBar}
    <div className="panel cmd"><div className="panel-head"><h2>Commits</h2><BoneText w="40%" /></div></div>
    <div className={path ? "code-wrap norail" : "code-wrap"}>
      <nav className="panel ftree-wrap" aria-label="Files">
        <div className="panel-head"><h2>Files</h2></div>
        <ul className="ftree">{Array.from({ length: files }, (_, i) => <li key={i} className="skel-row" style={{ paddingLeft: DEPTH[i % 12] * 12 + 8 }}><BoneText i={i} /></li>)}</ul>
      </nav>
      <div className="col-main"><section className="panel">
        <div className="panel-head"><BoneText large w="30%" /></div>
        <ViewerSkel lines={lines} />
      </section></div>
      {!path && <aside className="rail"><Panel title={`Active in ${repo.name}`}>
        <ul className="list">{Array.from({ length: active }, (_, i) => <li key={i}><BoneText i={i} /><BoneText i={i + 3} /></li>)}</ul>
      </Panel></aside>}
    </div>
  </LoadingRegion>;
}

// The page with the repo-wide data that landed after it, kept as one object so the view's effects run once.
function Filled({ page, view }) {
  const wide = useAsyncValue();
  return view(useMemo(() => ({ ...page, ...wide }), [page, wide]));
}

function LoadError() {
  const err = useAsyncError();
  const { revalidate } = useRevalidator();
  return (<>{idleBar}
    <State kind="error" title="Couldn't load code" request={`GET ${err.message}`} onRetry={revalidate}>
      <p>The API didn't answer. Agents keep working and nothing is lost; this page just can't read their state right now.</p>
    </State></>
  );
}

// Code, Blame, History, Edit and New file draw from the same page: switching between them loads nothing.
const viewOnly = (u) => [...u.searchParams.keys()].every((k) => k === "v");
export const codeRevalidate = ({ currentUrl: a, nextUrl: b, formMethod, defaultShouldRevalidate }) =>
  defaultShouldRevalidate && (!!formMethod || a.pathname !== b.pathname || a.search === b.search || !viewOnly(a) || !viewOnly(b));

// page stays a promise: the page renders its loading and error states around it.
// ?q= adds the repo's code search hits to the page.
// ?v=commits&sha adds that commit's diff. Every page with files carries the Commits card's log as a promise: the file never waits on it.
// A full load can split a slash ref (release/1.2 reads as ref release, path 1.2): the real ref is found in the branch
// list, unless the URL's ref has a tree first, then its encoded URL opened.
export const codeLoader = async ({ params, request }) => {
  const url = new URL(request.url);
  const sp = url.searchParams;
  const q = sp.get("q");
  const rest = params["*"] ?? "";
  const sha = sp.get("v") === "commits" && sp.get("sha");
  // The diff, the tree and the file are all asked for at once.
  const diff = sha ? commitsFor(params.repo, params.ref, 1, sha) : null;
  diff?.catch(() => {}); // a failure surfaces where the page awaits it
  const page = codeFor(params.repo, params.ref, rest).then(async (p) => {
    const ref = p.missing ? p.ref : params.ref;
    if (!p.files.length) return p;
    const commits = sha ? await (p.missing ? commitsFor(params.repo, ref, 1, sha) : diff) : null;
    const log = commitLog(params.repo, ref);
    log.catch(() => {}); // a failure surfaces where the Commits card awaits it
    return { ...p, log, commits };
  });
  if (rest) {
    // The branch list loads alongside: whichever answers first places the ref. A failed list leaves it as given for codeFor to report.
    const split = refNames(params.repo, params.ref).then((names) => parseCodePath(params.ref, rest, names), () => ({ ref: params.ref }));
    const at = await Promise.race([split, hasRef(params.repo, params.ref).then((ok) => (ok ? { ref: params.ref } : split))]);
    if (at.ref !== params.ref) {
      page.catch(() => {}); // the redirect drops this page
      return redirect(codePath(params.repo, at.ref, at.path) + url.search);
    }
  }
  return { page: q ? Promise.all([page, searchCode(params.repo, params.ref, q)]).then(([p, hits]) => ({ ...p, hits })) : page };
};

// Saving an edit creates a change, or commits into the workspace of a change the person drives, and opens it; a refused
// edit (stale base, held lease) stays on the form with the reason. Take over posts here too and returns {driving}.
// Commit writes one commit straight onto the branch through the commit API, then opens the file's history.
export async function codeAction({ request, params }) {
  const form = await request.formData();
  forgetTrees(); // a commit or a new change's files change the tree
  try {
    if (form.get("op") === "takeover") {
      await takeOver(params.ref);
      return { driving: true };
    }
    const op = form.get("op");
    const on = isWs(params.ref) ? { change_id: params.ref } : { target: params.ref };
    const list = form.get("changes") && JSON.parse(form.get("changes"));
    if (op === "commit" && !isWs(params.ref)) {
      const changes = list || [{ path: form.get("path") ?? params["*"], content: form.get("content") }];
      // An empty base (an empty repo's first file) is null: the commit creates the branch.
      await commitFiles(params.repo, { branch: params.ref, base_sha: form.get("base_sha") || null, message: form.get("intent"), changes });
      return redirect(`${codePath(params.repo, params.ref, changes.at(-1).path)}?v=history`);
    }
    // Staged files, a hand-off to an agent and a rename are one commit of files on a new change, or into the driven workspace.
    if (op === "submit" || op === "agent" || list?.length > 1) {
      const change = await proposeFiles(params.repo, { ...on, intent: form.get("intent"), base_sha: form.get("base_sha"), changes: list, agent: op === "agent", choice: form.get("choice") || undefined });
      return redirect(`/${encodeURIComponent(params.repo)}/changes/${change.id}`);
    }
    const change = await editFile(params.repo, { ...on, path: params["*"], base_sha: form.get("base_sha"), content: form.get("content"), intent: form.get("intent"), choice: form.get("choice") || undefined });
    return redirect(`/${encodeURIComponent(params.repo)}/changes/${change.id}`);
  } catch (e) {
    // A head that moved since the edit opened (commit conflict, edit stale_base) refuses the save.
    return { error: ["conflict", "stale_base"].includes(e.code) ? "Someone committed first; reload to rebase your edit" : e.message };
  }
}

export function Code() {
  const repo = useRouteLoaderData("repo");
  const { page } = useLoaderData();
  const { ref, "*": path = "" } = useParams();
  const { revalidate } = useRevalidator();
  // An event reloads the page from the kept trees and files (refreshCode drops what it outdated); leaving the page drops them.
  useEffect(() => listen(repo.name, () => refreshCode(repo.name).then(revalidate)), [repo.name, revalidate]);
  useEffect(() => forgetTrees, []);
  const [stage, setStage] = useState({ ref, files: [] });
  const setStaged = useCallback((next) => setStage((s) => ({ ref, files: next(s.ref === ref ? s.files : []) })), [ref]);
  const staged = stage.ref === ref ? stage.files : [];
  // A new path on this ref keeps drawing the last page, pending, until its own page lands; the landing renders as a
  // transition, so even a cached page swaps in without a fallback and the frame, tree and header stay mounted.
  // A new ref gets a new boundary and its skeleton.
  const [landed, setLanded] = useState(null);
  useEffect(() => { const done = () => startTransition(() => setLanded(page)); page.then(done, done); }, [page]);
  const [shown, setShown] = useState({ page, ref, path });
  const pending = shown.page !== page && shown.ref === ref && landed !== page;
  if (!pending && shown.page !== page) setShown({ page, ref, path });
  const at = pending ? shown : { page, path };
  return (
    <Frame>
      <Suspense key={ref} fallback={<CodeSkel repo={repo} path={path} />}>
        <Await resolve={at.page} errorElement={<LoadError />}>{(p) => {
          const view = (q) => <CodeView repo={repo} page={q} at={p.missing ? p.ref : ref} path={at.path} opening={path} staged={staged} setStaged={setStaged} pending={pending} />;
          // The file shows at once; changes, leases and symbols fill in when page.wide lands (first view of a repo and ref).
          // Without wide the view still renders in the same place, so the next file doesn't remount it.
          return <Suspense fallback={p.wide && view(p)}><Await resolve={p.wide ?? p} errorElement={<LoadError />}><Filled page={p} view={view} /></Await></Suspense>;
        }}</Await>
      </Suspense>
    </Frame>
  );
}
