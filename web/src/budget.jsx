// Agents paused at the token budget: the banner on Changes and Agents, and the Budget reached item's controls on Needs you.
import { Suspense } from "react";
import { Await, Link, useAsyncError, useFetcher, useRevalidator } from "react-router";
import { get } from "./client.js";
import { getAccount } from "./api/budget.js";
import { Ic } from "./icons.jsx";
import { useGet } from "./use-get.js";
import { BoneText } from "./skeleton.jsx";
import { tok } from "./ui.jsx";
import "./styles/budget.css";
import { sinceDay } from "./api/flakes.js";


// Shown to a person who can't raise the budget, beside the disabled controls.
const NotOwner = ({ owners }) => <>
  <span className="muted">Only owners can raise the budget: {owners.join(", ") || "none set"}</span>
  {owners[0] && <a className="btn btn-ghost btn-sm" href={`mailto:${owners[0]}?subject=${encodeURIComponent("Raise the token budget")}`}>Ask {owners[0]}</a>}
</>;

// [account, me]: the banner loads it on its own, so the Changes and Agents loaders are unchanged.
const useBudget = () => useGet(() => Promise.all([getAccount(), get("/api/me")]));

// Only while the budget pauses agent work. Loading and a failed load show nothing: the page under it is unchanged.
export function BudgetBanner() {
  const { data } = useBudget();
  if (!data?.[0].paused) return null;
  const [a, me] = data;
  return <div className="banner" role="status"><Ic name="token" />
    <span><b>Agents paused: budget reached</b> · {tok(a.spent)} of {tok(a.budget_tokens)} tokens · resumes {sinceDay(a.resets_at)} or when an owner raises it</span>
    {me.owner ? <Link className="btn btn-primary btn-sm" to="/needs">Raise budget</Link>
      : <><NotOwner owners={a.owners} /><button type="button" className="btn btn-secondary btn-sm" disabled>Raise budget</button></>}
  </div>;
}

// A Budget reached item's footer: the paused agents, "Raise to __ M tokens" with Raise budget, and Resume once the budget
// is above what's spent. budget is the needs loader's budgetState() promise.
export function BudgetActions({ budget }) {
  return <Suspense fallback={<span className="meta" role="status">Loading the budget…</span>}>
    <Await resolve={budget} errorElement={<BudgetError />}>{(b) => <Controls {...b} />}</Await>
  </Suspense>;
}

function Controls({ account: a, owner, paused }) {
  const min = Math.floor(a.spent / 1e6) + 1;
  return <>
    {paused.map((n) => <span key={n} className="pill mono"><Ic name="token" />{n}</span>)}
    <label className="row">Raise to<input className="input" name="millions" type="number" min={min} step="1" defaultValue={min} disabled={!owner} aria-label="New budget in millions of tokens" />M tokens</label>
    <button type="submit" name="action" value="Raise budget" className="btn btn-primary btn-sm" disabled={!owner}>Raise budget</button>
    <button type="submit" name="action" value="Resume" className="btn btn-secondary btn-sm" disabled={!owner || a.paused}>Resume</button>
    {!owner && <NotOwner owners={a.owners} />}
  </>;
}

const BudgetError = () => <span className="meta" role="alert">Couldn&apos;t load the budget: {useAsyncError()?.message}</span>;

// Repositories › Budget settings: what happens when agents reach the budget, and who can raise it. Only owners can save,
// through reposAction (intent account). budget is the repos loader's [account, me] promise.
export function BudgetSettings({ budget }) {
  return <Suspense fallback={<div className="card" aria-busy="true"><div className="card-b"><h3>Budget settings</h3><BoneText /><BoneText i={1} /></div></div>}>
    <Await resolve={budget} errorElement={<SettingsError />}>{([a, me]) => <Settings a={a} me={me} />}</Await>
  </Suspense>;
}

function SettingsError() {
  const { revalidate } = useRevalidator();
  return <div className="card"><div className="card-b"><h3>Budget settings</h3>
    <p className="meta" role="alert">Couldn&apos;t load the budget settings: {useAsyncError()?.message} <button type="button" className="btn btn-ghost btn-sm" onClick={revalidate}>Retry</button></p></div></div>;
}

function Settings({ a, me }) {
  const fetcher = useFetcher();
  return <div className="card"><div className="card-b"><h3>Budget settings</h3><fetcher.Form method="post">
    <input type="hidden" name="intent" value="account" />
    <fieldset className="budget-set" disabled={!me.owner}><legend>When agents reach it</legend>
      <label><input type="radio" name="when_reached" value="pause" defaultChecked={a.when_reached === "pause"} /><span><b>Pause agents</b> until it resets or an owner raises it. Runs in progress finish.</span></label>
      <label><input type="radio" name="when_reached" value="alert" defaultChecked={a.when_reached === "alert"} /><span><b>Alert only</b>. Agents keep running past the budget.</span></label>
      <span><button type="submit" className="btn btn-secondary btn-sm">Save</button></span>
    </fieldset>
    {fetcher.data?.error && <p className="meta" role="alert">{fetcher.data.error}</p>}
    <p className="muted">Who can raise it: owners {a.owners.join(", ") || "none set"}. Change owners in <Link to="/settings/access">Access &amp; people</Link>.</p>
  </fetcher.Form></div></div>;
}
