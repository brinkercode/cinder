import { channelAgent } from "./canary.js";
import { judge } from "./judgments.js";
import { clearNeeds, raiseNeeds } from "./needs.js";
import { DEFAULT_RULE, glob } from "./policy.js";

// Each answer as a share of changes reverted, compared with a rule's "auto-merge if risk ≤" percentage.
const RISK_PERCENT = { low: 10, medium: 50 };
const RISK_QUESTIONS = { risk: { kind: "choice", prompt: "How risky is this change?", options: ["low", "medium", "high"],
  guide: "The state holds the diff's size, the changed paths and their owners, test_delta (tests added and removed), the intent and past lease " +
    "overlaps on these symbols. Judge how likely the change is to be reverted or cause an incident after it merges.",
  criteria: {
    low: "Small and contained, with tests: docs, copy or tests only, or a few lines in one module. No auth, secrets, payments, migrations, CI or deploy config.",
    medium: "An ordinary feature or fix across several files or a shared module, with tests added or kept. Reverting it would be routine.",
    high: "Touches auth, secrets, payments, data migrations, CI or deploy config, or a module many owners share; removes tests or adds code " +
      "without them; a large diff; or symbols other changes recently leased.",
  } } };

// files: [{ path, added, removed }]; test_delta: tests added/removed; lease_overlaps: past lease overlaps on these symbols.
export async function riskState(db, repo, { files, intent, test_delta, lease_overlaps }) {
  const paths = files.map((f) => f.path);
  const { results: owners } = await db.prepare(
    "SELECT path, owner, weight FROM owners WHERE repo = ? AND path IN (SELECT value FROM json_each(?)) ORDER BY path, weight DESC, owner",
  ).bind(repo, JSON.stringify(paths)).all();
  return {
    diff: {
      files: files.length,
      added: files.reduce((n, f) => n + f.added, 0),
      removed: files.reduce((n, f) => n + f.removed, 0),
    },
    paths,
    owners,
    test_delta,
    intent,
    lease_overlaps,
  };
}

// Recorded as kind risk, on change when given (so a person's verdict on it can disagree); returns { risk: { answer: low|medium|high, p, trusted } }.
export async function judgeRisk(env, repo, input, change) {
  return judge(env, repo, "risk", await riskState(env.DB, repo, input), RISK_QUESTIONS, change);
}

// A changed line's comment syntax by file extension; a line in a file not listed here is code unless blank.
// A changed line is a comment only when nothing else can hide on it: a line comment, or a block comment opened and closed
// on that line with nothing after it. A block comment's inner lines ("* …") count as code, as a continuation line looks
// the same. lazy: a comment-looking line inside a multi-line string counts as a comment; track string state per file if
// that ever matters (verify still runs on every change).
const BLOCK = String.raw`\/\*((?!\*\/).)*\*\/$`;
const COMMENT = [[/\.(c|cc|cjs|cpp|go|h|java|js|jsx|kt|mjs|rs|swift|ts|tsx)$/, new RegExp(String.raw`^(\/\/|${BLOCK})`)], [/\.s?css$/, new RegExp(`^${BLOCK}`)],
  [/\.(bash|py|rb|sh|toml|ya?ml)$/, /^#(?!!)/], [/\.tf$/, new RegExp(String.raw`^(#|\/\/|${BLOCK})`)], [/\.sql$/, new RegExp(String.raw`^(--|${BLOCK})`)],
  [/\.(html?|svelte|vue|xml)$/, /^<!--((?!-->).)*-->$/]];
const DOC = /\.(md|mdx|txt)$/i;

// files: [{ path, lines }] as diffFiles (code.js) gives them. The reason a change that edits only documentation, comments
// or blank lines needs no person, else null. A file with no line diff (too big to diff) counts as code.
export function quietDiff(files) {
  if (!files?.length) return null;
  if (files.every((f) => DOC.test(f.path))) return "documentation-only change";
  const comment = (path) => COMMENT.find(([ext]) => ext.test(path))?.[1];
  const quiet = files.every((f) => DOC.test(f.path) || f.lines?.every((l) => {
    const text = l.slice(1).trim();
    return l[0] === " " || !text || comment(f.path)?.test(text);
  }));
  return quiet ? "comment-only change" : null;
}

// Routes a change from its calibrated risk, stores { route: auto|agent|human, reason, p } on it and records the route
// with its judgment as a routed event. A trusted high answer waits for a human. An untrusted judge (too few outcomes)
// routes to the reviewer agent, whose verdict also scores the judge, so it earns trust without a person; agent review
// needs a reviewer agent with a released version, else a human. No judgment at all (no backend, airlock refusal) merges
// on green as before routing existed.
// rule is the target branch's (policy.js): a touched path matching its route goes to a person, and a trusted judge
// auto-merges only within its risk percentage and judge count. An input.diff (quietDiff) that changes no code routes as
// a trusted low answer, whatever the judge says.
export async function routeChange(env, repo, id, input, rule = DEFAULT_RULE) {
  const { risk: { answer, p, trusted } } = await judgeRisk(env, repo, input, id);
  // lazy: a route glob's * stays within one path segment, as in release patterns; add ** if routes need subtrees.
  const routed = rule.route.find((g) => input.files.some((f) => glob(g).test(f.path)));
  const quiet = quietDiff(input.diff);
  let review;
  if (quiet && !routed) review = { route: rule.judges > 1 || RISK_PERCENT.low > rule.risk ? "agent" : "auto", reason: quiet };
  else if (answer === "high" && trusted) review = { route: "human", reason: "risk high" };
  else if (routed) review = { route: "human", reason: `touches ${routed}` };
  // lazy: fails open while no judge answers, so repos without a reachable backend keep merging.
  else if (!answer) review = { route: "auto", reason: "no risk judgment" };
  else if (!trusted) review = { route: "agent", reason: `risk ${answer}, judge not yet trusted` };
  // lazy: the risk judge is the one judge a route counts, so a rule needing more holds every change for agent review.
  else if (rule.judges > 1) review = { route: "agent", reason: `risk ${answer}, ${rule.judges} trusted judges needed` };
  else if (RISK_PERCENT[answer] <= rule.risk) review = { route: "auto", reason: `risk ${answer}, judge trusted` };
  else review = { route: "agent", reason: `risk ${answer}` };
  // A finding's fix change never merges on verify alone: it gets at least an agent review.
  if (review.route === "auto" && await env.DB.prepare("SELECT 1 FROM finding_fixes WHERE change_id = ?").bind(id).first()) {
    review = { route: "agent", reason: `fix change, ${review.reason}` };
  }
  if (review.route === "agent" && !(await channelAgent(env, "review", id)).agent_version) {
    review = { route: "human", reason: `no reviewer agent, ${review.reason}` };
  }
  // A deploy plan that prunes or drops goes to a person whatever the risk (DESIGN §9).
  if (input.deploy_plan?.destructive) review = { route: "human", reason: `deploy plan ${input.deploy_plan.destructive}` };
  review.p = p;
  review.trusted = trusted;
  await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id)).stageEvent({
    kind: "routed", actor: { type: "system", id: "cinder" }, action: "stage.decide", target: id, result: review.route,
    reason: `${review.reason} (p ${p}, trusted ${trusted})`,
  }, { review, deploy_plan: input.deploy_plan ?? null });
  // An untrusted judge's change that still lands on a person (no reviewer agent) asks them; any other route clears that ask.
  const text = `The risk judge on change ${id} has too few outcomes to be trusted, so its call can't merge the change alone.`;
  if (answer && !trusted && review.route === "human") await raiseNeeds(env.DB, repo, [{ kind: "Untrusted judge", change: id, text, actions: ["Approve change", "Open change"] }]);
  else await clearNeeds(env.DB, "Untrusted judge", repo, id);
  return review;
}
