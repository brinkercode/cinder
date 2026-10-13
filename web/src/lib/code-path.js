// Every Code URL is /:repo/code/:ref/:path. A ref may hold "/" (release/1.2): links encode it as %2F, but static asset
// serving turns %2F back into "/" on a full load, and a typed URL may not encode it at all.
export const codePath = (repo, ref, path = "") =>
  `/${encodeURIComponent(repo)}/code/${encodeURIComponent(ref)}${path ? `/${path.split("/").map(encodeURIComponent).join("/")}` : ""}`;

// The router hands over ref (its first segment, decoded) and the rest. The longest known branch or tag the segments
// spell is the ref; when none does (a change workspace, an unknown ref), ref stays as given for the page to handle.
export function parseCodePath(ref, rest, names) {
  if (!rest) return { ref, path: "" };
  const parts = rest.split("/");
  for (let i = parts.length; i > 0; i--) {
    const at = [ref, ...parts.slice(0, i)].join("/");
    if (names.includes(at)) return { ref: at, path: parts.slice(i).join("/") };
  }
  return { ref, path: rest };
}
