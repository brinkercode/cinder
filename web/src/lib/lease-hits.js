// The leases another change holds on the symbols an edit touches. was and now are the file's lines before and after; the
// edit spans the lines between their common prefix and suffix (a pure insertion touches the line it lands on).
// syms are the file's { name, from, to }; leaseOf(name) is the lease on that symbol, if any. Each hit is the lease plus its lines.
export function leaseHits(was, now, syms, leaseOf) {
  let top = 0;
  while (top < was.length && top < now.length && was[top] === now[top]) top++;
  let tail = 0;
  while (tail < was.length - top && tail < now.length - top && was[was.length - 1 - tail] === now[now.length - 1 - tail]) tail++;
  const first = top + 1, last = Math.max(first, was.length - tail);
  return syms.flatMap((s) => {
    const l = s.from <= last && s.to >= first && leaseOf(s.name);
    return l ? [{ ...l, from: s.from, to: s.to }] : [];
  });
}
