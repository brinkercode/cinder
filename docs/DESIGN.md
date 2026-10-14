# Cinder — design

## 1. The idea: git that keeps score

Git records *what* changed. It has no opinion about what is *likely* to happen next: two edits colliding, a test being flaky, a diff being risky, a commit being the one that broke the build. Teams fill that gap with habit and review meetings. Agents working in parallel at scale break those habits.

Cinder builds two kinds of model into git's operations from day one:

- **System 1** answers typed questions about repository state fast and cheaply, with a probability on each answer. Examples: will these two intents touch the same functions? Is this failure flaky? How risky is this change? Which change most likely broke this test?
- **System 2** agents do the work: write code, resolve conflicts, review, split changes, extract interfaces.

Every System 1 judgment is recorded together with the outcome that later proved it right or wrong. From that record each repo **calibrates its own judges**, so a stated probability means what it says. The UI shows how accurate each judge has been. Thresholds come from that evidence, never from hand-tuned constants.

Rules that hold everywhere:

1. **Code owns arithmetic, budgets, timers and verdicts.** System 1 makes ranking and routing decisions where a wrong answer costs time, not correctness. Merging always requires the deterministic verifier.
2. **Provider-agnostic, including open-weight and self-hosted** (§5).
3. **No forced branching strategy.** Trunk-based, gitflow, release branches, fork-and-PR and stacked changes all work. Every mechanism below is keyed by a change's *target branch* (§3).

## 2. What it changes about git

| Git pain | Cinder's answer | System 1 role | System 2 role |
|---|---|---|---|
| Merge conflicts found late | **Symbol leases + scheduler.** An intent leases the functions and types it will touch; non-overlapping work runs fully in parallel, overlapping work is stacked | Predicts each intent's symbol set and pairwise collision risk | Renegotiates a lease when the real diff outgrows it |
| Long-lived divergence | **Continuous convergence.** Active forks are kept current with their target branch; a divergence budget forces a sync before drift gets expensive | Scores conflict risk as a fork drifts | Resolves a fresh, small conflict while its context is still warm |
| Shared hot spots | **Interface-first splits.** When intents share a seam, the seam lands first as its own change and both build on it | Judges whether an overlap is a shared interface | Writes the seam change |
| Line-based merge noise | **Structured merge + merge drivers.** Merges are done at the syntax-tree level; lockfiles are regenerated, migrations renumbered, changelogs unioned | — | — (deterministic) |
| Review is the bottleneck | **Risk-routed review.** Each change gets a calibrated risk score; low risk merges on green, medium gets an agent reviewer, high waits for a human | Risk score | Reviewer agent |
| Flaky tests blame the wrong change | **Flake statistics.** A flake rate per test from history, failure classification, automatic rerun and quarantine | Breaks ties on failures that deterministic signals can't classify | — |
| Bad content lands | **Push guard.** Every push to any fork is scanned (secrets, injected instructions, unexpected binaries) before it can be verified | Hazard probabilities alongside a deterministic scanner | — |
| "Which change broke this?" | **Probabilistic bisect.** Noisy-test-aware Bayesian bisection with System 1 suspicion scores as the prior | Suspicion per candidate change | — |
| Stale CODEOWNERS | **Learned ownership.** Who (person or agent version) actually maintains each path and symbol, from history | Ranks owners for routing | — |
| Giant mixed diffs | **Change splitting.** Oversized or mixed changes become a stack of changes that each pass alone | Flags mixed or oversized | Splitter agent |
| "Why is this line here?" | **Intent-addressed history.** Every commit links to its intent, the agent version, the judgments made and the verdicts | — | — |
| Agent quality is invisible | **Versioned agents and stacks.** Tags lock an agent's exact configuration; two versions can race the same intent | Routes models once outcomes exist | The agents themselves |

## 3. Branch-strategy neutrality

A repo declares its strategy in `.cinder.yml`; nothing assumes trunk-based development.

```yaml
# .cinder.yml
branches:
  integration: [main]            # gitflow: [develop, main]
  release: ["release/*"]         # optional
check: make check
stack: code@v1
```

- A **change** targets any branch. Queues, leases, convergence and risk thresholds are all keyed by `(repo, target branch)`.
- Repos without `.cinder.yml` default to: integration branch = the default branch.
- Fork-and-PR is native: every change already lives in its own fork.

## 4. Architecture

Every part that backs cinder is a Cloudflare resource ([ARCHITECTURE-CLOUDFLARE.md](ARCHITECTURE-CLOUDFLARE.md) §1 has the full map and what is live today). Cinder stores, encrypts and logs nothing itself.

```
   browser (React SPA)     cinder CLI · git clients     BYO runner pools
            │                        │                 (self-hosted, other clouds)
            └────────────────────────┼─────────────────────────┘
                     Cloudflare Access (owners + runners service token)
┌────────────────────────────────────▼──────────────────────────────────────┐
│ Cloudflare                                                                │
│  Worker (JS)     API, SPA assets, Queue consumers, cron                   │
│  State           D1 (index, jobs, judgments), Durable Objects (RepoDO,    │
│                  ChangeDO, DispatchDO), Artifacts (repos, one fork per    │
│                  change, agents repo), R2 (CI cache, run logs)            │
│  Execution       Queues · Workflows (CI checks, previews, env sync,       │
│                  Cloudflare deploy steps) · Containers / Sandbox (runner  │
│                  pool: one ephemeral instance per job, scales to zero)    │
│  AI              Workers AI (Clef judges, embeddings) · AI Gateway (all   │
│                  model calls, stored provider keys) · Vectorize (advisory │
│                  index)                                                   │
│  Secrets         Secrets Store (signing key, model keys, webhook secrets, │
│                  deploy credentials), injected by the outbound proxy      │
│  Observability   Workers Logs + traces · Analytics Engine (insights)      │
└──────────▲───────────────────────────────────────────────▲────────────────┘
           │ claim, fork-scoped token                      │ claim, merge token
┌──────────┴────────────────────────┐   ┌──────────────────┴────────────────┐
│ runner: cinder-agent              │   │ runner: cinder-verify             │
│ System 2 harnesses: claude |      │   │ check, structured merge, push     │
│ codex | opencode, models through  │   │ guard, flake stats, bisect,       │
│ AI Gateway; non-Cloudflare deploy │   │ convergence, symbol index; sole   │
│ steps (AWS, GCP, Azure, SSH)      │   │ holder of the merge token         │
└───────────────────────────────────┘   └───────────────────────────────────┘
```

Runners are identical and stateless: every instance starts from the same image, runs any job kind and keeps nothing between jobs. The managed pool runs on Containers / Sandbox; BYO pools run the same binaries elsewhere.

Workers can't run `git` or tests, and the Artifacts binding can read objects but has no commit or merge call. So the Worker commits with its own minimal git writer (`worker/src/git/`): it hashes the new blobs, trees, commit and tag with WebCrypto SHA-1, packs them and pushes over git smart HTTP (`git-receive-pack`) with a 60 s write token for that one repo, refusing a stale base. `POST /api/repos/:name/commits` and every server-side write go through it. Runners push the rest (agent work, merges). Cloudflare decides who may push where by minting scoped, expiring Artifacts tokens:

| Holder | Token | Scope | TTL |
|---|---|---|---|
| cinder-agent, per job | write | its change's fork only | ≤ 10 min, re-minted on each heartbeat |
| cinder-agent, per job | read | target repo (a review job: its change's fork) | ≤ 10 min, re-minted on each heartbeat |
| cinder-verify, verify/converge job | write | the fork it converges; read on target | ≤ 10 min, re-minted on each heartbeat |
| cinder-verify, merge job | write | target repo | ≤ 10 min, minted by RepoDO when the queue head is green |
| Worker, per server-side commit | write | the one repo it commits to | 60 s (the binding's minimum) |
| UI / CLI | owner API token | cinder API only | until revoked |

Acceptance tests live in the ChangeDO, never in the fork. The verifier overlays them before running checks.

## 5. The model layer

### System 1: one wire format, many backends

Cinder speaks the System One API (`POST /v1/systemone`: a state plus named Choice / Score / Noul questions, answered in one pass with probabilities). Backends:

| Backend | Where | Kind |
|---|---|---|
| `jev` | TypeSafe, hosted | proprietary, reference implementation |
| `clef` / `clef-flash` | Workers AI binding | open-weight (Apache-2.0), on Cloudflare |
| `systemone-http` | any URL: a System One server or a codesoda/systemone shim on a self-hosted machine, Ollama/vLLM behind a shim | open-weight, self-hosted |
| `stat` | inside the Worker | per-repo statistical models (logistic regression, frequency tables) for questions with enough history; no model at all |

Each judgment is stored with: repo, kind (lease, collision, risk, flake, guard, suspicion, split, route), backend and model version, state hash, the question, the answer and its probability. An **outcome** row is attached when reality answers (the change touched symbols outside its lease, the merged change was reverted, the rerun passed). Calibration is fitted per `(repo, kind, backend)` with isotonic regression on those pairs. Raw probabilities are shown next to calibrated ones until a judge has enough outcomes; until then the decision falls back to the safe default for that kind.

Backends are pinned by version. A new model version starts a new calibration series.

### System 2: harness adapters

Runners execute agents through existing CLI harnesses rather than a home-grown loop:

| Harness | Models |
|---|---|
| `claude-code` | Claude models via the owner's login or API key |
| `codex` | OpenAI models |
| `opencode` | any OpenAI-compatible endpoint: OpenRouter, Ollama, vLLM, llama.cpp, hosted open-weight providers |

A stack names an agent version; an agent version names a harness, a model and its limits. Per-stage model routing by System 1 is available behind a flag once each `(stage, model)` has enough outcomes.

## 6. Change lifecycle

```
draft ─► planned ─► leased ─► developing ─► verifying ─► in_queue ─► merged
   │        │          │           │  ▲          │            │
   │        │          ▼           ▼  │          ▼            ▼
   │        │       waiting    converging     needs_fix    conflict ─► resolving
   │        ▼     (stacked on                (repairs ≤ 2,            │
   │   split into     another                 $8 stop)                ▼
   │   a stack        change)                                     verifying
   ▼
 closed (from any state)
```

- **planned:** intent recorded verbatim; acceptance drafted; System 1 predicts symbols, collisions, risk; splitting or an interface-first seam may be proposed.
- **leased:** the scheduler granted the leases; the change may start. If it overlaps a running change, it waits or stacks on that change's fork head.
- **converging:** the target moved; the runner rebased the fork with structured merge. A clean result continues; a conflict becomes a first-class conflict object handled by a resolver agent.
- **in_queue:** per-target queue, speculative on the changes ahead. The merge job alone holds the target write token.

## 7. Agents, stacks and context

The agents repo (an Artifacts repo) holds `agents/<name>/{agent.yml,prompt.md}` and `stacks/<name>.yml`. A release is an annotated tag `agent/<name>/vN` whose message is the resolved lock (prompt hash, harness, model, effort, tools, limits, egress). Channels (`stable`, `canary`) are rows in D1 that point at versions. Every stage of every change records the agent version, model, cost and duration. Two versions can race one intent; the comparison is kept.

When a change merges or closes, its context is written to the target repo as commits under `refs/cinder/changes/<id>`: intent, acceptance, events, judgments with outcomes, stages. Any line can be traced to its intent.

## 8. Stack

| Part | Choice |
|---|---|
| Control plane | JavaScript, Cloudflare Workers, Durable Objects (SQLite-backed), D1, Queues, Artifacts, Access |
| Execution | Cloudflare Containers / Sandbox (ephemeral runner pool), Workflows (pipeline, Cloudflare deploy steps) |
| Storage | R2 (CI cache, run logs) |
| AI | Workers AI, AI Gateway (every model call, stored provider keys), Vectorize (advisory index) |
| Secrets | Secrets Store, one binding per secret; cinder never encrypts or stores values |
| Frontend | React 19, React Router 8, Vite; JavaScript with `.jsx` components; no component kits ([frontend rules](../CONTRIBUTING.md#frontend-rules)); visual design by the owner |
| Runners, CLI | Go; shell out to `git`, `ctags` (symbol index), `mergiraf` (structured merge) and the harness CLIs. These are external binaries the runner uses, not linked libraries |
| Tests | vitest with `@cloudflare/vitest-plugin`; Go `testing` with `-race` |

## 9. Delivery to Cloudflare (GitOps)

Desired state lives in the repo; cinder makes Cloudflare match it.

- **Manifest.** `.cinder.yml` gains a `deploy` section:
  ```yaml
  deploy:
    environments:
      - { name: preview,    from: change }                 # every change gets a preview
      - { name: staging,    branch: develop, auto_sync: true }
      - { name: production, branch: main, auto_sync: true, gradual: [10, 50, 100], health: /healthz }
    worker: wrangler.jsonc                                  # the app's own Worker config (default wrangler.jsonc)
    resources:                                              # reconciled per environment
      - { type: d1,    name: pulse-db, migrations: migrations }
      - { type: kv,    name: pulse-cache }
      - { type: queue, name: pulse-checks }
      - { type: r2,    name: pulse-reports }
  ```
- **Pipeline.** A namespace-wide `cf.artifacts.repo.pushed` trigger starts the `cinder-pipeline` Workflow on every push (it also feeds `cinder-events`). The Workflow runs the repo's checks with `@cloudflare/ci` in Cloudflare sandboxes, so CI moves into Cloudflare.
- **Previews.** A push to a change's fork uploads a Worker version (`versions upload`) and records its preview URL on the change.
- **Sync.** When an environment's branch moves, the pipeline reconciles resources, applies D1 migrations, uploads a version and deploys it, as a gradual rollout for environments that set `gradual`, gated by health checks. Each environment reports Synced, OutOfSync, Progressing, Degraded or Failed, with its history.
- **Rollback.** One action redeploys the last healthy version. A failing health check during a gradual rollout rolls back automatically.
- **Reconcile.** Declared D1, KV, Queue and R2 resources are created or updated per environment. Resources tagged by cinder but missing from the manifest show as drift; pruning needs confirmation.
- **Keeping score.** A rollback or a failed sync is an outcome for the risk judgment of the changes in that deploy, so deploys calibrate the judges too. High risk slows a rollout or routes it to a person.
- **Credentials.** One `CF_DEPLOY_TOKEN` Worker secret, scoped to Workers scripts, D1, KV, Queues, R2, Secrets Store and AI Gateway in the target account; never logged, never sent to runners. Keystore values live in Secrets Store and model keys in AI Gateway stored keys: cinder holds references, never a value.
