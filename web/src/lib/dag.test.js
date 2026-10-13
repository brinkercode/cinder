import { describe, expect, it } from "vitest";
import { connector, layout } from "./dag.js";

describe("dag layout", () => {
  it("lays out a chain in increasing columns", () => {
    const { positions, cycleEdges } = layout(["a", "b", "c"], [{ from: "a", to: "b" }, { from: "b", to: "c" }]);
    expect(positions).toEqual({ a: { col: 0, row: 0 }, b: { col: 1, row: 0 }, c: { col: 2, row: 0 } });
    expect(cycleEdges).toEqual([]);
  });

  it("returns cycle edges instead of NaN columns", () => {
    const back = { from: "c", to: "b" };
    const self = { from: "d", to: "d" };
    const { positions, cycleEdges } = layout(["a", "b", "c", "d"], [{ from: "a", to: "b" }, { from: "b", to: "c" }, back, self]);
    expect(cycleEdges).toEqual([{ from: "b", to: "c" }, back, self]);
    for (const p of Object.values(positions)) expect(Number.isInteger(p.col) && Number.isInteger(p.row)).toBe(true);
    expect(positions.b.col).toBe(1);
  });

  it("parallel nodes share a column", () => {
    const { positions } = layout(["a", "b", "c", "d"], [
      { from: "a", to: "b" }, { from: "a", to: "c" }, { from: "b", to: "d" }, { from: "c", to: "d" },
    ]);
    expect(positions.b).toEqual({ col: 1, row: 0 });
    expect(positions.c).toEqual({ col: 1, row: 1 });
    expect(positions.d).toEqual({ col: 2, row: 0 });
  });

  it("a cycle edge stays out of the columns and is drawn dashed", () => {
    const edges = [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "c", to: "b" }, { from: "c", to: "d" }];
    const { positions, cycleEdges } = layout(["a", "b", "c", "d"], edges);
    expect(Object.fromEntries(Object.entries(positions).map(([id, p]) => [id, p.col]))).toEqual({ a: 0, b: 1, c: 0, d: 1 });
    const dash = edges.map((e) => connector([0, 0], [100, 50], cycleEdges.includes(e)).dash);
    expect(dash).toEqual([undefined, "5 4", "5 4", undefined]);
    expect(connector([0, 0], [100, 50]).d).toBe("M0,0 C50,0 50,50 100,50");
  });
});
