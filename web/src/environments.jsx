// Environments: one card per branch environment (target
// cloud, version, gate, rollout, drift) and promotion of a published release.
import { Fragment, Suspense, useRef, useState } from "react";
import { Await, Form, Link, useActionData, useLoaderData, useNavigation, useParams, useRevalidator, useRouteLoaderData, useSearchParams, useSubmit } from "react-router";
import { editFile, environmentTree, environmentsFor, repoList, repoPost, resolveNeed } from "./client.js";
import { servicesFor } from "./api/services.js";
import { Ic } from "./icons.jsx";
import { ago } from "./repos.jsx";
import { BonePill, BoneText, LoadingRegion, useShape } from "./skeleton.jsx";
import { Dialog, EmptyState, ErrorState, Tabs, Frame } from "./ui.jsx";
import { codePath } from "./lib/code-path.js";
import "./styles/environments.css";

// Not awaited: the page renders its loading and error states around it; the catch only stops an unhandled rejection.
export const environmentsLoader = ({ params }) => {
  // Cards draw from the environments list; each tree fills in its card when it arrives, and one that fails to load
  // leaves its card up with a note rather than failing the page.
  const envs = environmentsFor(params.repo).then((list) => list.map((e) => ({
    ...e, tree: e.branch ? environmentTree(params.repo, e.name).catch(() => null) : null })));
  const data = Promise.all([envs, repoList(params.repo, "/releases")]);
  const services = servicesFor(params.repo);
  data.catch(() => {});
  services.catch(() => {});
  return { data, services };
};

// Promote: the environment's pipeline deploys the release's commit behind its gate. Sync, roll back and a pending
// approval's Approve or Reject post the same way; the page reloads to show the run.
export async function environmentsAction({ request, params }) {
  const f = Object.fromEntries(await request.formData());
  const at = `/environments/${encodeURIComponent(f.env)}`;
  try {
    if (f.flow) {
      const change = await editFile(params.repo, { target: f.target, path: `.cinder/flows/${f.flow}.yml`, base_sha: f.base_sha, content: f.yaml, intent: `Add deploy flow ${f.flow}` });
      return { added: { flow: f.flow, change: change.id } };
    }
    if (f.intent === "sync") await repoPost(params.repo, `${at}/sync`);
    else if (f.intent === "rollback") await repoPost(params.repo, `${at}/rollback`, { reason: `Rolled back to ${f.previous} from Environments` });
    else if (f.need) await resolveNeed(f.need, f.decision);
    else await repoPost(params.repo, `${at}/promote`, { release: f.release, rollout: f.rollout });
  } catch (e) {
    return { error: e.message };
  }
  return null;
}

// The page bar stays real while loading and on error; Promote is disabled until there are environments,
// Add environment until the repo has loaded.
function Bar({ onPromote }) {
  const repo = useRouteLoaderData("repo");
  const [sp, setSp] = useSearchParams();
  return (
    <div className="page-bar">
      <Tabs label="Environments" options={[["all", "Environments"], ["services", "Services"]]} value={sp.get("view") ?? "all"} onChange={(v) => setSp({ view: v })} />
      <div className="end">
        <button type="button" className="btn btn-secondary" disabled={!onPromote} onClick={onPromote}><Ic name="tag" />Promote a release</button>
        {repo ? <Link className="btn btn-primary" to={codePath(repo.name, repo.default_branch, ".cinder.yml")}><Ic name="plus" />Add environment</Link>
          : <button type="button" className="btn btn-primary" disabled><Ic name="plus" />Add environment</button>}
      </div>
    </div>
  );
}

function Ready({ envs, releases }) {
  const repo = useRouteLoaderData("repo");
  const error = useActionData()?.error;
  const submit = useSubmit();
  const [sp] = useSearchParams();
  const view = sp.get("view") ?? "all";
  const [env, setEnv] = useState("");
  const [back, setBack] = useState(null);
  const dlg = useRef(null);
  const rbDlg = useRef(null);
  const q = encodeURIComponent(repo.name);
  const yml = codePath(repo.name, repo.default_branch, ".cinder.yml");
  const cards = envs.filter((e) => e.branch);
  useShape(`environments/${repo.name}/cards`, 3, cards.length);
  const published = releases.filter((r) => r.state === "published");
  // A dialog reopened with Escape keeps its last returnValue, so clear it or a cancel would submit again.
  const promote = (name) => { setEnv(name); dlg.current.returnValue = ""; dlg.current.showModal(); };
  const rollback = (e) => { setBack(e); rbDlg.current.returnValue = ""; rbDlg.current.showModal(); };
  const send = (e) => e.currentTarget.returnValue === "ok" && submit(new FormData(e.currentTarget.querySelector("form")), { method: "post" });
  return (
    <>
      <Bar onPromote={cards.length ? () => promote(cards[0].name) : undefined} />
      {error && <span className="inline-msg" role="alert">{error}</span>}
      <div className="envs" hidden={view !== "all"}>
        {!cards.length && noEnvs}
        {cards.map((e) => { const drifted = e.drift.length > 0 || (e.history[0]?.actor === "cinder-drift" && e.history[0].status === "OutOfSync");
          return <div className="card env" key={e.name}>
          <div className="card-h">{e.status === "Progressing" ? <span className="run-i running" role="status"><Ic name="spin" /></span>
            : <span className={`dot ${drifted || e.branch_missing ? "warn" : "ok"}`} />}<h3>{e.name}</h3>
            {e.status === "Progressing" && <span className="muted">Syncing · step {e.step ?? 0}%</span>}<span className="pill"><Ic name="globe" />{e.target}</span>
            <span className="end"><button type="button" className="ib" aria-label={`More for ${e.name}`} popoverTarget={`env-${e.name}`} style={{ anchorName: `--env-${e.name}` }}><Ic name="more" /></button>
              <div popover="auto" id={`env-${e.name}`} className="menu" style={{ positionAnchor: `--env-${e.name}` }}><Link to={yml}>Edit in .cinder.yml</Link></div></span></div>
          <div className="card-b">
            {e.branch_missing && <div className="block" role="status"><Ic name="tri" /><span>Branch not found: <span className="mono">{e.branch}</span> has no commits on the remote</span></div>}
            <dl className="kv">
              <dt>Branch</dt><dd className="mono">{e.branch}</dd>
              <dt>Version</dt><dd className="mono">{e.release ?? e.live_version?.sha.slice(0, 7) ?? "—"}</dd>
              <dt>Deployed</dt><dd>{e.deployed_at ? `${ago(e.deployed_at)} ago` : "—"}</dd>
              <dt>Gate</dt><dd>{e.gate}</dd>
              <dt>Rollout</dt><dd>{e.step ? `${e.step}%` : "—"}</dd>
            </dl>
            <Link className="secs" to="/settings/keystore"><Ic name="key" />{e.secrets} secrets · Keystore <Ic name="ar" /></Link>
            {e.history.length > 0 && <ul className="list" aria-label={`${e.name} deploy history`}>{e.history.map((h, i) => <li key={i}>
              <span className="mono">{h.sha.slice(0, 7)}</span> {h.status} · {h.actor} · {ago(h.at)} ago{h.reason && ` · ${h.reason}`}</li>)}</ul>}
            <Suspense fallback={<BoneText />}><Await resolve={e.tree}>{(tree) => (tree ? <ul className="etree" aria-label={`${e.name} resources`}><li><Ic name="globe" /><span className="mono">{tree.script ?? "—"}</span>
              <span className="muted mono">{tree.live_version?.version_id ?? "not deployed"}</span>
              <ul>{tree.bindings.map((b) => <li key={b.resource}><span className={`dot ${b.drift ? "warn" : "ok"}`} />
                <span className="mono">{b.binding ?? "unbound"}</span><span className="muted">{b.type}</span><span className="mono">{b.resource}</span>
                {b.drift && <span className="pill">Drift</span>}</li>)}</ul></li></ul>
              : <p className="meta">Couldn&apos;t load the resource tree</p>)}</Await></Suspense>
            {(e.pending ?? []).map((p) => <Form method="post" className="appr" key={p.need}><input type="hidden" name="need" value={p.need} />
              <span><Ic name="hand" /><b>Waiting for approval</b> · <span className="mono">{p.release}</span> · gate: {p.gate} ({p.approvers.join(", ") || "owners"}){p.at && ` · ${ago(p.at)} ago`}</span>
              <span className="end">{p.can_resolve === false && <span className="meta">Only approvers can approve</span>}
                <button className="btn btn-secondary btn-sm" name="decision" value="Reject" disabled={p.can_resolve === false}>Reject</button>
                <button className="btn btn-primary btn-sm" name="decision" value="Approve" disabled={p.can_resolve === false}>Approve</button></span></Form>)}
            {drifted && <div className="block"><Ic name="tri" /><span>Drift: {e.drift.length ? `${e.drift.length} resources differ from ` : "the live Worker differs from "}<span className="mono">.cinder.yml</span></span>
              <Link className="btn btn-secondary btn-sm end" to={`/${q}/changes/new?target=${encodeURIComponent(repo.default_branch)}`} state={{ intent: e.drift.length
                ? `Reconcile ${e.name}: declare or remove ${e.drift.map((r) => `${r.type} ${r.name}`).join(", ")} in .cinder.yml`
                : `Reconcile ${e.name}: declare its live changes in .cinder.yml` }}>Reconcile</Link></div>}
          </div>
          <div className="lc-f">
            {e.host ? <span className="mono muted">{e.host}</span> : e.console && <a href={e.console} target="_blank" rel="noreferrer">{e.target === "Cloudflare" ? "Worker › Deployments" : `Open in ${e.target} console`} <Ic name="ur" /></a>}
            <span className="r"><Form method="post"><input type="hidden" name="env" value={e.name} />
              <button className="btn btn-secondary btn-sm" name="intent" value="sync" disabled={e.status === "Progressing"}><Ic name="refresh" />Sync now</button></Form>
              <button type="button" className="btn btn-secondary btn-sm" disabled={!e.previous} title={e.previous ? `Roll back to ${e.previous}` : "No earlier release to roll back to"}
                onClick={() => rollback(e)}>Roll back</button>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => promote(e.name)}>Promote <Ic name="ar" /></button></span>
          </div>
        </div>; })}
      </div>
      <Dialog ref={dlg} title="Promote a release" action="Promote" disabled={!published.length} onClose={send}>
        <label className="field"><span>Environment</span><select className="input" name="env" value={env} onChange={(e) => setEnv(e.target.value)}>{cards.map((e) => <option key={e.name}>{e.name}</option>)}</select></label>
        <label className="field"><span>Release</span><select className="input mono" name="release" required>{published.map((r) => <option key={r.id} value={r.id}>{r.tag}</option>)}</select></label>
        <fieldset className="field"><legend>Rollout</legend>
          <label><input type="radio" name="rollout" value="gradual" defaultChecked /> Gradual, in the environment&apos;s steps</label>
          <label><input type="radio" name="rollout" value="all" /> All at once</label></fieldset>
        <p className="meta">Gate: {cards.find((e) => e.name === env)?.gate}</p>
        {!published.length && <p className="meta">Publish a release first.</p>}
      </Dialog>
      <Dialog ref={rbDlg} title={`Roll back ${back?.name ?? ""}?`} action={`Roll back to ${back?.previous ?? ""}`} onClose={send}>
        <input type="hidden" name="intent" value="rollback" /><input type="hidden" name="env" value={back?.name ?? ""} /><input type="hidden" name="previous" value={back?.previous ?? ""} />
        <p><b>{back?.name}</b> goes back to <span className="mono">{back?.previous}</span>, the release live before the current one. The gate still applies; gradual rollout is skipped for a rollback.</p>
      </Dialog>
    </>
  );
}

function LoadError() {
  const { revalidate } = useRevalidator();
  return <><Bar /><div className="envs"><div className="card"><ErrorState message="Couldn't load environments" onRetry={revalidate} /></div></div></>;
}

// 3 cards with their 5 detail rows.
const noEnvs = <div className="card"><EmptyState icon="globe" title="No environments">Declare environments in <span className="mono">.cinder.yml</span></EmptyState></div>;

function EnvsSkel() {
  const { n } = useShape(`environments/${useParams().repo}/cards`, 3);
  if (!n) return <><Bar /><div className="envs">{noEnvs}</div></>;
  return <>
  <Bar />
  <LoadingRegion page="environments" busy>
    <div className="envs">{Array.from({ length: n }, (_, c) => <div className="card env" key={c}>
      <div className="card-h"><BoneText large w={120} /><BonePill row={c} /></div>
      <div className="card-b"><dl className="kv">{["Branch", "Version", "Deployed", "Gate", "Rollout"].map((k, i) =>
        <Fragment key={k}><dt>{k}</dt><dd><BoneText i={c + i} /></dd></Fragment>)}</dl></div>
    </div>)}</div>
  </LoadingRegion>
</>;
}

// Suggested resources are only listed; Add deploy flow files the generated flow as an edit change on the target.
function ServiceList({ data: { ref, sha, services, added } }) {
  const q = encodeURIComponent(useRouteLoaderData("repo").name);
  const { added: done, error } = useActionData() ?? {};
  const sending = useNavigation().formData?.get("flow");
  if (!services.length) return <div className="card"><EmptyState icon="globe" title="No services detected">Cinder looks for a Wrangler config, a Dockerfile or Cloudflare Terraform at the root and one directory down.</EmptyState></div>;
  return <><div className="envs">{services.map((s) => {
    const made = done?.flow === s.flow.name ? done.change : null;
    const exists = made || added.includes(s.flow.name);
    return <div className="card svc" key={s.id}>
      <div className="card-h"><h3>{s.name}</h3><span className="pill">{s.kind}</span><span className="muted mono">{s.path}</span><span className="end muted mono">{s.id}</span></div>
      <div className="card-b">
        <p className="meta">Suggested resources (not created)</p>
        <ul className="list" aria-label={`${s.name} suggested resources`}>{s.resources.map((r, i) => <li key={i}><span className="muted">{r.type}</span> <span className="mono">{r.name}</span></li>)}</ul>
        <details><summary>Deploy flow <span className="mono">{s.flow.name}</span></summary><pre className="mono">{s.flow.yaml}</pre></details>
      </div>
      <div className="lc-f">
        {made && <Link className="mono" to={`/${q}/changes/${encodeURIComponent(made)}`}>{made}</Link>}
        <Form method="post" className="r">
          <input type="hidden" name="flow" value={s.flow.name} /><input type="hidden" name="yaml" value={s.flow.yaml} />
          <input type="hidden" name="target" value={ref ?? ""} /><input type="hidden" name="base_sha" value={sha ?? ""} />
          <button type="submit" className="btn btn-secondary btn-sm" disabled={Boolean(exists) || !sha || sending === s.flow.name}>
            {exists ? "Flow added" : sending === s.flow.name ? "Adding…" : "Add deploy flow"}</button>
        </Form>
      </div>
    </div>;
  })}</div>{error && <span className="inline-msg" role="alert">{error}</span>}</>;
}

function ServicesError() {
  const { revalidate } = useRevalidator();
  return <div className="card"><ErrorState message="Couldn't load services" onRetry={revalidate} /></div>;
}

const servicesSkel = <LoadingRegion page="environments" busy><div className="envs">{[0, 1].map((c) => <div className="card svc" key={c}>
  <div className="card-h"><BoneText large w={120} /><BonePill row={c} /></div><div className="card-b"><BoneText i={c} /></div></div>)}</div></LoadingRegion>;

function Services() {
  const { services } = useLoaderData();
  return <Suspense fallback={servicesSkel}><Await resolve={services} errorElement={<ServicesError />}>{(s) => <ServiceList data={s} />}</Await></Suspense>;
}

// The route's hydrate fallback: drawn before /api/repos answers.
export function EnvironmentsLoading() {
  const [sp] = useSearchParams();
  return <Frame className="envp">{sp.get("view") === "services" ? <><Bar />{servicesSkel}</> : <EnvsSkel />}</Frame>;
}

export function Environments() {
  const { data } = useLoaderData();
  const [sp] = useSearchParams();
  if (sp.get("view") === "services") return <Frame className="envp"><Bar /><Services /></Frame>;
  return (
    <Frame className="envp">
      <Suspense fallback={<EnvsSkel />}>
        <Await resolve={data} errorElement={<LoadError />}>{([envs, releases]) => <Ready envs={envs} releases={releases} />}</Await>
      </Suspense>
    </Frame>
  );
}
