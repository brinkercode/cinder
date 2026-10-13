// Releases: list cards. Create a tag, draft a
// release from it and publish a draft; each card links the environments the release is live in. Promoting happens in Environments.
import { Suspense, useEffect, useRef, useState } from "react";
import { Await, Form, Link, redirect, useActionData, useLoaderData, useParams, useRevalidator, useRouteLoaderData, useSubmit } from "react-router";
import { resolveSha } from "./api/tags.js";
import { branchesFor, commitsFor, repoList, repoPost } from "./client.js";
import { Ic } from "./icons.jsx";
import { Markdown } from "./lib/markdown.jsx";
import { ago } from "./repos.jsx";
import { ListCardSkel, LoadingRegion, useShape } from "./skeleton.jsx";
import { Dialog, EmptyState, ErrorState, Tabs, Frame } from "./ui.jsx";
import { codePath } from "./lib/code-path.js";
import { scopedPath } from "./shell.jsx";
import "./styles/releases.css";

// Not awaited: the page renders its loading and error states around it. The catch only stops a revalidation that
// never renders from raising an unhandled rejection; <Await> still sees it.
export const releasesLoader = ({ params }) => {
  const data = Promise.all([repoList(params.repo, "/tags"), repoList(params.repo, "/releases")]);
  data.catch(() => {});
  return { data };
};

export async function releasesAction({ request, params }) {
  const f = Object.fromEntries(await request.formData());
  try {
    if (f.intent === "tag") {
      await repoPost(params.repo, "/tags", { tag: f.tag, sha: f.sha, message: f.message });
      return { created: f.tag };
    } else if (f.intent === "publish") await repoPost(params.repo, `/releases/${encodeURIComponent(f.id)}/publish`);
    else await repoPost(params.repo, "/releases", { tag: f.tag, title: f.title, notes: f.notes, draft: true });
  } catch (e) {
    return { error: e.message };
  }
  return redirect(`/${encodeURIComponent(params.repo)}/releases`);
}

// Releases sits under Code: the page bar leads with a crumb back to the repo's Code.
// Before the repo loads (the route's skeleton) it links to the repo, which lands on Code.
function Crumb() {
  const repo = useRouteLoaderData("repo");
  const name = useParams().repo;
  return <nav className="crumb" aria-label="Breadcrumb"><Link to={repo ? scopedPath(repo, "code") : `/${encodeURIComponent(name)}`}>Code</Link><span>›</span><span className="cur">Releases</span></nav>;
}

const SHOW = [["all", "Show all"], ["draft", "Drafts"], ["published", "Published"]];

// A dialog reopened with Escape keeps its last returnValue, so clear it or a cancel would submit again.
const open = (ref) => { ref.current.returnValue = ""; ref.current.showModal(); };

function Ready({ tags, releases }) {
  const repo = useRouteLoaderData("repo");
  const { error, created } = useActionData() ?? {};
  const submit = useSubmit();
  const [q, setQ] = useState("");
  const [show, setShow] = useState("all");
  const [notes, setNotes] = useState("");
  const [view, setView] = useState("write");
  const [tagging, setTagging] = useState(false);
  const tagDlg = useRef(null);
  const relDlg = useRef(null);
  const send = (intent) => (e) => e.currentTarget.returnValue === "ok"
    && submit({ intent, ...Object.fromEntries(new FormData(e.currentTarget.querySelector("form"))) }, { method: "post" });
  const needle = q.trim().toLowerCase();
  const shown = releases.filter((r) => (show === "all" || r.state === show) && `${r.tag} ${r.title} ${r.notes}`.toLowerCase().includes(needle));
  // Tags with no release yet get a card of their own; they have no state, so only Show all lists them.
  const bare = tags.filter((t) => !releases.some((r) => r.tag === t.name));
  const shownTags = show === "all" ? bare.filter((t) => `${t.name} ${t.message}`.toLowerCase().includes(needle)) : [];
  const envs = `/${encodeURIComponent(repo.name)}/environments`;
  const newTag = <button type="button" className="btn btn-secondary" onClick={() => { setTagging(true); open(tagDlg); }}><Ic name="tag" />New tag</button>;
  useShape(`releases/${repo.name}/list`, 3, releases.length + bare.length);
  return (
    <>
      <div className="page-bar"><Crumb /><div className="end">{newTag}
        <button type="button" className="btn btn-primary" onClick={() => open(relDlg)}><Ic name="plus" />Draft release</button></div></div>
      <div className="tb"><div className="tb-in">
        <label className="q"><Ic name="search" /><input aria-label="Search tags and releases" placeholder="Search tags and releases" value={q} onChange={(e) => setQ(e.target.value)} /></label>
        <select aria-label="Show" value={show} onChange={(e) => setShow(e.target.value)}>{SHOW.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
      </div></div>
      {error && <span className="inline-msg" role="alert">{error}</span>}
      {created && <span className="inline-msg" role="status">Tag {created} created</span>}
      {!releases.length && !tags.length && <NoReleases action={newTag} />}
      {(releases.length > 0 || tags.length > 0) && !shown.length && !shownTags.length
        && <div className="lc"><EmptyState icon="search" title="No tags or releases match" /></div>}
      <div className="stack">{shownTags.map((t) => <div className="lc" key={t.name}>
        <div className="lc-m"><span className="lc-ico"><Ic name="tag" /></span>
          <div><div className="lc-t"><span className="mono">{t.name}</span><span className="tag">tag</span></div>
          <div className="lc-s">{t.message}</div></div>
          <span className="lc-time">{ago(t.created_at)} ago</span>
        </div>
      </div>)}{shown.map((r) => <div className="lc" key={r.id}>
        <div className="lc-m"><span className="lc-ico"><Ic name="tag" /></span>
          <div><div className="lc-t"><span className="mono">{r.tag}</span>
            {r.state === "draft" ? <span className="tag">draft</span> : <span className="pill"><span className="dot ok" />published</span>}
            <span>{r.title}</span></div>
          <div className="lc-s"><Markdown text={r.notes} /></div></div>
          <span className="lc-time">{ago(r.created_at)} ago</span>
          <button type="button" className="ib" aria-label={`More for ${r.tag}`} popoverTarget={`more-${r.id}`} style={{ anchorName: `--more-${r.id}` }}><Ic name="more" /></button>
          <div popover="auto" id={`more-${r.id}`} className="menu" style={{ positionAnchor: `--more-${r.id}` }}>
            <Link to={codePath(repo.name, r.tag)}>Browse files at {r.tag}</Link></div>
        </div>
        <div className="lc-f"><span><Ic name="branch" /><span className="mono">{repo.default_branch}</span></span>
          {r.environments.length ? <span className="live-in"><Ic name="globe" />Live in {r.environments.map((e) =>
            <Link key={e} className="pill" to={envs} title={`Open ${e} in Environments`}><span className="dot ok" />{e}</Link>)}</span>
            : <span className="muted">Not deployed</span>}
          {r.state === "published" && !r.environments.length && <Link to={envs}>Promote in Environments <Ic name="ar" /></Link>}
          <span className="r">
            {r.state === "draft" && <Form method="post" onSubmit={(e) => confirm(`Publish ${r.tag}? Everyone with access sees it.`) || e.preventDefault()}>
              <input type="hidden" name="id" value={r.id} /><button className="btn btn-primary btn-sm" name="intent" value="publish">Publish</button></Form>}
          </span>
        </div>
      </div>)}</div>
      <TagDialog ref={tagDlg} repo={repo} tags={tags} opened={tagging} onClose={send("tag")} />
      <Dialog ref={relDlg} title="Draft release" action="Save draft" disabled={!tags.length} onClose={send("release")}>
        <label className="field"><span>Tag</span><select className="input mono" name="tag" required>{tags.map((t) => <option key={t.name}>{t.name}</option>)}</select></label>
        <label className="field"><span>Title</span><input className="input w" name="title" required /></label>
        <Tabs label="Notes" options={[["write", "Write"], ["preview", "Preview"]]} value={view} onChange={setView} />
        <textarea className="input" name="notes" aria-label="Release notes (markdown)" rows={6} value={notes} onChange={(e) => setNotes(e.target.value)} hidden={view !== "write"} />
        <div className="md" hidden={view !== "preview"}><Markdown text={notes} /></div>
      </Dialog>
    </>
  );
}

const HEX = /^[0-9a-f]{7,40}$/;
const firstLine = (m) => m.split("\n")[0];

// New tag: a name that no tag has, and the commit it tags, picked from a branch's recent commits or a pasted SHA. Branches
// and commits load once the dialog is first opened.
function TagDialog({ ref, repo, tags, opened, onClose }) {
  const [name, setName] = useState("");
  const [from, setFrom] = useState("branch");
  const [branch, setBranch] = useState(repo.default_branch);
  const [branches, setBranches] = useState(null);
  const [log, setLog] = useState(null);
  const [picked, setPicked] = useState(null);
  const [pasted, setPasted] = useState("");
  const [resolved, setResolved] = useState(null);
  const text = pasted.trim().toLowerCase();
  useEffect(() => {
    if (opened) branchesFor(repo.name).then((b) => setBranches(b.filter((x) => x.kind === "branch").map((x) => x.name)), (e) => setBranches(e));
  }, [opened, repo.name]);
  useEffect(() => {
    if (!opened || from !== "branch") return;
    let live = true;
    commitsFor(repo.name, branch, 1).then((b) => live && setLog({ branch, commits: b.commits }), (e) => live && setLog({ branch, error: e.message }));
    return () => { live = false; };
  }, [opened, from, branch, repo.name]);
  useEffect(() => {
    if (!HEX.test(text)) return;
    let live = true;
    resolveSha(repo.name, text).then((commit) => live && setResolved({ text, commit }),
      (e) => live && setResolved({ text, error: e.status === 404 ? `No commit ${text} in ${repo.name}. Paste a short or full SHA from this repo.` : e.message }));
    return () => { live = false; };
  }, [text, repo.name]);
  const tag = name.trim();
  const clash = tags.find((t) => t.name === tag);
  const latest = tags.reduce((a, t) => (!a || t.created_at > a.created_at ? t : a), null);
  const shown = log?.branch === branch ? log : null;
  const found = resolved?.text === text ? resolved : null;
  const commit = from === "branch" ? shown?.commits?.find((c) => c.sha === picked) : found?.commit;
  return (
    <Dialog ref={ref} title="New tag" action="Create tag" disabled={!tag || !!clash || !commit} onClose={onClose}>
      <label className="field"><span>Tag name</span>
        <input className="input mono" name="tag" required placeholder="v1.2.0" value={name} onChange={(e) => setName(e.target.value)} aria-invalid={!!clash} />
        {clash ? <span className="tag-err" role="alert">{tag} already exists, at <span className="mono">{clash.sha.slice(0, 7)}</span>. Tags can&apos;t move</span>
          : <span className="tag-hint">Semver: <span className="mono">vMAJOR.MINOR.PATCH</span>{latest && <>. Latest is <span className="mono">{latest.name}</span></>}</span>}
      </label>
      <div className="field"><span>Commit</span>
        <Tabs label="Commit from" options={[["branch", "Recent on a branch"], ["sha", "Paste a SHA"]]} value={from} onChange={setFrom} /></div>
      {!opened ? null : from === "branch" ? <>
        <label className="field"><span>Branch</span>
          <select className="input mono" value={branch} onChange={(e) => setBranch(e.target.value)} disabled={!Array.isArray(branches)}>
            {(Array.isArray(branches) ? branches : [branch]).map((b) => <option key={b}>{b}</option>)}</select></label>
        {branches instanceof Error && <span className="tag-err" role="alert">Couldn&apos;t load branches: {branches.message}</span>}
        {!shown ? <div className="tag-commits" aria-busy="true">{[0, 1, 2].map((i) => <div key={i} className="skel tag-skel" />)}</div>
          : shown.error ? <span className="tag-err" role="alert">Couldn&apos;t load commits: {shown.error}</span>
            : !shown.commits.length ? <span className="tag-hint">No commits on {branch}</span>
              : <div className="tag-commits" role="radiogroup" aria-label={`Recent commits on ${branch}`}>{shown.commits.map((c) => <label key={c.sha} className="tag-commit">
                <input type="radio" name="sha" value={c.sha} checked={picked === c.sha} onChange={() => setPicked(c.sha)} />
                <span className="mono">{c.sha.slice(0, 7)}</span><span className="tag-msg">{firstLine(c.message)}</span>
                {c.date && <span className="muted">{ago(c.date)} ago</span>}</label>)}</div>}
      </> : <label className="field"><span>Commit SHA</span>
        <input className="input mono" value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="9f2c1e4 or the full 40 characters" aria-invalid={!!found?.error} />
        {text && !HEX.test(text) ? <span className="tag-err" role="alert">A SHA is 7 to 40 hex characters</span>
          : found?.error ? <span className="tag-err" role="alert">{found.error}</span>
            : found?.commit ? <span className="tag-hint"><span className="mono">{found.commit.sha.slice(0, 7)}</span> · {firstLine(found.commit.message)}</span>
              : text && <span className="tag-hint" role="status">Resolving {text}</span>}
        {found?.commit && <input type="hidden" name="sha" value={found.commit.sha} />}
      </label>}
      <label className="field"><span>Message (optional)</span><textarea className="input" name="message" rows={2} /></label>
    </Dialog>
  );
}

// Loading and error keep the page bar and toolbar in place, disabled.
const OffBar = () => <>
  <div className="page-bar"><Crumb /><div className="end"><button type="button" className="btn btn-secondary" disabled><Ic name="tag" />New tag</button>
    <button type="button" className="btn btn-primary" disabled><Ic name="plus" />Draft release</button></div></div>
  <div className="tb"><div className="tb-in">
    <label className="q"><Ic name="search" /><input aria-label="Search tags and releases" placeholder="Search tags and releases" disabled /></label>
    <select aria-label="Show" disabled><option>Show all</option></select>
  </div></div>
</>;

const NoReleases = ({ action }) => <div className="lc"><EmptyState icon="tag" title="No releases yet" action={action}>Tag a commit, then draft a release from the tag.</EmptyState></div>;

function Skel() {
  const { n } = useShape(`releases/${useParams().repo}/list`, 3);
  return <LoadingRegion page="Releases" busy><OffBar />{n ? <div className="stack">{Array.from({ length: n }, (_, i) => <ListCardSkel key={i} />)}</div>
    : <NoReleases action={<button type="button" className="btn btn-secondary" disabled><Ic name="tag" />New tag</button>} />}</LoadingRegion>;
}

function LoadError() {
  const { revalidate } = useRevalidator();
  return <><OffBar /><div className="lc"><ErrorState message="Couldn't load releases" onRetry={revalidate} /></div></>;
}

// The route's hydrate fallback: drawn before /api/repos answers.
export const ReleasesLoading = () => <Frame><Skel /></Frame>;

export function Releases() {
  const { data } = useLoaderData();
  return (
    <Frame>
      <Suspense fallback={<Skel />}>
        <Await resolve={data} errorElement={<LoadError />}>{([tags, releases]) => <Ready tags={tags} releases={releases} />}</Await>
      </Suspense>
    </Frame>
  );
}
