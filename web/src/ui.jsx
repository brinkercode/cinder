// Shared components.
import { cloneElement, Fragment, Suspense, useEffect, useId, useMemo, useRef, useState } from "react";
import { Await } from "react-router";
import { PiArrowClockwise, PiFile } from "react-icons/pi";
import { Sparkline } from "./charts.jsx";
import { fetchJson, fixtures, sessionExpired } from "./client.js";
import { Ic } from "./icons.jsx";

// A branch name in a tight space: the head shrinks with an ellipsis, the tail (last segment up to 14 characters, else the last 12) never does.
export function Mid({ text }) {
  const i = text.lastIndexOf("/");
  const cut = text.length < 23 ? text.length : i > 0 && text.length - i - 1 <= 14 ? i + 1 : text.length - 12;
  return <span className="mid mono" title={text} aria-label={text}><span className="h">{text.slice(0, cut)}</span><span className="t">{text.slice(cut)}</span></span>;
}

const TRUST_MIN = { outcomes: 200, races: 30 };

// judge: { name, count, trusted?, brier?, backend? }. `trusted` from the API wins over the default threshold.
// For agent win rates pass unit="races" and judge = { name: "agent@version", count: races }.
export function Prob({ p, judge, airlock = false, unit = "outcomes", empty = "not judged yet" }) {
  if (!judge) return <span className="subtle">{empty}</span>;
  const { name, count = 0, brier } = judge;
  if (airlock && judge.backend === "hosted") {
    return <span className="trust subtle" title="Hosted judge paused while airlock is on">{name}: paused by airlock</span>;
  }
  if (!count) return <span className="subtle">{unit === "races" ? "not raced" : "no outcomes yet"}</span>;
  if (!(judge.trusted ?? count >= TRUST_MIN[unit])) {
    return <span className="trust untrusted" title={`${name} needs ${TRUST_MIN[unit]} ${unit} before its numbers count`}>untrusted: {count} {unit}</span>;
  }
  if (p == null) return <span className="subtle">{empty}</span>;
  const score = brier == null ? "" : ` · Brier ${brier.toFixed(3)}`;
  return (
    <span className="trust" title={`${name} · trusted${score} over ${count.toLocaleString("en")} ${unit}`}>
      <span className="p">{Math.round(p * 100)}%</span><span className="subtle">{name}</span>
    </span>
  );
}

// change: { agent, ver } where ver is null for a person (README §State and data).

export const tok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

// A change in mono: its key (label, PULSE-6) when it has one, else its id's first 8 characters, whose copy carries the full id.
// The tooltip carries the full id either way.
// Change keys (PULSE-6) by id, for a ChangeId shown without its key: each id is looked up once and every ChangeId showing it
// updates. lazy: one GET per unseen change; a page that shows dozens should pass keys from its own data instead.
const KEYS = new Map(), WAITING = new Map();
function useKey(id, label) {
  const [, redraw] = useState(0);
  useEffect(() => {
    if (label || !id || fixtures() || KEYS.has(id)) return;
    const mine = () => redraw((n) => n + 1);
    if (!WAITING.has(id)) {
      WAITING.set(id, new Set());
      fetchJson(`/api/changes/${encodeURIComponent(id)}`).then((c) => c?.key ?? null, () => null).then((key) => {
        KEYS.set(id, key);
        for (const f of WAITING.get(id)) f();
        WAITING.delete(id);
      });
    }
    WAITING.get(id).add(mine);
    return () => WAITING.get(id)?.delete(mine);
  }, [id, label]);
  return label ?? KEYS.get(id) ?? undefined;
}
export const ChangeId = ({ id, label }) => {
  const key = useKey(id, label);
  return <span className="mono" title={id} onCopy={key ? undefined : (e) => { e.preventDefault(); e.clipboardData.setData("text/plain", id); }}>{key ?? id.slice(0, 8)}</span>;
};
// Text with every change id in it (a 36-character UUID) shown as a ChangeId.
export const IdText = ({ text }) => text.split(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)
  .map((s, i) => (i % 2 ? <ChangeId key={i} id={s} /> : s));
export const Br = ({ name }) => <span className="br">{name}</span>;
export const Tag = ({ tone, children }) => <span className={tone ? `tag t-${tone}` : "tag"}>{children}</span>;
export const Dot = ({ tone }) => <span className={`dot ${tone}`} />;


// options: [[value, label], ...]
export const Seg = ({ label, options, value, onChange }) => (
  <div className="seg" role="group" aria-label={label}>
    {options.map(([v, l]) => <button type="button" key={v} aria-pressed={v === value} onClick={() => onChange(v)}>{l}</button>)}
  </div>
);

// With stack, each <td data-l="Label"> becomes a labelled cell of a card under 720px.
export const Table = ({ stack = false, children }) => <div className="panel-scroll"><table className={stack ? "tbl stack" : "tbl"}>{children}</table></div>;

export const Panel = ({ title, aside, children }) => (
  <section className="panel">
    {title && <div className="panel-head"><h2>{title}</h2>{aside}</div>}
    {children}
  </section>
);

const LINE = { h: ["hunk", ""], c: ["", " "], a: ["add", "+"], d: ["del", "−"] };
// One file's diff. lines: [[h|c|a|d, old line, new line, who, text], ...]; children sit at the end of the file header; inRow/after add content inside / below each line's row.
export const Diff = ({ file, adds, dels, lines, children, inRow, after }) => (
  <div className="diff"><div className="diff-in">
    <div className="fh"><PiFile /><span>{file}</span><span className="adds">+{adds}</span><span className="dels">−{dels}</span>{children}</div>
    {lines.map((l, i) => {
      const [k, o, n, who, text] = l;
      return <Fragment key={i}>
        <div className={`dl ${LINE[k][0]}`}><span className="ln">{o}</span><span className="ln">{n}</span><span className="pv">{who}</span><span>{LINE[k][1]}{text}</span>{inRow?.(l, i)}</div>
        {after?.(l, i)}
      </Fragment>;
    })}
  </div></div>
);

// kind: empty | error. Error needs `request`, e.g. "GET /api/changes → 503 unavailable · req 7f3a91c2".
export function State({ kind = "empty", title, request, onRetry, children }) {
  // Signing in again can't give a service token an email.
  if (kind === "error" && sessionExpired() === "access_no_email") {
    return <div className="panel"><div className="state error"><h2>This Access identity has no email</h2><p>An owner must allow this service token in Settings › Access &amp; people.</p></div></div>;
  }
  // A full load of "/" goes through Cloudflare Access, which signs the person in again.
  if (kind === "error" && sessionExpired()) {
    return <div className="panel"><div className="state error"><h2>Session expired, sign in again</h2><a className="btn btn-primary" href="/">Sign in</a></div></div>;
  }
  return (
    <div className="panel">
      <div className={`state ${kind}`}>
        <h2>{title}</h2>
        {children}
        {request && <pre>{request}</pre>}
        {kind === "error" && <button type="button" className="btn btn-secondary" onClick={onRetry}><PiArrowClockwise />Retry</button>}
      </div>
    </div>
  );
}

// Native dialog; Cancel closes with returnValue "cancel", the primary action with "ok".
export const Dialog = ({ ref, title, action, disabled = false, onClose, children }) => (
  <dialog className="dlg" ref={ref} onClose={onClose}>
    <form method="dialog">
      <div className="panel-head"><h2>{title}</h2></div>
      <div className="pad">{children}</div>
      <div className="dlg-foot"><button className="btn btn-ghost" value="cancel" formNoValidate>Cancel</button><button className="btn btn-primary" value="ok" disabled={disabled}>{action}</button></div>
    </form>
  </dialog>
);

// A page action that needs the page's data: disabled, with the reason, until `data` resolves; it stays disabled if it fails.
export function Loaded({ data, reason, children }) {
  const off = cloneElement(children, { disabled: true, "aria-disabled": "true", title: reason, onClick: undefined });
  return <Suspense fallback={off}><Await resolve={data} errorElement={off}>{children}</Await></Suspense>;
}

// Live helpers.
export const LiveLabel = () => <span className="live-s"><span className="dot ok" />live</span>;

// Holds its children still while focus is inside, so live updates never move what the user is working in.
export function Region({ children, ...props }) {
  const [focused, setFocused] = useState(false);
  const shown = useMemo(() => children, [focused || children]); // focused: dep stays `true`, children are frozen
  return (
    <div {...props} onFocus={() => setFocused(true)} onBlur={(e) => setFocused(e.currentTarget.contains(e.relatedTarget))}>
      {shown}
    </div>
  );
}

// v3 primitives.
// Fewer than 20 outcomes is untrusted; zero is "no outcomes yet", never 0%.
export function Untrusted({ n }) {
  if (n >= 20) return null;
  return <span className="untrusted">{n ? `untrusted: ${n} outcome${n === 1 ? "" : "s"}` : "no outcomes yet"}</span>;
}

// untrusted: the outcome count behind value; under 20 it shows the Untrusted line.
export const Tile = ({ label, value, sub, delta, dn = false, spark, untrusted, children }) => (
  <div className={spark ? "tile" : "tile flat"}>
    <div className="l">{label}</div>
    <div className="v">{value}{sub && <small>{sub}</small>}{delta && <span className={dn ? "d dn" : "d"}><Ic name={dn ? "trendd" : "trend"} />{delta}</span>}</div>
    {untrusted != null && <Untrusted n={untrusted} />}
    {children}
    {spark && <Sparkline values={spark} />}
  </div>
);

// The v3 segmented control: one tab per view, arrows move the choice. options: [[value, label], ...]
export function Tabs({ label, options, value, onChange }) {
  const key = (e) => {
    const d = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (!d) return;
    const i = (options.findIndex(([v]) => v === value) + d + options.length) % options.length;
    onChange(options[i][0]);
    e.currentTarget.children[i].focus();
  };
  return <div className="seg" role="tablist" aria-label={label} onKeyDown={key}>
    {options.map(([v, l]) => <button type="button" role="tab" key={v} aria-selected={v === value} tabIndex={v === value ? 0 : -1} onClick={() => onChange(v)}>{l}</button>)}
  </div>;
}

// Native popover under its anchor, flipped above it or left of the edge to stay in the viewport.
export function Popover({ label, title, children }) {
  const id = useId();
  const anchor = useRef(null);
  const place = (pop) => {
    const open = (e) => {
      if (e.newState !== "open") return;
      const a = anchor.current.getBoundingClientRect(), p = pop.getBoundingClientRect();
      pop.style.top = `${a.bottom + 4 + p.height <= innerHeight ? a.bottom + 4 : Math.max(4, a.top - 4 - p.height)}px`;
      pop.style.left = `${Math.max(4, Math.min(a.left, innerWidth - p.width - 4))}px`;
    };
    pop.addEventListener("toggle", open);
    return () => pop.removeEventListener("toggle", open);
  };
  return <><button type="button" className="btn btn-secondary" ref={anchor} popoverTarget={id} aria-label={title}>{label}</button><div className="pop" id={id} popover="auto" ref={place}>{children}</div></>;
}

export const Toggle = ({ label, checked, onChange }) => <input type="checkbox" role="switch" className="tg" aria-label={label} checked={checked} onChange={(e) => onChange(e.target.checked)} />;

// Sized like the content it stands in for.

export const EmptyState = ({ icon, title, children, action }) => <div className="empty"><Ic name={icon} /><h3>{title}</h3><p>{children}</p>{action}</div>;

export const ErrorState = ({ message, onRetry }) => <div className="err" role="alert"><Dot tone="bad" /><span>{message}</span><button type="button" className="btn btn-secondary" onClick={onRetry}>Retry</button></div>;

// The only page container: one .fc holds the title, the body and the aside, so every page shares one width and edge.
// head is the title area's content, aside the right column, measure caps the body's children at a reading width.
// className scopes a page's own styles.
export function Frame({ head, aside, measure, className, children }) {
  const main = <>{head && <div className="ph"><div className="ph-in">{head}</div></div>}<div className="f-body">{children}</div></>;
  return <div className={`frame${aside ? " f-aside" : ""}${measure ? " f-measure" : ""}${className ? ` ${className}` : ""}`}>
    <div className="fc">{aside ? <><div>{main}</div><aside>{aside}</aside></> : main}</div>
  </div>;
}
