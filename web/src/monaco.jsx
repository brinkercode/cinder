// Monaco bundled by Vite (no CDN loader); code.jsx loads this file lazily.
import Editor, { loader } from "@monaco-editor/react";
// The editor with every feature (find, folding, ...) but no language services: a viewer and plain editor need only the
// base worker. Colours come from Shiki's grammars (lib/highlight.js), the same ones View uses.
import * as monaco from "monaco-editor/editor/editor.api";
import "monaco-editor/features/register.all";
import { shikiToMonaco } from "@shikijs/monaco";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import { CLASS_VAR, CODE, codeTheme, editorOptions } from "./lib/code-metrics.js";
import { highlighter, languageOf, load, textmateTheme } from "./lib/highlight.js";

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
loader.config({ monaco });

// Monaco themes take hex and tokens.css colours are oklch, so a canvas pixel converts each one.
let px;
const hex = (css) => {
  px ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  px.fillStyle = css; px.fillRect(0, 0, 1, 1);
  return `#${[...px.getImageData(0, 0, 1, 1).data.slice(0, 3)].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
};
// Hands m (Monaco) path's grammar and codeTheme(), coloured from the page's current tokens.css (.dark switches it).
// lazy: each new grammar or theme re-runs shikiToMonaco, which wraps setTheme once more; a page opens few of either.
let synced = "";
export async function sync(m, path, colorOf = (v) => hex(getComputedStyle(document.documentElement).getPropertyValue(v).trim())) {
  const lang = await load(path), name = codeTheme(), h = await highlighter();
  if (lang) m.languages.register({ id: lang });
  if (`${lang}|${name}` !== synced) {
    synced = `${lang}|${name}`;
    await h.loadTheme(textmateTheme(name, name === "cinder-dark" ? "dark" : "light", (cls) => colorOf(cls ? CLASS_VAR[cls] : "--text")));
    // View's limit (lib/highlight.js): the 500ms default cuts a cold first line short, and Edit then disagrees with View.
    shikiToMonaco(h, m, { tokenizeTimeLimit: 3000 });
  }
  m.editor.setTheme(name);
  return lang ?? "plaintext";
}

const fit = (h) => Math.min(560, h);

// The language follows path (languageOf); colours follow the app theme.
// The height follows the content, up to 560px. leases: [{from, to, cls, strip}], each strip a view zone above
// line from (CODE.strip tall, as in View) and cls a band over from..to, so Edit's lines sit where View's do.
export default function Monaco({ options, leases = [], ...props }) {
  const [height, setHeight] = useState(() => fit(CODE.top + (props.value ?? "").split("\n").length * CODE.lineHeight));
  const [hosts, setHosts] = useState([]);
  const [lang, setLang] = useState(() => languageOf(props.path ?? "") ?? "plaintext");
  useEffect(() => { sync(monaco, props.path ?? "").then(setLang, (e) => console.warn("highlighting failed", e)); }, [props.path]);
  // lazy: zones and bands are set once at mount, so a lease taken mid-edit shows on the next Edit; diff leases if that matters.
  const mount = (editor) => {
    editor.onDidContentSizeChange((e) => setHeight(fit(e.contentHeight)));
    const nodes = leases.map(() => document.createElement("div"));
    editor.changeViewZones((z) => leases.forEach((l, i) => z.addZone({ afterLineNumber: l.from - 1, heightInPx: CODE.strip, domNode: nodes[i] })));
    editor.createDecorationsCollection(leases.map((l) => ({ range: { startLineNumber: l.from, startColumn: 1, endLineNumber: l.to, endColumn: 1 },
      options: { isWholeLine: true, className: `band ${l.cls}`, marginClassName: `band edge ${l.cls}` } })));
    setHosts(nodes);
  };
  return (<>
    <Editor height={height} theme={codeTheme()} language={lang} onMount={mount} {...props}
      options={{ minimap: { enabled: false }, scrollBeyondLastLine: false, contextmenu: false,
        scrollbar: { vertical: "hidden", horizontal: "hidden", useShadows: false }, overviewRulerLanes: 0, ...editorOptions, ...options }} />
    {hosts.map((h, i) => createPortal(leases[i].strip, h, i))}
  </>);
}
