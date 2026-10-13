// Wiki: page tree and search on the left, the open page and its comments in the reading column, the page rail on the right.
import { useRef, useState } from "react";
import { PiCode, PiLink, PiListBullets, PiQuotes, PiTable, PiTextB, PiTextH, PiTextItalic } from "react-icons/pi";
import { Form, Link, redirect, useActionData, useLoaderData, useNavigate, useParams, useRevalidator, useSearchParams, useSubmit } from "react-router";
import { ago } from "./access.jsx";
import { list, wikiComments, wikiDiff, wikiHistory, wikiPage, wikiSearch, wikiTree, wikiWrite } from "./client.js";
import { EmptyRepo } from "./empty-repo.jsx";
import { Ic } from "./icons.jsx";
import { anchor, Markdown } from "./lib/markdown.jsx";
import { Diff, EmptyState, Tag, Frame, Seg, Toggle } from "./ui.jsx";
import "./styles/wiki.css";

const CONFLICT = "Conflict: someone saved this page since you opened it. Copy your text, open the page again and reapply it.";
const LINE = { " ": "c", "-": "d", "+": "a" };
// Toolbar: [label, icon, before, after, Ctrl shortcut key] wrapped around the selection.
const FORMATS = [["Bold", PiTextB, "**", "**", "b"], ["Italic", PiTextItalic, "_", "_", "i"], ["Heading", PiTextH, "## ", ""], ["List", PiListBullets, "- ", ""],
  ["Quote", PiQuotes, "> ", ""], ["Code", PiCode, "`", "`"], ["Link", PiLink, "[", "](https://)", "k"], ["Table", PiTable, "| A | B |\n|---|---|\n| ", " |  |"]];

export async function wikiLoader({ params, request }) {
  const q = new URL(request.url).searchParams;
  const [repos, tree, hits] = await Promise.all([list("/api/repos"), wikiTree(params.repo), q.get("q") ? wikiSearch(params.repo, q.get("q")) : null]);
  const repo = repos.find((r) => r.name === params.repo);
  if (repo?.empty && !q.has("new")) return { empty: repo };
  const id = params.id ?? tree[0]?.id;
  if (!id) return { tree, hits, page: null };
  let history;
  try {
    // History before the page: base_version is then never newer than the text shown, so a race ends in a 409, not a lost edit.
    history = await wikiHistory(params.repo, id);
  } catch (e) {
    if (e.status === 404) return { tree, hits, page: null, missing: id };
    throw e;
  }
  const [page, comments] = await Promise.all([wikiPage(params.repo, id), wikiComments(params.repo, id)]);
  const asked = Number(q.get("at"));
  const at = history.some((v) => v.version === asked) ? asked : history[0]?.version;
  const diff = q.get("v") === "history" && at > 1 ? await wikiDiff(params.repo, id, at - 1, at) : null;
  return { tree, hits, page, comments, history, at, diff };
}

// A form's intent picks the write; no intent is the editor's save.
export async function wikiAction({ request, params }) {
  const form = Object.fromEntries(await request.formData());
  const base = `/wiki/${encodeURIComponent(params.repo)}`;
  const at = `/pages/${encodeURIComponent(params.id)}`;
  const write = (rest, body, method) => wikiWrite(params.repo, rest, body, method);
  try {
    switch (form.intent) {
      case "create": {
        const page = await write("/pages", { title: form.title, content: "", parent_id: form.parent_id || null });
        return redirect(`${base}/${encodeURIComponent(page.id)}?v=edit`);
      }
      case "move": await write(`${at}/move`, { parent_id: form.parent_id || null, sort_order: Number(form.sort_order) }, "PATCH"); break;
      case "delete": await write(at, undefined, "DELETE"); return redirect(base);
      case "restore": await write(`${at}/restore/${form.v}`); break;
      case "comment": await write(`${at}/comments`, { body: form.body }); break;
      case "comment-edit": await write(`${at}/comments/${form.c}`, { body: form.body }, "PATCH"); break;
      case "comment-delete": await write(`${at}/comments/${form.c}`, undefined, "DELETE"); break;
      default: await write(at, { title: form.title, content: form.content, message: form.message ?? "", base_version: Number(form.base_version) }, "PATCH");
    }
  } catch (e) {
    return { error: e.status === 409 && !form.intent ? CONFLICT : e.message };
  }
  return redirect(`${base}/${encodeURIComponent(params.id)}`);
}

// A POST to action carrying intent and fields as hidden inputs.
const Act = ({ action, intent, fields = {}, children, ...props }) => (
  <Form method="post" action={action} {...props}>
    <input type="hidden" name="intent" value={intent} />
    {Object.entries(fields).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
    {children}
  </Form>
);

// Parent choices: the top level, then every page depth-first bar skip's subtree (a page can't move under itself).
const flat = (nodes, skip, depth = 0) => nodes.flatMap((n) => (n.id === skip ? [] : [{ ...n, depth }, ...flat(n.children, skip, depth + 1)]));
const Parents = ({ tree, skip, ...props }) => (
  <select className="input" name="parent_id" {...props}>
    <option value="">Top level</option>
    {flat(tree, skip).map((n) => <option key={n.id} value={n.id}>{"\u00a0".repeat(n.depth * 2)}{n.title}</option>)}
  </select>
);

// Folders, and pages with sub-pages, are collapsible rows with a child count; agent-context pages carry the robot mark.
// The current page is the selected row, not a link to where you already are.
const Tree = ({ nodes, to, cur, depth = 0 }) => nodes.map((n) => {
  const pad = { paddingLeft: depth * 14 + 4 };
  const mark = n.agent_context && <i className="wt-a" title="Agent context"><Ic name="robot" /></i>;
  if (n.type === "folder" || n.children.length > 0) {
    const name = n.type === "folder" ? <span>{n.title}</span> : n.id === cur ? <span aria-current="page">{n.title}</span> : <Link to={to(n.id)}>{n.title}</Link>;
    return <li key={n.id}><details open><summary className="wt-r wt-f" style={pad}><i className="wt-tw"><Ic name="chevR" /></i><Ic name="folder" />{name}{mark}<small>{n.children.length}</small></summary>
      <ul><Tree nodes={n.children} to={to} cur={cur} depth={depth + 1} /></ul></details></li>;
  }
  const row = <><Ic name="file" /><span>{n.title}</span>{mark}</>;
  return <li key={n.id}>{n.id === cur ? <span className="wt-r" style={pad} aria-current="page">{row}</span> : <Link className="wt-r" to={to(n.id)} style={pad}>{row}</Link>}</li>;
});

// The pages above id, top first; null when id isn't under nodes.
const trail = (nodes, id) => {
  for (const n of nodes) {
    if (n.id === id) return [];
    const t = trail(n.children, id);
    if (t) return [n, ...t];
  }
  return null;
};

// Headings carry no id, so the heading is found by the toc's anchor rule; the .main scroller moves, not window.
const jump = (e, to) => {
  e.preventDefault();
  const main = document.querySelector(".main");
  const h = [...(main?.querySelectorAll(".wk-doc h3") ?? [])].find((n) => anchor(n.textContent) === to);
  if (h) main.scrollTo({ top: main.scrollTop + h.getBoundingClientRect().top - main.getBoundingClientRect().top, behavior: "smooth" });
};

// The snippet as text with each [start, end) match in <mark>.
const marked = ({ snippet, matches }) => [
  ...matches.flatMap((m, i) => [snippet.slice(matches[i - 1]?.end ?? 0, m.start), <mark key={i}>{snippet.slice(m.start, m.end)}</mark>]),
  snippet.slice(matches.at(-1)?.end ?? 0),
];

function WikiPage({ repo, tree, page, comments, history, at, diff, to }) {
  const [search] = useSearchParams();
  const view = ["edit", "history"].includes(search.get("v")) ? search.get("v") : "page";
  const here = to(page.id);
  const [text, setText] = useState(page.content);
  const [title, setTitle] = useState(page.title);
  const [note, setNote] = useState("");
  const [tab, setTab] = useState("split");
  const area = useRef(null);
  const submit = useSubmit();
  const navigate = useNavigate();
  const [base] = useState(history[0]?.version ?? 0); // the version this edit started from, kept when a refused save reloads the page
  const [agent, setAgent] = useState(page.agent_context);
  const [flagError, setFlagError] = useState(null);
  const { revalidate } = useRevalidator();
  // Flips at once; a refused PATCH puts it back and says why. A landed one reloads so the tree's mark follows.
  const flip = async () => {
    const next = !agent;
    setAgent(next);
    setFlagError(null);
    try {
      await wikiWrite(repo, `/pages/${encodeURIComponent(page.id)}`, { agent_context: next }, "PATCH");
      revalidate();
    } catch (e) {
      setAgent(!next);
      setFlagError(e.message);
    }
  };
  if (view === "edit") {
    const dirty = title !== page.title || text !== page.content;
    const cancel = () => (!dirty || confirm("Discard your unsaved changes?")) && navigate(here);
    // Nothing changed: back to the page without a request.
    const save = () => (dirty ? submit({ title, content: text, message: note, base_version: base }, { method: "post", action: `${here}?v=edit` }) : navigate(here));
    const keys = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); save(); }
      const f = (e.ctrlKey || e.metaKey) && FORMATS.find((x) => x[4] === e.key.toLowerCase());
      if (f) { e.preventDefault(); wrap(f[2], f[3]); }
      if (e.key === "Escape") { e.preventDefault(); cancel(); }
    };
    const wrap = (a, b) => {
      const { selectionStart: s, selectionEnd: end } = area.current;
      setText(text.slice(0, s) + a + text.slice(s, end) + b + text.slice(end));
    };
    return (
      <Frame measure>
        <section className="wk-ed card" onKeyDown={keys}>
          <div className="wk-etb">{FORMATS.map(([l, Glyph, a, b, k]) => <button key={l} type="button" className="btn btn-ghost btn-sm" aria-label={l}
            title={k ? `${l} (Ctrl ${k.toUpperCase()})` : l} onClick={() => wrap(a, b)}><Glyph /></button>)}
            <span className="end"><Seg label="Editor view" options={[["write", "Write"], ["split", "Split"], ["preview", "Preview"]]} value={tab} onChange={setTab} /></span></div>
          <input className="wk-tt" aria-label="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
          <div className={`wk-pane t-${tab}`}>
            <textarea ref={area} className="mono" spellCheck={false} aria-label="Content, Markdown" value={text} onChange={(e) => setText(e.target.value)} />
            <div className="wk-prev"><Markdown text={text} /></div>
          </div>
          <div className="wk-ef"><input aria-label="Note" placeholder="What changed? Shown in page history" value={note} onChange={(e) => setNote(e.target.value)} />
            <span className="meta">Markdown · Esc to cancel</span>
            <button type="button" className="btn btn-secondary btn-sm" onClick={cancel}>Cancel</button>
            <button type="button" className="btn btn-primary btn-sm" onClick={save}>Save page</button></div>
        </section>
      </Frame>
    );
  }
  let body;
  if (view === "history") {
    const count = (k) => diff?.lines.filter((l) => l[0] === k).length;
    body = (
      <section className="card">
        <div className="card-h"><h3>History</h3><span className="meta">{history.length} versions</span>
          {at !== history[0]?.version && <Act className="end" action={here} intent="restore" fields={{ v: at }}>
            <button type="submit" className="btn btn-secondary btn-sm">Restore v{at}</button></Act>}</div>
        <div className="wk-hg">
          <ul className="wk-hl">{history.map((v) => (
            <li key={v.version}><Link to={`?v=history&at=${v.version}`} aria-current={v.version === at ? "true" : undefined}>
              <span className="mono">v{v.version}</span>{v.version === history[0].version && <Tag tone="info">current</Tag>}
              {v.message && <small>{v.message}</small>}<small className="meta">{v.edited_by} · {v.created_at.slice(0, 10)}</small></Link></li>
          ))}</ul>
          {diff ? <Diff file={`v${diff.from} → v${diff.to}`} adds={count("+")} dels={count("-")} lines={diff.lines.map((l) => [LINE[l[0]], "", "", "", l.slice(1)])} />
            : <p className="meta pad">{history.length ? `v${at} is the first version; nothing to compare.` : "No versions yet."}</p>}
        </div>
      </section>
    );
  } else {
    body = (
      <>
        <article className="wk-doc"><Markdown text={page.content || "This page is empty."} /></article>
        <section className="wk-cm" aria-label="Comments">
          <h3>Comments <span className="meta">{comments.length}</span></h3>
          <ul className="list">{comments.map((c) => (
            <li key={c.id}>
              <div className="row"><span className="meta">{c.author}</span><span className="meta end">{c.created_at.slice(0, 10)}{c.edited_at && " · edited"}</span></div>
              <Markdown text={c.body} />
              <details><summary>Edit</summary>
                <Act action={here} intent="comment-edit" fields={{ c: c.id }}>
                  <textarea className="input w" name="body" required aria-label="Edit comment" defaultValue={c.body} />
                  <button type="submit" className="btn btn-sm btn-secondary">Save comment</button>
                </Act>
              </details>
              <Act action={here} intent="comment-delete" fields={{ c: c.id }}><button type="submit" className="btn btn-sm btn-ghost">Delete comment</button></Act>
            </li>
          ))}</ul>
          {/* A new last comment remounts the composer, so a post that landed clears it and a failed one keeps the text. */}
          <Act key={comments.at(-1)?.id} action={here} intent="comment">
            <textarea className="input w" name="body" required aria-label="New comment" placeholder="Leave a comment" />
            <button type="submit" className="btn btn-secondary">Comment</button>
          </Act>
        </section>
      </>
    );
  }
  const crumbs = [...(trail(tree, page.id) ?? []), page];
  return (
    <>
      <Frame measure>
        <div className="wk-head">
          <nav className="wk-crumb" aria-label="Breadcrumb"><span className="meta">{repo}</span>
            {crumbs.flatMap((n) => [<span key={`>${n.id}`} className="meta">›</span>, <span key={n.id}>{n.title}</span>])}</nav>
          <div className="end row">
            <Link className="btn btn-secondary btn-sm" to={view === "history" ? here : "?v=history"} aria-pressed={view === "history"}><Ic name="clock" />History</Link>
            <Link className="btn btn-secondary btn-sm" to="?v=edit"><Ic name="edit" />Edit</Link>
            {view === "page" && <details className="wk-more">
              <summary className="btn btn-ghost btn-sm" aria-label="More"><Ic name="more" /></summary>
              <div>
                <a className="btn btn-ghost btn-sm" href="#wk-location">Move</a>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigator.clipboard.writeText(location.href)}>Copy link</button>
                <Act action={here} intent="delete" onSubmit={(e) => !confirm(`Delete ${page.title} and its sub-pages?`) && e.preventDefault()}>
                  <button type="submit" className="btn btn-ghost btn-sm">Delete</button>
                </Act>
              </div>
            </details>}
          </div>
        </div>
        <div className="wk-title"><h1>{page.title}</h1>
          <p className="meta">{history[0] && `Updated ${ago(history[0].created_at)} by ${history[0].edited_by} · v${history[0].version}`}
            {agent && <span className="wk-agc"><Ic name="robot" />Agent context</span>}</p></div>
        {body}
      </Frame>
      {view === "page" && <aside className="wk-rail" aria-label="Page details">
        <section><h4>Page info</h4>
          <dl className="wk-dl">
            <dt>Edited by</dt><dd>{history[0]?.edited_by ?? "—"}</dd>
            <dt>Last edited</dt><dd>{ago(page.updated_at)}</dd>
            <dt>Views</dt><dd>{page.views}</dd>
            <dt>Words</dt><dd>{page.words}</dd>
            <dt>Read time</dt><dd>{page.read_minutes} min</dd>
          </dl></section>
        <section><h4>Agent context</h4>
          <label className="wk-ag"><Toggle label="Agent context" checked={agent} onChange={flip} />
            {/* The plan adds ceil(bytes / 4) tokens per page, the rule /wiki/context counts by. */}
            <span><b>Agents read this page</b><small>about {Math.ceil(new TextEncoder().encode(page.content).length / 4)} tokens added to each plan</small></span></label>
          {flagError && <p className="meta" role="alert">{flagError}</p>}</section>
        <section id="wk-location"><h4>Location</h4>
          {/* lazy: keeps its sort_order under the new parent; ordering within a level waits for drag and drop */}
          <Act action={here} intent="move" fields={{ sort_order: page.sort_order }} className="row">
            <Parents tree={tree} skip={page.id} aria-label="Parent page" defaultValue={page.parent_id ?? ""} />
            <button type="submit" className="btn btn-secondary btn-sm">Move</button>
          </Act></section>
        {page.toc.length > 0 && <section><h4>On this page</h4>
          <nav className="wk-toc" aria-label="On this page">{page.toc.map((h) => (
            <a key={h.anchor} className={`l${h.level}`} href={`#${h.anchor}`} onClick={(e) => jump(e, h.anchor)}>{h.text}</a>
          ))}</nav></section>}
        <section><h4>History</h4>
          <ul className="wk-h">{history.slice(0, 3).map((v) => (
            <li key={v.version}><Link to={`?v=history&at=${v.version}`}><span className="mono">v{v.version}</span><span className="meta">{v.edited_by} · {ago(v.created_at)}</span></Link></li>
          ))}</ul>
          <Link to="?v=history">All {history.length} versions</Link></section>
      </aside>}
    </>
  );
}

export function Wiki() {
  const { repo } = useParams();
  const { tree, hits, page, comments, missing, history, at, diff, empty } = useLoaderData();
  const result = useActionData();
  const [search] = useSearchParams();
  if (empty) return <EmptyRepo repo={empty} page="wiki" />;
  const base = `/wiki/${encodeURIComponent(repo)}`;
  const to = (id) => `${base}/${encodeURIComponent(id)}`;
  // Edit keeps one key so a refused save doesn't wipe the text; leaving edit starts the next one from the saved version.
  const key = `${page?.id}:${search.get("v") === "edit" ? "edit" : history?.[0]?.version}`;
  const folder = page?.type === "folder" ? page.id : page?.parent_id ?? "";
  return (
    <div className="wk">
      {result?.error && <p className="meta" role="alert">{result.error}</p>}
      <nav className="wk-nav" aria-label="Pages">
        <Form method="get"><input className="input w" type="search" name="q" aria-label="Search the wiki" placeholder="Search the wiki" defaultValue={search.get("q") ?? ""} /></Form>
        <Act intent="create" fields={{ title: "Untitled", parent_id: folder }}><button type="submit" className="btn btn-secondary w"><Ic name="plus" />New page</button></Act>
        {hits && <ul className="list">{hits.length ? hits.map((h) => (
          <li key={h.id}><Link to={to(h.id)}>{h.title}</Link><span className="meta mono">{h.path}</span><span className="meta">{marked(h)}</span></li>
        )) : <li className="meta">No pages match.</li>}</ul>}
        <ul className="wt"><Tree nodes={tree} to={to} cur={page?.id} /></ul>
      </nav>
      {page ? <WikiPage key={key} repo={repo} tree={tree} page={page} comments={comments} history={history} at={at} diff={diff} to={to} />
        : <Frame measure><div className="card">{missing
          ? <EmptyState icon="file" title={`Page ${missing} not found`} action={<Link className="btn btn-secondary" to={base}>Back to the wiki</Link>}>It may have been deleted, or the link is wrong.</EmptyState>
          : <EmptyState icon="book" title="No wiki pages yet" action={<Act intent="create" fields={{ title: "Untitled" }}><button type="submit" className="btn btn-primary">Write the first page</button></Act>}>
            Pages marked as agent context are read before every plan.</EmptyState>}</div></Frame>}
    </div>
  );
}
