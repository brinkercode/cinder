// The heading anchor rule, shared with the wiki toc the API returns.
import { useEffect, useState } from "react";
import { anchor } from "../../../worker/src/api/contract.js";

export { anchor };

const INLINE = /`(?<code>[^`]+)`|!\[(?<alt>[^\]]*)\]\((?<src>[^)\s]+)\)|\[\[(?<page>[^\]]+)\]\]|\[(?<label>[^\]]+)\]\((?<href>[^)\s]+)\)|\*\*(?<bold>[^*]+)\*\*|\*(?<em>[^*\s][^*]*)\*|~~(?<del>[^~]+)~~|<(?<auto>https?:\/\/[^>\s]+)>|(?<cmt><!--[\s\S]*?-->)|<(?<close>\/)?(?<tag>[a-zA-Z][\w-]*)(?<attrs>(?:\s[^<>]*?)?)\/?>/g;
// http, https or relative; anything else with a scheme (javascript:, data:) or protocol-relative (//host) is refused.
const safe = (u) => /^https?:\/\//i.test(u) || (!/^[^/?#]*:/.test(u) && !u.startsWith("//"));
const relative = (u) => !/^(https?:|#|\/\/)/i.test(u);

// Raw HTML a README uses for layout. Any other tag stays text; attributes outside ATTRS are dropped, so no handler or style runs.
const TAGS = new Set("a abbr b blockquote br code dd del details div dl dt em h1 h2 h3 h4 h5 h6 hr i img ins kbd li mark ol p picture pre q s samp small span strong sub summary sup table tbody td tfoot th thead tr tt u ul var".split(" "));
const VOID = new Set(["br", "hr", "img"]);
const ATTRS = { align: "align", alt: "alt", title: "title", width: "width", height: "height", colspan: "colSpan", rowspan: "rowSpan", open: "open", start: "start", href: "href", src: "src" };

// An allowed tag's props: href and src only when safe, relative ones resolved through cx.
function props(attrs, cx) {
  const out = {};
  for (const [, n, a, b, c] of attrs.matchAll(/([a-zA-Z-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    const name = ATTRS[n.toLowerCase()], v = a ?? b ?? c ?? true;
    if (!name) continue;
    if (name === "href" || name === "src") { if (typeof v === "string" && safe(v)) out[name] = cx.url(v, name); } else out[name] = v;
  }
  return out;
}

// Opened tags take what follows as children until their closing tag; unclosed ones close at the end, a stray close is dropped.
function nest(tokens) {
  const stack = [{ kids: [] }];
  const close = () => { const f = stack.pop(); stack.at(-1).kids.push(<f.tag key={stack.at(-1).kids.length} {...f.props}>{f.kids.length ? f.kids : undefined}</f.tag>); };
  for (const t of tokens) {
    if (t?.tag && t.close) { if (stack.some((f) => f.tag === t.tag)) { while (stack.at(-1).tag !== t.tag) close(); close(); } }
    else if (t?.tag && VOID.has(t.tag)) { const top = stack.at(-1); top.kids.push(<t.tag key={top.kids.length} {...t.props} />); }
    else if (t?.tag) stack.push({ tag: t.tag, props: t.props, kids: [] });
    else stack.at(-1).kids.push(t);
  }
  while (stack.length > 1) close();
  return stack[0].kids;
}

// Inline code, bold, italic, strikethrough, images, links, <https://…>, raw HTML and [[Page]] links (to `${cx.wiki}/Page`), as
// tokens for nest(). A link or image that isn't safe stays text.
function tokens(s, cx) {
  const out = [];
  let at = 0;
  for (const m of s.matchAll(INLINE)) {
    out.push(s.slice(at, m.index));
    at = m.index + m[0].length;
    const k = m.index, g = m.groups;
    if (g.code) out.push(<code key={k}>{g.code}</code>);
    else if (g.src !== undefined && safe(g.src)) out.push(<img key={k} src={cx.url(g.src, "src")} alt={g.alt} />);
    else if (g.page && cx.wiki) out.push(<a key={k} href={`${cx.wiki}/${encodeURIComponent(g.page)}`}>{g.page}</a>);
    else if (g.label && safe(g.href)) out.push(<a key={k} href={cx.url(g.href, "href")}>{inline(g.label, cx)}</a>);
    else if (g.bold) out.push(<strong key={k}>{g.bold}</strong>);
    else if (g.em) out.push(<em key={k}>{g.em}</em>);
    else if (g.del) out.push(<del key={k}>{g.del}</del>);
    else if (g.auto) out.push(<a key={k} href={g.auto}>{g.auto}</a>);
    else if (g.cmt) continue;
    else if (g.tag && TAGS.has(g.tag.toLowerCase())) out.push({ tag: g.tag.toLowerCase(), close: !!g.close, props: props(g.attrs, cx) });
    else out.push(m[0]);
  }
  out.push(s.slice(at));
  return out.filter((t) => t !== "");
}
const inline = (s, cx) => nest(tokens(s, cx));

const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

// A fence's language (js, bash, yml, …) names a grammar the way a file extension does.
export const fenceTokens = (lang, src) => import("./highlight.js").then((m) => m.tokens(`x.${lang.toLowerCase()}`, src));

// A fenced block: plain on first paint, then coloured by the fence's language with the grammars the Code page uses.
function Fenced({ lang, src }) {
  const [colored, setColored] = useState(null);
  useEffect(() => {
    let on = true;
    if (lang) fenceTokens(lang, src).then((t) => on && setColored({ src, t }), (e) => console.warn("highlighting failed", e));
    return () => { on = false; };
  }, [lang, src]);
  const t = colored?.src === src ? colored.t : null;
  return <pre className="code md-pre">{t ? t.map((line, i) => [i ? "\n" : "", ...line.map(([c, x], k) => (c ? <span key={`${i}.${k}`} className={c}>{x}</span> : x))]) : src}</pre>;
}

const H = { 1: "h2", 2: "h3", 3: "h4", 4: "h5", 5: "h6", 6: "h6" };
const ITEM = /^(\s*)(?:([-*+])|(\d+)[.)])\s+(.*)$/;
const HTML = /^\s*(<!--|<\/?([a-zA-Z][\w-]*)[\s/>])/;

// Items [indent, El, number, text] as nested lists: an item indented past its list's first item belongs to the item above.
function lists(items, li, key = "") {
  const out = [];
  for (const it of items) {
    const top = out.at(-1);
    if (top && it[0] >= top.items[0][0] + 2) top.items.at(-1)[4].push(it);
    else if (top && top.items[0][1] === it[1]) top.items.push([...it, []]);
    else out.push({ items: [[...it, []]] });
  }
  return out.map(({ items: [first, ...rest] }, i) => {
    const El = first[1], all = [first, ...rest];
    return <El key={`${key}${i}`} start={El === "ol" && first[2] !== "1" ? Number(first[2]) : undefined}>{all.map((x, j) => li(x[3], j, x[4].length ? lists(x[4], li) : null))}</El>;
  });
}

// Headings, nested and task lists, blockquotes, tables, rules, fenced code, images, links and a README's raw HTML: what a README
// or wiki page needs, not full markdown. url(u, "src" | "href") resolves a relative image or link (the Code page points them into the repo).
export function Markdown({ text, wiki, url = (u) => u }) {
  const cx = { wiki, url: (u, kind) => (relative(u) ? url(u, kind) : u) };
  const blocks = [];
  let fence = null, prev = "";
  for (const l of text.split("\n")) {
    const last = blocks.at(-1), head = !fence && l.match(/^(#{1,6}) (.*)$/);
    if (fence ? l.trimStart().startsWith(fence) : /^\s*(```|~~~)/.test(l)) {
      if (fence) fence = null;
      else { fence = l.trim().slice(0, 3); blocks.push(["pre", [], l.trim().slice(3).trim().split(/\s/)[0]]); }
    } else if (fence) last[1].push(l);
    else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) blocks.push(["hr", []]);
    else if (ITEM.test(l)) {
      const [, ind, bullet, n, x] = l.match(ITEM), it = [ind.replace(/\t/g, "    ").length, bullet ? "ul" : "ol", n, x];
      if (last?.[0] === "list") last[1].push(it); else blocks.push(["list", [it]]);
    } else if (l.trim() && (last?.[0] === "html" && prev.trim() || (HTML.test(l) && (l.includes("<!--") || TAGS.has(l.match(HTML)[2]?.toLowerCase()))))) {
      if (last?.[0] === "html" && prev.trim()) last[1].push(l); else blocks.push(["html", [l]]);
    } else if (l.startsWith(">")) { const q = l.replace(/^> ?/, ""); if (last?.[0] === "blockquote") last[1].push(q); else blocks.push(["blockquote", [q]]); }
    else if (l.startsWith("|")) { if (/^[\s|:-]+$/.test(l)) continue; if (last?.[0] === "table") last[1].push(cells(l)); else blocks.push(["table", [cells(l)]]); }
    else if (head) blocks.push([H[head[1].length], [head[2]]]);
    else if (l.trim() && last?.[0] === "p" && prev.trim()) last[1][0] += ` ${l.trim()}`; // consecutive lines are one paragraph
    else if (l.trim()) blocks.push(["p", [l]]);
    prev = l;
  }
  const md = (s) => inline(s, cx);
  // "[ ] x" and "[x] x" items show a checkbox, as a task list.
  const li = (x, j, kids) => { const t = x.match(/^\[([ xX])\] (.*)$/); return <li key={j}>{t ? <><input type="checkbox" checked={t[1] !== " "} disabled readOnly /> {md(t[2])}</> : md(x)}{kids}</li>; };
  // HTML blocks share one nest() with the blocks between them, so <details> … </details> wraps the markdown inside it.
  return (
    <div className="md">{nest(blocks.flatMap(([El, ls, arg], i) => (El === "html" ? tokens(ls.join("\n"), cx)
      : El === "pre" ? <Fenced key={i} lang={arg} src={ls.join("\n")} />
      : El === "hr" ? <hr key={i} />
      : El === "list" ? lists(ls, li, `${i}.`)
      : El === "blockquote" ? <blockquote key={i}>{ls.map((x, j) => <p key={j}>{md(x)}</p>)}</blockquote>
      : El === "table" ? (
        <table key={i}>
          <thead><tr>{ls[0].map((c, j) => <th key={j}>{md(c)}</th>)}</tr></thead>
          <tbody>{ls.slice(1).map((r, j) => <tr key={j}>{r.map((c, n) => <td key={n}>{md(c)}</td>)}</tr>)}</tbody>
        </table>
      ) : <El key={i} id={El === "h4" ? anchor(ls[0]) : undefined}>{md(ls[0])}</El>)))}</div>
  );
}
