// Change detail.
import { Fragment, Suspense, useEffect, useRef, useState } from "react";
import { Await, Link, useAsyncError, useLoaderData, useParams, useRevalidator, useRouteError } from "react-router";
import { patchLines } from "./branches.jsx";
import { sinceDay } from "./api/flakes.js";
import { useCollisions } from "./api/collisions.js";
import { editChange } from "./api/labels.js";
import { repairRounds } from "./api/repairs.js";
import { setAgentPushes } from "./api/agent-pushes.js";
import { laneOf, repairing } from "../../worker/src/api/lanes.js";
import { ago, CLOSE_CONFIRM, CloseDialog, COLUMNS, exhausted, openDialog, outOfRounds, retryVerify } from "./changes.jsx";
import { removeReviewer, reviewerSources } from "./api/reviewers.js";
import { changeAct, getLeaseMap, listen, requestReviewer, reviewChange, setAutoQueue, threadAct } from "./client.js";
import { CollisionCard, Symbols } from "./collisions.jsx";
import { Ic } from "./icons.jsx";
import { Who } from "./who.jsx";
import { Bone, BoneAvatar, BonePill, BoneText, LoadingRegion, SkelFallback, useShape } from "./skeleton.jsx";
import { ChangeId, Dot, EmptyState, ErrorState, Tabs, Tag, Toggle, Frame, tok } from "./ui.jsx";
import { LabelsEdit } from "./labels.jsx";
import { ThreadCard } from "./thread-card.jsx";
import { codePath } from "./lib/code-path.js";
import { langOf, tokenize } from "./lib/tokenize.js";
import "./styles/change.css";

const DONE = ["merged", "closed", "failed"];
const VERDICTS = [["comment", "Comment", "General feedback without approval"], ["approve", "Approve", "Lets the verifier merge once checks pass"],
  ["request_changes", "Request changes", "Sends it back for a fix"]];
const STATUS = { approved: ["ok", "Approved"], requested: ["bad", "Changes requested"], pending: ["warn", "Pending"] };
const RUN = { pass: "okc", fail: "xc", pending: "spin", quarantined: "circle" };
// Why a blocked or conflicting change can't merge, in words, when no failed job reported a reason; never the raw state.
const WHY = { conflict: "Its target moved and the change no longer applies cleanly", resolving: "The agent is resolving conflicts with its target",
  failed: "The agent stopped before the change passed verification" };
const Pill = ({ tone, children }) => <span className="pill"><Dot tone={tone} />{children}</span>;
const Stat = ({ s }) => <Pill tone={STATUS[s][0]}>{STATUS[s][1]}</Pill>;
const slug = (path) => `f-${path.replace(/\W/g, "")}`;
const count = (rows, k) => rows.filter((r) => r[0] === k).length;
// Who did a timeline event, named and linked: the agent version (its Versions tab), the judge that decided (its
// calibration), the worker that ran the job (Workers), a push, or the person. claimedBy maps a worker to the agent it claimed for.
const JUDGE_OF = { leased: "lease", routed: "risk" };
function Actor({ e, claimedBy }) {
  const a = e.actor, agent = e.agent ?? a.agent_version ?? claimedBy[a.id];
  if (agent) return <Link to={`/automation/agents/${encodeURIComponent(agent.split("@")[0])}/versions`}><Who a={agent} /></Link>;
  if (a.type === "human") return <Who a={a.id} />;
  // A job's claim and report name the worker that ran it as the actor id; cinder's own steps are id "cinder".
  if (/^job\./.test(e.action) && a.id !== "cinder") return <Link to="/automation/workers"><Who a={`${a.type === "verifier" ? "verifier" : "worker"} · ${a.name ?? a.id.slice(0, 8)}`} /></Link>;
  if (JUDGE_OF[e.kind]) return <Link to={`/automation/judges/${JUDGE_OF[e.kind]}`}><Who a={`${JUDGE_OF[e.kind]} judge`} /></Link>;
  return <Who a={a.id === "artifacts" ? "git push" : "scheduler"} />;
}
const PLAN_KIND = { create: "create", prune: "prune", apply: "migrate" };

const Card = ({ who, what, at, s, children }) => (
  <div className="cmt-card">
    <div className="cmt-h"><Who a={who} /><span className="subtle">{what} · {ago(at)} ago</span>{s && <span className="end"><Stat s={s} /></span>}</div>
    {children && <div className="cmt-b">{children}</div>}
  </div>
);

// The deploy plan (worker/src/deploy.js planDeploy): one block per environment, each step a create, prune, migrate
// (apply) or config (bind, unbind, compatibility_date) row. A prune, or a migration the plan says drops, is destructive.
function DeployPlan({ plan, review }) {
  const bang = <span className="tag t-bad"><Ic name="warn" />destructive</span>;
  return <div className="card">
    <div className="card-h"><h3>Deploy plan</h3>{plan && review && <span className={review.route === "human" ? "end tag t-warn" : "end tag"}>{review.route} review</span>}</div>
    <div className="cmt-b stack">
      {!plan ? <p className="subtle">No deploy changes. Merging this touches no environment.</p> : <>
        {review && <p className="subtle">Routed to {review.route}: {review.reason}</p>}
        {plan.destructive && <p role="alert">{bang} {plan.destructive}</p>}
        {plan.environments.map((e) => <div key={e.name}>
          <h4>{e.name}</h4>
          {e.steps.length ? e.steps.map((s) => {
            const [verb, ...rest] = s.split(" ");
            const kind = PLAN_KIND[verb] ?? "config";
            const item = kind === "config" ? s : rest.join(" ");
            const drops = verb === "prune" || (verb === "apply" && plan.destructive?.split("; ").includes(`${item} drops`));
            return <div className="row" key={s}><span className="tag">{kind}</span><span className="mono">{item}</span>{drops && bang}</div>;
          }) : <p className="subtle">No steps.</p>}
        </div>)}
      </>}
    </div>
  </div>;
}

// A file's diff rows. With onLine, a line number opens a comment on that line (`at` is "path:row"); its threads sit below it.
function Rows({ rows, path, threads = [], at, onLine, note, setNote, onSave }) {
  // Shiki colours the rows once path's grammar loads (as Code does); until then the light highlighter.
  // lazy: old and new lines are tokenized as one text, so a construct opened on a removed line can run into an added one.
  const src = rows.map((r) => r[3]).join("\n");
  const [colored, setColored] = useState(null);
  useEffect(() => {
    let on = true;
    import("./lib/highlight.js").then((m) => m.tokens(path ?? "", src)).then((t) => on && setColored({ src, t }), (e) => console.warn("highlighting failed", e));
    return () => { on = false; };
  }, [path, src]);
  const toks = (text, i) => (colored?.src === src ? colored.t[i] : tokenize(text, langOf(path ?? "")));
  return <div className="cd-diff"><table><tbody>{rows.map(([k, o, n, text], i) => {
    // Old-side anchors need no change head, so a line on both sides is anchored on the old one.
    const side = o ? "old" : "new", line = o ?? n;
    const num = (v) => <td className="ln">{onLine && v ? <button type="button" aria-label={`Comment on line ${v}`} onClick={() => onLine(`${path}:${i}`)}>{v}</button> : v}</td>;
    return <Fragment key={i}>
      <tr className={k === "+" ? "da" : k === "-" ? "dd" : undefined}>{num(o)}{num(n)}<td className="lc2">{k === "+" ? "+ " : k === "-" ? "− " : "  "}{toks(text, i).map(([c, t], j) => (c ? <span key={j} className={c}>{t}</span> : t))}</td></tr>
      {threads.filter((t) => t.path === path && t.side === side && t.line === line).map((t) => <tr className="ic" key={t.id}><td colSpan={3}><div className="ic-box">
        {t.comments.map((c, j) => <div className="cmt-h" key={j}><Who a={c.actor} /><span>{c.body}</span></div>)}
      </div></td></tr>)}
      {at === `${path}:${i}` && <tr className="ic"><td colSpan={3}><div className="ic-box">
        <textarea rows={2} aria-label={`Comment on line ${line}`} placeholder={`Comment on line ${line}`} value={note} onChange={(e) => setNote(e.target.value)} />
        <div className="row"><span className="end" /><button type="button" className="btn btn-ghost" onClick={() => onLine(null)}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={!note.trim()} onClick={() => onSave({ path, side, line, body: note })}>Comment</button></div>
      </div></td></tr>}
    </Fragment>;
  })}</tbody></table></div>;
}

// The Reviewers header's Request picker. Rows already requested (have) are left out; Esc closes it and hands focus back to Request.
function RequestPicker({ repo, id, have, onPicked }) {
  const [open, setOpen] = useState(false);
  const [src, setSrc] = useState(null);
  const [err, setErr] = useState(null);
  const [q, setQ] = useState("");
  const trigger = useRef(null);
  const toggle = () => {
    setOpen(!open);
    if (open) return;
    setQ(""); setErr(null); setSrc(null);
    reviewerSources(repo, id).then(setSrc, (e) => setErr(`Couldn't load people and judges: ${e.message}`));
  };
  const close = () => { setOpen(false); trigger.current.focus(); };
  const pick = async (kind, who) => {
    setErr(null);
    try { await requestReviewer(id, kind, who); close(); onPicked(); } catch (e) { setErr(e.message); }
  };
  const m = (w) => !have.includes(w) && w.toLowerCase().includes(q.trim().toLowerCase());
  const row = (kind, w, sub) => <button type="button" className="rq-r" key={w} onClick={() => pick(kind, w)}><Who a={w} />{sub && <small>{sub}</small>}</button>;
  const sections = src && [
    ["Suggested · owners of touched paths", src.suggested.filter((s) => m(s.owner))
      .map((s) => row(src.people.includes(s.owner) ? "person" : "agent_version", s.owner, `owns ${s.owns} · touched ${s.touched}`))],
    ["People", src.people.filter(m).map((p) => row("person", p))],
    ["Judges", src.judges.filter(m).map((j) => row("agent_version", j, "scores, doesn't approve"))],
  ].filter(([, rows]) => rows.length);
  return <span className="rv end">
    <button type="button" ref={trigger} className="btn btn-ghost" aria-expanded={open} onClick={toggle}><Ic name="plus" />Request</button>
    {open && <div className="rv-pop menu" role="dialog" aria-label="Request a review" onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); close(); } }}>
      <input className="input" aria-label="Person or judge" placeholder="Person or judge" autoFocus value={q} onChange={(e) => setQ(e.target.value)} />
      {err && <p className="err-line" role="alert">{err}</p>}
      {!src ? !err && <LoadingRegion page="reviewers" busy>{[0, 1, 2].map((i) => <BoneText key={i} i={i} />)}</LoadingRegion>
        : sections.length ? <div className="menu-scroll">{sections.map(([l, rows]) => <div key={l} role="group" aria-label={l}><p className="lbl">{l}</p>{rows}</div>)}</div>
          : <p className="subtle">{q.trim() ? `No person or judge matches “${q.trim()}”.` : "No one left to request."} Invite people in <Link to="/settings/access">Access &amp; people</Link>.</p>}
    </div>}
  </span>;
}

// The loader's data is deferred, so the skeleton shows inside the shell while it loads, client-side navigation included.
export function ChangeDetail() {
  const { detail } = useLoaderData();
  const { revalidate } = useRevalidator();
  // Suspense sits inside the frame, so the frame renders at once and only its body waits.
  return <Frame className="cd"><Suspense fallback={<SkelFallback skel={<SkeletonBody />} onRetry={revalidate} />}>
    <Await resolve={detail} errorElement={<ErrorBody />}>{(d) => <Detail {...d} />}</Await>
  </Suspense></Frame>;
}

function Detail({ change: c, threads, changes, commits, checks, files: diffP, queue }) {
  const { repo } = useParams();
  const { revalidate } = useRevalidator();
  // lazy: refetches on any event in the repo; filter by change_id if busy repos refetch too often.
  useEffect(() => listen(repo, revalidate), [repo, revalidate]);
  const [tab, setTab] = useState("conv");
  const [text, setText] = useState("");
  const [verdict, setVerdict] = useState("comment");
  const review = useRef(null);
  const closeDlg = useRef(null);
  const [body, setBody] = useState("");
  const [at, setAt] = useState(null);
  const [note, setNote] = useState("");
  const [err, setErr] = useState(null);
  // A write is in flight until the loader brings a new change: no second write is sent meanwhile.
  const [sentOn, setSentOn] = useState(null);
  const busy = sentOn === c;
  // Fold and Viewed per change: "fold:<path>" and "viewed:<path>" in localStorage.
  const key = `cinder.change.${c.id}`;
  const [marks, setMarks] = useState(() => { try { return JSON.parse(localStorage.getItem(key)) ?? {}; } catch { return {}; } });
  const mark = (k, on) => {
    const next = { ...marks, [k]: on };
    setMarks(next);
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* no storage (private mode): kept for this visit */ }
  };
  // Every write re-runs the loader, so the page re-renders with the server's state; a refused write shows its reason.
  const write = (call, then) => async () => {
    if (busy) return;
    setErr(null);
    setSentOn(c);
    try {
      await call();
      then?.();
      revalidate();
    } catch (e) {
      setSentOn(null);
      setErr(e.message);
    }
  };

  // Auto-queue writes without re-running the loader or marking the page busy, so only the toggle and its line change.
  const [auto, setAuto] = useState({ c, on: c.auto_queue, err: null });
  const autoOn = auto.c === c ? auto.on : c.auto_queue, autoErr = auto.c === c && auto.err;
  const toggleAuto = async (on) => {
    setAuto({ c, on, err: null });
    try { await setAutoQueue(c.id, on); } catch (e) { setAuto({ c, on: !on, err: e.message }); }
  };

  // The repair rounds load on their own, so the rest of the timeline shows while they load or when they fail.
  const [loaded, setRounds] = useState({ id: null, list: null, err: null });
  // Another change's rounds (the page reused for the next change) count as still loading.
  const rounds = loaded.id === c.id ? loaded : { list: null, err: null };
  useEffect(() => {
    if (!c.repair) return;
    let live = true;
    repairRounds(c.id).then((list) => live && setRounds({ id: c.id, list, err: null }), (e) => live && setRounds({ id: c.id, list: null, err: e.message }));
    return () => { live = false; };
  }, [c]);

  // Collisions and the leases load on their own (live): the rest of the page shows while they load or fail.
  const col = useCollisions(repo, c.target_branch);
  const mine = (col.data?.feed ?? []).filter((f) => f.ours === c.id || f.theirs === c.id);
  const opened = mine.find((f) => f.ours === c.id && !f.resolution);
  // The controls show once: on the collision this change ran into, else on one where it holds the symbol.
  const controls = opened ?? mine.find((f) => !f.resolution);
  const [leaseMap, setLeaseMap] = useState([]);
  useEffect(() => { getLeaseMap(repo, c.target_branch).then((m) => setLeaseMap(m.leases), () => setLeaseMap([])); }, [repo, c]);

  // The diff loads on its own: the header and timeline draw before it; a revalidation keeps the last diff until the new one lands.
  const [diff, setDiff] = useState({ id: null, list: null, err: null });
  useEffect(() => {
    let live = true;
    diffP.then((list) => live && setDiff({ id: c.id, list, err: null }), (e) => live && setDiff({ id: c.id, list: null, err: e.message }));
    return () => { live = false; };
  }, [diffP, c.id]);
  const shown = diff.id === c.id ? diff : { list: null, err: null };
  const rb = `/${encodeURIComponent(repo)}`;
  const files = (shown.list ?? []).map((f) => ({ path: f.path, rows: patchLines(f.patch).filter(([k]) => k !== "h")
    .map(([k, o, n, , text]) => [k === "a" ? "+" : k === "d" ? "-" : " ", o === "" ? null : o, n === "" ? null : n, text]) }));
  const ro = DONE.includes(c.state);
  // The server's can_approve: Review's Approve and Request changes are disabled for anyone else; Comment stays.
  const locked = c.can_approve === false;
  const stage = c.state === "merged" ? "merged" : laneOf(null, c);
  const [, column, tone] = COLUMNS.find(([s]) => s === stage) ?? [null, c.state, "off"];
  const blocked = ["failed", "conflict"].includes(c.state);
  const mergedAt = c.events.findLast((e) => e.to_state === "merged")?.at ?? c.updated_at;
  const rep = c.repair, fixing = repairing(c), spent = exhausted(c);
  const agent = c.events.findLast((e) => e.actor.agent_version)?.actor.agent_version ?? c.agent_version;
  const author = agent ?? c.events[0]?.actor.id ?? "owner";
  const open = changes.filter((x) => !["merged", "closed"].includes(x.state));
  const n = open.findIndex((x) => x.id === c.id) + 1;
  const unresolved = threads.filter((t) => !t.resolved).length;
  const asked = c.events.filter((e) => e.kind === "changes_requested");
  const approvals = c.approvals ?? [];
  // Requested reviewers are pending until their latest review.
  const requested = (c.reviewers ?? []).map((r) => r.person ?? r.agent_version);
  const reviewers = Object.fromEntries(requested.map((w) => [w, "pending"]));
  const reviews = [...asked.map((e) => [e.at, e.actor.id, "requested", e.reason]), ...approvals.map((a) => [a.at, a.actor.id, "approved"])]
    .sort(([a], [b]) => a.localeCompare(b));
  reviews.forEach(([, who, s]) => { reviewers[who] = s; });
  const last = reviews.at(-1);
  // A person's Request changes moves the change to needs_fix; any other needs_fix is a failed verify.
  const sentBack = c.state === "needs_fix" && last?.[2] === "requested";
  const label = c.state === "merged" ? `Merged · ${ago(mergedAt)}` : fixing ? "Repairing" : c.state === "failed" ? "Failed" : c.state === "closed" ? "Closed"
    : sentBack ? "Changes requested" : column;

  const queued = ["in_queue", "merged"].includes(c.state);
  const approved = approvals.some((a) => a.actor.type === "human");
  // Requested people hold auto-queue until they approve the current head (review.requested, set once verified).
  const people = (c.reviewers ?? []).filter((r) => r.person).map((r) => r.person);
  const held = (c.review?.requested ?? people.map((who) => ({ who, state: "pending" }))).filter((r) => people.includes(r.who));
  const waiting = held.filter((r) => r.state === "pending").map((r) => r.who);
  const done = held.filter((r) => r.state === "approved").map((r) => r.who).join(", ");
  const head = c.head_sha?.slice(0, 7) ?? "the head";
  const failed = checks.filter((k) => k.status === "fail").length;
  const passed = checks.filter((k) => k.status === "pass").length;
  const ran = `${passed} of ${checks.length} checks passed`;
  const failing = c.events.findLast((e) => e.result === "failed" && e.reason)?.reason;
  // A retry re-runs only the failed tests, which its event names (changes.js retryChange).
  const moved = c.events.findLast((e) => e.to_state);
  const retried = c.state === "verifying" && moved?.kind === "retried" ? moved : null;
  const rd = [
    fixing ? ["info", `Verifier repairing · round ${rep.round} of ${rep.max}`, `${agent ?? "The agent"} is fixing ${rep.check ?? "the failing check"}`]
      : ["draft", "planned"].includes(c.state) ? ["", "Verifier not started", "Runs when the change leaves draft"]
      : c.state === "verifying" && !checks.length && !c.review ? ["info", "Verifier queued", "Checks start within one tick"]
      : retried ? ["info", `Verifier running · checks ${passed}/${checks.length}`, "Re-running the failed checks"]
      : c.failure ? ["bad", `Failed at ${c.failure.stage}`, c.failure.reason ?? WHY.failed]
      : blocked ? ["bad", "Verifier blocked", c.events.findLast((e) => e.result === "failed" && e.reason)?.reason ?? WHY[c.state]]
        : queued ? ["ok", "Verifier passed", ran]
          // needs_fix with no person's request for changes last is a failed verify.
          : failed || (c.state === "needs_fix" && last?.[2] !== "requested") ? ["bad", "Verifier failed", failed ? `${failed} of ${checks.length} checks failed` : "The last verify failed"]
            : c.review ? ["ok", "Verifier passed", ran] : ["info", "Verifier running", checks.length ? ran : "Checks run on each push"],
    ["ok", "Judges", "no outcomes yet"],
    ...(c.blocked ? [["bad", c.blocked, <Link to="/needs">Decide in Needs you</Link>]] : []),
    last?.[2] === "requested" ? ["bad", "Changes requested", last[3] ?? ""]
      : c.review?.route === "human" && !approved ? ["warn", "Awaiting human approval", c.review.reason]
        : approved || (queued && c.review?.route === "human") ? ["ok", "Human approval given", "Approved at the head"] : ["ok", "No human approval needed", c.review?.reason ?? "Routed by risk once verified"],
    ...(!held.length ? [] : waiting.length ? [["warn", `Waiting on ${waiting.join(", ")} (requested)`,
      done ? `${done} approved ${head} · auto-queue waits for the rest` : "Auto-queue holds until requested reviewers approve the head"]]
      : [["ok", "Requested reviewers approved", `${done} approved ${head}`]]),
    opened ? ["bad", `Collision with ${opened.theirs} on ${opened.symbol.split("#")[1] ?? opened.symbol}`, "Resolve it from the collision card on Conversation"]
      : ["conflict", "resolving"].includes(c.state) ? ["bad", "Conflicts with its target", WHY[c.state]] : ["ok", `No conflicts with ${c.target_branch}`, "Leases released on merge"],
  ];
  // Ready needs the queue's own rule (queue_blocker, changes.js queueBlocker) to pass as well as every row: never Ready while the queue refuses.
  const ready = c.state === "verifying" && !c.queue_blocker && rd.every(([t]) => t === "ok");
  // Shown after the verifier's rows but not part of ready: a plain comment is a thread too.
  const threadRow = !threads.length ? [] : unresolved ? [["warn", `${unresolved} unresolved ${unresolved === 1 ? "thread" : "threads"}`, c.blockers.find((b) => b.code === "threads_unresolved")?.reason ?? "Resolve them or reply"]]
    : [["ok", "All threads resolved", ""]];
  const pos = queue.findIndex((q) => q.change_id === c.id);
  // An edit from Code lands through a commit job (commit_job): until a worker commits it the change has no diff.
  const job = c.commit_job;
  const jobCard = job && <div className="card">{job.status === "failed"
    ? <EmptyState icon="warn" title="Edit commit failed" action={<Link className="btn btn-secondary" to={codePath(repo, c.id, job.path)}>Retry in Code</Link>}>
      The commit job for <code>{job.path}</code> failed, so the edit isn't on the change. Reopen the file in Code to make the edit again.</EmptyState>
    : <EmptyState icon="file" title="Committing your edit…">
      {job.status === "queued" ? <>The commit of <code>{job.path}</code> is waiting for a worker.</> : <>A worker is committing <code>{job.path}</code>.</>}</EmptyState>}</div>;
  const lines = { onLine: ro ? null : (k) => { setAt(k); setNote(""); }, at, note, setNote, onSave: (t) => write(() => threadAct(c.id, t), () => setAt(null))() };

  // The rounds replace their repair_started events; until they load they're one Repair rounds card where the first round began.
  const roundsAt = c.events.find((e) => e.kind === "repair_started")?.at ?? c.updated_at;
  const roundItems = !rep ? [] : rounds.list ? rounds.list.map((r) => {
    const cur = fixing && r.round === rep.round && !r.result;
    return [r.at, <div className="tl-e" key={`round-${r.round}`}>
      <span className={`tl-i run-i ${cur ? "running" : r.result ?? ""}`}><Ic name={cur ? "spin" : r.result === "pass" ? "okc" : "xc"} /></span><Who a={agent ?? "agent"} />
      <span className="subtle">Repair round {r.round} of {rep.max} · {r.did ?? `fixing ${r.check}`} · verifier {r.result ?? (cur ? "running" : "not run")}{r.reason ? `: ${r.reason}` : ""} · {tok(r.tokens)} tokens</span>
      <span className="subtle end">{ago(r.at)} ago</span></div>];
  }) : [[roundsAt, <div className="card" key="rounds"><div className="card-h"><h3>Repair rounds</h3></div>
    {rounds.err ? <ErrorState message={`Couldn't load repair rounds: ${rounds.err}`} onRetry={revalidate} />
      : <LoadingRegion page="repair rounds" busy>{Array.from({ length: rep.round }, (_, i) => <div className="tl-e" key={i}><BoneAvatar size={24} row={i} /><BoneText i={i} /></div>)}</LoadingRegion>}
  </div>]];
  const claimedBy = Object.fromEntries(c.events.filter((e) => e.action === "job.claim" && e.actor.agent_version).map((e) => [e.actor.id, e.actor.agent_version]));
  const items = [
    ...roundItems,
    ...c.events.filter((e) => e.kind !== "changes_requested" && !(rep && e.kind === "repair_started")).map((e) => [e.at, <div className="tl-e" key={e.id}>
      <span className="tl-i"><Ic name={e.actor.type === "verifier" ? "shieldck" : e.action === "stage.decide" ? "chart" : e.kind === "agent_push_refused" ? "lock" : "merge"} /></span><Actor e={e} claimedBy={claimedBy} />
      <span className="subtle">{e.kind === "agent_push_refused" ? <>push refused: Agents may push is off{e.commits > 0 && ` · ${e.commits} commit${e.commits > 1 ? "s" : ""} not applied`}
        {c.driver && c.agent_pushes === false && !ro && <> <button type="button" className="lnk" disabled={busy} onClick={write(() => setAgentPushes(c.id, true))}>Allow agent pushes</button></>}</>
        : e.kind === "reviewer_removed" ? `removed ${e.target} from requested reviewers · ${e.reason ? `auto-queue now waits on ${e.reason}` : "auto-queue no longer waits on anyone"}`
        : e.kind.replaceAll("_", " ")}{e.to_state && e.to_state !== e.from_state ? ` → ${e.to_state.replace("_", " ")}` : ""}{e.kind === "closed" && e.reason && ` · ${e.reason}`}</span>
      <span className="subtle end">{ago(e.at)} ago</span></div>]),
    ...threads.map((t) => [t.comments[0].at, <ThreadCard key={t.id} id={c.id} t={t} ro={ro} />]),
    ...approvals.map((a) => [a.at, <Card key={`a${a.actor.id}`} who={a.actor.id} what="reviewed" at={a.at} s="approved" />]),
    // Its body is also a thread (reviewChange), shown with the comments.
    ...asked.map((e) => [e.at, <Card key={e.id} who={e.actor.id} what="reviewed" at={e.at} s="requested" />]),
  ].sort(([a], [b]) => a.localeCompare(b)).map(([, el]) => el);
  useShape(`change/${repo}/timeline`, 3, items.length);

  const panes = {
    conv: <div className="stack">
      <div className="cmt-card">
        <div className="cmt-h"><Who a={author} /><span className="subtle">opened · {ago(c.created_at)} ago</span></div>
        <div className="cmt-b cd-desc"><p><b>Intent</b> — {c.intent}</p>
          {files.length > 0 && <p><b>Touches</b> — {files.map((f) => <Fragment key={f.path}><code>{f.path}</code> </Fragment>)}</p>}</div>
      </div>
      <DeployPlan plan={c.deploy_plan} review={c.review} />
      {col.err && !col.data && <ErrorState message={`Couldn't load collisions: ${col.err}`} onRetry={col.reload} />}
      {mine.map((f) => <CollisionCard key={f.id} f={f} id={c.id} first={f === controls} reload={col.reload} />)}
      {items}
      {!ro && <div className="cmt-card">
        <textarea rows={3} aria-label="Comment" placeholder="Leave a comment" value={text} onChange={(e) => setText(e.target.value)} />
        <div className="cmt-h"><span className="subtle">Markdown supported · @agent to steer</span><span className="end row">
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={write(() => changeAct(c.id, "close"))}>Close change</button>
          <button type="button" className="btn btn-secondary" disabled={!text.trim()} onClick={write(() => threadAct(c.id, { body: text }), () => setText(""))}>Comment</button>
        </span></div>
      </div>}
      {c.state === "closed" && <p className="subtle row"><Ic name="lock" />This change is closed. Comments and reviews are read-only.</p>}
    </div>,
    files: shown.err ? <div className="card"><ErrorState message={`Couldn't load the files: ${shown.err}`} onRetry={revalidate} /></div>
      : !shown.list ? <LoadingRegion page="files" busy><div className="card">{[0, 1, 2].map((i) => <BoneText key={i} i={i} />)}</div></LoadingRegion>
      : job && !files.length ? jobCard : !files.length ? <div className="card"><EmptyState icon="file" title="No files changed">There is no diff to show for this change.</EmptyState></div> : <div className="cd-files">
      <nav className="card cd-ftree" aria-label="Files">{files.map((f) => <a key={f.path} className="tr-f" href={`#${slug(f.path)}`}>
        <Ic name="file" /><span>{f.path}</span>{marks[`viewed:${f.path}`] && <Ic name="check" />}</a>)}</nav>
      <div className="stack">{files.map((f) => {
        const folded = marks[`fold:${f.path}`];
        return <div className="card" id={slug(f.path)} key={f.path}>
          <div className="card-h">
            <button type="button" className="ib" aria-label={`${folded ? "Unfold" : "Fold"} ${f.path}`} onClick={() => mark(`fold:${f.path}`, !folded)}><Ic name={folded ? "chevR" : "chevD"} /></button>
            <span className="mono">{f.path}</span><span className="mono"><span className="adds">+{count(f.rows, "+")}</span> <span className="dels">−{count(f.rows, "-")}</span></span>
            <label className="end row"><input type="checkbox" checked={!!marks[`viewed:${f.path}`]} onChange={(e) => mark(`viewed:${f.path}`, e.target.checked)} />Viewed</label>
          </div>
          {!folded && <Rows rows={f.rows} path={f.path} threads={threads} {...lines} />}
        </div>;
      })}</div>
    </div>,
    commits: !commits.length ? <div className="card"><EmptyState icon="merge" title="No commits yet">Commits show once the change's branch has work on it.</EmptyState></div>
      : <div className="card tscroll"><table className="tbl"><tbody>{commits.map((k) => <tr key={k.sha}>
        <td className="mono">{k.sha.slice(0, 7)}</td><td>{k.message.split("\n")[0]}</td><td><Who a={k.author?.name || author} /></td></tr>)}</tbody></table></div>,
    checks: !checks.length ? <div className="card"><EmptyState icon="shieldck" title="No checks yet">Checks run on each push to the change.</EmptyState></div>
      : <div className="card">{checks.map((k) => <details className="ck" key={`${k.kind}:${k.name}`}>
        <summary><span className={`run-i ${k.status === "pending" ? "running" : k.status}`}><Ic name={RUN[k.status]} /></span><b className="mono">{k.name}</b><span className="tag">{k.kind}</span>
          {k.status === "quarantined" && <><span className="pill"><Dot tone="warn" />quarantined</span>
            <span className="subtle">flake {Math.round(k.flake_rate * 100)}% · since {sinceDay(k.since)} · excluded from the verdict</span>
            <Link className="end" to={`${rb}/settings#flaky-checks`}>Manage</Link></>}
          {k.duration_ms !== null && <span className="subtle">{Math.round(k.duration_ms / 1000)}s</span>}
          {k.log_url && <a className="end" href={k.log_url} target="_blank" rel="noreferrer">View log <Ic name="ur" /></a>}<span className="tw"><Ic name="chevR" /></span></summary>
        <pre>{k.status} at {k.sha}</pre>
      </details>)}</div>,
  };
  const adds = files.reduce((s, f) => s + count(f.rows, "+"), 0), dels = files.reduce((s, f) => s + count(f.rows, "-"), 0);
  const cnt = (l, x) => <>{l} <span className="cnt">{x}</span></>;

  return (
    <>
      <div className="cd-head">
        <div className="row subtle"><Link to={`${rb}/changes`}><Ic name="chevL" />Changes</Link><span>·</span><span>{n ? `${n} of ${open.length} open` : c.state}</span></div>
        <div className="row">
          <h1>{c.title} <span className="subtle"><ChangeId id={c.id} label={c.key} /></span>
            <button type="button" className="iconbtn" aria-label="Copy change id" onClick={() => navigator.clipboard.writeText(c.id)}><Ic name="copy" /></button></h1>
          {!ro && <span className="end row">
            <button type="button" className="btn btn-secondary" onClick={write(() => changeAct(c.id, c.driver ? "release" : "takeover"))}>
              <Ic name={c.driver ? "robot" : "hand"} />{c.driver ? (agent ? `Hand back to ${agent}` : "Hand to an agent") : "Take over"}</button>
            <details className="rv" ref={review}>
              <summary className="btn btn-primary">Review<Ic name="chevD" /></summary>
              <div className="rv-pop">
                {locked && <p className="meta"><Ic name="lock" />Only approvers can approve or request changes: {c.approvers?.join(", ")}. You can still comment.</p>}
                <textarea rows={3} aria-label="Review comment" placeholder="Optional comment" value={body} onChange={(e) => setBody(e.target.value)} />
                {VERDICTS.map(([val, l, s]) => <label className="rvo" key={val}>
                  <input type="radio" name="verdict" value={val} checked={verdict === val} disabled={locked && val !== "comment"} onChange={() => setVerdict(val)} /><span><b>{l}</b><small>{s}</small></span></label>)}
                <button type="button" className="btn btn-primary" onClick={write(() => reviewChange(c.id, verdict, body), () => { setBody(""); setVerdict("comment"); review.current.open = false; })}>Submit review</button>
              </div>
            </details>
          </span>}
        </div>
        <div className="row">
          <Pill tone={fixing ? "info" : blocked || sentBack ? "bad" : tone}>{label}</Pill><Who a={author} /><span className="subtle">wants to merge</span><span className="pill"><Ic name="merge" /><ChangeId id={c.id} label={c.key} /></span>
          <span className="subtle">→</span><span className="pill"><Ic name="branch" />{c.target_branch}</span>
          <span className="subtle">· {commits.length} {commits.length === 1 ? "commit" : "commits"} · updated {ago(c.updated_at)} ago</span>
          {job && <Pill tone={job.status === "failed" ? "bad" : "warn"}>{job.status === "failed" ? "Edit commit failed" : job.status === "queued" ? "Committing your edit… · waiting for a worker" : "Committing your edit…"}</Pill>}
        </div>
        {c.driver && <div className="lease-strip"><Ic name="user" /><span><b>{c.driver}</b> holds the lease on this change. The agent is paused and resumes from the last commit when it's handed back.</span>
          <Link className="btn btn-secondary end" to={codePath(repo, c.id, files[0]?.path)}>Edit in Code</Link></div>}
        {c.state === "draft" && <div className={`lease-strip${err ? " bad" : ""}`} role={err ? "alert" : undefined}><Ic name={err ? "tri" : "file"} />
          <span><b>{err ? "Couldn't start the verifier." : "Draft."}</b> {err ? `${err}. The change stays a draft.` : "The verifier doesn't run on a draft. Mark it ready to start."}</span>
          <button type="button" className="btn btn-primary end" disabled={busy} onClick={write(() => changeAct(c.id, "ready"))}>{err ? "Try again" : "Mark ready"}</button></div>}
        {c.state === "verifying" && !checks.length && c.head_sha && !c.review && <div className="lease-strip" role="status"><span className="run-i running"><Ic name="spin" /></span>
          <span><b>Verifier starting on <span className="mono">{head}</span></b> · usually under 10s</span></div>}
        {c.state === "failed" && !spent && <div className="lease-strip bad"><Ic name="tri" /><span><b>{c.failure ? `Failed at ${c.failure.stage}.` : "Failed."}</b> {c.failure?.reason ?? WHY.failed}</span>
          <span className="end row"><button type="button" className="btn btn-primary" disabled={busy} onClick={write(() => retryVerify(c.id))}><Ic name="refresh" />Retry verify</button>
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => openDialog(closeDlg)}>Close change…</button></span></div>}
        {spent && <div className="lease-strip repair-strip out" role="alert"><Ic name="tri" /><span>{outOfRounds(rep)}</span><span className="end row">
          <button type="button" className="btn btn-primary" disabled={busy} onClick={write(() => changeAct(c.id, "retry"))}>Retry verify</button>
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={write(() => changeAct(c.id, "takeover"))}>Take over</button>
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => confirm(CLOSE_CONFIRM) && write(() => changeAct(c.id, "close"))()}>Close…</button>
        </span></div>}
        {retried && <div className="lease-strip" role="status"><span className="run-i running"><Ic name="spin" /></span><span><b>Retrying verify.</b> {retried.reason
          ? <>Re-running the failed check <span className="mono">{retried.reason}</span>; the {passed} passing checks are kept.</> : "Re-running verify on the head."}</span></div>}
        {c.state === "closed" && <div className="lease-strip"><Ic name="x" /><span><b>Closed{c.closed_by && ` by ${c.closed_by}`} {ago(c.closed_at ?? c.updated_at)} ago</b>
          {c.close_reason && ` · ${c.close_reason}`}. Closed changes can't reopen.</span>
          <Link className="btn btn-secondary end" to={`${rb}/changes/new?target=${encodeURIComponent(c.target_branch)}`} state={{ intent: c.intent }}><Ic name="plus" />New change from intent</Link></div>}
        {fixing && <div className="lease-strip repair-strip">
          <span className="pips" role="img" aria-label={`Round ${rep.round} of ${rep.max}`}>{Array.from({ length: rep.max }, (_, i) => <i key={i} className={i + 1 < rep.round ? "done" : i + 1 === rep.round ? "cur" : undefined} />)}</span>
          <span><b>{agent ?? "The agent"}</b> is fixing <b>{rep.check ?? "the failing check"}</b>{failing && <> · <span className="mono">{failing.split("\n")[0]}</span></>}</span>
          <button type="button" className="btn btn-secondary end" onClick={() => setTab("checks")}>Open run</button></div>}
        {err && c.state !== "draft" && <p className="err-line" role="alert">{err}</p>}
      </div>
      <div className="row">
        <Tabs label="Change" value={tab} onChange={setTab} options={[["conv", cnt("Conversation", items.length + 1)], ["files", shown.list ? cnt("Files changed", files.length) : "Files changed"],
          ["commits", cnt("Commits", commits.length)], ["checks", cnt("Checks", checks.length)]]} />
        {shown.list && <span className="end mono"><span className="adds">+{adds}</span> <span className="dels">−{dels}</span> <span className="subtle">across {files.length} files</span></span>}
      </div>
      <div className="cd-grid" aria-busy={busy || undefined}>
        <div className="cd-main">{panes[tab]}</div>
        <aside className="cd-rail">
          <div className="card">
            <div className="card-h"><h3>Merge readiness</h3><span className="end">{c.state === "merged" ? <Pill tone="ok">Merged</Pill> : c.state === "in_queue" ? <Pill tone="ok">Queued</Pill> : ready ? <Pill tone="ok">Ready</Pill> : <Pill tone="warn">Not ready</Pill>}</span></div>
            {[...rd, ...threadRow].map(([t, title, sub]) => <div className="rd" key={title}><Dot tone={t} /><div><b>{title}</b><small>{sub}</small></div></div>)}
            <div className="card-b stack">
              {c.state === "merged" ? <p className="subtle">Merged by the verifier {ago(mergedAt)} ago.</p>
                : c.state === "closed" ? <p className="subtle">Closed changes don't merge.</p>
                : c.state === "in_queue" ? <div className="rd"><Dot tone="ok" /><div><b>In merge queue{pos >= 0 && ` · position ${pos + 1} of ${queue.length}`}</b><small>The verifier merges into <span className="mono">{c.target_branch}</span> after re-running checks on the queue head.</small></div></div>
                  : <><button type="button" className="btn btn-primary" disabled={!ready} onClick={write(() => changeAct(c.id, "queue"))}>Add to merge queue</button>
                    <p className="subtle">{ready ? "The verifier owns the merge." : `Blocked: ${c.queue_blocker ?? rd.find(([t]) => t !== "ok")?.[1] ?? "resolve the items above to queue"}.`}</p></>}
              {!ro && <label className="row"><span><b>Auto-queue</b><br /><span className="subtle" role={autoErr ? "alert" : undefined}>{autoErr || "Queue as soon as everything is green"}</span>
                {held.length > 0 && <><br /><span className="subtle">{waiting.length ? "Queues when requested reviewers approve" : "Requested reviewers approved · queues when the rest is green"}</span></>}</span>
                <span className="end"><Toggle label="Auto-queue" checked={autoOn} onChange={toggleAuto} /></span></label>}
            </div>
          </div>
          <div className="rail-sec"><div className="pl2 row">Reviewers{!ro && <RequestPicker repo={repo} id={c.id} have={requested} onPicked={revalidate} />}</div>
            {Object.entries(reviewers).map(([w, s]) => <div className="row" key={w}><Who a={w} />{requested.includes(w) && <span className="tag">requested</span>}<span className="end row"><Stat s={s} />
              {!ro && requested.includes(w) && <button type="button" className="iconbtn" aria-label={`Remove ${w}`} disabled={busy} onClick={write(() => removeReviewer(c.id, w))}><Ic name="x" /></button>}</span></div>)}</div>
          <div className="rail-sec"><div className="pl2">Lease</div><div className="subtle">held by {c.driver ?? author}</div></div>
          {c.driver && !ro && <div className="rail-sec"><div className="pl2">Agent pushes</div>
            <label className="row"><span><b>Agents may push</b><br /><span className="subtle">{c.agent_pushes ? `${agent ?? "An agent"} can add commits to this branch.` : "Only people push. Agent pushes are refused and logged."}</span></span>
              <span className="end"><Toggle label="Agents may push" checked={c.agent_pushes === true} onChange={(on) => write(() => setAgentPushes(c.id, on))()} /></span></label></div>}
          <Symbols id={c.id} leases={leaseMap} data={col.data} />
          {ro ? c.labels?.length > 0 && <div className="rail-sec"><div className="pl2">Labels</div><span className="row">{c.labels.map((l) => <Tag key={l}>{l}</Tag>)}</span></div>
            : <div className="rail-sec"><LabelsEdit labels={c.labels ?? []} priority={c.priority ?? "P2"} save={async (body) => { await editChange(c.id, body); revalidate(); }} /></div>}
        </aside>
      </div>
      {c.state === "failed" && !spent && <CloseDialog dlg={closeDlg} c={c} onClose={(reason) => write(() => changeAct(c.id, "close", { reason }))()} />}
    </>
  );
}

const Back = ({ repo }) => <div className="row subtle"><Link to={`/${encodeURIComponent(repo)}/changes`}><Ic name="chevL" />Changes</Link></div>;
const TABS = [["conv", "Conversation"], ["files", "Files changed"], ["commits", "Commits"], ["checks", "Checks"]];

// Loading: a title bone and 5 meta pills, an intent card and
// 3 timeline rows, and a rail of 4 readiness rows over a full-width button bone.
export const ChangeSkeleton = () => <Frame className="cd"><SkeletonBody /></Frame>;

function SkeletonBody() {
  const { repo } = useParams();
  const { n } = useShape(`change/${repo}/timeline`, 3);
  return <LoadingRegion page="change" busy>
    <div className="cd-head">
      <Back repo={repo} />
      <div className="row"><h1><Bone w={360} h={12} /></h1></div>
      <div className="row">{[0, 1, 2, 3, 4].map((i) => <BonePill key={i} row={i} />)}</div>
    </div>
    <div className="row"><Tabs label="Change" value="conv" onChange={() => {}} options={TABS} /></div>
    <div className="cd-grid">
      <div className="cd-main"><div className="stack">
        <div className="cmt-card"><div className="cmt-h"><BoneAvatar /><BoneText w={160} /></div><div className="cmt-b"><BoneText /><BoneText i={1} /></div></div>
        {Array.from({ length: n }, (_, i) => <div className="tl-e" key={i}><BoneAvatar size={24} row={i} /><BoneText i={i} /></div>)}
      </div></div>
      <aside className="cd-rail"><div className="card">
        <div className="card-h"><h3>Merge readiness</h3></div>
        {[0, 1, 2, 3].map((i) => <div className="rd" key={i}><div className="skel-lines"><BoneText i={i} /><BoneText i={i + 1} /></div></div>)}
        <div className="card-b"><Bone w="100%" h={32} r="pill" /></div>
      </div></aside>
    </div>
  </LoadingRegion>;
}

// Not found and load errors sit where the skeleton's intent card does.
export const ChangeError = () => <Frame className="cd"><ErrorBody /></Frame>;

function ErrorBody() {
  const loadErr = useAsyncError();
  const routeErr = useRouteError();
  const err = loadErr ?? routeErr;
  const { repo } = useParams();
  const { revalidate } = useRevalidator();
  const back = <Link className="btn btn-secondary" to={`/${encodeURIComponent(repo)}/changes`}>Back to Changes</Link>;
  return <>
    <div className="cd-head"><Back repo={repo} /></div>
    <div className="cd-grid"><div className="cd-main">{err?.status === 404
      ? <div className="card"><EmptyState icon="merge" title="Change not found" action={back}>It may have been closed and archived, or the link is wrong.</EmptyState></div>
      : <div className="card"><ErrorState message={`Couldn't load this change: ${err?.message ?? err}`} onRetry={revalidate} /></div>}</div></div>
  </>;
}
