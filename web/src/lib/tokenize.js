// A small per-line highlighter for first paint, before Shiki's grammars load (lib/highlight.js): comments, strings and
// keywords, plus builtins, function names, types, numbers, operators, tags and keys where a language lists them, in the
// same classes Shiki's tokens map to.
// lazy: one line at a time, so a block comment or string spanning lines is only coloured on its first line.
const STR = String.raw`"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'`;
const words = (s) => String.raw`\b(?:${s.split(" ").join("|")})\b`;
const C = String.raw`//.*|/\*.*?(?:\*/|$)`;
const HASH = String.raw`(?:^|(?<=\s))#.*`;

const JS = "async await break case catch class const continue default delete do else export extends finally for from function if import in instanceof let new null of return static super switch this throw true false try typeof undefined var void while yield";
// TypeScript's keywords beyond JavaScript's.
export const TS_WORDS = "abstract as declare enum implements interface keyof namespace private protected public readonly type";
const TEMPLATE = `${STR}|\`(?:\\\\.|[^\`\\\\])*\``;
const NUM = String.raw`-?\b\d+(?:\.\d+)?(?:[eE][-+]?\d+)?\b`;
const ci = (s) => s.replace(/[a-z]/gi, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`);
const base = (cm, st, kw) => ({ "c-cm": cm, "c-st": st, "c-kw": kw });
// JSX tags (a < not right after a name: Array<string> is a generic), types, function names and JSX attributes.
const JSX = { "c-tg": String.raw`(?<=(?:^|[^\w$])<\/?)[a-zA-Z][\w.-]*`, "c-ty": String.raw`\b[A-Z][\w$]*`, "c-fn": String.raw`[a-z_$][\w$]*(?=\s*\()`,
  "c-at": String.raw`[a-zA-Z_][\w-]*(?==[{"'])` };
const LABEL = String.raw`(?:[\w-]+|"[^"]*")`;
// Each language: {class: pattern}, tried in that order.
const LANGS = {
  js: { ...base(C, TEMPLATE, words(JS)), ...JSX },
  ts: { ...base(C, TEMPLATE, words(`${JS} ${TS_WORDS}`)), ...JSX },
  py: base(HASH, STR, words("and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield None True False self")),
  cs: base(C, STR, words("abstract as async await base bool break case catch class const continue default do else enum false finally for foreach if in int interface internal is namespace new null object override private protected public readonly return sealed static string struct switch this throw true try using var virtual void while")),
  tf: { "c-cm": `${C}|${HASH}`, "c-ty": String.raw`(?<=^\s*)[\w-]+(?=[ \t]+(?:${LABEL}[ \t]*){0,2}\{)`,
    "c-ns": String.raw`(?<=^\s*[\w-]+[ \t]+(?:${LABEL}[ \t]*)?)${LABEL}(?=[ \t]*(?:${LABEL}[ \t]*)?\{)`, "c-at": String.raw`(?<=^\s*)[\w-]+(?=\s*=(?!=))`,
    "c-st": STR, "c-kw": words("var local path for_each any string number bool true false null if else endif for in endfor"), "c-nm": NUM, "c-op": String.raw`[=><!~?:&|+\-*/^%]+` },
  go: { "c-cm": C, "c-st": `${STR}|\`[^\`]*\``, "c-kw": words("break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var"),
    "c-bi": words("nil true false iota append cap clear close complex copy delete imag len make max min new panic print println real recover"),
    "c-ty": `${words("any bool byte comparable error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr")}|\\b[A-Z]\\w*\\b(?!\\()`,
    "c-fn": String.raw`[A-Za-z_]\w*(?=\()`, "c-nm": String.raw`\b(?:0[xX][\da-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][-+]?\d+)?)\b`,
    "c-op": String.raw`\/(?![/*])=?|[=><!~?:&|+\-*^%]+`, "c-pu": String.raw`[{}()[\];,]|\.(?!\d)` },
  rs: base(C, STR, words("fn pub use let mut for in impl struct trait const match return where mod type crate super Self self true false if else loop while enum")),
  json: { "c-at": String.raw`"(?:\\.|[^"\\])*"(?=\s*:)`, "c-st": STR, "c-kw": words("true false null"), "c-nm": NUM },
  // Keys, anchors and aliases, then a value: keyword, number or (quoted or not) string.
  yaml: { "c-cm": HASH, "c-ty": String.raw`(?<=^\s*(?:-\s+)?)(?:"[^"]*"|'[^']*'|[^\s#'"-][^#'"]*?)(?=[ \t]*:(?: |$))`, "c-ns": "[&*][^ ]+",
    "c-kw": String.raw`(?<=:\s+)(?:true|false|null|~)(?=\s*(?:#|$))`, "c-nm": String.raw`(?<=:\s+)-?\d+(?:\.\d+)?(?=\s*(?:#|$))`,
    "c-st": String.raw`${STR}|(?<=:\s+)[^\s#&*'"][^#]*?(?=\s*(?:\s#|$))` },
  md: { "c-kw": String.raw`^#{1,6} .*|^\s*(?:[*+:-]|\d+\.)\s`, "c-st": "^\\s*(?:```|~~~).*|`[^`]+`" },
  sql: { "c-cm": String.raw`--.*|/\*.*?(?:\*/|$)`, "c-st": "'(?:''|[^'])*'",
    "c-ty": words(ci("bigint blob boolean char date decimal int integer json numeric real smallint text timestamp uuid varchar")),
    "c-op": `${words(ci("all and any between exists in like not or some union join left right inner outer cross full is null"))}|[<>=!%&+\\-*/|~^]`,
    "c-fn": String.raw`[A-Za-z_]\w*(?=\()`, "c-kw": words(ci("select from where insert into values update set delete create table alter drop index view primary key foreign references unique default check constraint group by order having limit offset as on distinct case when then else end asc desc")),
    "c-nm": NUM },
  css: base(String.raw`/\*.*?(?:\*/|$)`, STR, "@[\\w-]+|!important"),
  html: base("<!--.*?(?:-->|$)", STR, "</?[\\w-]+|/?>"),
  docker: base(HASH, STR, String.raw`^\s*(?:FROM|RUN|CMD|LABEL|EXPOSE|ENV|ADD|COPY|ENTRYPOINT|VOLUME|USER|WORKDIR|ARG|ONBUILD|STOPSIGNAL|HEALTHCHECK|SHELL)\b|\bAS\b`),
  sh: base(HASH, STR, words("if then else elif fi for in do done while until case esac function return local export set")),
};
const EXT = { js: "js", jsx: "js", mjs: "js", cjs: "js", ts: "ts", tsx: "ts", py: "py", cs: "cs", tf: "tf", hcl: "tf", go: "go", rs: "rs", json: "json", sql: "sql", yaml: "yaml", yml: "yaml",
  md: "md", css: "css", html: "html", sh: "sh", bash: "sh", toml: "sh", mk: "sh", dockerfile: "docker" };
// Files known by name: Dockerfile and the rest have no extension to go by.
const NAMES = { Dockerfile: "docker", Containerfile: "docker", Makefile: "sh", GNUmakefile: "sh", "go.mod": "go", "go.sum": "go", ".gitignore": "sh", ".dockerignore": "sh" };
const RE = Object.fromEntries(Object.entries(LANGS).map(([k, ps]) => [k, [new RegExp(Object.values(ps).map((p) => `(${p})`).join("|"), "g"), Object.keys(ps)]]));

// The language of path: its file name first (Dockerfile, Makefile, go.mod, .env*), then its extension; null when unknown.
export const langOf = (path) => {
  const name = path.split("/").at(-1);
  return NAMES[name] ?? (name.startsWith("Dockerfile.") ? "docker" : name.startsWith(".env") ? "sh" : EXT[name.split(".").at(-1)] ?? null);
};

// [[class or null, text], ...] covering the whole line; plain text for languages it doesn't know.
export function tokenize(line, lang) {
  if (!RE[lang] || !line) return [[null, line]];
  const [re, names] = RE[lang];
  const out = [];
  let at = 0;
  for (const m of line.matchAll(re)) {
    if (!m[0]) continue;
    if (m.index > at) out.push([null, line.slice(at, m.index)]);
    const cls = names[m.slice(1).findIndex((g) => g !== undefined)];
    out.push([cls, m[0]]);
    at = m.index + m[0].length;
  }
  if (at < line.length) out.push([null, line.slice(at)]);
  return out;
}
