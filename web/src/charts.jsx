// Hand-drawn charts. No chart library.
const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, "")}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, "")}k` : String(n));

// The next 1, 2, 2.5, 5 or 10 × 10^k at or above m (m >= 1).
const nice = (m) => { const p = 10 ** Math.floor(Math.log10(m)); return [1, 2, 2.5, 5, 10].find((f) => m / p <= f) * p; };

export function Sparkline({ values }) {
  const w = 300, h = 40, m = Math.max(...values, 1);
  const pts = values.map((v, i) => `${(i / Math.max(values.length - 1, 1) * w).toFixed(1)},${(h - 2 - v / m * (h - 6)).toFixed(1)}`).join(" ");
  return <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true"><polyline points={pts} fill="none" stroke="var(--chart)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" /></svg>;
}

// Stacked bars: values pass on --chart, fails (same length) on --danger-fill.
export function BarChart({ values, fails, labels = [], height = 240, title }) {
  const top = nice(Math.max(...values.map((v, i) => v + (fails?.[i] ?? 0)), 1));
  // Counts only: rounding thirds of a small top repeats a label (1, 1, 0, 0), so repeats are dropped.
  const ticks = [...new Set([top, top * 2 / 3, top / 3, 0].map((t) => fmt(Math.round(t))))];
  const xs = labels.filter((_, i) => i % Math.ceil(labels.length / 7) === 0);
  return (
    <div className="bc">
      <div className="bc-y" style={{ height }}>{ticks.map((t) => <span key={t}>{t}</span>)}</div>
      <div className="bc-p" style={{ height }}>
        <div className="bc-g"><i /><i /><i /><i /></div>
        <div className="bc-b">
          {values.map((v, i) => {
            const f = fails?.[i] ?? 0;
            return <i key={i} style={{ height: `${Math.max(0.8, (v + f) / top * 100)}%` }} title={`${labels[i] ?? ""}: ${v}${fails ? ` pass, ${f} fail` : ""}`}><b style={{ flex: v || 0.01 }} />{f > 0 && <b className="f" style={{ flex: f }} />}</i>;
          })}
        </div>
      </div>
      <div className="bc-x">{xs.map((x, i) => <span key={i}>{x}</span>)}</div>
      {title && <div className="bc-t">{title}</div>}
    </div>
  );
}

// pct null draws the empty track only: an empty metric is never 0%.
export function Ring({ pct, label }) {
  const size = 88, r = size / 2 - 5, c = 2 * Math.PI * r, o = size / 2;
  return (
    <svg className="ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle cx={o} cy={o} r={r} fill="none" stroke="var(--tint)" strokeWidth="7" />
      {pct != null && <circle cx={o} cy={o} r={r} fill="none" stroke="var(--chart)" strokeWidth="7" strokeLinecap="round" strokeDasharray={`${(pct / 100 * c).toFixed(1)} ${c.toFixed(1)}`} transform={`rotate(-90 ${o} ${o})`} />}
      <text x="50%" y="50%" dominantBaseline="central" textAnchor="middle" fill="var(--text-strong)" fontSize="14" fontWeight="500">{label}</text>
    </svg>
  );
}

// segments: [{ label, value, colour }], colour a token such as "var(--danger-fill)".
export const PropBar = ({ segments }) => (
  <div>
    <div className="leg">{segments.map((s) => <span key={s.label}><span className="sw" style={{ background: s.colour }} />{s.label} <b>{s.value}</b></span>)}</div>
    <div className="prop">{segments.map((s) => <i key={s.label} style={{ flex: s.value, background: s.colour }} title={`${s.label}: ${s.value}`} />)}</div>
  </div>
);

// Judge charts: reliability, bin counts, Brier over weeks and a sparkline. A null point is a gap, never 0.
export const pct = (v) => `${Math.round(v * 100)}%`;
export const f3 = (v) => (v == null ? "—" : (+v).toFixed(3).replace(/^0/, ""));

// x = stated p, y = observed rate. series: [{ bins, color, dash, dim }]; dot size is the bin's share of the series' outcomes.
export function Rel({ series, axes, band, size = 150, label = "Reliability curve" }) {
  const s = size, L = axes ? 30 : 4, T = 4, B = axes ? 26 : 4, W = L + s + 6, H = T + s + B;
  const X = (v) => L + v * s, Y = (v) => T + (1 - v) * s;
  return (
    <svg className="pl" viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={label}>
      <rect className="pl-bg" x={X(0)} y={Y(1)} width={s} height={s} />
      {axes && <>
        {[0.25, 0.5, 0.75].map((t) => <g key={t}><line className="pl-grid" x1={X(t)} x2={X(t)} y1={Y(0)} y2={Y(1)} /><line className="pl-grid" x1={X(0)} x2={X(1)} y1={Y(t)} y2={Y(t)} /></g>)}
        {[0, 0.5, 1].map((t) => <g key={t}><text className="pl-t" x={X(t)} y={Y(0) + 16} textAnchor="middle">{t}</text><text className="pl-t" x={X(0) - 6} y={Y(t) + 4} textAnchor="end">{t}</text></g>)}
        <text className="pl-t" x={X(0.5)} y={H - 1} textAnchor="middle">stated probability</text>
        <text className="pl-t" transform={`translate(9 ${Y(0.5)}) rotate(-90)`} textAnchor="middle">observed</text>
      </>}
      <line className="pl-diag" x1={X(0)} y1={Y(0)} x2={X(1)} y2={Y(1)} />
      {band && <path className="pl-band" d={`M${X(0)} ${Y(0)} L${X(1)} ${Y(1)} L${X(1)} ${Y(0.9)} L${X(0.1)} ${Y(0)}Z M${X(0)} ${Y(0)} L${X(1)} ${Y(1)} L${X(0.9)} ${Y(1)} L${X(0)} ${Y(0.1)}Z`} />}
      {series.map((se, k) => {
        const max = Math.max(...se.bins.map((b) => b.count)), op = se.dim ? 0.45 : undefined;
        return <g key={k}>
          <polyline className={se.dash ? "pl-line dash" : "pl-line"} style={{ stroke: se.color, opacity: op }} points={se.bins.map((b) => `${X(b.mean_p).toFixed(1)},${Y(b.observed).toFixed(1)}`).join(" ")} />
          {se.bins.map((b) => <circle key={b.lo} className="pl-pt" style={{ fill: se.dash ? "var(--elevated)" : se.color, stroke: se.color, opacity: op }} cx={X(b.mean_p).toFixed(1)} cy={Y(b.observed).toFixed(1)}
            r={(1.6 + Math.sqrt(b.count / max) * (axes ? 4.5 : 2.6)).toFixed(1)}><title>{`${b.lo}–${b.hi}: said ${pct(b.mean_p)}, happened ${pct(b.observed)} · n=${b.count}`}</title></circle>)}
        </g>;
      })}
    </svg>
  );
}

// Outcomes per bin, on Rel's x scale with axes.
export function Hist({ bins, size = 150 }) {
  const L = 30, h = 36, max = Math.max(...bins.map((b) => b.count));
  return (
    <svg className="pl" viewBox={`0 0 ${L + size + 6} ${h + 14}`} width="100%" role="img" aria-label="Outcomes per bin">
      {bins.map((b) => <rect key={b.lo} className="pl-hist" x={L + b.lo * size + 1} y={h - b.count / max * h} width={size / 10 - 2} height={b.count / max * h}><title>{`${b.count} outcomes`}</title></rect>)}
      <text className="pl-t" x={L} y={h + 12}>outcomes per bin</text>
    </svg>
  );
}

// A path through pts that lifts the pen at every null.
const path = (pts, X, Y) => { let d = "", pen = false; pts.forEach((v, i) => { if (v == null) { pen = false; return; } d += `${pen ? "L" : "M"}${X(i).toFixed(1)} ${Y(v).toFixed(1)} `; pen = true; }); return d; };

// Brier over weeks, lower is better. series: [{ pts, color, dash, label }], marks: [{ i, label }] vertical lines at week i.
export function Trend({ series, labels, lo = 0, hi = 0.2, marks = [], endLabels, every = 2 }) {
  const w = 560, h = 260, L = 40, R = endLabels ? 92 : 12, T = 12, iw = w - L - R, ih = h - T - 24, n = labels.length;
  const X = (i) => L + i / Math.max(n - 1, 1) * iw, Y = (v) => T + (1 - (v - lo) / (hi - lo)) * ih;
  return (
    <svg className="pl" viewBox={`0 0 ${w} ${h}`} width="100%" role="img" aria-label="Brier score over time">
      {[0, 1, 2, 3, 4].map((k) => { const v = lo + (hi - lo) * k / 4; return <g key={k}><line className="pl-grid" x1={L} x2={L + iw} y1={Y(v)} y2={Y(v)} /><text className="pl-t" x={L - 6} y={Y(v) + 4} textAnchor="end">{f3(v)}</text></g>; })}
      {labels.map((t, i) => (i % every === 0 || i === n - 1) && <text key={i} className="pl-t" x={X(i)} y={h - 6} textAnchor="middle">{t}</text>)}
      {marks.map((m) => <g key={m.i}><line className="pl-mark" x1={X(m.i)} x2={X(m.i)} y1={T} y2={T + ih} /><text className="pl-t mk" x={X(m.i) + 5} y={T + 11}>{m.label}</text></g>)}
      {series.map((se, k) => {
        const li = se.pts.length - 1, lv = se.pts[li];
        return <g key={k}>
          <path className={se.dash ? "pl-line dash" : "pl-line"} style={{ stroke: se.color }} d={path(se.pts, X, Y)} />
          {lv != null && <circle className="pl-pt" style={{ fill: se.color, stroke: se.color }} cx={X(li)} cy={Y(lv)} r="3" />}
          {lv != null && endLabels && <text className="pl-t el" x={X(li) + 8} y={Y(lv) + 4} style={{ fill: se.color }}>{`${se.label} ${f3(lv)}`}</text>}
        </g>;
      })}
    </svg>
  );
}

export function Spark({ pts, color }) {
  const w = 120, h = 28, v = pts.filter((x) => x != null), lo = Math.min(...v) - 0.005, hi = Math.max(...v) + 0.005;
  const d = path(pts, (i) => 2 + i / Math.max(pts.length - 1, 1) * (w - 4), (p) => 2 + (1 - (p - lo) / (hi - lo)) * (h - 4));
  return <svg className="pl" viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden="true"><path className="pl-line" style={{ stroke: color, strokeWidth: 1.5 }} d={d} /></svg>;
}
