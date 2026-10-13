// The Branches modal, and patchLines for change detail's diff.
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { branchesFor, createBranch, deleteBranch } from "./client.js";
import { PiLock } from "react-icons/pi";
import { Br, State, Table, Tag } from "./ui.jsx";
import { RowsSkel } from "./skeleton.jsx";

const ROLE_TONE = { integration: "brand", release: "info", other: undefined };
// New change from a branch: the target is the base, the branch is the head.
export const newChangePath = (repo, base, head) => `/${encodeURIComponent(repo)}/changes/new?target=${encodeURIComponent(base)}&head=${encodeURIComponent(head)}`;

// The Branches modal from "See all branches…" in the top bar's branch dropdown; mounted while open. The API refuses
// create and delete to anyone but an owner or maintainer, and the reason shows here.
export function Branches({ repo, target, to, onTarget, onClose }) {
  const [branches, setBranches] = useState(null);
  const [error, setError] = useState(null);
  const [q, setQ] = useState("");
  const match = (b) => b.name.toLowerCase().includes(q.trim().toLowerCase());
  useEffect(() => { branchesFor(repo.name).then(setBranches, (e) => setError(e.message)); }, [repo.name]);
  const run = async (write) => {
    setError(null);
    try {
      await write();
      setBranches(await branchesFor(repo.name));
    } catch (e) {
      setError(e.message);
    }
  };
  const create = (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    run(async () => {
      await createBranch(repo.name, new FormData(form).get("name"));
      form.reset();
    });
  };
  return (
    <dialog className="dlg" aria-label="Branches" ref={(d) => { if (d && !d.open) d.showModal(); }} onClose={onClose}>
      <div className="panel-head"><h2>Branches</h2></div>
      <div className="pad">
        <div className="row">
        <input className="input" type="search" aria-label="Search branches" placeholder="Search branches" value={q} onChange={(e) => setQ(e.target.value)} />
        <form className="row" onSubmit={create}>
          <input className="input mono" name="name" aria-label="New branch name" placeholder={`New branch from ${repo.default_branch}`} required />
          <button type="submit" className="btn btn-primary btn-sm">Create branch</button>
        </form>
        </div>
        {error && <p className="meta" role="alert">{error}</p>}
        {!branches ? <RowsSkel label="branches" /> : branches.length ? (
          <Table stack>
            <thead><tr><th>Branch</th><th>Role</th><th>Ahead</th><th>Behind</th><th /></tr></thead>
            <tbody>{branches.filter((b) => b.kind === "branch" && match(b)).map((b) => (
              <tr key={b.name}>
                <td data-l="Branch">{(b.role === "integration" || b.name === repo.default_branch) && <PiLock aria-label="protected" />}<Br name={b.name} />{b.name === repo.default_branch && <> <Tag tone="ok">default</Tag></>}</td>
                <td data-l="Role"><Tag tone={ROLE_TONE[b.role]}>{b.role}</Tag></td>
                <td data-l="Ahead" className="mono">↑{b.ahead}</td>
                <td data-l="Behind" className="mono">↓{b.behind}</td>
                <td>{b.name === target ? <Tag tone="info">target</Tag> : <Link className="btn btn-secondary btn-sm" to={to(b.name)} onClick={() => { onTarget(b.name); onClose(); }}>Set as target</Link>}
                  {b.name !== repo.default_branch && <> <Link to={newChangePath(repo.name, repo.default_branch, b.name)} onClick={onClose}>New change</Link></>}
                  {b.role !== "integration" && b.name !== repo.default_branch && <> <button type="button" className="btn btn-ghost btn-sm" aria-label={`Delete ${b.name}`}
                    onClick={() => confirm(`Delete branch ${b.name}?`) && run(() => deleteBranch(repo.name, b.name))}>Delete</button></>}</td>
              </tr>
            ))}</tbody>
          </Table>
        ) : <State title="No branches yet"><p>The default branch appears with the repository's first commit.</p></State>}
        {branches?.some((b) => b.kind === "tag") && <Table stack>
          <thead><tr><th>Tag</th><th>Commit</th></tr></thead>
          <tbody>{branches.filter((b) => b.kind === "tag" && match(b)).map((t) => (
            <tr key={t.name}><td data-l="Tag" className="mono">{t.name}</td><td data-l="Commit" className="mono">{t.head_sha.slice(0, 7)}</td></tr>
          ))}</tbody>
        </Table>}
      </div>
      <form method="dialog" className="dlg-foot"><button className="btn btn-ghost">Close</button></form>
    </dialog>
  );
}

// A unified patch as Diff lines; file headers before the first hunk are skipped.
export function patchLines(patch) {
  let o = 0;
  let n = 0;
  let inHunk = false;
  return patch.split("\n").flatMap((l) => {
    const h = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/);
    if (h) {
      [o, n, inHunk] = [Number(h[1]), Number(h[2]), true];
      return [["h", "", "", "", l]];
    }
    if (!inHunk || l.startsWith("\\")) return [];
    if (l[0] === "+") return [["a", "", n++, "", l.slice(1)]];
    if (l[0] === "-") return [["d", o++, "", "", l.slice(1)]];
    return [["c", o++, n++, "", l.slice(1)]];
  });
}
