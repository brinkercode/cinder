import { describe, expect, it } from "vitest";
import { CLEF_MODELS, MAX_CHOICE_OPTIONS, createS1Client } from "../src/s1/client.js";
import { fakeClefAI } from "./fakes/ai.js";

const MODEL = "kev@2026-09-01";
const questions = {
  route: { kind: "choice", prompt: "Which stage next?", options: ["develop", "verify"] },
  risk: { kind: "score", prompt: "How risky is this change?" },
  flaky: { kind: "noul", prompt: "Is this failure a flake?" },
};

function recordingFetch(response) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return response();
  };
  return { calls, fetch };
}

describe("s1 client", () => {
  it("request shape for one Choice, one Score, one Noul", async () => {
    const answers = { route: { develop: 0.7, verify: 0.3 }, risk: 0.2, flaky: 0.9 };
    const { calls, fetch } = recordingFetch(() => Response.json({ answers }));
    const client = createS1Client({ backend: "systemone-http", baseUrl: "http://lab:8080/", apiKey: "k", model: MODEL, fetch });
    const result = await client.ask({ diff: "x" }, questions);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://lab:8080/v1/systemone");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers).toEqual({ "content-type": "application/json", authorization: "Bearer k" });
    expect(JSON.parse(calls[0].init.body)).toEqual({ model: MODEL, state: { diff: "x" }, questions });
    expect(result).toEqual({ ok: true, backend: "systemone-http", model: MODEL, answers });

    const tooMany = Array.from({ length: MAX_CHOICE_OPTIONS + 1 }, (_, i) => `o${i}`);
    await expect(client.ask({}, { route: { kind: "choice", prompt: "p", options: tooMany } })).rejects.toThrow(/255/);
    expect(calls).toHaveLength(1);

    const jev = recordingFetch(() => Response.json({ answers }));
    await createS1Client({ backend: "jev", apiKey: "ts", model: MODEL, fetch: jev.fetch }).ask({}, questions);
    expect(jev.calls[0].init.headers.authorization).toBe("Bearer ts");
  });

  it("unpinned model rejected", () => {
    const base = { backend: "systemone-http", baseUrl: "http://lab", fetch: async () => Response.json({}) };
    for (const model of ["kev", "kev@latest", "kev@", "", undefined]) {
      expect(() => createS1Client({ ...base, model })).toThrow(/pinned/);
    }
    expect(() => createS1Client({ backend: "jev", env: {}, model: MODEL })).toThrow(/TYPESAFE_API_KEY Keystore secret/);
  });

  it("timeout returns ok:false (fake fetch)", async () => {
    const hang = (url, init) =>
      new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
    const client = createS1Client({ backend: "systemone-http", baseUrl: "http://lab", model: MODEL, fetch: hang, timeoutMs: 20 });
    expect(await client.ask({}, questions)).toEqual({ ok: false, error: "s1: timeout" });
  });
});

describe("s1 clef backend", () => {
  it("fake AI binding receives the System One payload and the response maps to probabilities", async () => {
    const answers = { route: { develop: 0.6, verify: 0.4 }, risk: 0.1, flaky: 0.8 };
    const calls = [];
    const AI = fakeClefAI(async (model, body) => (calls.push({ model, body }), answers));
    for (const backend of ["clef", "clef-flash"]) {
      const model = `${backend}@1`;
      const result = await createS1Client({ backend, env: { AI }, model }).ask({ diff: "x" }, questions);
      expect(calls.at(-1)).toEqual({ model: CLEF_MODELS[model], body: { model, state: { diff: "x" }, questions } });
      expect(result).toEqual({ ok: true, backend, model, answers });
    }
    expect(() => createS1Client({ backend: "clef", env: {}, model: "clef@1" })).toThrow(/AI binding/);
    expect(() => createS1Client({ backend: "clef", env: { AI }, model: "clef@2026-10-01" })).toThrow(/no Workers AI model/);
  });

  // The decision models' raw run() calls, so the test sees exactly what reaches Workers AI.
  const recordingAI = (result) => {
    const calls = [];
    return { calls, run: async (model, input, options) => (calls.push({ model, input, options }), result) };
  };
  const answers = { route: { develop: 0.6, verify: 0.4 }, risk: 0.1, flaky: 0.8 };

  // Clef's input and output as Workers AI publishes them (GET /ai/models/schema?model=@cf/cloudflare/clef), checked live 2026-10-10.
  const clefAnswers = { route: { type: "choice", choice: "develop", probabilities: { develop: 0.6, verify: 0.4 }, confidence: 0.2 },
    risk: { type: "noul", noul: 0.1 }, flaky: { type: "noul", noul: 0.8 } };
  const clefQuestions = (qs) => Object.fromEntries(Object.entries(qs).map(([n, q]) => [n, q.kind === "choice"
    ? { type: "choice", instructions: q.prompt, criteria: Object.fromEntries(q.options.map((o) => [o, null])) } : { type: "noul", instructions: q.prompt }]));

  it("clef@2 sends Clef's own request shape and maps its typed answers to probabilities", async () => {
    const AI = recordingAI({ model: "clef", answers: clefAnswers, usage: { input_tokens: 1, output_tokens: 0 } });
    const result = await createS1Client({ backend: "clef", env: { AI, AI_GATEWAY_ID: "cinder" }, model: "clef@2" }).ask({ diff: "x" }, questions);
    expect(AI.calls).toEqual([{ model: "@cf/cloudflare/clef", input: { model: "clef", state: { diff: "x" }, questions: clefQuestions(questions) },
      options: { gateway: { id: "cinder", metadata: undefined } } }]);
    expect(result).toEqual({ ok: true, backend: "clef", model: "clef@2", answers });
  });

  it("choice criteria describe each option to Clef", async () => {
    const AI = recordingAI({ model: "clef", answers: { risk: clefAnswers.route }, usage: { input_tokens: 1, output_tokens: 0 } });
    const risk = { kind: "choice", prompt: "How risky?", guide: "Judge the revert odds.", options: ["low", "high"], criteria: { low: "Docs only.", high: "Touches auth." } };
    await createS1Client({ backend: "clef", env: { AI }, model: "clef@2" }).ask({ diff: "x" }, { risk });
    expect(AI.calls[0].input.questions).toEqual({ risk: { type: "choice", instructions: "How risky?\n\nJudge the revert odds.", criteria: { low: "Docs only.", high: "Touches auth." } } });
  });

  it("clef-flash@2 calls @cf/cloudflare/clef-flash naming clef-flash", async () => {
    const AI = recordingAI({ model: "clef-flash", answers: clefAnswers, usage: { input_tokens: 1, output_tokens: 0 } });
    const result = await createS1Client({ backend: "clef-flash", env: { AI }, model: "clef-flash@2" }).ask({ diff: "x" }, questions);
    expect(AI.calls.map((c) => [c.model, c.input.model])).toEqual([["@cf/cloudflare/clef-flash", "clef-flash"]]);
    expect(result).toEqual({ ok: true, backend: "clef-flash", model: "clef-flash@2", answers });
  });

  it("clef@1 still answers through its pinned model", async () => {
    const AI = recordingAI({ response: JSON.stringify({ answers }) });
    const result = await createS1Client({ backend: "clef", env: { AI }, model: "clef@1" }).ask({ diff: "x" }, questions);
    expect(AI.calls[0].model).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    expect(AI.calls[0].input.messages.at(-1)).toEqual({ role: "user", content: JSON.stringify({ model: "clef@1", state: { diff: "x" }, questions }) });
    expect(result).toEqual({ ok: true, backend: "clef", model: "clef@1", answers });
  });
});

describe("stat backend", () => {
  it("fitted model separates a synthetic separable set", async () => {
    // Changes touching many files outside the lease were reverted; small ones were not.
    const samples = [];
    for (let i = 0; i < 20; i++) samples.push({ features: { files: i % 5, outside: 0 }, y: 0 });
    for (let i = 0; i < 20; i++) samples.push({ features: { files: 10 + (i % 5), outside: 3 + (i % 3) }, y: 1 });
    const client = createS1Client({ backend: "stat", model: "stat@1", samples });
    const q = { reverted: { kind: "noul", prompt: "Will this change be reverted?" } };
    for (const s of samples) {
      const res = await client.ask(s.features, q);
      expect(res.ok).toBe(true);
      expect(res.answers.reverted > 0.5).toBe(s.y === 1);
    }
    const low = (await client.ask({ files: 1, outside: 0 }, q)).answers.reverted;
    const high = (await client.ask({ files: 12, outside: 4 }, q)).answers.reverted;
    expect(low).toBeLessThan(0.1);
    expect(high).toBeGreaterThan(0.9);
  });
});
