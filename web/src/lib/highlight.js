// One highlighter for View, Blame, change diffs and Monaco's Edit: Shiki's TextMate grammars (the ones VS Code ships),
// each language loaded on first use. Tokens become the c-* classes (CLASS_VAR), so tokens.css colours them in light and dark.
import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { bundledLanguages, bundledLanguagesInfo } from "shiki/langs";
import { CLASS_VAR } from "./code-metrics.js";

// TextMate scopes and the class each shows; the most specific matching scope wins, as in any TextMate theme.
export const SCOPES = [
  ["comment", "c-cm"], ["string", "c-st"], ["keyword", "c-kw"], ["storage", "c-kw"], ["keyword.operator", "c-op"],
  ["constant.numeric", "c-nm"], ["constant.language", "c-bi"], ["support.constant", "c-bi"], ["variable.language", "c-bi"], ["support.function.builtin", "c-bi"],
  ["entity.name.function", "c-fn"], ["support.function", "c-fn"], ["entity.name.type", "c-ty"], ["entity.name.class", "c-ty"], ["support.type", "c-ty"],
  ["storage.type.primitive", "c-ty"], ["entity.other.inherited-class", "c-ty"], ["entity.name.namespace", "c-ns"], ["entity.name.package", "c-ns"],
  ["punctuation", "c-pu"], ["entity.name.tag", "c-tg"], ["entity.other.attribute-name", "c-at"], ["support.type.property-name", "c-at"], ["meta.object-literal.key", "c-at"],
];
const CLASSES = Object.keys(CLASS_VAR);
// A TextMate theme colouring each scope with colorOf(its class): real colours for Monaco, one stand-in per class for View.
export const textmateTheme = (name, type, colorOf) => ({ name, type, colors: { "editor.foreground": colorOf(null) },
  settings: [{ settings: { foreground: colorOf(null) } }, ...SCOPES.map(([scope, cls]) => ({ scope, settings: { foreground: colorOf(cls) } }))] });
// View reads classes back from these stand-in colours: one per class, numbered 1 up; 0 is plain text.
const stand = (cls) => `#${(cls ? CLASSES.indexOf(cls) + 1 : 0).toString(16).padStart(6, "0")}`;
const CLASS_OF = Object.fromEntries(CLASSES.map((c) => [stand(c), c]));

// Extensions and file names the grammars' ids and aliases don't cover, as GitHub's language detection maps them.
const EXT = { cc: "cpp", cxx: "cpp", hh: "cpp", hpp: "cpp", h: "c", ex: "elixir", exs: "elixir", ml: "ocaml", mli: "ocaml", pl: "perl", pm: "perl", gradle: "groovy",
  bzl: "python", tfvars: "hcl", mk: "make", mts: "ts", cts: "ts", htm: "html", svg: "xml", plist: "xml", csproj: "xml", gemspec: "ruby", jenkinsfile: "groovy" };
const NAMES = { Dockerfile: "docker", Containerfile: "docker", Makefile: "make", GNUmakefile: "make", Jenkinsfile: "groovy", CODEOWNERS: "codeowners",
  ".gitignore": "shellscript", ".dockerignore": "shellscript", ".gitattributes": "shellscript", ".bashrc": "shellscript", ".zshrc": "shellscript", ".profile": "shellscript",
  ".bash_profile": "shellscript", "go.mod": "go", "go.sum": "go", Gemfile: "ruby", Rakefile: "ruby", Vagrantfile: "ruby", Podfile: "ruby", Procfile: "yaml",
  BUILD: "python", "BUILD.bazel": "python", WORKSPACE: "python", "WORKSPACE.bazel": "python", "CMakeLists.txt": "cmake", "nginx.conf": "nginx" };
// Each grammar's id by itself and by its aliases (py is python), so Monaco and View name a grammar the same way.
const ID = Object.fromEntries(bundledLanguagesInfo.flatMap((l) => [l.id, ...(l.aliases ?? [])].map((a) => [a, l.id])));
// The grammar for path: its file name, then its extension; null when none fits (plain text).
export function languageOf(path) {
  const name = path.split("/").at(-1);
  const id = NAMES[name] ?? (name.startsWith("Dockerfile.") ? "docker" : name.startsWith(".env") ? "dotenv" : null);
  if (id) return id;
  const ext = name.includes(".") ? name.split(".").at(-1).toLowerCase() : null;
  return ext && (ID[EXT[ext] ?? ext] ?? null);
}

// lazy: the JavaScript regex engine (no WASM download); a grammar it can't compile falls back to plain text.
let core;
export const highlighter = () => (core ??= createHighlighterCore({ engine: createJavaScriptRegexEngine({ forgiving: true }),
  themes: [textmateTheme("cinder-classes", "light", stand)], langs: [] }));
// path's grammar, loaded if need be; null for plain text.
export async function load(path) {
  const lang = languageOf(path);
  if (!lang) return null;
  const h = await highlighter();
  if (!h.getLoadedLanguages().includes(lang)) await h.loadLanguage(bundledLanguages[lang]);
  return lang;
}

// text's lines as [[class or null, text], ...], as the first-paint tokenizer gives them.
export async function tokens(path, text) {
  const lang = await load(path);
  if (!lang) return text.split("\n").map((l) => [[null, l]]);
  // A line past the time limit is left plain from where it stopped; 500 ms (the default) cut heavy grammars (PHP) short on a busy CPU.
  return (await highlighter()).codeToTokensBase(text, { lang, theme: "cinder-classes", tokenizeTimeLimit: 3000 })
    .map((line) => line.map((t) => [CLASS_OF[t.color?.toLowerCase()] ?? null, t.content]));
}
