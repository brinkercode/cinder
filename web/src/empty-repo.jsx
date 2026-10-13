// A repo with no code (repo.empty) shows one empty state on each repo page instead of the page's data.
import { Link, Outlet, useLocation, useRouteLoaderData } from "react-router";
import { Ic } from "./icons.jsx";
import { scopedPath } from "./shell.jsx";
import { EmptyState, Frame } from "./ui.jsx";

// page: [icon, title, sentence, primary action label]; {b} is the default branch, {r} the repo.
const EMPTY = {
  changes: ["merge", "No changes yet", "Describe what you want and an agent writes it, or push your own work to refs/for/{b}.", "Describe a change"],
  releases: ["tag", "No releases yet", "Tag a commit on {b} once code lands, then draft release notes here."],
  watchtower: ["shield", "Nothing to scan yet", "Watchtower scans dependencies and agent network egress once the repository has code."],
  wiki: ["book", "No wiki pages yet", "Write docs that live next to the code. Agents read the wiki for context.", "Create the first page"],
  insights: ["chart", "No data yet", "Insights fill in after the first changes merge. Rates stay hidden until there are enough outcomes to trust."],
  flows: ["play", "No flows yet", "Flows come from .cinder.yml: add one to define checks and deploys for {r}."],
  environments: ["globe", "No environments yet", "Environments are declared in .cinder.yml under deploy. Add one once {r} has code."],
};

// Issues and wiki pass ?new through to the page itself, where the first one is written.
export function EmptyRepo({ repo, page }) {
  const [icon, title, line, primary] = EMPTY[page];
  const to = page === "changes" ? `/${encodeURIComponent(repo.name)}/changes/new` : "?new=1";
  return <Frame><div className="card"><EmptyState icon={icon} title={title}
    action={<div className="row">
      {primary && <Link className="btn btn-primary" to={to}><Ic name={page === "changes" ? "robot" : "plus"} />{primary}</Link>}
      <Link className={`btn ${primary ? "btn-secondary" : "btn-primary"}`} to={scopedPath(repo, "code")}><Ic name="term" />Quick setup</Link>
    </div>}>{line.replace("{b}", repo.default_branch).replace("{r}", repo.name)}</EmptyState></div></Frame>;
}

// The /:repo route's element: a page directly under an empty repo shows its empty state; deeper paths and ?new pass.
export function RepoGate() {
  const repo = useRouteLoaderData("repo");
  const { pathname, search } = useLocation();
  const [, , page, rest] = pathname.split("/");
  if (!repo?.empty || rest !== undefined || !EMPTY[page] || new URLSearchParams(search).has("new")) return <Outlet />;
  return <EmptyRepo repo={repo} page={page} />;
}
