import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import { validateAgentVersions } from "../src/api/contract.js";
import worker from "../src/index.js";
import { WorkerLite } from "../src/workers.js";
import { fakeArtifacts } from "./fakes/artifacts.js";

// A fake Containers binding: a pool member's container id is its runner id.
const started = [];
const containers = { idFromName: (name) => name, get: (id) => ({ start: async (o) => { started.push({ id, ...o }); }, stop: async () => {} }) };
const converted = [];
const AI = { toMarkdown: async (docs) => {
  converted.push(await docs[0].blob.text());
  return [{ name: docs[0].name, mimeType: "text/html", format: "markdown", tokens: 3, data: "# Docs\n" }];
} };
const e = { ...env, AI, ARTIFACTS: fakeArtifacts(), WORKER_LITE: containers };
const call = (path, body) => worker.fetch(new Request(`http://cinder.test${path}`,
  { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` }, body: body && JSON.stringify(body) }), e);
const HTML = "<html><head><title>Docs</title></head><body><h1>Docs</h1><nav>a lot of markup</nav></body></html>";

afterEach(() => {
  vi.restoreAllMocks();
  converted.length = 0;
});

// A pool container holding one claimed develop job run by agent <name>@v1 on `web`, allowed to reach docs.example.
// Returns a GET through the container's egress and the requests that reached fetch.
async function agentOn(name, web) {
  await call("/api/workers/pools", { name: `pool-${name}`, size: "lite", min: 1, max: 1, kinds: ["develop"] });
  const { id } = started.at(-1);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO agent_versions (id, name, version, harness, model, effort, prompt_hash, tools, limits) " +
      "VALUES (?, ?, 1, 'claude-code', 'claude-opus-5-5', 'default', 'h', '[]', '{}')").bind(`agent/${name}/v1`, name),
    env.DB.prepare("INSERT INTO agent_releases (name, version, egress, released_at) VALUES (?, 1, '[\"docs.example\"]', '2026-10-10T00:00:00.000Z')").bind(name),
    env.DB.prepare("INSERT INTO agent_release_web (name, version, web) VALUES (?, 1, ?)").bind(name, web),
    env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, change_id, status, runner_id, lease_expires_at, created_at, payload) VALUES (?, 'r-md', 'develop', ?, 'claimed', ?, ?, ?, ?)")
      .bind(`job-${name}`, `c-${name}`, id, new Date(Date.now() + 60_000).toISOString(), new Date().toISOString(), JSON.stringify({ agent: `${name}@v1` })),
  ]);
  const sent = [];
  const answer = (body, type) => vi.spyOn(globalThis, "fetch").mockImplementation(async (req) => {
    sent.push(req);
    return new Response(body, { headers: { "content-type": type } });
  });
  const get = (url) => WorkerLite.outbound(new Request(url, { headers: { accept: "*/*" } }), e, { containerId: id, className: "WorkerLite" });
  return { answer, get, sent };
}

it("an agent on web markdown asks allowed hosts for text/markdown", async () => {
  const { answer, get, sent } = await agentOn("md-ask", "markdown");
  answer("# Docs\n", "text/markdown; charset=utf-8");
  const res = await get("https://docs.example/guide");
  expect(res.status).toBe(200);
  expect(sent[0].headers.get("accept")).toBe("text/markdown, text/html;q=0.9, */*;q=0.8");
  expect(await res.text()).toBe("# Docs\n");
  expect(converted).toEqual([]); // the site answered in Markdown itself
});

it("an HTML answer is converted to Markdown before the agent reads it", async () => {
  const { answer, get } = await agentOn("md-convert", "markdown");
  answer(HTML, "text/html; charset=utf-8");
  const res = await get("https://docs.example/guide");
  expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
  expect(await res.text()).toBe("# Docs\n");
  expect(converted).toEqual([HTML]);
  // The job's usage counts the conversion and the bytes it saved, and the agent's Versions tab reads them.
  expect(await env.DB.prepare("SELECT agent_version, converted, saved_bytes FROM job_web_usage WHERE job_id = 'job-md-convert'").first())
    .toEqual({ agent_version: "md-convert@v1", converted: 1, saved_bytes: HTML.length - 7 });
  const versions = await (await call("/api/agents/md-convert/versions")).json();
  expect(validateAgentVersions(versions)).toEqual({ ok: true, errors: [] });
  expect(versions[0].web).toEqual({ mode: "markdown", converted: 1, saved_bytes: HTML.length - 7 });
});

it("a raw agent and a non-HTML answer pass through unchanged", async () => {
  const raw = await agentOn("md-raw", "raw");
  raw.answer(HTML, "text/html");
  const res = await raw.get("https://docs.example/guide");
  expect(raw.sent[0].headers.get("accept")).toBe("*/*");
  expect(res.headers.get("content-type")).toBe("text/html");
  expect(await res.text()).toBe(HTML);
  vi.restoreAllMocks();

  const md = await agentOn("md-json", "markdown");
  md.answer("{\"ok\":true}", "application/json");
  const json = await md.get("https://docs.example/api.json");
  expect(json.headers.get("content-type")).toBe("application/json");
  expect(await json.text()).toBe("{\"ok\":true}");
  expect(converted).toEqual([]);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM job_web_usage WHERE job_id IN ('job-md-raw', 'job-md-json')").first("n")).toBe(0);
});

it("a denied host is still refused before any conversion", async () => {
  const { answer, get, sent } = await agentOn("md-deny", "markdown");
  answer(HTML, "text/html");
  const res = await get("https://evil.example/page");
  expect(res.status).toBe(403);
  expect((await res.json()).error.code).toBe("egress_denied");
  expect(sent).toEqual([]);
  expect(converted).toEqual([]);
});
