// Minimal YAML subset for .cinder.yml: nested maps by indentation, `- ` lists, flow `[a, b]` and `{k: v}`,
// quoted or plain scalars, `#` comments, lists of block maps (`- name: x` then indented keys). No anchors or multi-line strings.
// A duplicate key or a tab in indentation is an error, as in YAML itself.
// Split on commas outside quotes and nested [] or {}, so `"0,30 * * * *"` stays one cron and `{ gradual: [10, 50, 100] }` keeps its list.
const split = (s) => {
  const parts = [""];
  let depth = 0;
  let quote = null;
  for (const c of s) {
    if (quote) { if (c === quote) quote = null; } else if (c === '"' || c === "'") quote = c;
    else if (c === "," && depth === 0) { parts.push(""); continue; } else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth--;
    parts[parts.length - 1] += c;
  }
  return parts;
};

const scalar = (s) => {
  s = s.trim();
  if (/^[[{]/.test(s) && !/[\]}]$/.test(s)) throw new Error(`unclosed "${s[0]}"`);
  if (s.startsWith("[") && s.endsWith("]")) return split(s.slice(1, -1)).map(scalar).filter((v) => v !== "");
  if (s.startsWith("{") && s.endsWith("}")) {
    const map = {};
    for (const p of split(s.slice(1, -1)).filter((x) => x.trim())) {
      const i = p.indexOf(":");
      if (i < 0) throw new Error(`bad flow map entry "${p.trim()}"`);
      const k = p.slice(0, i).trim();
      if (Object.hasOwn(map, k)) throw new Error(`duplicate key ${k}`);
      map[k] = scalar(p.slice(i + 1));
    }
    return map;
  }
  return /^(["']).*\1$/.test(s) ? s.slice(1, -1) : s;
};

// at, when given, is filled with each block key's dotted path (list items by index) → its 1-based line.
export function parseYaml(text, at = {}) {
  const lines = text.split("\n")
    .map((l, n) => ({ n: n + 1, l: l.replace(/\s+#.*$|^\s*#.*$/, "").trimEnd() }))
    .filter(({ l }) => l.trim())
    .map(({ n, l }) => {
      if (/^ *\t/.test(l)) throw new Error(`yaml: line ${n}: tab used for indentation`);
      return { n, indent: l.length - l.trimStart().length, text: l.trim() };
    });
  let i = 0;
  // A scalar's error names the 1-based line of the file it is on.
  const value = (line, s) => {
    try { return scalar(s); } catch (e) { throw new Error(`yaml: line ${line.n}: ${e.message}`, { cause: e }); }
  };
  const block = (indent, path) => {
    if (lines[i].text.startsWith("- ")) {
      const list = [];
      while (i < lines.length && lines[i].indent === indent && lines[i].text.startsWith("- ")) {
        const item = lines[i].text.slice(1).trimStart();
        // `- key: value` opens a block map whose keys line up with `key`; re-read the line as that map's first entry.
        if (/^[^\s"'[{][^:]*:(\s|$)/.test(item)) {
          const at = indent + lines[i].text.length - item.length;
          lines[i] = { ...lines[i], indent: at, text: item };
          list.push(block(at, [...path, list.length]));
        } else list.push(value(lines[i], lines[i++].text.slice(2)));
      }
      return list;
    }
    const map = {};
    while (i < lines.length && lines[i].indent === indent) {
      const line = lines[i++];
      const m = /^([^:]+):(?:\s+(.*))?$/.exec(line.text);
      if (!m) throw new Error(`yaml: line ${line.n}: expected "key: value", got "${line.text}"`);
      const key = m[1].trim(), here = [...path, key];
      if (Object.hasOwn(map, key)) throw new Error(`yaml: line ${line.n}: duplicate key ${here.join(".")}`);
      at[here.join(".")] = line.n;
      map[key] = m[2] !== undefined ? value(line, m[2])
        : i < lines.length && lines[i].indent > indent ? block(lines[i].indent, here) : null;
    }
    return map;
  };
  if (!lines.length) return {};
  const out = block(lines[0].indent, []);
  if (i < lines.length) throw new Error(`yaml: line ${lines[i].n}: unexpected indentation at "${lines[i].text}"`);
  return out;
}
