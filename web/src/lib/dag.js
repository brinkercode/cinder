// Layered layout for a directed graph. Edges inside a strongly connected
// component (Tarjan) are returned as cycleEdges and ignored for layering,
// so a cycle never turns into NaN or unbounded columns.
export function layout(nodes, edges) {
  const out = new Map(nodes.map((id) => [id, []]));
  for (const e of edges) out.get(e.from)?.push(e.to);

  const index = new Map(), low = new Map(), comp = new Map(), stack = [];
  const visit = (v) => {
    index.set(v, index.size);
    low.set(v, index.get(v));
    stack.push(v);
    for (const w of out.get(v)) {
      if (!out.has(w)) continue;
      if (!index.has(w)) { visit(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (!comp.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
    }
    if (low.get(v) !== index.get(v)) return;
    let w;
    do { w = stack.pop(); comp.set(w, v); } while (w !== v);
  };
  for (const v of nodes) if (!index.has(v)) visit(v);

  const cycleEdges = edges.filter((e) => comp.has(e.from) && comp.get(e.from) === comp.get(e.to));
  const dagEdges = edges.filter((e) => out.has(e.from) && out.has(e.to) && !cycleEdges.includes(e));

  // Longest-path layering over the acyclic remainder (Kahn order).
  const col = new Map(nodes.map((id) => [id, 0]));
  const indeg = new Map(nodes.map((id) => [id, 0]));
  for (const e of dagEdges) indeg.set(e.to, indeg.get(e.to) + 1);
  const queue = nodes.filter((id) => indeg.get(id) === 0);
  for (const v of queue) {
    for (const e of dagEdges) {
      if (e.from !== v) continue;
      col.set(e.to, Math.max(col.get(e.to), col.get(v) + 1));
      indeg.set(e.to, indeg.get(e.to) - 1);
      if (indeg.get(e.to) === 0) queue.push(e.to);
    }
  }

  const rows = new Map();
  const positions = {};
  for (const id of nodes) {
    const c = col.get(id);
    rows.set(c, (rows.get(c) ?? -1) + 1);
    positions[id] = { col: c, row: rows.get(c) };
  }
  return { positions, cycleEdges };
}

// The curve from an out port to an in port; dashed for a cycle edge (it stays out of the columns) and the trigger's edges.
export function connector([x1, y1], [x2, y2], dashed = false) {
  const dx = Math.max(40, (x2 - x1) / 2);
  return { d: `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`, dash: dashed ? "5 4" : undefined };
}
