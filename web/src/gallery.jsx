// /__ui: every v3 primitive in dark and light, with sample data.
import { useState } from "react";
import { BarChart, PropBar, Ring, Sparkline } from "./charts.jsx";
import { EmptyState, ErrorState, Frame, Popover, Tabs, Tile, Toggle, Untrusted } from "./ui.jsx";
import { Bone } from "./skeleton.jsx";

// An Insights series for billing-api, from a seeded series().
const MERGED = [3, 0, 1, 0, 1, 1, 3, 0, 1, 2, 0, 4, 0, 1, 3, 1, 2, 2, 2, 3, 2, 3, 2, 0, 3, 0, 10, 2, 3, 1, 0, 3, 3, 0, 0, 0, 2, 1, 11, 1, 8, 3, 2, 1, 1, 4, 1, 0];
const READS = [26, 14, 18, 6, 21, 22, 0, 0, 9, 0, 11, 22, 0, 9, 12, 9, 6, 17, 1, 0, 0, 0, 26, 16, 0, 0, 40, 1, 25, 29, 10, 13, 3, 15, 1, 2, 0, 50, 1, 11, 23, 16, 6, 2, 4, 4, 3, 6];
const FAILS = [3, 0, 1, 2, 1, 3, 0, 0, 3, 2, 1, 1, 0, 2, 2, 0, 2, 2, 0, 0, 0, 1, 2, 0, 0, 4, 2, 1, 0, 1, 8, 7, 7, 0, 0, 0, 1, 1, 1, 2, 3, 1, 0, 2, 0, 0, 0, 0];
const LABELS = MERGED.map((_, i) => `${String(i >> 1).padStart(2, "0")}:${i % 2 ? "30" : "00"}`);
const SEVERITY = [{ label: "Critical", value: 2, colour: "var(--danger-fill)" }, { label: "Moderate", value: 5, colour: "var(--warning-fill)" },
  { label: "Low", value: 9, colour: "var(--chart)" }, { label: "No advisories", value: 141, colour: "var(--success-fill)" }];

function Theme({ name }) {
  const [view, setView] = useState("overview");
  const [auto, setAuto] = useState(true);
  const [retries, setRetries] = useState(0);
  const [imported, setImported] = useState(false);
  return (
    <section className={name} aria-label={name}>
      <Frame>
        <h2>{name}</h2>
        <Tabs label="Lens" options={[["overview", "Overview"], ["usage", "Usage"]]} value={view} onChange={setView} />
        <div className="tiles" hidden={view !== "overview"}>
          <Tile label="Changes merged" value={String(MERGED.reduce((a, b) => a + b, 0))} delta="38.2%" spark={MERGED} />
          <Tile label="Verifier runs" value="3,912" delta="4.1%" dn spark={READS} />
          <Tile label="Win rate" value="—" untrusted={14} />
          <Tile label="Calibration" value="—" untrusted={0} />
        </div>
        <div className="tiles" hidden={view !== "usage"}><Tile label="Tokens" value="3.8M" sub="this period" /></div>
        <div className="card"><div className="card-b"><BarChart values={READS} fails={FAILS} labels={LABELS} height={180} title="Time (UTC)" /></div></div>
        <div className="card"><div className="card-b"><Ring pct={63} label="7.2M" /><Ring pct={null} label="—" /><Sparkline values={MERGED} /></div></div>
        <div className="card"><div className="card-b"><PropBar segments={SEVERITY} /></div></div>
        <div className="card"><div className="card-b"><Untrusted n={9} /> <Untrusted n={0} /></div></div>
        <div className="card"><div className="card-b">
          <Toggle label="Auto-merge" checked={auto} onChange={setAuto} /> <span>{auto ? "Auto-merge on" : "Auto-merge off"}</span>{" "}
          <Popover label="Branch"><button type="button" className="btn btn-ghost">main</button><button type="button" className="btn btn-ghost">release/2026.10</button></Popover>
        </div></div>
        <div className="card"><div className="card-b"><Bone w="100%" h={112} /></div></div>
        <div className="card">
          <EmptyState icon="folder" title={imported ? "Import started" : "No repositories yet"}
            action={<button type="button" className="btn btn-primary" onClick={() => setImported(true)}>Import repository</button>}>Import one from GitHub or create an empty one.</EmptyState>
        </div>
        <div className="card"><ErrorState message={`GET /api/repos → 503 unavailable${retries ? ` · retried ${retries}×` : ""}`} onRetry={() => setRetries(retries + 1)} /></div>
      </Frame>
    </section>
  );
}

const Gallery = () => <main><Theme name="dark" /><Theme name="light" /></main>;

// Dev only: a production build ships no /__ui.
export const devRoutes = import.meta.env.MODE === "production" ? [] : [{ path: "/__ui", element: <Gallery /> }];
