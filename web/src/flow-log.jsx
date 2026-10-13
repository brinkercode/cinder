// A flow job's log: header, toolbar, annotations and its steps, each step's lines fetched when it opens.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { flowLogPage, logTextUrl } from "./api/flow-runs.js";
import { icon, jobName, ST, took } from "./flow-run.jsx";
import { Ic } from "./icons.jsx";

// px per line and per step header (runs.css), rows drawn past the window, and the line count past which the log is virtualised.
const ROW = 20, HEAD = 34, OVER = 40, BIG = 2000;
// lazy: Wrap makes long lines taller than ROW, so a wrapped log past BIG lines places its window by estimate; measure rows if that shows.
const NONE = [];
const NOLOG = ["queued", "skipped"];
const COLOURS = [["ok", /^\s*(✓|.*\bpassed\b|.*successfully)/i], ["err", /^\s*(×|✗|FAIL\b)/], ["warn", /\bwarn/i],
  ["src", /^\s+\d+\s*\||^[-+] /], ["dim", /^(remote:|>|\s*RUN\b|Receiving|Resolving)/]];

// A line's kind and the text it shows.
function look(text) {
  if (text.startsWith("##[group]")) return ["grp", text.slice(9)];
  const a = /^##\[(error|warning)\](.*)/.exec(text);
  if (a) return [a[1] === "error" ? "err ann" : "warn ann", a[2]];
  if (text.startsWith("[command]")) return ["cmd", text.slice(9)];
  return [COLOURS.find(([, re]) => re.test(text))?.[0] ?? "", text];
}

// Escape sequences: CSI (m[2] is its final byte, "m" for SGR), OSC, and any other ESC with its intermediate and final bytes.
// eslint-disable-next-line no-control-regex -- every escape starts with the ESC control character
const ESC = /\x1b(?:\[([0-?]*)[ -/]*([@-~])|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[ -/]*[0-~]?)/g;
// text without escapes, and its runs as {at, t, cls}: SGR bold is "bd", foreground 30–37 and 90–97 are "fg0"–"fg7".
// lazy: bright colours share the normal ones' class and background, 256 and RGB colours are dropped; add them if logs need them.
function ansi(text) {
  const segs = [];
  let plain = "", cls = "", fg = "", bold = false, i = 0;
  const put = (t) => { if (t) { segs.push({ at: plain.length, t, cls }); plain += t; } };
  for (const m of text.matchAll(ESC)) {
    put(text.slice(i, m.index));
    i = m.index + m[0].length;
    if (m[2] !== "m") continue;
    const ps = (m[1] || "0").split(";").map(Number);
    for (let k = 0; k < ps.length; k++) {
      const p = ps[k];
      if (p === 0) { fg = ""; bold = false; } else if (p === 1) bold = true;
      else if (p === 22) bold = false;
      else if (p === 39) fg = "";
      else if ((p >= 30 && p <= 37) || (p >= 90 && p <= 97)) fg = `fg${p % 10}`;
      else if (p === 38 || p === 48) k += ps[k + 1] === 5 ? 2 : 4; // skip the colour's arguments
    }
    cls = [fg, bold && "bd"].filter(Boolean).join(" ");
  }
  put(text.slice(i));
  return { plain, segs };
}

// A step's lines as rows: ##[endgroup] takes no row, each row lists the group headers (by n) it sits in, and hot holds
// the groups with an error or a failed test inside.
const parsed = new WeakMap();
function rowsOf(lines) {
  if (parsed.has(lines)) return parsed.get(lines);
  const rows = [], hot = new Set(), stack = [];
  for (const l of lines) {
    if (l.text.startsWith("##[endgroup]")) { stack.pop(); continue; }
    const { plain, segs } = ansi(l.text);
    const [kind, shown] = look(plain);
    // look only cuts a prefix, so the runs move left by its length.
    const cut = plain.length - shown.length;
    rows.push({ n: l.n, at: l.at, kind, shown, segs: segs.map((s) => ({ ...s, at: s.at - cut })), groups: [...stack] });
    if (kind.startsWith("err")) for (const g of stack) hot.add(g);
    if (kind === "grp") stack.push(l.n);
  }
  parsed.set(lines, { rows, hot });
  return parsed.get(lines);
}

// lines with page (from, more) laid over it; a page past the end leaves a gap, so it is dropped.
const merge = (lines, from, more) => (from > lines.length ? lines : [...lines.slice(0, from), ...more, ...lines.slice(from + more.length)]);

const hits = (t, q) => {
  let k = 0;
  for (let i = t.toLowerCase().indexOf(q); i >= 0; i = t.toLowerCase().indexOf(q, i + q.length)) k++;
  return k;
};
// The runs' text from a to b, styled runs in a span.
const paint = (segs, a, b) => segs.map((s) => {
  if (s.at >= b || s.at + s.t.length <= a) return null;
  const t = s.t.slice(Math.max(0, a - s.at), b - s.at);
  return s.cls ? <span key={s.at} className={s.cls}>{t}</span> : t;
});
function marked(t, segs, q, cur) {
  if (!q) return paint(segs, 0, t.length);
  const out = [], low = t.toLowerCase();
  let i = 0;
  for (let j = low.indexOf(q), k = 0; j >= 0; j = low.indexOf(q, i), k++) {
    out.push(paint(segs, i, j), <mark key={k} className={k === cur ? "cur" : undefined}>{paint(segs, j, j + q.length)}</mark>);
    i = j + q.length;
  }
  out.push(paint(segs, i, t.length));
  return out;
}

// Props are all plain values or stable callbacks, so a re-render of the log redraws only the lines that changed.
const Line = memo(function Line({ idx, n, at, kind, shown, segs, depth, fold, sel, term, cur, link, onPick, onFold }) {
  const label = { "err ann": "Error:", "warn ann": "Warning:" }[kind];
  return <div className={`ln${kind ? ` k-${kind}` : ""}${sel ? " sel" : ""}`}>
    <a className="n" href={`${link}${n + 1}`} onClick={(e) => { e.preventDefault(); onPick(idx, n); }}>{n + 1}</a>
    <span className="ts">{at.slice(11, 19)}</span>
    <span className="tx" style={depth ? { paddingLeft: depth * 18 } : undefined}>
      {fold !== undefined && <button type="button" className="lgp" aria-expanded={fold} onClick={() => onFold(idx, n, !fold)}><Ic name={fold ? "chevD" : "chevR"} /></button>}
      {kind === "cmd" && <i className="dol">$</i>}{label && <b>{label} </b>}{marked(shown, segs, term, cur)}
    </span>
  </div>;
});

export function FlowLog({ repo, run, job, stage, notes, sink, onRerun }) {
  const [params, setParams] = useSearchParams();
  const key = job.key;
  const running = job.status === "running";
  const [logs, setLogs] = useState({}); // step idx → its lines so far
  const [errs, setErrs] = useState({});
  const [open, setOpen] = useState({}); // step idx → open, as toggled or jumped to
  const [folds, setFolds] = useState({}); // "idx:n" of a group header → open, as toggled
  const [all, setAll] = useState(null); // Expand / Collapse all, over every default until toggled again
  const [text, setText] = useState("");
  const [term, setTerm] = useState("");
  const [cur, setCur] = useState(-1);
  const [ts, setTs] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [follow, setFollow] = useState(running);
  const [sel, setSel] = useState(null); // "idx:n"
  const [target, setTarget] = useState(null); // {idx, n}: open, scroll to and highlight once its step has loaded
  const [view, setView] = useState({ top: 0, h: 0 });
  const box = useRef(null), search = useRef(null), last = useRef(0), asked = useRef(new Set()), now = useRef(logs), nav = useRef(null);
  now.current = logs;
  nav.current = setParams;

  const pull = (idx, from) => flowLogPage(repo, run, key, idx, from).then((p) => {
    setLogs((l) => ({ ...l, [idx]: merge(l[idx] ?? NONE, p.from, p.lines) }));
    if (p.next !== undefined) return pull(idx, p.next);
  }).catch((e) => setErrs((x) => ({ ...x, [idx]: e.message })));
  const goTo = (idx, n) => { setOpen((o) => ({ ...o, [idx]: true })); setTarget({ idx, n }); };
  const onPick = useCallback((idx, n) => {
    setSel(`${idx}:${n}`);
    nav.current((p) => { p.set("L", `${key}-${idx}-${n + 1}`); return p; }, { replace: true });
  }, [key]);
  const onFold = useCallback((idx, n, v) => setFolds((f) => ({ ...f, [`${idx}:${n}`]: v })), []);

  // run.log lines append to their step; a batch past what is loaded fetches the gap.
  useEffect(() => {
    sink.current = (m) => {
      const old = now.current[m.step];
      if (old && m.from <= old.length) return setLogs((l) => ({ ...l, [m.step]: merge(l[m.step], m.from, m.lines) }));
      // lazy: a batch landing while the step's first page is in flight waits for the next batch's gap to be fetched
      if (old || !asked.current.has(m.step)) { asked.current.add(m.step); pull(m.step, old?.length ?? 0); }
    };
    return () => { sink.current = null; };
  }, [sink]);
  useEffect(() => {
    const t = setTimeout(() => { setTerm(text.toLowerCase()); setCur(-1); }, 120);
    return () => clearTimeout(t);
  }, [text]);
  const L = params.get("L");
  useEffect(() => {
    const m = L?.startsWith(`${key}-`) && /-(\d+)-(\d+)$/.exec(L);
    if (m && `${m[1]}:${m[2] - 1}` !== sel) goTo(Number(m[1]), m[2] - 1);
  }, [L]);
  useEffect(() => {
    const f = (e) => {
      if (e.key !== "/" || ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.nodeName)) return;
      e.preventDefault();
      search.current?.focus();
    };
    document.addEventListener("keydown", f);
    return () => document.removeEventListener("keydown", f);
  }, []);
  useEffect(() => {
    const el = box.current;
    const ro = new ResizeObserver(() => setView({ top: el.scrollTop, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const found = useMemo(() => {
    const list = [];
    if (term) for (const s of job.steps) for (const r of rowsOf(logs[s.idx] ?? NONE).rows) for (let k = 0, c = hits(r.shown, term); k < c; k++) list.push({ idx: s.idx, n: r.n, k, groups: r.groups });
    return { list, steps: new Set(list.map((f) => f.idx)), groups: new Set(list.flatMap((f) => f.groups.map((g) => `${f.idx}:${g}`))) };
  }, [logs, term, job.steps]);
  const hit = found.list[cur];
  const big = job.steps.reduce((t, s) => t + (logs[s.idx]?.length ?? 0), 0) > BIG;
  // Each step's place: below BIG lines every row is drawn, above it only the rows near the window, with spacers for the rest.
  let y = 0;
  const lay = job.steps.map((s) => {
    const lines = logs[s.idx];
    const { rows, hot } = rowsOf(lines ?? NONE);
    const isOpen = open[s.idx] ?? all ?? (s.status === "failed" || s.status === "running" || found.steps.has(s.idx));
    const fold = (g) => folds[`${s.idx}:${g}`] ?? all ?? (hot.has(g) || found.groups.has(`${s.idx}:${g}`));
    const vis = isOpen ? rows.filter((r) => r.groups.every(fold)) : NONE;
    const note = !isOpen ? null : errs[s.idx] ? `Couldn't load this step's log: ${errs[s.idx]}` : s.status === "running" ? "waiting for output…"
      : !lines && !NOLOG.includes(s.status) ? "Loading…" : null;
    const body = (y += HEAD);
    const clip = (v) => Math.max(0, Math.min(vis.length, v));
    const [a, b] = big ? [clip(Math.floor((view.top - y) / ROW) - OVER), clip(Math.ceil((view.top + view.h - y) / ROW) + OVER)] : [0, vis.length];
    y += vis.length * ROW + (note ? ROW : 0);
    return { s, lines, isOpen, fold, vis, note, body, a, b };
  });

  // An open step loads its lines; a search loads every step's, so hits in closed steps are found.
  useEffect(() => {
    for (const l of lay) {
      if ((l.isOpen || term) && !NOLOG.includes(l.s.status) && !asked.current.has(l.s.idx)) { asked.current.add(l.s.idx); pull(l.s.idx, 0); }
    }
  });
  // A jump waits for its step's lines, opens the groups around the line, then scrolls it under the step header.
  useLayoutEffect(() => {
    if (!target) return;
    const l = lay.find((x) => x.s.idx === target.idx);
    if (!l || errs[target.idx]) return setTarget(null);
    if (!l.lines) return;
    const row = rowsOf(l.lines).rows.find((r) => r.n === target.n);
    const shut = row?.groups.filter((g) => !l.fold(g)) ?? [];
    if (shut.length) return setFolds((f) => ({ ...f, ...Object.fromEntries(shut.map((g) => [`${target.idx}:${g}`, true])) }));
    setTarget(null);
    if (!row) return;
    const el = box.current;
    el.scrollTop = Math.max(0, l.body + l.vis.indexOf(row) * ROW - 60);
    last.current = el.scrollTop;
    setView((v) => ({ ...v, top: el.scrollTop }));
    setSel(`${target.idx}:${target.n}`);
  });
  useLayoutEffect(() => {
    if (!follow || !running) return;
    const el = box.current;
    el.scrollTop = el.scrollHeight;
    last.current = el.scrollTop;
  }, [logs, follow, running]);
  const onScroll = () => {
    const el = box.current;
    if (el.scrollTop < last.current) setFollow(false);
    last.current = el.scrollTop;
    if (big) setView({ top: el.scrollTop, h: el.clientHeight });
  };
  const step = (d) => {
    const n = found.list.length;
    if (!n) return;
    const i = (cur + d + n) % n;
    setCur(i);
    goTo(found.list[i].idx, found.list[i].n);
  };
  const count = job.steps.reduce((t, s) => t + s.lines, 0);
  const notesHere = notes.filter((a) => a.job_key === key && a.level !== "notice");
  const expanded = all === true;
  return <>
    <div className="rp-lh">{icon(job.status)}<div><b>{stage} / {jobName(job)}</b>
      <small>{[`${ST[job.status][2]}${took(job) ? ` in ${took(job)}` : ""}`, job.instance === "byo" ? "BYO worker" : job.instance ?? "—",
        job.instance === "byo" ? null : "managed worker", `attempt ${job.attempt}`].filter(Boolean).join(" · ")}</small></div>
      {!running && job.status !== "queued" && <span className="rp-acts"><button type="button" className="btn btn-secondary" onClick={onRerun}><Ic name="refresh" />Re-run job</button></span>}
    </div>
    <div className="rp-tb">
      <label className="rp-q"><Ic name="search" />
        <input ref={search} aria-label="Search the log" placeholder={`Search ${count} lines`} value={text} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); step(e.shiftKey ? -1 : 1); } }} />
        {term && <span className="mono meta">{cur + 1}/{found.list.length}</span>}
        <button type="button" className="iconbtn" aria-label="Previous match" onClick={() => step(-1)}>▲</button>
        <button type="button" className="iconbtn" aria-label="Next match" onClick={() => step(1)}>▼</button>
      </label>
      <span className="fd-grp">
        <button type="button" className="ib sm" aria-pressed={ts} aria-label="Timestamps" title="Timestamps" onClick={() => setTs(!ts)}><Ic name="clock" /></button>
        <button type="button" className="ib sm" aria-pressed={wrap} aria-label="Wrap long lines" title="Wrap long lines" onClick={() => setWrap(!wrap)}><Ic name="wrap" /></button>
      </span>
      {running && <button type="button" className="btn btn-secondary" aria-pressed={follow} onClick={() => setFollow(!follow)}><Ic name="chevD" />Follow</button>}
      <span className="rp-acts">
        <button type="button" className="btn btn-secondary" onClick={() => { setAll(!expanded); setOpen({}); setFolds({}); }}><Ic name="expand" />{expanded ? "Collapse all" : "Expand all"}</button>
        <a className="btn btn-secondary" href={logTextUrl(repo, run, key)} download><Ic name="file" />Raw</a>
      </span>
    </div>
    {notesHere.length > 0 && <div className="rp-an">{notesHere.map((a, i) => <button type="button" key={i} className={`an an-${a.level}`}
      onClick={() => { const s = job.steps.find((x) => x.name === a.step); if (s) goTo(s.idx, a.line); }}>
      <Ic name={a.level === "error" ? "xc" : "tri"} /><span>{a.step}<small>{a.message}</small></span></button>)}</div>}
    <div className={`rp-ls${ts ? " ts-on" : ""}${wrap ? " wrap" : ""}`} ref={box} onScroll={onScroll}>
      {lay.map(({ s, isOpen, fold, vis, note, a, b }) => <details key={s.idx} className={`stp st-${s.status}`} open={isOpen}>
        <summary onClick={(e) => { e.preventDefault(); setOpen((o) => ({ ...o, [s.idx]: !isOpen })); }}>
          <Ic name="chevR" />{icon(s.status)}<span className="stp-n">{s.name}</span><span className="stp-d mono">{took(s)}</span>
        </summary>
        {isOpen && <div className="stp-b">
          {a > 0 && <div style={{ height: a * ROW }} />}
          {vis.slice(a, b).map((r) => <Line key={r.n} idx={s.idx} n={r.n} at={r.at} kind={r.kind} shown={r.shown} segs={r.segs} depth={r.groups.length}
            fold={r.kind === "grp" ? fold(r.n) : undefined} sel={sel === `${s.idx}:${r.n}`} term={term} cur={hit?.idx === s.idx && hit.n === r.n ? hit.k : -1}
            link={`?job=${encodeURIComponent(key)}&L=${encodeURIComponent(`${key}-${s.idx}-`)}`} onPick={onPick} onFold={onFold} />)}
          {b < vis.length && <div style={{ height: (vis.length - b) * ROW }} />}
          {note && <div className="ln live"><span /><span /><span className="tx">{note}</span></div>}
        </div>}
      </details>)}
    </div>
  </>;
}
