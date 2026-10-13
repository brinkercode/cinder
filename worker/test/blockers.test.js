import { describe, expect, it } from "vitest";
import { validateChangeDetail } from "../src/api/contract.js";
import changeDetail from "../src/api/fixtures/change-detail.json";
import { blockersFor } from "../src/merge/blockers.js";

const at = "2026-10-04T09:00:00.000Z";
const green = {
  change: { head: "abc", state: "in_queue" },
  policy: { approvals: 1 },
  verdict: { sha: "abc", status: "pass", at },
  approvals: [{ by: "owner", sha: "abc", state: "approved", at }],
  guard: { status: "clear", at },
  route: { reviewers: ["owner"] },
};
const codes = (input) => blockersFor(input).map((b) => b.code);

describe("merge blockers", () => {
  it("blocks when the verdict is missing", () => {
    expect(codes({ ...green, verdict: undefined })).toEqual(["no_verdict"]);
  });

  it("blocks when the verdict sha differs from the head", () => {
    expect(blockersFor({ ...green, verdict: { ...green.verdict, sha: "old" } }))
      .toEqual([{ code: "stale_verdict", reason: "verdict is for old, head is abc", since: at }]);
  });

  it("blocks when the guard input is undefined", () => {
    expect(codes({ ...green, guard: undefined })).toEqual(["guard_quarantined"]);
  });

  it("blocks on a reported SARIF finding", () => {
    expect(blockersFor({ ...green, verdict: { ...green.verdict, findings: [{ rule: "G101", file: "a.go", line: 2 }] } }))
      .toEqual([{ code: "sarif_finding", reason: "G101 at a.go:2", since: at }]);
  });

  it("returns no blockers for a green change at head", () => {
    expect(blockersFor(green)).toEqual([]);
  });

  it("blocks on every missing input, never passes", () => {
    expect(codes({})).toEqual(["no_verdict", "conflict", "guard_quarantined", "approval_missing"]);
    expect(validateChangeDetail({ ...changeDetail, blockers: blockersFor({}) })).toEqual({ ok: true, errors: [] });
  });
});
