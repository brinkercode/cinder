import { readFileSync } from "node:fs";
import { prerender } from "react-dom/static";
import { renderToString } from "react-dom/server";
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { CLASS_VAR, CODE } from "./lib/code-metrics.js";
import { SCOPES, tokens } from "./lib/highlight.js";
import Monaco, { sync } from "./monaco.jsx";
import { routes } from "./routes.jsx";

// The real monaco.jsx over fake Monaco packages, which record what the editor and the View's colouring were given.
// monaco.jsx sets self.MonacoEnvironment on import, and node has no self.
const seen = vi.hoisted(() => { globalThis.self ??= globalThis; return {}; });
vi.mock("@monaco-editor/react", () => ({ default: (props) => { seen.editor = props; return null; }, loader: { config() {} } }));
vi.mock("monaco-editor/editor/editor.api", () => ({
  editor: { setTheme() {}, defineTheme() {} }, languages: { getLanguages: () => [], register() {}, setTokensProvider() {} },
}));
// The theme reads tokens.css colours and converts each through a canvas pixel.
const canvas = { getContext: () => ({ fillRect() {}, getImageData: () => ({ data: [0, 0, 0, 255] }) }) };
globalThis.getComputedStyle ??= () => ({ getPropertyValue: () => "oklch(50% 0 0)" });
vi.mock("monaco-editor/features/register.all", () => ({}));
vi.mock("monaco-editor/editor/editor.worker?worker", () => ({ default: class {} }));

const doc = { documentElement: { classList: { contains: () => false } }, createElement: (tag) => (tag === "canvas" ? canvas : {}) };
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it("View and Edit of the same file use the same theme name and line-height and padding constants", async () => {
  vi.stubGlobal("document", { documentElement: { classList: { contains: (c) => c === "dark" } }, createElement: (tag) => (tag === "canvas" ? canvas : {}) });
  renderToString(<Monaco path="src/a.js" value="const a = 1;" options={{ ariaLabel: "Edit src/a.js" }} />);
  const { theme, options } = seen.editor;
  expect(options).toMatchObject({ fontSize: CODE.fontSize, lineHeight: CODE.lineHeight, padding: { top: CODE.top },
    lineNumbersMinChars: CODE.digits, lineDecorationsWidth: CODE.gap, tabSize: CODE.tabSize, ariaLabel: "Edit src/a.js" });

  expect([theme, seen.editor.language]).toEqual(["cinder-dark", "javascript"]);

  vi.stubEnv("VITE_FIXTURES", "1");
  const handler = createStaticHandler(routes);
  const context = await handler.query(new Request("http://cinder.test/acme%2Fweb/code/develop/src/headers/normalize.rs"));
  const { prelude } = await prerender(<StaticRouterProvider router={createStaticRouter(handler.dataRoutes, context)} context={context} hydrate={false} />);
  const view = await new Response(prelude).text();
  expect(view).toContain(`<div class="codev-in" style="font-size:${CODE.fontSize}px;line-height:${CODE.lineHeight}px;padding-top:${CODE.top}px;tab-size:${CODE.tabSize}">`);
});

it("the editor options' fontFamily resolves to the same font token View uses, and bracketPairColorization is disabled", () => {
  vi.stubGlobal("document", doc);
  renderToString(<Monaco path="src/a.js" value="" />);
  const { options } = seen.editor;
  const css = readFileSync(new URL("./styles/app.css", import.meta.url), "utf8");
  expect(css).toContain(".codev{overflow-x:auto;font-family:var(--font-mono)}");
  expect(options.fontFamily).toBe("var(--font-mono)");
  expect(options.bracketPairColorization).toEqual({ enabled: false });
});

it("the editor height for a 5-line file is the content height, not a fixed 630 px", () => {
  vi.stubGlobal("innerHeight", 900);
  vi.stubGlobal("document", doc);
  renderToString(<Monaco path="src/a.js" value={"a\nb\nc\nd\ne"} />);
  expect(seen.editor.height).toBe(CODE.top + 5 * CODE.lineHeight);
});

it("Edit puts each lease strip in a view zone above its first line, as tall as View's, and bands its lines", () => {
  vi.stubGlobal("document", doc);
  renderToString(<Monaco path="src/a.js" value="" leases={[{ from: 2, to: 4, cls: "exclusive agent", strip: <div className="lrow" /> }]} />);
  const zones = [], bands = [];
  seen.editor.onMount({ onDidContentSizeChange() {}, changeViewZones: (f) => f({ addZone: (z) => zones.push(z) }), createDecorationsCollection: (d) => bands.push(...d) });
  expect(zones).toEqual([{ afterLineNumber: 1, heightInPx: CODE.strip, domNode: {} }]);
  expect(bands).toEqual([{ range: { startLineNumber: 2, startColumn: 1, endLineNumber: 4, endColumn: 1 },
    options: { isWholeLine: true, className: "band exclusive agent", marginClassName: "band edge exclusive agent" } }]);
});

it("Edit uses the same tokens as View", async () => {
  vi.stubGlobal("document", doc);
  // A recording Monaco: shikiToMonaco hands it a tokens provider per grammar and a theme whose rules name scopes.
  const ids = new Set(), providers = {};
  const m = { languages: { register: ({ id }) => ids.add(id), getLanguages: () => [...ids].map((id) => ({ id })), setTokensProvider: (id, p) => { providers[id] = p; } },
    editor: { defineTheme() {}, setTheme() {}, create() {} } };
  // A distinct colour per tokens.css variable; punctuation shares --text with plain text, so both count as plain below.
  const hexOf = (v) => `#00${(Object.values(CLASS_VAR).indexOf(v) + 16).toString(16)}00`;
  const line = "func Area(s Shape) float64 { return math.Max(len(s.Pts), 0x1f) // done";
  expect(await sync(m, "geo/area.go", hexOf)).toBe("go");
  const cls = Object.fromEntries(SCOPES), plain = (c) => (c === "c-pu" ? null : c);
  // Each character's class in Edit (Monaco's tokens) and in View (lib/highlight.js), which must agree.
  const edit = [], view = [];
  const toks = providers.go.tokenize(line, providers.go.getInitialState()).tokens;
  toks.forEach((t, i) => { for (let j = t.startIndex; j < (toks[i + 1]?.startIndex ?? line.length); j++) edit[j] = plain(cls[t.scopes] ?? null); });
  for (const [c, text] of (await tokens("geo/area.go", line))[0]) view.push(...Array(text.length).fill(plain(c)));
  expect(edit.filter((c, j) => line[j] !== " ")).toEqual(view.filter((c, j) => line[j] !== " "));
  expect(new Set(view.filter(Boolean)).size).toBeGreaterThan(3);
}, 60000);
