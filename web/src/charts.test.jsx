import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { Rel, Spark, Trend } from "./charts.jsx";

it("Rel puts a bin at its stated p on x and its observed rate on y", () => {
  const html = renderToStaticMarkup(<Rel series={[{ bins: [{ lo: 0.2, hi: 0.3, count: 4, mean_p: 0.2, observed: 0.6 }], color: "var(--chart)" }]} />);
  // 150px square, 4px inset: x = 4 + 150 × .2, y = 4 + 150 × (1 − .6).
  expect(html).toContain('cx="34.0" cy="64.0"');
  expect(html).toContain('points="34.0,64.0"');
});

it("Trend breaks the path at a null week", () => {
  const html = renderToStaticMarkup(<Trend series={[{ pts: [0.1, null, 0.1, 0.1], color: "var(--chart)" }]} labels={["a", "b", "c", "d"]} />);
  const d = html.match(/<path class="pl-line"[^>]* d="([^"]*)"/)[1];
  expect(d.match(/[ML]/g)).toEqual(["M", "M", "L"]);
});

it("Spark renders an empty path for an all-null series", () => {
  expect(renderToStaticMarkup(<Spark pts={[null, null, null]} color="var(--chart)" />)).toContain('d=""');
});
