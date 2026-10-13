// Flows: runs, and a DAG designer over .cinder/flows/*.yml whose YAML
// view is live. The layout is a longest-path DAG layout with a cycle guard:
// edges inside a cycle (lib/dag.js) stay out of the longest-path columns and are drawn dashed red.
import { Suspense, useEffect, useReducer, useRef, useState } from "react";
import { Await, Link, useLoaderData, useParams, useRevalidator, useSearchParams } from "react-router";
import { flowYaml, parseFlow, planFlow, validateFlow } from "../../worker/src/api/contract.js";
import { parseYaml } from "../../worker/src/yaml.js";
import { flakes, sinceDay } from "./api/flakes.js";
import { BarChart } from "./charts.jsx";
import { connector, layout } from "./lib/dag.js";
import { flowFile } from "./api/flows.js";
import { repoNamed } from "./api/repos.js";
import { branchesFor, branchLists, flowRuns, flowsFor, get, invalidate, list, listen, proposeFiles, startFlowRun } from "./client.js";
import { Ic } from "./icons.jsx";
import { BonePill, BoneText, ChartSkel, ListCardSkel, LoadingRegion, TileSkel, useShape } from "./skeleton.jsx";
import { ChangeId, Dot, EmptyState, ErrorState, IdText, Mid, Tabs, Tag, Tile, Frame } from "./ui.jsx";
import "./styles/flows.css";

export async function flowsLoader({ params, request }) {
  const repo = await repoNamed(params.repo);
  const runs = flowRuns(repo.name);
  const q = new URL(request.url).searchParams, target = q.get("target") ?? repo.default_branch;
  runs.catch(() => {}); // <Await> shows a failed load; this stops an unhandled rejection before it renders
  const at = flowsFor(repo, target);
  // The branch menu's list loads beside the flows, never before them; the menu reports its own failed load.
  branchesFor(repo.name).then((bs) => branchLists.set(repo.name, bs), () => {});
  // The designer's pool and secret pickers are prefetched with the flows, so opening the inspector never waits.
  // The keystore needs keystore.read: without it the secret picker is empty, the page still loads.
  const [flows, pools, byo, keystore] = await Promise.all([at, list("/api/workers/pools"), list("/api/workers/byo-pools"), get("/api/keystore").catch(() => ({ secrets: [] }))]);
  // Only the flow opened on the canvas loads its file, deferred so the rail draws from the list without waiting for it.
  const name = q.get("flow") ?? flows.list[0]?.flow;
  const entry = q.get("view") === "designer" && flows.list.find((f) => f.flow === name);
  // The list carries the first flow's file; any other flow's is fetched.
  const file = entry ? (entry.file ? { ...entry.file, head: entry.head } : flowFile(repo.name, name, target)) : null;
  if (file instanceof Promise) file.catch(() => {}); // <Await> shows a failed load
  return { repo, target, runs, file, ...flows, pools: [...pools, ...byo], secrets: keystore.secrets };
}

const TYPES = { command: ["term", "Command", "Runs on a cinder worker"], verify: ["shieldck", "Verify", "Hands the change to the verifier"],
  cf: ["bolt", "Cloudflare Workflow", "Hands off to a Cloudflare Workflow"], deploy: ["globe", "Deploy", "Deploys to a target cloud"], approval: ["hand", "Approval gate", "Waits for a role to approve"] };
// What a new step, or a step switched to a type, starts with; the type is read back from these fields.
const FRESH = { command: { run: "echo hello" }, verify: { uses: "cinder/verify" }, cf: { uses: "cloudflare/workflow", workflow: "wf-new" }, deploy: { deploy: "preview", target: "Cloudflare" }, approval: { approval: "maintainers" } };
const CLEAR = { run: "", deploy: "", uses: undefined, workflow: undefined, target: undefined, approval: undefined, matrix: undefined, aws: undefined, gcp: undefined, azure: undefined, ssh: undefined };
const typeOf = (s) => ({ "cinder/verify": "verify", "cloudflare/workflow": "cf" })[s.uses] ?? (s.approval != null ? "approval" : s.deploy ? "deploy" : "command");
const TARGETS = ["Cloudflare", "AWS", "Google Cloud", "Azure", "Bring your own (SSH)"];
// Each target's config key (TARGET_CONFIG in the contract) and its fields below Target and Environment: [key, label, options as [value, label]].
const CLOUD = { AWS: "aws", "Google Cloud": "gcp", Azure: "azure", "Bring your own (SSH)": "ssh" };
const CLOUD_FIELDS = {
  aws: [["region", "Region"], ["service", "Service", [["lambda", "Lambda"], ["ecs", "ECS"], ["apprunner", "App Runner"]]], ["resource", "Resource"]],
  gcp: [["region", "Region"], ["service", "Service", [["run", "Cloud Run"], ["functions", "Cloud Functions"]]], ["name", "Name"]],
  azure: [["subscription", "Subscription"], ["resource_group", "Resource group"], ["service", "Service", [["containerapps", "Container Apps"], ["functions", "Functions"]]], ["app", "App"]],
  ssh: [["host", "Host"], ["user", "User"], ["command", "Command"], ["fingerprint", "Known host fingerprint"]],
};
// Authentication per cloud: the federated option's field (none for azure), then the two choices.
const AUTH = { aws: ["role_arn", "Role ARN", "Assume role (OIDC)", "Access key from Keystore"], gcp: ["provider", "Workload identity provider", "Workload identity", "Service account key from Keystore"],
  azure: [null, null, "Federated credential", "Client secret from Keystore"] };
const TRIGGERS = [["change", "A change is opened or updated"], ["push", "Push to an integration branch"], ["cron", "On a schedule"], ["manual", "Manual run"]];
const CONC = [["", "Not set"], ["cancel", "Cancel older runs on the same change"], ["queue", "Queue runs"], ["parallel", "Run all in parallel"]];
const COND = [["success()", "When all dependencies succeed"], ["always()", "Always"], ["failure()", "Only on failure"]];
const TEMPLATES = {
  ci: "name: ci\non: [change, manual]\nsteps:\n  install: { stage: build, run: \"npm ci\", needs: [] }\n  test: { stage: build, run: \"npm test\", needs: [install] }\n  verify: { stage: verify, uses: \"cinder/verify\", needs: [test] }\n",
  deploy: "name: deploy\non: [push, manual]\nsteps:\n  test: { stage: build, run: \"npm test\", needs: [] }\n  ship: { stage: deploy, deploy: production, target: \"Cloudflare\", needs: [test] }\n",
};
const STEP = { queued: ["", "Queued"], running: ["info", "Running"], passed: ["ok", "Done"], failed: ["bad", "Failed"], skipped: ["", "Skipped"] };
const RUN = { queued: ["", "circle"], claimed: ["running", "spin"], done: ["pass", "okc"], failed: ["fail", "xc"] };
const RANGES = [["0.5", "Last 30 minutes"], ["6", "Last 6 hours"], ["24", "Last 24 hours"], ["168", "Last 7 days"], ["720", "Last 30 days"]];
const wfHref = (wf) => `https://dash.cloudflare.com/?to=/:account/workers/workflows/${encodeURIComponent(wf ?? "")}`;
const NW = 208, NH = 84, CW = 256, X0 = 32 + CW, Y0 = 64, RH = 112;

const edgesOf = (steps) => steps.flatMap((s) => s.needs.map((n) => [n, s.name]));
const edgePath = (a, b, dashed) => connector([a[0] + NW, a[1] + NH / 2], [b[0], b[1] + NH / 2], dashed);
const sub = (s) => ({ deploy: `${s.target ?? "Cloudflare"} · ${s.deploy}`, cf: s.workflow, approval: s.approval || "approvers", verify: "verifier + judges", command: s.run })[typeOf(s)] + (s.matrix ? " · matrix" : "");
const matrixText = (m) => (m && typeof m === "object" ? Object.entries(m).map(([k, v]) => `${k}: [${[].concat(v).join(", ")}]`).join(", ") : m ?? "");
const combos = (m) => (m && typeof m === "object" ? Object.values(m).reduce((n, v) => n * [].concat(v).length, 1) : 0);
const ROW = { passed: ["pass", "okc"], failed: ["fail", "xc"], running: ["running", "spin"] };
export const dur = (ms) => (ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60000)}m ${Math.floor(ms / 1000) % 60}s`);
const zoomTo = (z) => Math.min(1.5, Math.max(0.5, +z.toFixed(2)));
// Text that reads as {axis: [values]} is kept as that map; anything else stays text, which validateFlow flags so save stays blocked.
const toMatrix = (v) => {
  if (!v.trim()) return undefined;
  try { const m = parseYaml(`m: { ${v} }`).m; return Object.values(m).every(Array.isArray) ? m : v; } catch { return v; }
};
const read = (text, name) => { try { return [parseFlow(text), null]; } catch (e) { return [{ name, on: ["manual"], cron: "", env: {}, steps: [] }, e.message]; } };

// Every graph edit goes through reduce, which returns the next graph {flow, bad, pos}; history keeps the 50 before it for undo.
function reduce(g, a) {
  if (a.type === "flow") return { ...g, flow: { ...g.flow, ...a.patch } };
  if (a.type === "steps") return { ...g, flow: { ...g.flow, steps: a.steps } };
  if (a.type === "add") return { ...g, flow: { ...g.flow, steps: [...g.flow.steps, a.step] }, pos: a.xy ? { ...g.pos, [a.step.name]: a.xy } : g.pos };
  if (a.type === "move") return { ...g, pos: { ...g.pos, [a.name]: a.xy } };
  if (a.type === "layout") return { ...g, pos: {} };
  try { return { ...g, flow: parseFlow(a.text), bad: null }; } catch (e) { return { ...g, bad: e.message }; } // "yaml"
}
function history(h, a) {
  if (a.type !== "undo" && a.type !== "redo") return { g: reduce(h.g, a), past: [...h.past, h.g].slice(-50), future: [] };
  const [from, to] = a.type === "undo" ? ["past", "future"] : ["future", "past"];
  return h[from].length ? { ...h, g: h[from].at(-1), [from]: h[from].slice(0, -1), [to]: [...h[to], h.g] } : h;
}

export function Designer({ repo, target, head, name, text, last = {}, pools = [], secrets = [], reload }) {
  const [h, dispatch] = useReducer(history, null, () => { const [flow, bad] = read(text, name); return { g: { flow, bad, pos: {} }, past: [], future: [] }; });
  const { flow, bad, pos } = h.g;
  const [yaml, setYaml] = useState(null); // the YAML view's text while it's being typed
  const [mode, setMode] = useState("graph"); // graph, split or yaml
  const [dry, setDry] = useState(null); // each step's dry-run status while one runs
  const timer = useRef(null);
  const [view, setView] = useState({ z: 1, x: 0, y: 0 }); // zoom, and the pan in canvas units
  const [live, setLive] = useState(null); // [step, xy] while a step is dragged
  const [sel, setSel] = useState(null); // a step's name, "a>b" for the edge from a to b, or "" for the Flow tab
  const [msg, setMsg] = useState(null);
  const [tmp, setTmp] = useState(null);
  const [saving, setSaving] = useState(false);
  const box = useRef(null);
  const steps = flow.steps, edges = edgesOf(steps);
  const { positions, cycleEdges } = layout(steps.map((s) => s.name), edges.map(([from, to]) => ({ from, to })));
  const cyc = new Set(cycleEdges.map((e) => `${e.from}>${e.to}`));
  const xy = Object.fromEntries(steps.map(({ name: n }) => [n, live?.[0] === n ? live[1] : pos[n] ?? [X0 + positions[n].col * CW, Y0 + positions[n].row * RH]]));
  const cols = Math.max(0, ...Object.values(positions).map((p) => p.col)) + 1, roots = steps.filter((s) => positions[s.name].col === 0);
  const W = Math.max(X0 + cols * CW, ...Object.values(xy).map(([x]) => x + NW)) + 80, H = Math.max(Y0 + 2 * RH, ...Object.values(xy).map(([, y]) => y + NH)) + 60;
  const trig = [32, Y0 + Math.max(0, (roots.length - 1) * RH / 2)];
  const cur = steps.find((s) => s.name === sel), t = cur && typeOf(cur), [ea, eb] = sel?.split(">") ?? [];
  const invalid = validateFlow(flow).errors;
  const state = (n) => (dry?.[n] ? { status: dry[n] } : last[n]);
  const dryBusy = Object.values(dry ?? {}).some((v) => v === "queued" || v === "running");
  const lines = flowYaml(flow).split("\n").slice(0, -1), stepsAt = lines.indexOf("steps:");
  const repoKeys = [...new Set(secrets.filter((k) => k.scope === "global" || k.repo === repo.name).map((k) => k.name))];
  const change = (a) => { dispatch(a); setYaml(null); setMsg(null); };
  const setFlow = (patch) => change({ type: "flow", patch });
  const edit = (next) => change({ type: "steps", steps: next });
  const undo = (type) => { dispatch({ type }); setYaml(null); setSel(null); };
  const put = (patch) => edit(steps.map((s) => (s.name === sel ? { ...s, ...patch } : s)));
  const remove = () => {
    edit(eb ? steps.map((s) => (s.name === eb ? { ...s, needs: s.needs.filter((n) => n !== ea) } : s))
      : steps.filter((s) => s.name !== sel).map((s) => ({ ...s, needs: s.needs.filter((n) => n !== sel) })));
    setSel(null);
  };
  const rename = (v) => {
    v = v.trim().replace(/\s+/g, "-");
    if (v && !steps.some((s) => s.name === v)) { edit(steps.map((s) => ({ ...s, name: s.name === sel ? v : s.name, needs: s.needs.map((n) => (n === sel ? v : n)) }))); setSel(v); }
  };
  const add = (type, at, after) => {
    const base = type === "cf" ? "workflow" : type;
    let id = base;
    for (let i = 2; steps.some((s) => s.name === id); i++) id = `${base}-${i}`;
    change({ type: "add", step: { name: id, stage: "build", run: "", deploy: "", needs: after ? [after] : [], ...FRESH[type] }, xy: at });
    setSel(id);
  };
  const typed = (v) => { setYaml(v); setMsg(null); dispatch({ type: "yaml", text: v }); };
  const validate = () => setMsg(invalid.length ? ["bad", invalid.join("; ")] : ["ok", `Valid. ${steps.length} steps, ${edges.length} dependencies, no cycles.`]);
  // Walks planFlow's stages ~700 ms each in the browser: a stage's steps run, then pass; approval gates are skipped.
  const dryRun = () => {
    if (invalid.length) return setMsg(["bad", cyc.size ? "Fix the cycle before a dry run." : `Fix these before a dry run: ${invalid.join("; ")}`]);
    const levels = planFlow(flow).stages.map((st) => [...new Set(st.jobs.flatMap((j) => j.steps))]);
    const gate = (n) => steps.find((s) => s.name === n)?.approval != null;
    let c = 0, now = Object.fromEntries(steps.map((s) => [s.name, "queued"]));
    const tick = () => {
      for (const n of levels[c - 1] ?? []) if (!gate(n)) now = { ...now, [n]: "passed" };
      for (const n of levels[c] ?? []) now = { ...now, [n]: gate(n) ? "skipped" : "running" };
      setDry(now);
      if (c++ < levels.length) timer.current = setTimeout(tick, 700);
      else setMsg(["ok", `Dry run passed. ${steps.length} steps in ${(levels.length * 0.7).toFixed(1)}s. Gates were skipped.`]);
    };
    setMsg(null);
    tick();
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  const save = () => {
    setSaving(true);
    proposeFiles(repo.name, { target, intent: `Flows: save ${name}`, base_sha: head, changes: [{ path: `.cinder/flows/${name}.yml`, content: flowYaml(flow) }] })
      .then((c) => setMsg(["ok", <>Opened change <ChangeId id={c.id} label={c.key} /> with .cinder/flows/{name}.yml. The verifier runs it before merge.</>]), (e) => {
        if (e.status !== 409) return setMsg(["bad", e.message]);
        setMsg(["bad", `${target} moved since this page loaded. Reloading it…`]);
        reload();
      })
      .finally(() => setSaving(false));
  };
  const rel = (e) => { const r = box.current.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  // A pointer's canvas point: divide by zoom, subtract pan.
  const at = (e) => { const [sx, sy] = rel(e); return [sx / view.z - view.x, sy / view.z - view.y]; };
  // Zooms keeping the canvas point under s (box pixels) where it is.
  const zoom = (f, [sx, sy] = [0, 0]) => setView((v) => { const z = zoomTo(f(v.z)); return { z, x: sx / z - sx / v.z + v.x, y: sy / z - sy / v.z + v.y }; });
  const fit = () => setView({ z: zoomTo(Math.min(box.current.clientWidth / W, box.current.clientHeight / H)), x: 0, y: 0 });
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    // Not onWheel: React's wheel listener is passive, so it couldn't stop the browser zooming the page.
    const wheel = (e) => { if (!e.ctrlKey && !e.metaKey) return; e.preventDefault(); zoom((z) => z + (e.deltaY < 0 ? 0.1 : -0.1), rel(e)); };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [mode]); // zoom and rel only read setView and the ref, so the first render's are enough
  // Pointer moves are followed on window, so a drag keeps going outside the canvas.
  const drag = (move, up) => {
    const done = (e) => { removeEventListener("pointermove", move); removeEventListener("pointerup", done); up(e); };
    addEventListener("pointermove", move); addEventListener("pointerup", done);
  };
  const pan = (e) => {
    setSel(null);
    const [sx, sy] = rel(e), v = view;
    drag((m) => { const [mx, my] = rel(m); setView({ ...v, x: v.x + (mx - sx) / v.z, y: v.y + (my - sy) / v.z }); }, () => {});
  };
  const grab = (e, node) => {
    e.stopPropagation();
    if (bad) return;
    const [sx, sy] = at(e), [ox, oy] = xy[node], snap = (v) => Math.max(0, Math.round(v / 8) * 8);
    const to = (m) => { const [x, y] = at(m); return [snap(ox + x - sx), snap(oy + y - sy)]; };
    drag((m) => setLive([node, to(m)]), (u) => {
      const p = to(u);
      setLive(null);
      if (p[0] !== ox || p[1] !== oy) change({ type: "move", name: node, xy: p });
      setSel(node);
    });
  };
  const connect = (e, out) => {
    e.stopPropagation();
    e.preventDefault();
    if (bad) return;
    const from = [xy[out][0] + NW, xy[out][1] + NH / 2];
    drag((m) => setTmp(connector(from, at(m)).d), (u) => {
      setTmp(null);
      const [x, y] = at(u), to = steps.find(({ name: n }) => x >= xy[n][0] && x <= xy[n][0] + NW && y >= xy[n][1] && y <= xy[n][1] + NH)?.name;
      if (!to || to === out || steps.find((s) => s.name === to).needs.includes(out)) return;
      edit(steps.map((s) => (s.name === to ? { ...s, needs: [...s.needs, out] } : s)));
      setSel(to);
    });
  };
  const drop = (e) => {
    const type = e.dataTransfer.getData("text/cinder-step");
    if (!TYPES[type] || bad) return;
    e.preventDefault();
    const [x, y] = at(e);
    add(type, [x - NW / 2, y - NH / 2]);
  };
  // lazy: the box size is read at render, so the minimap's viewport catches up with a resize on the next render.
  const ms = Math.min(176 / W, 104 / H), vw = (box.current?.clientWidth ?? 0) / view.z, vh = (box.current?.clientHeight ?? 0) / view.z;
  const jump = (e) => {
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    setView((v) => ({ ...v, x: vw / 2 - (e.clientX - r.left) / ms, y: vh / 2 - (e.clientY - r.top) / ms }));
  };
  const keys = (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "z" || e.target.nodeName === "TEXTAREA") return;
    e.preventDefault();
    undo(e.shiftKey ? "redo" : "undo");
  };
  const field = (label, k) => <label className="fld">{label}<input className="mono" value={cur[k] ?? ""} onChange={(e) => put({ [k]: e.target.value })} /></label>;
  const cloud = CLOUD[cur?.target], tc = cur?.[cloud] ?? {};
  const putCloud = (patch) => put({ [cloud]: { ...tc, ...patch } });
  // A credential is chosen from Keystore names, never typed, so no secret value lands in the flow file.
  const secretPick = (label, k) => <label className="fld">{label}<select className="mono" value={tc[k] ?? ""} onChange={(e) => putCloud({ [k]: e.target.value })}>
    <option value="">Pick a Keystore secret</option>{[...new Set([...repoKeys, ...(tc[k] ? [tc[k]] : [])])].map((n) => <option key={n}>{n}</option>)}</select></label>;
  const pick = (label, k, options) => <label className="fld">{label}<select value={cur[k] ?? options[0]} onChange={(e) => put({ [k]: e.target.value })}>{[...new Set([...options, cur[k] ?? options[0]])].map((o) => <option key={o}>{o}</option>)}</select></label>;
  const banner = bad ? ["bad", `This flow's YAML doesn't parse (${bad}), so the graph is read-only.`] : msg
    ?? (cyc.size ? ["bad", `Cycle detected on ${[...cyc].map((k) => k.replace(">", " → ")).join(", ")}. The red edge won't run.`]
      : invalid.length ? ["bad", invalid.join("; ")] : null);
  // A pool is picked by its labels, which is what runs-on matches; labels no pool has stay listed so they aren't lost.
  const poolPick = (label, v, set, none) => {
    const opts = pools.filter((p) => p.labels?.length).map((p) => [p.labels.join(","), p.name]);
    if (v?.length && !opts.some(([k]) => k === v.join(","))) opts.push([v.join(","), v.join(", ")]);
    return <label className="fld">{label}<select value={v?.join(",") ?? ""} onChange={(e) => set(e.target.value ? e.target.value.split(",") : undefined)}>
      <option value="">{none}</option>{opts.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>;
  };
  const tool = (label, onClick, children, disabled = false) => <button type="button" className="btn btn-secondary btn-sm" aria-label={label} title={label} disabled={disabled} onClick={onClick}>{children}</button>;
  return (
    <>
      <section className="panel dag-main" onKeyDown={keys}>
        <div className="panel-head">
          <h2 className="mono">{name}</h2><span className="meta">.cinder/flows/{name}.yml · {steps.length} steps</span>
          <span className="end row">
            {tool("Undo (Ctrl Z)", () => undo("undo"), "Undo", !h.past.length)}{tool("Redo (Ctrl Shift Z)", () => undo("redo"), "Redo", !h.future.length)}
            {tool("Zoom out", () => zoom((z) => z - 0.1), "−", mode === "yaml")}{tool("Reset zoom", () => zoom(() => 1), `${Math.round(view.z * 100)}%`, mode === "yaml")}
            {tool("Zoom in", () => zoom((z) => z + 0.1), "+", mode === "yaml")}{tool("Fit to view", fit, "Fit", mode === "yaml")}
            <button type="button" className="btn btn-secondary btn-sm" disabled={!Object.keys(pos).length} onClick={() => change({ type: "layout" })}><Ic name="graph" />Auto layout</button><button type="button" className="btn btn-secondary btn-sm" onClick={validate}><Ic name="check" />Validate</button>
            <button type="button" className="btn btn-secondary btn-sm" disabled={dryBusy} onClick={dryRun}><Ic name="play" />Dry run</button>
            <Tabs label="Flow view" options={[["graph", "Graph"], ["split", "Split"], ["yaml", "YAML"]]} value={mode} onChange={setMode} />
            <button type="button" className="btn btn-primary btn-sm" disabled={!!bad || !head || saving || invalid.length > 0} onClick={save}>{saving ? "Saving…" : "Save as change"}</button>
          </span>
        </div>
        {banner && <div className={`strip ${banner[0]}`} role="status"><Ic name={banner[0] === "bad" ? "tri" : "okc"} /><span>{banner[1]}</span>
          {banner === msg && <button type="button" className="iconbtn end" aria-label="Dismiss" onClick={() => setMsg(null)}><Ic name="x" /></button>}</div>}
        {mode === "yaml" ? <textarea className="dag-yaml mono" aria-label="Flow YAML" spellCheck={false} value={yaml ?? flowYaml(flow)} onChange={(e) => typed(e.target.value)} />
          : <div className={`dag-body${mode === "split" ? " split" : ""}`}><Palette add={add} />
            <div className="dag" ref={box} tabIndex={0} aria-label="Flow graph" onPointerDown={pan} onDragOver={(e) => e.dataTransfer.types.includes("text/cinder-step") && e.preventDefault()} onDrop={drop}
              onKeyDown={(e) => !bad && sel && ["Delete", "Backspace"].includes(e.key) && remove()}>
              <div className="dag-layer" style={{ width: W, height: H, transform: `scale(${view.z}) translate(${view.x}px, ${view.y}px)` }}>
                <div className="dag-lane" style={{ left: 20, width: NW + 24, height: H }}><span>Trigger</span></div>
                {Array.from({ length: cols }, (_, c) => <div key={c} className="dag-lane" style={{ left: X0 + c * CW - 12, width: NW + 24, height: H }}><span>Stage {c + 1}</span></div>)}
                <svg className="dag-svg" width={W} height={H}>
                  <defs><pattern id="dots" width="16" height="16" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="var(--chart-grid)" /></pattern>
                    {[["arr", "var(--text-inactive)"], ["arrb", "var(--danger-fill)"]].map(([id, fill]) => <marker key={id} id={id} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 8,4 0,8z" fill={fill} /></marker>)}</defs>
                  <rect width="100%" height="100%" fill="url(#dots)" />
                  {roots.map((s) => { const { d, dash } = connector([trig[0] + NW, trig[1] + 30], [xy[s.name][0], xy[s.name][1] + NH / 2], true); return <path key={s.name} className="dag-e trig" d={d} strokeDasharray={dash} />; })}
                  {edges.filter(([a, b]) => xy[a] && xy[b]).map(([a, b]) => {
                    const k = `${a}>${b}`, { d, dash } = edgePath(xy[a], xy[b], cyc.has(k));
                    return <g key={k} data-edge={k} onPointerDown={(e) => { e.stopPropagation(); setSel(k); }}>
                      <path className={`dag-e${cyc.has(k) ? " cyc" : ""}${sel === k ? " sel" : ""}${state(b)?.status === "running" ? " live" : ""}`} d={d} strokeDasharray={dash} markerEnd={`url(#${cyc.has(k) ? "arrb" : "arr"})`} /><path className="dag-hit" d={d} /></g>;
                  })}
                  {tmp && <path className="dag-e tmp" d={tmp} />}
                </svg>
                <div className="dag-n trig" style={{ left: trig[0], top: trig[1], width: NW }} onPointerDown={(e) => e.stopPropagation()} onClick={() => setSel("")}>
                  <div className="dn-h"><Ic name={flow.on.includes("cron") ? "clock" : flow.on.includes("change") ? "merge" : "play"} /><b>on</b></div><div className="dn-s">{flow.on.join(", ")}</div>
                </div>
                {steps.map((s) => {
                  const n = combos(s.matrix), r = state(s.name), [cls, icon] = ROW[r?.status] ?? ["", "circle"];
                  return <div key={s.name} data-node={s.name} className={`dag-n t-${typeOf(s)}${sel === s.name ? " sel" : ""}${n ? " mx" : ""}`} style={{ left: xy[s.name][0], top: xy[s.name][1], width: NW, height: NH }} onPointerDown={(e) => grab(e, s.name)}>
                    <span className="port in" /><div className="dn-h"><Ic name={TYPES[typeOf(s)][0]} /><b className="mono">{s.name}</b>{n > 0 && <span className="tag dn-mx" title={matrixText(s.matrix)}>×{n}</span>}</div>
                    <div className="dn-s">{sub(s)}</div>
                    <div className="dn-st">{r ? <><span className={`run-i ${cls}`}><Ic name={icon} /></span><span>{r.status}</span>{r.ms != null && <span className="mono">{dur(r.ms)}</span>}</> : <span>not run yet</span>}</div>
                    <span className="tag dn-t">{TYPES[typeOf(s)][1]}</span><span className="port out" data-out={s.name} title="Drag to connect" onPointerDown={(e) => connect(e, s.name)} />
                    <button type="button" className="dn-add" aria-label={`Add a step after ${s.name}`} onPointerDown={(e) => e.stopPropagation()} onClick={() => add("command", null, s.name)}><Ic name="plus" /></button>
                  </div>;
                })}
              </div>
              <svg className="dag-mini" width="176" height="104" viewBox={`0 0 ${176 / ms} ${104 / ms}`} aria-label="Minimap" onPointerDown={jump}>
                {steps.map((s) => <rect key={s.name} x={xy[s.name][0]} y={xy[s.name][1]} width={NW} height={NH} rx="12" />)}
                <rect className="vp" x={-view.x} y={-view.y} width={vw} height={vh} />
              </svg>
            </div>
            {mode === "split" && <pre className="dag-lines mono" aria-label="Flow YAML lines">{lines.map((l, i) =>
              <span key={i} className={i > stepsAt && l.startsWith(`  ${sel}: `) ? "yl on" : "yl"}><i>{i + 1}</i>{l}{"\n"}</span>)}</pre>}
          </div>}
      </section>
      <fieldset className="panel dag-insp" disabled={!!bad}>
        <div className="pad"><Tabs label="Inspector" options={[["step", "Step"], ["flow", "Flow"]]} value={sel === "" ? "flow" : "step"} onChange={(v) => setSel(v === "flow" ? "" : null)} /></div>
        {eb ? <><div className="panel-head"><h2>Dependency</h2></div>
          <div className="pad stack"><p><span className="mono">{eb}</span> runs after <span className="mono">{ea}</span></p>
            {cyc.has(sel) && <p className="strip bad"><Ic name="tri" />This edge closes a cycle. Remove it or the flow won&apos;t run.</p>}
            <button type="button" className="btn btn-secondary" onClick={remove}><Ic name="x" />Remove dependency</button></div>
        </> : cur ? <><div className="panel-head"><Ic name={TYPES[t][0]} /><h2 className="mono">{cur.name}</h2><button type="button" className="iconbtn end" aria-label="Close" onClick={() => setSel(null)}><Ic name="x" /></button></div>
          <div className="pad stack">
            <label className="fld">Name<input key={cur.name} className="mono" defaultValue={cur.name} onBlur={(e) => rename(e.target.value)} /></label>
            <label className="fld">Type<select value={t} onChange={(e) => put({ ...CLEAR, ...FRESH[e.target.value] })}>{Object.entries(TYPES).map(([k, [, l]]) => <option key={k} value={k}>{l}</option>)}</select></label>
            {t === "command" && <>{field("Run", "run")}<label className="fld">Matrix<input className="mono" value={matrixText(cur.matrix)} onChange={(e) => put({ matrix: toMatrix(e.target.value) })} placeholder="node: [20, 22]" /></label></>}
            {t === "cf" && <>{field("Workflow", "workflow")}<a href={wfHref(cur.workflow)} target="_blank" rel="noreferrer">View in Compute › Workflows <Ic name="ur" /></a></>}
            {t === "deploy" && <><label className="fld">Target<select value={cur.target ?? "Cloudflare"} onChange={(e) => put({ target: e.target.value, aws: undefined, gcp: undefined, azure: undefined, ssh: undefined })}>{[...new Set([...TARGETS, cur.target ?? "Cloudflare"])].map((o) => <option key={o}>{o}</option>)}</select></label>{pick("Environment", "deploy", ["preview", "staging", "production", "eu-batch"])}
              {cloud && <>{AUTH[cloud] && <label className="fld">Authentication<select value={tc.secret != null ? "secret" : "federated"}
                onChange={(e) => putCloud(e.target.value === "secret" ? { secret: "", ...(AUTH[cloud][0] && { [AUTH[cloud][0]]: undefined }) } : { secret: undefined })}>
                <option value="federated">{AUTH[cloud][2]}</option><option value="secret">{AUTH[cloud][3]}</option></select></label>}
              {tc.secret != null ? secretPick("Secret", "secret") : AUTH[cloud]?.[0] && <label className="fld">{AUTH[cloud][1]}<input className="mono" value={tc[AUTH[cloud][0]] ?? ""} onChange={(e) => putCloud({ [AUTH[cloud][0]]: e.target.value })} /></label>}
              {CLOUD_FIELDS[cloud].map(([k, label, opts]) => (opts ? <label key={k} className="fld">{label}<select value={tc[k] ?? ""} onChange={(e) => putCloud({ [k]: e.target.value })}>
                <option value="" disabled>Pick a service</option>{opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
                : <label key={k} className="fld">{label}<input className="mono" value={tc[k] ?? ""} onChange={(e) => putCloud({ [k]: e.target.value })} /></label>))}
              {cloud === "ssh" && secretPick("Key secret", "key_secret")}</>}</>}
            {t === "approval" && field("Approvers", "approval")}
            <div className="fld">Runs after<div className="needs">{steps.filter((o) => o !== cur).map((o) => <label key={o.name}>
              <input type="checkbox" checked={cur.needs.includes(o.name)} onChange={(e) => put({ needs: e.target.checked ? [...cur.needs, o.name] : cur.needs.filter((n) => n !== o.name) })} />
              <span className="mono">{o.name}</span></label>)}</div></div>
            <label className="fld">Condition<select value={cur.if ?? "success()"} onChange={(e) => put({ if: e.target.value === "success()" ? undefined : e.target.value })}>
              {COND.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
            {t !== "approval" && <>{poolPick("Worker pool", cur["runs-on"], (v) => put({ "runs-on": v }), "Flow default")}
              <label className="fld">Timeout<input className="mono" value={cur.timeout ?? ""} placeholder="30m" onChange={(e) => put({ timeout: e.target.value || undefined })} /></label>
              <label className="fld">Retries<select value={cur.retries ?? "0"} onChange={(e) => put({ retries: e.target.value === "0" ? undefined : e.target.value })}>{["0", "1", "2", "3"].map((r) => <option key={r}>{r}</option>)}</select></label>
              <div className="fld">Secrets<div className="needs">{[...new Set([...repoKeys, ...(cur.secrets ?? [])])].map((k) => <label key={k}>
                <input type="checkbox" checked={!!cur.secrets?.includes(k)} onChange={(e) => put({ secrets: e.target.checked ? [...(cur.secrets ?? []), k] : cur.secrets.filter((x) => x !== k) })} />
                <span className="mono">{k}</span></label>)}</div><span className="meta">Injected from Keystore at run time.</span></div></>}
            <button type="button" className="btn btn-danger" onClick={remove}><Ic name="x" />Delete step</button>
          </div>
        </> : sel === "" ? <div className="pad stack">
          <div className="fld">Runs on<div className="needs">{TRIGGERS.map(([k, l]) => <label key={k}>
            <input type="checkbox" checked={flow.on.includes(k)} onChange={(e) => setFlow({ on: e.target.checked ? [...flow.on, k] : flow.on.filter((x) => x !== k), ...(k === "cron" && { cron: "" }) })} />
            <span>{l}</span></label>)}</div></div>
          {flow.on.includes("cron") && <label className="fld">Cron (UTC)<input className="mono" value={flow.cron} placeholder="0 2 * * *" onChange={(e) => setFlow({ cron: e.target.value })} /></label>}
          <label className="fld">Concurrency<select value={flow.concurrency ?? ""} onChange={(e) => setFlow({ concurrency: e.target.value || undefined })}>{CONC.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          {poolPick("Default worker pool", flow["runs-on"], (v) => setFlow({ "runs-on": v }), "Any pool")}
          <p className="meta">Flows are read from the target branch. Saving opens a change; the verifier runs the new flow before it merges.</p>
        </div> : <div className="pad stack"><p className="meta">Select a step, a dependency or the trigger to edit it.</p>
          <dl className="dag-sum">{Object.entries(TYPES).map(([k, [i, l]]) => { const c = steps.filter((s) => typeOf(s) === k).length; return c > 0 && <div key={k}><dt><Ic name={i} />{l}</dt><dd>{c}</dd></div>; })}
            <div><dt><Ic name="graph" />Dependencies</dt><dd>{edges.length}</dd></div></dl></div>}
      </fieldset>
    </>
  );
}

const Palette = ({ add }) => <div className="dag-pal" aria-label="Step palette"><div className="panel-head"><h2>Add a step</h2></div>
  {Object.entries(TYPES).map(([k, [i, l, hint]]) => <button type="button" key={k} className="act" disabled={!add} draggable={!!add} onClick={() => add(k)}
    onDragStart={(e) => { e.dataTransfer.setData("text/cinder-step", k); e.dataTransfer.effectAllowed = "copy"; }}>
    <span className={k === "cf" ? "act-i human" : "act-i"}><Ic name={i} /></span><span><b>{l}</b><small>{hint}</small></span></button>)}
  <p className="pad meta">Drag a type onto the canvas or click it. Drag from a step&apos;s right port to another step to add a dependency. Delete removes the selection.</p>
</div>;

// Skeletons keep the real positions with bones for data.
const GHOST = [[32, 200], [280, 112], [280, 288], [528, 200], [776, 200]];
const GHOST_EDGES = [[0, 1], [0, 2], [1, 3], [2, 3], [3, 4]];
const VIEWS = [["runs", "Runs"], ["designer", "Designer"]];

// empty takes the ghost nodes' place, so a repo with no flows keeps the designer's layout.
const DesignerSkel = ({ empty }) => (
  <div className="dag-wrap">
    <nav className="panel dag-flows" aria-label="Flows"><div className="panel-head"><h2>Flows</h2></div>
      {!empty && [0, 1, 2].map((i) => <div key={i} className="dfl"><BoneText i={i} /></div>)}</nav>
    <section className="panel dag-main">
      <div className="panel-head"><BoneText large w={160} /><span className="end row"><button type="button" className="btn btn-secondary btn-sm" disabled><Ic name="check" />Validate</button>
        <button type="button" className="btn btn-primary btn-sm" disabled>Save as change</button></span></div>
      <div className="dag-body"><Palette />
      <div className="dag">
        <svg className="dag-svg" width={1036} height={404}>
          <defs><pattern id="dots" width="16" height="16" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="var(--chart-grid)" /></pattern></defs>
          <rect width="100%" height="100%" fill="url(#dots)" />
          {!empty && GHOST_EDGES.map(([a, b]) => <path key={`${a}>${b}`} className="dag-e ghost" d={edgePath(GHOST[a], GHOST[b]).d} />)}
        </svg>
        {empty ?? GHOST.map(([x, y], i) => <div key={i} className="dag-n ghost" style={{ left: x, top: y, width: NW, height: NH }} />)}
      </div></div>
    </section>
    <fieldset className="panel dag-insp" disabled />
  </div>
);

const noRuns = <div className="card"><EmptyState icon="play" title="No runs yet">Run a flow, or push to a branch one runs on.</EmptyState></div>;

function RunsSkel() {
  const { repo } = useParams();
  const steps = useShape(`flows/${repo}/steps`, 7).n, cards = useShape(`flows/${repo}/runs`, 5).n;
  return <LoadingRegion page="runs" busy>
    <div className="stack">
      <div className="tiles">{["Runs", "Pass rate", "Median duration", "Waiting for approval"].map((l) => <TileSkel key={l} label={l} />)}</div>
      {steps > 0 && <section className="panel"><div className="panel-head"><BoneText large w={160} /></div>
        {Array.from({ length: steps }, (_, i) => <div key={i} className="fstep"><span className="fs-n" /><div className="grow"><BoneText i={i} /></div><BonePill row={i} /></div>)}</section>}
      <section className="panel"><div className="panel-head"><h2>Runs per hour</h2></div><div className="pad"><ChartSkel /></div></section>
      <div className="row"><input className="input grow" type="search" aria-label="Search runs" placeholder="Search runs" disabled /></div>
      <div className="stack">{cards ? Array.from({ length: cards }, (_, i) => <ListCardSkel key={i} />) : noRuns}</div>
    </div>
  </LoadingRegion>;
}

// The route's hydrate fallback: the real top row, then the view's skeleton.
export function FlowsSkeleton() {
  const [q] = useSearchParams();
  const view = q.get("view") === "designer" ? "designer" : "runs";
  return (
    <Frame className="flows">
      <div className="row"><Tabs label="Flows" options={VIEWS} value={view} onChange={() => {}} />
        <span className="end row"><button type="button" className="btn btn-primary" disabled><Ic name="play" />Run flow</button></span></div>
      {view === "runs" ? <RunsSkel /> : <LoadingRegion page="designer" busy><DesignerSkel /></LoadingRegion>}
    </Frame>
  );
}

// The repo's quarantined tests and how each did at the run's sha; nothing when none is quarantined.
function Quarantined({ repo, sha }) {
  const [got, setGot] = useState(null);
  const [tries, setTries] = useState(0);
  useEffect(() => {
    let live = true;
    setGot(null);
    flakes(repo, sha).then((data) => live && setGot({ data }), (error) => live && setGot({ error }));
    return () => { live = false; };
  }, [repo, sha, tries]);
  const held = got?.data?.filter((f) => f.quarantined_since);
  if (held && !held.length) return null;
  const result = (r) => (r === "fail" ? <span className="pill"><Dot tone="warn" />failed · ignored</span> : { pass: "passed", skip: "skipped" }[r] ?? "not run");
  return <section className="panel">
    <div className="panel-head"><h2>Quarantined</h2><span className="meta">ran, but excluded from the verdict</span>
      <Link className="btn btn-secondary end" to={`/${encodeURIComponent(repo)}/settings#flaky-checks`}>Manage</Link></div>
    {got?.error ? <ErrorState message="Couldn't load quarantined tests." onRetry={() => setTries(tries + 1)} />
      : !held ? <div className="pad" aria-busy="true"><BoneText /></div>
        : <div className="tscroll"><table className="tbl"><thead><tr><th>Test</th><th>This run</th><th>Flake rate</th><th>Since</th></tr></thead>
          <tbody>{held.map((f) => <tr key={f.test}><td className="mono">{f.test}</td><td>{result(f.result)}</td>
            <td className="mono">{Math.round(f.rate * 100)}% <span className="meta">· {f.flakes}/{f.runs}</span></td><td className="meta">{sinceDay(f.quarantined_since)}</td></tr>)}</tbody></table></div>}
  </section>;
}

function Runs({ runs, names, target, q }) {
  const [find, setFind] = useState("");
  const [only, setOnly] = useState("");
  const [shown, setShown] = useState(true);
  const { revalidate } = useRevalidator();
  const now = Date.now(), age = (r) => (now - Date.parse(r.created_at)) / 36e5;
  const inRange = runs.filter((r) => age(r) <= Number(q.get("range") ?? 24));
  const ended = inRange.filter((r) => ["done", "failed"].includes(r.status)), passed = ended.filter((r) => r.status === "done").length;
  const ms = inRange.map((r) => r.step_ms).filter((m) => m != null).sort((a, b) => a - b), med = (ms[(ms.length - 1) >> 1] + ms[ms.length >> 1]) / 2;
  const secs = Math.round(med / 1e3);
  const hours = Array.from({ length: 24 }, (_, i) => runs.filter((r) => Math.floor(age(r)) === 23 - i));
  const run = runs.find((r) => r.id === q.get("run")) ?? runs[0];
  const { repo } = useParams();
  useShape(`flows/${repo}/steps`, 7, run ? run.steps.length : 0);
  useShape(`flows/${repo}/runs`, 5, inRange.length);
  // The shown run's flow file (refetched with each new runs list) gives its steps' types; until it loads, or when it
  // can't, steps show without them.
  const [file, setFile] = useState(null);
  const flow = (q.get("view") ?? "runs") === "runs" ? run?.flow : null;
  useEffect(() => {
    if (!flow) return;
    let live = true;
    flowFile(repo, flow, target).then((f) => live && setFile(f), () => live && setFile(null));
    return () => { live = false; };
  }, [repo, flow, target, runs]);
  const def = (r, name) => { try { return parseFlow(file.yaml).steps.find((s) => s.name === name) ?? {}; } catch { return {}; } };
  const ago = (r) => { const h = age(r); return h < 1 / 60 ? "now" : h < 1 ? `${Math.floor(h * 60)}m` : h < 48 ? `${Math.floor(h)}h` : `${Math.floor(h / 24)}d`; };
  return (
    <>
      <div className="tiles">
        <Tile label="Runs" value={inRange.length} />
        <Tile label="Pass rate" value={ended.length ? `${(passed / ended.length * 100).toFixed(1)}%` : "—"} sub={ended.length ? `n=${ended.length}` : undefined} untrusted={ended.length} />
        <Tile label="Median duration" value={ms.length ? (secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`) : "—"} sub={ms.length ? `n=${ms.length}` : undefined} />
        <Tile label="Waiting for approval" value={inRange.length ? inRange.filter((r) => r.waiting_approval).length : "—"} sub={inRange.length ? "runs" : undefined} />
      </div>
      {run && shown && <section className="panel">
        <div className="panel-head"><span className={`run-i ${RUN[run.status][0]}`}><Ic name={RUN[run.status][1]} /></span><h2 className="mono">{run.flow}</h2>
          <span className="end meta mono"><IdText text={run.id} /></span><button type="button" className="iconbtn" aria-label="Hide" onClick={() => setShown(false)}><Ic name="x" /></button></div>
        {run.status === "queued" && <p className="strip"><Ic name="info" />No flow executor has picked this run up yet, so its steps stay Queued.</p>}
        {run.steps.map((s, i) => {
          const d = def(run, s.name), type = typeOf(d);
          return <div key={s.name} className={`fstep ${s.status}`}><span className="fs-n">{s.status === "passed" ? <Ic name="check" /> : i + 1}</span>
            <div className="grow"><div className="fs-t"><span className="mono">{s.name}</span>{type === "cf" ? <Tag>Cloudflare Workflow</Tag> : type === "deploy" && <span className="pill"><Ic name="globe" />{d.target ?? "Cloudflare"}</span>}</div>
              {type === "cf" && <div className="lc-s"><span className="mono">{d.workflow}</span> · <a href={wfHref(d.workflow)} target="_blank" rel="noreferrer">View in Compute › Workflows <Ic name="ur" /></a></div>}
              {s.status === "failed" && s.missing_secrets?.length > 0 && <div className="lc-s">Missing secret <span className="mono">{s.missing_secrets.join(", ")}</span> · <Link to="/settings/keystore">Save it in Keystore</Link></div>}</div>
            <span className="pill"><span className={`dot ${STEP[s.status][0]}`} />{STEP[s.status][1]}</span></div>;
        })}
      </section>}
      {run && shown && <Quarantined repo={repo} sha={run.sha} />}
      <section className="panel">
        <div className="panel-head"><h2>Runs per hour</h2><span className="leg"><span><span className="dot info" />Passed {hours.flat().filter((r) => r.status === "done").length}</span>
          <span><span className="dot bad" />Failed {hours.flat().filter((r) => r.status === "failed").length}</span></span></div>
        <div className="pad"><BarChart height={180} title="Time (UTC)" values={hours.map((h) => h.filter((r) => r.status === "done").length)} fails={hours.map((h) => h.filter((r) => r.status === "failed").length)}
          labels={hours.map((_, i) => `${new Date(now - (23 - i) * 36e5).toISOString().slice(11, 13)}:00`)} /></div>
      </section>
      <div className="row">
        <input className="input grow" type="search" aria-label="Search runs" placeholder="Search runs" value={find} onChange={(e) => setFind(e.target.value)} />
        <select aria-label="Flow" value={only} onChange={(e) => setOnly(e.target.value)}><option value="">All flows</option>{names.map((f) => <option key={f}>{f}</option>)}</select>
        <button type="button" className="iconbtn" aria-label="Refresh" onClick={() => { invalidate(); revalidate(); }}><Ic name="refresh" /></button>
      </div>
      <div className="stack">
        {!inRange.length && noRuns}
        {inRange.filter((r) => (!only || r.flow === only) && `${r.flow} ${r.id} ${r.sha}`.includes(find)).map((r) => (
          <Link key={r.id} className="lc" aria-current={r === run} to={`/${encodeURIComponent(repo)}/flows/runs/${encodeURIComponent(r.id)}`}>
            <span className={`run-i ${RUN[r.status][0]}`}><Ic name={RUN[r.status][1]} /></span><span className="grow"><span className="lc-t mono">{r.flow}</span><span className="lc-s mono"><IdText text={r.id} /> · {r.sha.slice(0, 7)}</span></span>
            <span className="steps">{(r.stages ?? []).map((s) => <span key={s.id} className={`step ${s.status}`} title={`${s.id}: ${s.status}`}><i />{s.id}</span>)}</span>
            <span className="meta">{ago(r)}</span>
          </Link>
        ))}
      </div>
    </>
  );
}

// The flow list's groups by a flow's main trigger, and a flow run's status as RUN's.
const GROUPS = [["change", "On a change"], ["push", "On push"], ["cron", "Scheduled"], ["manual", "Manual"]];
const LAST = { queued: RUN.queued, running: RUN.claimed, passed: RUN.done, failed: RUN.failed };
function FlowCard({ f, on, pick }) {
  const { passed, failed, n, trusted } = f.health, last = f.last_run && LAST[f.last_run.status];
  return <button type="button" className="dfl fcard" aria-current={on} onClick={pick}>
    <span className="row">{last && <span className={`run-i ${last[0]}`}><Ic name={last[1]} /></span>}<b className="mono">{f.flow}</b><span className="meta end">{n} runs</span></span>
    <small>{f.on.join(", ") || "no trigger"}</small>
    <span className="hbar" title={`${passed} passed, ${failed} failed`}><i style={{ flex: passed }} />{failed > 0 && <i className="f" style={{ flex: failed }} />}</span>
    {!trusted && <small>untrusted: {n} outcomes</small>}
  </button>;
}

export function Flows() {
  const { repo, target, head, list: flows, file, runs, pools, secrets } = useLoaderData();
  const [q, setSearch] = useSearchParams();
  const setQ = (patch) => setSearch((p) => { for (const [k, v] of Object.entries(patch)) p.set(k, v); return p; });
  const [err, setErr] = useState(null);
  const { revalidate } = useRevalidator();
  // A run's update refreshes the flow list's last runs and health (no event: reconnected, refetch anyway).
  useEffect(() => listen(repo.name, (e) => { if (!e || JSON.parse(e.data).kind === "run.updated") revalidate(); }), [repo.name, revalidate]);
  const view = q.get("view") ?? "runs", names = flows.map((f) => f.flow), name = q.get("flow") ?? names[0], saved = names.includes(name);
  const template = (TEMPLATES[name] ?? TEMPLATES.ci).replace(/^name: .*/, `name: ${name}`);
  const run = () => startFlowRun(repo.name, name, target).then((r) => setQ({ view: "runs", run: r.id }), (e) => setErr(e.message));
  return (
    <Frame className="flows">
      <div className="row">
        <Tabs label="Flows" options={VIEWS} value={view} onChange={(v) => setQ({ view: v })} />
        <span className="meta">{repo.name} · target <Mid text={target} /></span>
        <span className="end row">
          {err && <span className="meta" role="alert">{err}</span>}
          {view === "runs" && <select aria-label="Time range" value={q.get("range") ?? "24"} onChange={(e) => setQ({ range: e.target.value })}>{RANGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>}
          <button type="button" className="btn btn-primary" disabled={!saved} onClick={run}><Ic name="play" />Run flow</button>
        </span>
      </div>
      <div className="stack" hidden={view !== "runs"}>
        <Suspense fallback={<RunsSkel />}>
          <Await resolve={runs} errorElement={<div className="card"><ErrorState message="Couldn't load runs." onRetry={revalidate} /></div>}>{(r) => <Runs runs={r} names={names} target={target} q={q} />}</Await>
        </Suspense>
      </div>
      <div hidden={view !== "designer"}>
        {name ? <div className="dag-wrap">
          <nav className="panel dag-flows" aria-label="Flows">
            <div className="panel-head"><h2>Flows</h2><button type="button" className="iconbtn end" aria-label="New flow" onClick={() => setQ({ flow: `flow-${names.length + 1}` })}><Ic name="plus" /></button></div>
            {GROUPS.map(([t, label]) => flows.some((f) => f.trigger === t) && <div key={t} role="group" aria-label={label}><h3 className="fgroup">{label}</h3>
              {flows.filter((f) => f.trigger === t).map((f) => <FlowCard key={f.flow} f={f} on={f.flow === name} pick={() => setQ({ flow: f.flow })} />)}</div>)}
            {!saved && <button type="button" className="dfl" aria-current><span><b className="mono">{name}</b><small>not saved yet</small></span></button>}
          </nav>
          {file ? <Suspense fallback={<section className="panel dag-main" aria-busy="true" />}>
            <Await resolve={file} errorElement={<section className="panel dag-main"><ErrorState message="Couldn't load this flow." onRetry={revalidate} /></section>}>
              {(f) => <Designer key={`${name}/${f.head}`} repo={repo} target={target} head={f.head} name={name} text={f.yaml} last={f.last_run_steps} pools={pools} secrets={secrets} reload={revalidate} />}</Await>
          </Suspense> : view === "designer" && !saved && <Designer key={`${name}/${head}`} repo={repo} target={target} head={head} name={name} text={template} pools={pools} secrets={secrets} reload={revalidate} />}
        </div> : <DesignerSkel empty={<EmptyState icon="graph" title="Add your first flow" action={<span className="row">{Object.keys(TEMPLATES).map((k) =>
          <button type="button" key={k} className="btn btn-secondary" onClick={() => setQ({ flow: k })}>{k} template</button>)}</span>}>
          A flow is a .cinder/flows/&lt;name&gt;.yml file: steps and the steps they run after. Start from a template.</EmptyState>} />}
      </div>
    </Frame>
  );
}
