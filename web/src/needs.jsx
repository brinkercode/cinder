// Needs you: the inbox of decisions only a person can make.
import { Suspense } from "react";
import { Await, Form, redirect, useActionData, useAsyncError, useLoaderData, useRevalidator, useSearchParams } from "react-router";
import { budgetState } from "./api/budget.js";
import { BudgetActions } from "./budget.jsx";
import { agentList, needsList, repoPost, resolveNeed } from "./client.js";
import { Ic } from "./icons.jsx";
import { ListCardSkel, LoadingRegion, useShape } from "./skeleton.jsx";
import { ChangeId, EmptyState, IdText, ErrorState, Frame, Popover, Tabs } from "./ui.jsx";
import "./styles/needs.css";

// kind → [icon, severity]: warning, info or danger. A kind missing here gets NEUTRAL.
const SEV = { "Judges disagree": ["tri", "warn"], "Lease takeover": ["hand", "info"], "Untrusted judge": ["hand", "info"], "Critical advisory": ["shield", "bad"], "Flow approval": ["hand", "info"], "Release approval": ["hand", "info"],
  "Change quarantined": ["shield", "bad"], "Dependency needs approval": ["shield", "warn"], "Test quarantined": ["tri", "warn"] };
const NEUTRAL = ["bell", "info"];

// Tab → its kinds, in tab order. A kind in no group shows under All only.
const GROUPS = [["approvals", "Approvals", ["Flow approval", "Release approval"]], ["judges", "Judges", ["Judges disagree", "Untrusted judge"]],
  ["security", "Security", ["Critical advisory", "Change quarantined", "Dependency needs approval", "Test quarantined"]],
  ["budget", "Budget", ["Budget alert", "Budget reached"]], ["wiki", "Wiki", ["Wiki comment", "Stale wiki page"]], ["leases", "Leases", ["Lease takeover"]]];

const head = (
  <div>
    <h1>Needs you<a className="docs" href="https://github.com/brinkercode/cinder/blob/main/docs/DESIGN.md" target="_blank" rel="noreferrer">View docs</a></h1>
    <p>Decisions the verifier and judges can&apos;t make alone. Everything else merges without you.</p>
  </div>
);

// Not awaited, so a navigation here shows the skeleton cards at once, then the list or the card error.
export const needsLoader = () => {
  const needs = needsList(), budget = budgetState();
  for (const p of [needs, budget]) p.catch(() => {}); // <Await> renders the rejection
  // The Stale wiki page picker's agents, fetched only when one is open.
  const agents = needs.then((l) => (l.some((n) => n.kind === "Stale wiki page") ? agentList() : []));
  agents.catch(() => {});
  return { needs, agents, budget };
};

const changePath = (repo, change) => `/${encodeURIComponent(repo)}/changes/${encodeURIComponent(change)}`;

const pagePath = (repo, page) => `/wiki/${encodeURIComponent(repo)}/${encodeURIComponent(page)}`;

// Open change, Watchtower, Open page, Edit, Open Insights, Edit alerts and a Budget alert's Raise budget only navigate. Reply posts to
// the wiki page's comments and leaves the item open. Any other action runs its operation server-side and resolves the item when
// it succeeds; the loaders then revalidate, so the item and the sidebar and bell counts update.
export async function needsAction({ request }) {
  const f = Object.fromEntries(await request.formData());
  if (f.agent) f.action = "Hand to agent"; // a pick in the Hand to an agent menu
  if (f.action === "Edit") return redirect(`${pagePath(f.repo, f.page)}?v=edit`);
  // The Token budget card on Repositories sets the budget and its alerts.
  if (f.action === "Edit alerts" || (f.kind === "Budget alert" && f.action === "Raise budget")) return redirect("/");
  if (f.action === "Reply") {
    const body = f.body?.trim();
    if (!body) return { id: f.id, error: "Write a reply first" };
    try {
      await repoPost(f.repo, `/wiki/pages/${encodeURIComponent(f.page)}/comments`, { body });
    } catch (e) {
      return { id: f.id, error: e.message };
    }
    return { id: f.id, replied: body };
  }
  if (f.action === "Open change") return redirect(changePath(f.repo, f.change));
  if (f.action === "Watchtower") return redirect(`/${encodeURIComponent(f.repo)}/watchtower`);
  if (f.action === "Open page") return redirect(pagePath(f.repo, f.page));
  if (f.action === "Open Insights") return redirect("/insights");
  let need;
  try {
    // The Budget reached field is in millions of tokens.
    need = await resolveNeed(f.id, f.action, f.action === "Raise budget" && f.millions ? { amount: Math.round(Number(f.millions) * 1e6) } : f.agent ? { agent: f.agent } : f.reason && { reason: f.reason });
  } catch (e) {
    return { id: f.id, error: e.message };
  }
  return f.action === "Open fix change" && need ? redirect(changePath(f.repo, need.change)) : null;
}

// The agents to hand a stale page to, each at its stable version (else its newest).
const pick = (list) => list.map((a) => `${a.name}@v${(a.versions.find((v) => v.channel === "stable") ?? a.versions[0]).version}`);

function HandTo({ agents }) {
  return <Popover label={<><Ic name="robot" />Hand to an agent</>} title="Hand to an agent">
    <Suspense fallback={<span className="meta">Loading agents…</span>}>
      <Await resolve={agents} errorElement={<span className="meta" role="alert">Couldn&apos;t load agents</span>}>
        {(list) => (list.length ? pick(list).map((a) => <button key={a} type="submit" name="agent" value={a} className="btn btn-ghost mono">{a}</button>)
          : <span className="meta">No agents yet</span>)}
      </Await>
    </Suspense>
  </Popover>;
}

function Need({ n, result, agents }) {
  const [icon, sev] = SEV[n.kind] ?? NEUTRAL;
  // An approval item the caller isn't an approver of (the server's can_resolve) can't be approved or rejected here.
  const locked = n.can_resolve === false;
  const { budget } = useLoaderData();
  return (
    <Form method="post" className="lc">
      <input type="hidden" name="id" value={n.id} /><input type="hidden" name="repo" value={n.repo} /><input type="hidden" name="kind" value={n.kind} />
      {n.change && <input type="hidden" name="change" value={n.change} />}
      {n.page && <input type="hidden" name="page" value={n.page} />}
      <div className="lc-m">
        <span className={`lc-ico ${sev}`}><Ic name={icon} /></span>
        <div><div className="lc-t">{n.kind}<span className="tag">{n.repo}</span>{n.change && <span className="ch"><ChangeId id={n.change} /></span>}{n.agent && <span className="mono">{n.agent}</span>}</div><div className="lc-s"><IdText text={n.text} /></div></div>
      </div>
      <div className="lc-f">
        {n.kind === "Wiki comment" && n.page && (result?.replied ? <span role="status">Replied “{result.replied}”</span>
          : <span className="nd-reply"><input className="input" name="body" aria-label="Reply" placeholder="Reply on the page" />
            <button type="submit" name="action" value="Reply" className="btn btn-secondary btn-sm">Reply</button></span>)}
        {n.kind === "Dependency needs approval" && <input className="input" name="reason" aria-label="Reason" maxLength={500} placeholder="Reason, if you reject" />}
        {n.kind === "Budget reached" ? <BudgetActions budget={budget} /> : n.actions.map((a, i) => (a === "Hand to agent" ? <HandTo key={a} agents={agents} />
          : <button key={a} type="submit" name="action" value={a} disabled={locked} className={i || locked ? "btn btn-secondary btn-sm" : "btn btn-primary btn-sm"}>{a}</button>))}
        {n.kind === "Test quarantined" && <span className="meta">Release: it counts in the verdict again. Keep: it stays out of verdicts.</span>}
        {locked && <span className="meta">Only <b>{n.approvers ?? "people who may promote"}</b> can approve: {n.approver_names?.join(", ")}</span>}
        {result?.error && <span role="alert">{result.error}</span>}
        <span className="r"><button type="submit" name="action" value="Dismiss" className="btn btn-ghost btn-sm">Dismiss</button></span>
      </div>
    </Form>
  );
}

export function Needs() {
  const { needs, agents } = useLoaderData();
  return <Frame head={head}>
    <Suspense fallback={<Skel />}><Await resolve={needs} errorElement={<NeedsError />}>{(list) => <List needs={list} agents={agents} />}</Await></Suspense>
  </Frame>;
}

function List({ needs, agents }) {
  const result = useActionData();
  const [search, setSearch] = useSearchParams();
  useShape("needs//list", 3, needs.length);
  if (!needs.length) return nothing;
  const kinds = GROUPS.find(([v]) => v === search.get("tab"))?.[2];
  const tab = kinds ? search.get("tab") : "all";
  const shown = kinds ? needs.filter((n) => kinds.includes(n.kind)) : needs;
  const label = (l, n) => <>{l}<span className="nd-n">{n}</span></>;
  const tabs = [["all", label("All", needs.length)]];
  // A group's tab shows while it has items, or while it is selected, so an emptied tab keeps its empty state.
  for (const [v, l, k] of GROUPS) {
    const n = needs.filter((x) => k.includes(x.kind)).length;
    if (n || v === tab) tabs.push([v, label(l, n)]);
  }
  return <>
    <Tabs label="Needs you filters" options={tabs} value={tab} onChange={(v) => setSearch(v === "all" ? {} : { tab: v }, { replace: true })} />
    {shown.length ? <div className="stack">{shown.map((n) => <Need key={n.id} n={n} agents={agents} result={result?.id === n.id ? result : undefined} />)}</div>
      : <div className="lc"><EmptyState icon="okc" title="Nothing here">No items of this kind need you.</EmptyState></div>}
  </>;
}

const nothing = <div className="lc"><EmptyState icon="okc" title="Nothing needs you">The verifier is merging on its own. New judge disagreements, lease requests and critical advisories land here.</EmptyState></div>;

function Skel() {
  const { n } = useShape("needs//list", 3);
  return n ? <LoadingRegion page="Needs you" busy>
    <div className="stack">{Array.from({ length: n }, (_, i) => <ListCardSkel key={i} />)}</div></LoadingRegion> : nothing;
}

export const NeedsLoading = () => <Frame head={head}><Skel /></Frame>;

function NeedsError() {
  const err = useAsyncError();
  const { revalidate } = useRevalidator();
  return <div className="lc"><ErrorState message={`Couldn't load Needs you: ${err?.message ?? `${err?.status} ${err?.statusText}`}`} onRetry={revalidate} /></div>;
}
