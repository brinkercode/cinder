import { prerender } from "react-dom/static";
import { renderToString } from "react-dom/server";
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { routes } from "../routes.jsx";
import { repoUrl } from "../code.jsx";
import { fenceTokens, Markdown } from "./markdown.jsx";

const README = `<div class="md"><h2>edge-router</h2><p>L7 routing and request rewriting for the nimbus edge.</p><h3>How changes land here</h3><ul><li>Write an intent and an agent takes it, or open a file and edit it yourself. Both become a change.</li><li>Every change leases the symbols it touches. Agents and people share the same leases.</li><li>The verifier merges every change. Branch policy lives in <code>cinder.toml</code>.</li></ul><h3>Local development</h3><pre class="code md-pre">cargo test --workspace
cinder checkout c-1042                  # pull any change&#x27;s workspace
git push cinder HEAD:refs/for/develop   # a push becomes a change</pre></div>`;

afterEach(() => vi.unstubAllEnvs());

describe("markdown", () => {
  it("a javascript: link renders as text", () => {
    const html = renderToString(<Markdown text={"[x](javascript:void) [ok](https://a.test) [rel](docs/a.md) [p](//evil.test)"} />);
    expect(html).not.toContain("href=\"javascript");
    expect(html).toContain("[x](javascript:void)");
    expect(html).toContain('<a href="https://a.test">ok</a>');
    expect(html).toContain('<a href="docs/a.md">rel</a>');
    expect(html).toContain("[p](//evil.test)");
  });

  it("[[Billing]] links to the wiki page", () => {
    expect(renderToString(<Markdown text="See [[Billing]]." wiki="/acme%2Fweb/wiki" />)).toBe('<div class="md"><p>See <a href="/acme%2Fweb/wiki/Billing">Billing</a>.</p></div>');
  });

  it("renders ### as a heading with an anchor id", () => {
    expect(renderToString(<Markdown text={"### Lease queue"} />)).toBe('<div class="md"><h4 id="lease-queue">Lease queue</h4></div>');
  });

  it("renders tables and blockquotes", () => {
    expect(renderToString(<Markdown text={"> quoted\n| a | b |\n|---|---|\n| 1 | `2` |"} />)).toBe(
      '<div class="md"><blockquote><p>quoted</p></blockquote><table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td><code>2</code></td></tr></tbody></table></div>');
  });

  it("a fenced block is coloured by its language once the grammar loads", async () => {
    expect(renderToString(<Markdown text={"```js\nconst a = 1;\n```"} />)).toBe('<div class="md"><pre class="code md-pre">const a = 1;</pre></div>');
    expect((await fenceTokens("js", "const a = 1; // b"))[0]).toContainEqual(["c-kw", "const"]);
    expect((await fenceTokens("bash", "echo hi # b"))[0]).toContainEqual(["c-bi", "echo"]);
    expect((await fenceTokens("yml", "a: 1"))[0]).toContainEqual(["c-nm", "1"]);
  });

  it("renders numbered and task lists, deep headings, rules, images, strikethrough and joined paragraphs", () => {
    const html = renderToString(<Markdown text={"3. a\n4. b\n* [x] done\n+ [ ] todo\n#### Deep\n---\n![logo](img/a.png) ![x](javascript:1) ~~old~~ <https://a.test>\nsame paragraph"} />);
    expect(html).toContain('<ol start="3"><li>a</li><li>b</li></ol>');
    expect(html).toContain('<li><input type="checkbox" disabled="" readOnly="" checked=""/> <!-- -->done</li><li><input type="checkbox" disabled="" readOnly=""/> <!-- -->todo</li>');
    expect(html).toContain("<h5>Deep</h5><hr/>");
    expect(html).toContain('<img src="img/a.png" alt="logo"/>');
    expect(html).not.toContain('src="javascript');
    expect(html).toContain('<del>old</del> <a href="https://a.test">https://a.test</a> same paragraph</p>');
  });

  it("nests indented list items under the item above", () => {
    expect(renderToString(<Markdown text={"- a\n  - b\n    1. c\n- d"} />)).toBe(
      '<div class="md"><ul><li>a<ul><li>b<ol><li>c</li></ol></li></ul></li><li>d</li></ul></div>');
  });

  it("renders a README's raw HTML from an allowlist and drops handlers, styles and unsafe URLs", () => {
    const html = renderToString(<Markdown text={'<p align="center">\n  <img src="logo.png" width="120" onerror="alert(1)" style="x">\n</p>\n\n<details><summary>More</summary>\n\n- inside\n\n</details>\n\nPress <kbd>Ctrl</kbd> <a href="javascript:x">bad</a> <script>alert(1)</script> <!-- hidden -->'} url={(u, kind) => `/${kind}/${u}`} />);
    expect(html).toMatch(/<p align="center">\s*<img src="\/src\/logo.png" width="120"\/>\s*<\/p>/);
    expect(html).toContain("<details><summary>More</summary><ul><li>inside</li></ul></details>");
    expect(html).toContain("Press <kbd>Ctrl</kbd> <a>bad</a> <!-- -->&lt;script&gt;");
    expect(html).not.toMatch(/onerror|style=|hidden|javascript/);
  });

  it("resolves relative links and images through url and leaves absolute and anchor ones", () => {
    const html = renderToString(<Markdown text={"![a](img/a.png) [doc](docs/x.md) [ext](https://a.test) [top](#usage)"} url={(u, kind) => `/${kind}/${u}`} />);
    expect(html).toContain('src="/src/img/a.png"');
    expect(html).toContain('href="/href/docs/x.md"');
    expect(html).toContain('href="https://a.test"');
    expect(html).toContain('href="#usage"');
  });

  it("on the Code page a relative image reads the repo file and a relative link opens it, from the markdown file's folder", () => {
    expect(repoUrl("acme/web", "develop", "/acme%2Fweb/code/develop", "docs/guide.md", "../img/a b.png", "src")).toBe("/api/repos/acme%2Fweb/raw?ref=develop&path=img%2Fa%20b.png");
    expect(repoUrl("acme/web", "develop", "/acme%2Fweb/code/develop", "docs/guide.md", "setup.md#install", "href")).toBe("/acme%2Fweb/code/develop/docs/setup.md#install");
    expect(repoUrl("acme/web", "develop", "/acme%2Fweb/code/develop", "README.md", "/LICENSE", "href")).toBe("/acme%2Fweb/code/develop/LICENSE");
  });

  it("the README rendering on the Code page is unchanged", async () => {
    vi.stubEnv("VITE_FIXTURES", "1");
    const handler = createStaticHandler(routes);
    const context = await handler.query(new Request("http://cinder.test/acme%2Fweb/code/develop"));
    const { prelude } = await prerender(<StaticRouterProvider router={createStaticRouter(handler.dataRoutes, context)} context={context} hydrate={false} />);
    expect(await new Response(prelude).text()).toContain(README);
  });
});
