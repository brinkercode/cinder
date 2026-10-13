import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChangeId, Frame, Prob, State } from "./ui.jsx";
import { ChangeWho } from "./who.jsx";

const text = (el) => renderToStaticMarkup(el).replace(/<[^>]+>/g, "");

describe("shared components", () => {
  it("Frame measure caps its children at 760px, left-aligned", () => {
    const html = renderToStaticMarkup(<Frame measure head={<h1>Page</h1>}><p>Text</p></Frame>);
    expect(html).toBe('<div class="frame f-measure"><div class="fc"><div class="ph"><div class="ph-in"><h1>Page</h1></div></div><div class="f-body"><p>Text</p></div></div></div>');
    expect(renderToStaticMarkup(<Frame><p>Text</p></Frame>)).not.toContain("f-measure");
    const css = readFileSync(new URL("styles/app.css", import.meta.url), "utf8");
    const rule = /\.f-measure \.f-body>\*\{([^}]*)\}/.exec(css)?.[1];
    expect(rule).toBe("max-width:760px"); // no margin-inline:auto, so each child keeps the frame's left edge
  });

  it("Prob below threshold shows 'untrusted: n outcomes', never a bare %", () => {
    const shown = text(<Prob p={0.42} judge={{ name: "Kev", count: 64, brier: 0.141 }} />);
    expect(shown).toBe("untrusted: 64 outcomes");
    expect(text(<Prob p={0.42} judge={{ name: "Kev", count: 500, trusted: false }} />)).toBe("untrusted: 500 outcomes");
    expect(text(<Prob p={0.6} judge={{ name: "agent@1.0", count: 12 }} unit="races" />)).toBe("untrusted: 12 races");
    expect(text(<Prob p={0.42} judge={{ name: "Jev", count: 1840, brier: 0.071 }} />)).toBe("42%Jev");
  });

  it("Prob with zero outcomes never shows 0% or 100%", () => {
    for (const p of [0, 1, null]) {
      for (const judge of [{ name: "Jev", count: 0 }, { name: "Jev", count: 0, trusted: true }, { name: "Jev" }]) {
        const shown = text(<Prob p={p} judge={judge} />);
        expect(shown).toBe("no outcomes yet");
      }
    }
    expect(text(<Prob p={0} judge={{ name: "a@1", count: 0 }} unit="races" />)).toBe("not raced");
  });

  it("error state prints the request line and a Retry button", () => {
    const line = "GET /api/changes → 503 unavailable · req 7f3a91c2";
    const html = renderToStaticMarkup(<State kind="error" title="Couldn't load changes" request={line} onRetry={() => {}} />);
    expect(html).toContain(`<pre>${line}</pre>`);
    expect(html).toMatch(/<button[^>]*>.*Retry<\/button>/);
  });

  it("ChangeWho shows agent@version for agents and 'person' for people", () => {
    expect(renderToStaticMarkup(<ChangeWho change={{ agent: "developer", ver: "2.3.1" }} />)).toBe('<span class="mono">developer@2.3.1</span>');
    expect(text(<ChangeWho change={{ agent: "bea", ver: null }} />)).toBe("bea · person");
  });

  it("ChangeId for 5f20a6c9-1234-… renders 5f20a6c9 with title equal to the full id", () => {
    expect(renderToStaticMarkup(<ChangeId id="5f20a6c9-1234-4abc-8def-0123456789ab" />)).toBe('<span class="mono" title="5f20a6c9-1234-4abc-8def-0123456789ab">5f20a6c9</span>');
  });
});
