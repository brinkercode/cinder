// Skeleton primitives and timing.
import { useEffect, useRef, useState } from "react";

const WIDTHS = ["92%", "64%", "78%", "48%"];
const RADIUS = { text: 4, pill: 6, round: "50%" };

// row staggers the pulse by 80ms.
export const Bone = ({ w, h, r = "text", row = 0 }) =>
  <span className="bone" aria-hidden="true" style={{ width: w, height: h, borderRadius: RADIUS[r], animationDelay: `${row * 80}ms` }} />;

// i picks the width from the 92/64/78/48% cycle; large is for text above 13px.
export const BoneText = ({ i = 0, large = false, w = WIDTHS[i % 4] }) => <Bone w={w} h={large ? 12 : 10} row={i} />;

export const BonePill = ({ w = 64, h = 20, row = 0 }) => <Bone w={w} h={h} r="pill" row={row} />;

export const BoneAvatar = ({ size = 26, row = 0 }) => <Bone w={size} h={size} r="round" row={row} />;

export const TileSkel = ({ label }) =>
  <div className="tile flat"><div className="l">{label ?? <BoneText />}</div><div className="v"><BoneText i={1} large /></div></div>;

export const ListCardSkel = ({ lines = 2 }) => (
  <div className="card skel-card">
    <BoneAvatar />
    <div className="skel-lines">{Array.from({ length: lines }, (_, i) => <BoneText key={i} i={i} />)}</div>
  </div>
);

// cols: [label, monoWidthPx?]. A mono column gets its fixed width; the rest cycle. widths: the last real table's, from useShape.
export const TableSkel = ({ cols, rows = 6, widths }) => (
  <table className="tbl">
    <thead><tr>{cols.map(([label], c) => <th key={label} style={widths && { width: widths[c] }}>{label}</th>)}</tr></thead>
    <tbody>{Array.from({ length: rows }, (_, r) =>
      <tr key={r} style={{ height: 44 }}>{cols.map(([label, mono], c) => <td key={label}>{mono ? <Bone w={mono} h={10} row={r} /> : <BoneText i={r + c} />}</td>)}</tr>)}
    </tbody>
  </table>
);

// A panel of five loading rows over a "Loading <label>…" footer.
export const RowsSkel = ({ label }) => (
  <div className="panel" aria-busy="true">
    {[70, 55, 82, 40, 64].map((w, i) => <div className="ld-row" key={w}><Bone w={`${w}%`} h={10} row={i} /></div>)}
    <p className="mono subtle ld-foot">Loading {label}…</p>
  </div>
);

const BARS = [40, 65, 50, 80, 35, 70, 55, 90, 45, 60];

export const ChartSkel = ({ height = 180 }) => (
  <div className="chart-skel" style={{ height }}>
    {BARS.map((p, i) => <Bone key={i} w="100%" h={`${p}%`} row={i} />)}
  </div>
);

// progress adds a progress-bar bone to each card (the Verifying column).
export const BoardColSkel = ({ name, cards, progress = false }) => (
  <section className="col" aria-label={name}>
    <header className="col-h">{name}</header>
    <div className="cards">{Array.from({ length: cards }, (_, i) =>
      <div className="chg" key={i}><BoneText i={i} /><BoneText i={i + 1} />{progress && <Bone w="100%" h={4} r="pill" row={i} />}<BonePill row={i} /></div>)}
    </div>
  </section>
);

// A section's last real shape, a per-viewer rendering hint in localStorage under "shape:<page>/<repo>/<section>".
// Skeleton: useShape(key, spec).n is the last count (0 = known empty: draw the empty state, no bones), or spec on a first visit.
// Data: useShape(key, spec, count) records count once rendered, plus the column widths of the table its ref is on.
// A board's count is an array, one per column, the length of its spec.
const isCount = (v) => Number.isInteger(v) && v >= 0;
export function useShape(key, spec, count) {
  const ref = useRef(null);
  const [last] = useState(() => { try { return JSON.parse(localStorage.getItem(`shape:${key}`)); } catch { return null; } });
  useEffect(() => {
    if (count === undefined) return;
    const t = ref.current; // offsetWidth is 0 while hidden: keep no widths rather than zeros
    const widths = t?.offsetWidth ? [...t.querySelectorAll("thead th")].map((th) => `${(100 * th.offsetWidth / t.offsetWidth).toFixed(1)}%`) : undefined;
    try { localStorage.setItem(`shape:${key}`, JSON.stringify({ n: count, widths })); } catch { /* blocked or full: the next load uses spec */ }
  }, [key, JSON.stringify(count)]); // a board's array is new on every render: compare by value
  const n = last?.n;
  return { n: (Array.isArray(spec) ? Array.isArray(n) && n.length === spec.length && n.every(isCount) : isCount(n)) ? n : spec, widths: Array.isArray(last?.widths) ? last.widths : undefined, ref };
}

// Don't show before 150ms; once shown keep 300ms; after 10s flag slow.
function useSkelTiming(loading) {
  const [shownAt, setShownAt] = useState(0);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!loading) return;
    setSlow(false);
    const show = setTimeout(() => setShownAt(Date.now()), 150);
    const late = setTimeout(() => setSlow(true), 10000);
    return () => { clearTimeout(show); clearTimeout(late); };
  }, [loading]);
  useEffect(() => {
    if (loading || !shownAt) return;
    const hide = setTimeout(() => setShownAt(0), Math.max(0, shownAt + 300 - Date.now()));
    return () => clearTimeout(hide);
  }, [loading, shownAt]);
  return { show: shownAt > 0, slow: loading && slow };
}

// One per card, so each card loads on its own.
export function Loads({ loading, skel, onRetry, children }) {
  const { show, slow } = useSkelTiming(loading);
  if (!show) return loading ? null : children;
  return <>{skel}{slow && <p className="skel-slow">Still loading… <button type="button" className="btn btn-secondary" onClick={onRetry}>Retry</button></p>}</>;
}

// A Suspense fallback: hidden for 150ms, Still loading with Retry after 10s.
// Suspense unmounts it the moment data lands, so the 300ms hold of Loads can't apply here.
export const SkelFallback = ({ skel, onRetry }) => <Loads loading skel={skel} onRetry={onRetry} />;

// The page's loading region: aria-busy plus one visually hidden status line.
export const LoadingRegion = ({ page, busy, children }) => (
  <div aria-busy={busy}>
    <p role="status" className="sr-only">{busy ? `Loading ${page}` : ""}</p>
    {children}
  </div>
);
