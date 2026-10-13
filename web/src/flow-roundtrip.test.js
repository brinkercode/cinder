import { expect, it } from "vitest";
import { flowYaml, parseFlow } from "../../worker/src/api/contract.js";

const FILES = import.meta.glob("../../seed/repos/*/.cinder/flows/*.yml", { query: "?raw", import: "default", eager: true });

it("graph → YAML → parseFlow → graph is lossless for every seeded flow file", () => {
  expect(Object.keys(FILES).length).toBeGreaterThanOrEqual(6);
  for (const [path, text] of Object.entries(FILES)) {
    const f = parseFlow(text);
    // The designer's graph after its inspector sets every field it offers: the Flow tab's and each step's.
    const graph = { ...f, on: [...new Set([...f.on, "cron"])], cron: "0 2 * * *", concurrency: "queue", "runs-on": ["gpu", "large-disk"],
      steps: f.steps.map((s) => ({ ...s, "runs-on": ["linux"], timeout: "10m", retries: "2", secrets: [...(s.secrets ?? []), "NPM_TOKEN"], if: "always()" })) };
    expect(parseFlow(flowYaml(graph)), path).toEqual(graph);
    expect(parseFlow(flowYaml(f)), path).toEqual(f);
  }
});
