import { useEffect, useState } from "react";
import { Link, isRouteErrorResponse, matchRoutes, redirect, useLoaderData, useLocation, useRevalidator, useRouteError } from "react-router";
import { workFor } from "./api/work.js";
import { loadChange } from "./api/changes.js";
import { repoNamed as findRepo } from "./api/repos.js";
import { agentList, boardFor, branchesFor, compareFor, getJudges, getLeaseMap, getMe, hintsFor, list, needsList, sessionExpired } from "./client.js";
import { pages, repoPages, scoped } from "./pages.jsx";
import { Shell, lastRepo, scopedPath } from "./shell.jsx";
import { EmptyState, ErrorState, State, Frame } from "./ui.jsx";
import { RepoGate } from "./empty-repo.jsx";

const notFound = () => { throw new Response("Repo not found", { status: 404 }); };

export function ErrorPage() {
  const err = useRouteError();
  const { revalidate } = useRevalidator();
  // Loaders' thrown Responses reach here as ErrorResponses: their text is in data, statusText is often empty.
  const message = isRouteErrorResponse(err) ? `${err.status} ${err.statusText || err.data}`
    : err instanceof Response ? `${err.status} ${err.statusText}` : err?.message ?? String(err);
  // Every unmatched path lands on a missing repo, a 404, so this is the app's Page not found.
  const missing = err?.status === 404 && (isRouteErrorResponse(err) || err instanceof Response);
  return <Frame>{sessionExpired() ? <State kind="error" /> : missing
    ? <div className="card"><EmptyState icon="search" title="Page not found" action={<Link className="btn btn-secondary" to="/">All repositories</Link>}>{message}</EmptyState></div>
    : <ErrorState message={message} onRetry={revalidate} />}</Frame>;
}

// A navigation that only changes the search (Repositories' Show and Sort, Code's view) keeps data no search param feeds;
// actions and revalidations still reload it.
const keepOnSearch = ({ currentUrl, nextUrl, formMethod, defaultShouldRevalidate }) =>
  defaultShouldRevalidate && (!!formMethod || currentUrl.pathname !== nextUrl.pathname || currentUrl.search === nextUrl.search);

// The org wiki's index: its folders, one per repo (the worker files pages as <repo>/<id>.md in cinder-wiki).
function WikiFolders() {
  const repos = useLoaderData();
  return (
    <Frame>
      {repos.length ? <div className="card"><div className="card-h"><h3>Wiki</h3></div>
        <ul className="list">{repos.map((r) => <li key={r.name}><Link to={`/wiki/${encodeURIComponent(r.name)}`}>{r.name}</Link></li>)}</ul></div>
        : <State title="No repositories yet" />}
    </Frame>
  );
}

function PickRepo() {
  const { page, repos } = useLoaderData();
  return (
    <Frame>
      <State title={repos.length ? "Which repository?" : "No repositories yet"}>
        {repos.map((r) => <Link key={r.name} className="btn btn-secondary" to={scopedPath(r, page)}>{r.name}</Link>)}
        {!repos.length && <Link className="btn btn-primary" to="/">Import repository</Link>}
      </State>
    </Frame>
  );
}

// A first load holds every page until the root loader answers: meanwhile the shell draws around the matched page's own skeleton.
// The skeleton comes with the page's chunk: the shell draws alone until it lands (import() caches, so the router's own load is the same one).
function RootFallback() {
  const route = matchRoutes(routes, useLocation())?.at(-1).route;
  const [skeleton, setSkeleton] = useState(null);
  // A failed chunk is the router's to report: its own load of the same import shows the error page.
  useEffect(() => { route?.lazy?.().then((m) => setSkeleton(m.hydrateFallbackElement), () => {}); }, [route]);
  return <Shell>{skeleton}</Shell>;
}

export const routes = [{
  id: "root",
  element: <Shell />,
  hydrateFallbackElement: <RootFallback />,
  errorElement: <main><ErrorPage /></main>,
  // Every value stays a promise: slow repos, inbox or account show in the shell's <Await>s instead of holding up every page.
  // Each is marked handled: a redirect or error drops the loader data before <Await> can catch its rejection; Await still sees it.
  loader: () => {
    const data = { repos: list("/api/repos"), needs: needsList(), me: getMe() };
    for (const p of Object.values(data)) p.catch(() => {});
    return data;
  },
  shouldRevalidate: keepOnSearch,
  children: [
    { path: "/", shouldRevalidate: keepOnSearch, lazy: () => import("./repos.jsx").then((m) => ({ element: <m.Repos />, loader: m.reposLoader, action: m.reposAction })) },
    { path: "/:repo", id: "repo", element: <RepoGate />, loader: ({ params }) => findRepo(params.repo), shouldRevalidate: keepOnSearch, children: [
      // First, so Code keeps route id 0-1-0 (worker/test/code-live.test.js reads its action and loader data by it).
      ...repoPages,
      // cards stays a promise: the page renders its loading and error states around it.
      { path: "changes", lazy: () => import("./changes.jsx").then((m) => ({ element: <m.Changes /> })), loader: async ({ params }) => {
        const repo = await findRepo(params.repo);
        // The board card adds what /work leaves out: diff, files, tokens and the agent's outcomes.
        return { repo, data: Promise.all([workFor(repo.name), boardFor(repo)]) };
      } },
      { path: "changes/:id/:tab?", lazy: () => import("./change.jsx").then((m) => ({ element: <m.ChangeDetail />, errorElement: <m.ChangeError />, hydrateFallbackElement: <m.ChangeSkeleton /> })),
        loader: ({ params }) => {
          const detail = loadChange(params.repo, params.id);
          detail.catch(() => {}); // <Await> shows the failure; this only stops an unhandled rejection before it renders
          return { detail };
        } },
      { path: "changes/new", lazy: () => import("./new-change.jsx").then((m) => ({ element: <m.NewChange /> })), loader: async ({ params, request }) => {

        const repos = await list("/api/repos");
        const repo = repos.find((r) => r.name === params.repo) ?? notFound();
        const q = new URL(request.url).searchParams;
        const [target, head] = [q.get("target") ?? repo.default_branch, q.get("head")];
        return { repo, repos, data: Promise.all([agentList(), getLeaseMap(repo.name), hintsFor(repo), getJudges(), null /* the preview slot: live, the page asks as you type */, boardFor(repo),
          // Branches only fill the head picker: a failure leaves it with the URL's head, not the prediction.
          branchesFor(repo.name).catch(() => []), head ? compareFor(repo.name, target, head) : null,
          // Reviewer chips: anyone who may not list people still picks agent reviewers.
          list("/api/people").catch(() => [])]) };
      } },
      // The repo itself and unknown repo pages land on the repo's Code.
      ...[{ index: true }, { path: "*" }].map((r) => ({ ...r, loader: async ({ params }) => redirect(scopedPath(await findRepo(params.repo), "code")) })),
    ] },
    ...scoped.map((page) => ({ path: `/${page}`, element: <PickRepo />, loader: async () => {
      const repos = await list("/api/repos");
      const last = lastRepo(repos);
      return last ? redirect(scopedPath(last, page)) : { page, repos };
    } })),
    { path: "/wiki", element: <WikiFolders />, loader: () => list("/api/repos") },
    ...pages,
  // Each top-level page catches its own errors, so they render inside the shell; the root's stays for a failed shell.
  ].map((r) => ({ errorElement: <ErrorPage />, ...r })),
}];
