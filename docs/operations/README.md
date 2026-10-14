# Operations

Running cinder after `make up`: runners, judges, resource reconcile and releases. Install and sign-in are in the [README](../../README.md).

## Register a runner

Each machine that runs a runner needs Go 1.27+. `make up` writes the Worker URL and owner token to `~/.config/cinder/live.env`. On the runner machine, load them and follow [runner/README.md](../../runner/README.md) from step 1 (`make runners`):

```sh
set -a; . ~/.config/cinder/live.env; set +a   # CINDER_URL and CINDER_TOKEN
```

In step 3, also copy `CINDER_ACCESS_CLIENT_ID` and `CINDER_ACCESS_CLIENT_SECRET` from `live.env` into both env files, or Access turns the runners away. The agent runner writes code with Claude Code: install the `claude` CLI and add `ANTHROPIC_API_KEY` (or `CLAUDE_CODE_OAUTH_TOKEN`) to `agent.env`. The verify runner runs each repo's check, so it needs whatever that check needs (Node for [the first change](../usage/changes.md#your-first-change)).

### Bring-your-own pool on self-hosted machines

1. Create the pool: **Add worker pool** ▸ **Bring your own** on Workers (`/automation/workers`), which then mints a pool token and shows the register command, or `POST /api/workers/byo-pools {"name": "lab", "labels": ["gpu"]}` with the owner token.
2. Register a runner in it: `POST /api/workers {"name": "lab-1", "kinds": ["verify"], "pool": "lab"}` with the owner token. The response's `token` is shown once.
3. Put that token in `~/.config/cinder/verify.env` as `CINDER_RUNNER_TOKEN` and start `cinder-verify` (step 3 onwards of [runner/README.md](../../runner/README.md)). Within a minute the pool's card shows "1 of 1 online".

To register machines without the owner token, mint a pool token: `POST /api/workers/byo-pools/:id/tokens` with the owner token (or a role with `org.manage`) answers `201 {"token", "expires_at"}`. The token is shown once and registers one runner into that pool within 24 hours; mint one per machine. A pool runner's kinds may not include `merge`, `release` or `history` (400 `bad_request`), and must be among its pool's kinds (403 `kind_not_allowed`). A pool takes every other kind except `flow` until a role with `org.manage` sets its list with `PUT /api/workers/byo-pools/:id {"kinds": [...]}` (or `kinds` on create); the list applies to runners registering from then on. On each machine:

```sh
CINDER_URL=https://<worker> CINDER_POOL_TOKEN=<pool token> go run ./cmd/cinder runner register lab-2 --kinds verify
```

`--pool-token` works in place of `CINDER_POOL_TOKEN`. The response's `token` is that runner's `CINDER_RUNNER_TOKEN`, as in step 3. An unknown, already used or expired pool token answers 401 `bad_pool_token`; mint a new one. A pool token is accepted only in the body of `POST /api/runners`, never as a bearer token.

A runner token uploads SARIF (`POST /api/repos/:name/sarif`) only for a repo it holds a live job of; otherwise 403 `forbidden`. Lockfile regeneration after a merge (`npm install`, `go mod tidy`) runs with only `PATH`, `HOME`, `GOPATH`, `GOCACHE`, `GOMODCACHE` and `npm_config_cache`, and git never sees `CINDER_*` variables, so a repo's `.npmrc` or hooks can't read the runner token.

To revoke a pool token, list the pool's tokens with `GET /api/workers/byo-pools/:id/tokens` (prefix, created by and at, first used, expires; never the token) and `DELETE /api/workers/byo-pools/:id/tokens/:prefix`, or use **Revoke** under Issued tokens in the pool's Edit modal. The answer is `204`, and the token then gets 401 `bad_pool_token` on register. Workers registered with it finish the jobs they hold; their next claim gets 401 `token_revoked`, on which `cinder-agent` stops claiming and exits with status 1. Once they hold no job they are removed with their runner tokens.

To revoke a runner, run `cinder runner revoke <id>` (`DELETE /api/workers/:id`, owner token). Its token stops working at once and its claimed jobs return to the queue.

## Runner images

Managed worker pools run one of two images, by instance type. Cloudflare limits an image to its instance type's disk.

| Image | Pools | Contents | Size | Instance |
|---|---|---|---|---|
| `runner/Dockerfile` (slim) | `lite`, `basic` | cinder-agent, cinder-verify, Node 22.20.0 + npm, git, make, Claude Code CLI 2.0.14, OpenCode CLI 1.18.32 | about 0.7 GB | `lite` (1/16 vCPU, 256 MB, 2 GB disk), `basic` (1/4 vCPU, 1 GiB, 4 GB disk) |
| `runner/Dockerfile.full` | `standard-2` | cinder-agent, cinder-verify, the Claude Code and OpenCode CLIs, and one current version of each stack below | 3.23 GB built | `standard-2` (1 vCPU, 6 GiB, 12 GB disk) |

A pull request that changes `runner/Dockerfile*` runs the `image` job in `.github/workflows/ci.yml`: it builds the slim image, runs the `TestImage_` tests in `runner/cmd/cinder-verify` against it (`make check-image`; `make check-go` skips the build unless `CINDER_IMAGE_TEST=1`), and writes the image's size and its timed cold start to the job summary.

A pool created without `kinds` claims every job kind. cinder-verify runs `index` (symbols at a sha), `blame` (who wrote each line of a file) and `compare` (base...head commits, line counts and patches) on a clone made with a 10-minute read token, and `PUT`s the result to `/api/work/repos/<repo>/symbols/<sha>`, `/authorship/<sha>?path=` or `/compare/<base>/<head>`. Each `PUT` answers 403 unless that runner holds a live job of the matching kind on that repo. A claim answers 204 while the runner already holds as many live leases as its stored slots: the `slots` (1-64) an owner gave it in `POST /api/runners`, else 1. A pool worker always has 1, and the `slots_free` a claim sends never raises it. Until a runner claims them, Code's symbols and authorship and the Compare view stay empty. A push to a change's fork queues a `guard` job: cinder-verify clones the fork with a 10-minute read token (never a write token), scans each pushed commit for secrets, injected instructions, binary and oversize files, lists the dependencies the push's lockfiles or `package.json` add, and reports them with the diff. A finding quarantines the change; a new dependency raises "Dependency needs approval" and blocks merge until an owner approves it. A `review` job gets no repository token and makes no clone: cinder-agent reads the change's unified diff (the fork head against the target commit its verify ran on, at most 1 MB, the files past that named) from `GET /api/work/jobs/<job>/diff`, which answers 403 unless that runner holds the live review job, and runs the reviewer in an empty directory.

The full image's pinned versions, one `ARG` each at the top of `runner/Dockerfile.full`:

| Stack | Version |
|---|---|
| Base: build-essential, git, git-lfs, curl, unzip, zstd, xz, jq, shellcheck, sqlite3, openssh-client, libicu, libssl-dev, pkg-config | Debian bookworm packages |
| yq | 4.47.1 |
| Node + npm, corepack (yarn, pnpm) | 22.20.0 |
| Python + pip, pipx, uv | 3.12.11, pipx 1.7.1, uv 0.8.22 |
| Go | 1.27 |
| Rust (rustup minimal profile) + cargo, rustfmt, clippy | 1.90.0 |
| .NET SDK | 10.0.100 |
| Java (Temurin JDK) + Maven | 21.0.8, Maven 3.9.11 |
| Gradle | 9.1.0 |
| PHP CLI + Composer | 8.3.26, Composer 2.8.12 |
| Ruby + bundler | 3.3.9 |
| Terraform | 1.13.3 |
| Helm | 3.19.0 |
| Claude Code CLI (`claude`, the develop and resolve harness) | 2.0.14 |
| kubectl | 1.34.1 |
| gh | 2.78.0 |
| buildah, the image builder: no daemon, no privilege (`STORAGE_DRIVER=vfs`, `BUILDAH_ISOLATION=chroot` set in the image); a flow step runs `buildah bud -t <name> .` | 1.28.2 (Debian bookworm package) |

Other versions of a stack, browsers, cloud CLIs, databases and Docker are not in either image. Neither image builds unless every tool it ships answers its version command.

**Log retention.** Flow step logs live in the R2 bucket `cinder-logs` under `flows/<run>/<job_key>/<idx>/<chunk>`. `deploy/reconcile.sh` sets a lifecycle rule (`cinder-flow-logs-30d`) that deletes every `flows/` object 30 days after it was written, keeping any other rule on the bucket. A log page or `log.txt` whose chunk was deleted answers `410 expired`; the run's statuses, step line counts and annotations stay in D1.

**Artifact retention.** Flow artifacts live in `cinder-logs` under `artifacts/<run>/<job_key>/<name>`, at most 100 MB each. A second lifecycle rule (`cinder-flow-artifacts-30d`), set the same way, deletes every `artifacts/` object 30 days after upload; the artifact list's `expires_at` is upload time plus 30 days, and a deleted artifact drops out of the list. Test results stay in D1.

**Tool cache.** A flow step's `setup: { <tool>: "<version>" }` asks for a toolchain version. A worker skips a version its image bakes (`CINDER_BAKED` in each Dockerfile). For any other it calls `GET /api/work/toolcache/<tool>/<version>`, which reads `toolcache/<tool>/<version>/release` from the R2 bucket `cinder-ci-cache` (binding `TOOL_CACHE`). On a 404 the worker downloads the upstream release archive, checks its published SHA-256, unpacks it, and `PUT`s that archive back; the Worker stores it with its SHA-256 in `release.sha256` and answers 403 unless the runner holds a claimed flow job with a step that sets up that tool at that version (at most 512 MB). A cached archive is checked against the upstream published SHA-256 too; on a mismatch the worker downloads the release again, checks it and `PUT`s it over the bad entry. Downloads follow only the release URLs cinder-verify knows (nodejs.org, dl.google.com, releases.hashicorp.com, get.helm.sh), and redirects only on the same host. On the worker the tool unpacks into `$TOOL_CACHE/<tool>/<version>` (default `/tmp/cinder-toolcache`) and is reused until the container stops. To clear a version, delete its object: `npx wrangler r2 object delete cinder-ci-cache/toolcache/<tool>/<version>/release --remote`; the next job that needs it downloads it again.

**Routing.** A `develop`, `resolve`, `commit`, `seam`, `split`, `verify` or `flow` job on a repo whose language is anything but JavaScript, TypeScript, CSS, HTML, Vue, Svelte or Shell is claimed only by a `standard-2` pool worker, and only `standard-2` pools start workers for it. That covers the stacks the full image bakes (Go, Python, Rust, C#, Java, Kotlin, PHP, Ruby, HCL) and every stack neither image bakes. Every other job, and every job on a repo with no detected language, runs on any pool, including `lite` and `basic`. The language is the one detected on import (or set in repo settings). Runners you bring yourself claim any job; they need whatever toolchains your repos' checks use. Give a `standard-2` pool the kinds above if you have repos in those languages, or their jobs stay queued. Pools created as `standard-1` became `standard-2` with the migration that moved the full image.

Planned: Cloudflare's reported size of the full image, from the first release's deploy log.

## Merge queue

Each target branch has one queue. A change's verify job runs the repo's check on its speculative tree: the target's head, every queued change ahead of it merged in order, then the change itself, even when nothing is ahead. The job reports that tree and the target sha it merged onto. A retried failed change's verify job sets `CINDER_ONLY_TESTS` (the tests failing at its head, one per line) for the check; a check that reads it runs only those, one that ignores it runs everything. The check runs with only `PATH`, `HOME` and `CINDER_ONLY_TESTS` from the runner's environment, so it never sees the runner's token.

- **Batches.** The head's merge job lands the head and each consecutive entry behind it whose last passing verify ran on exactly the entries before it, in queue order, up to 4 changes. The runner merges them one by one and refuses the whole batch, pushing nothing, as soon as one merged tree differs from the tree its verify checked, or the target moved past the sha that verify merged onto. A refusal names both target shas; the change converges and re-verifies.
- **Failures.** A queued change that leaves the queue (a re-verify fails, a rebase changes its head, it closes) re-verifies the next 4 entries behind it without it. Entries further back never merge on top of it; they re-verify when they reach the head.
- **Refusals.** A merge refused at claim (the target moved, or the head's speculation no longer holds) or by the runner moves the change to `converging` with a converge job. A clean rebase of a queued change always re-verifies before it can merge again.
- **Convergence after a merge.** A merge converges only the changes on its target that it can affect: their lease or written symbols touch a symbol the merge wrote, or they read a symbol whose signature it changed. Their converge jobs run highest collision risk first, and a converge conflict hands the resolver both intents and those symbols. Every other change is marked behind (D1 `change_behind`) and rebases when it reaches the queue head or when its next push lands. A merged change with no recorded writes converges every change.
- **Runners.** Merges need runners from this release or later: an older `cinder-verify` reports no tree, so the merge job refuses its changes.

**Live activity.** While a develop or resolve job runs, `cinder-agent` checks its worktree every second. When another tracked or new file becomes the most recently modified one, it posts `{activity: "editing <path>", path}` to `POST /api/work/jobs/:job/activity`. Only the runner that holds the job's lease may post; any other runner gets 403. The Worker sends `work.activity` to the repo's live sockets at most once a second per change. A value that arrives inside that second is held in RepoDO storage, replaced by any later one, and sent when the second ends. A failed post is logged and never fails the job.

**Edit checks.** A develop run checks its agent's edits against the repo's leases while it runs (`POST /api/work/edit-check`). With Claude Code, `cinder-agent` installs hooks that run before and after each Edit, MultiEdit or Write and before the agent stops: an error blocks the edit (or the stop, once), and errors and warnings after an edit reach the agent as context. Codex and OpenCode have no edit hooks: when the run ends with diagnostics, the runner resumes the session once with them. An error the agent still can't fix doesn't fail the run: the run pushes and reports, and cinder settles the collision from the reported writes (it stacks the change behind the holder, or proposes a seam). An error is a write to a symbol a verified (`in_queue`) or merged-since-base change changed, or a read of a symbol whose signature such a change changed; a warning is a write to a symbol another in-flight change holds, or a read of one whose body changed. Between two in-flight changes the older lease grant keeps the symbol, and a higher-priority change takes it from a lower-priority one, which is told to rework on its next check. Every diagnostic is stored in D1 `edit_diagnostics` and counted in the repo's metrics (`edit_errors`, `edit_warnings`).

## Configure judges

Nothing to do for a first run: every new repo gets Clef on Workers AI for every judgment delivery asks for: `lease`, `collision`, `seam`, `split` and `guard` on `clef-flash@2`, `risk`, `flake` and `resembles_vuln` on `clef@2`, pinned (`clef-flash@2` on `@cf/cloudflare/clef-flash`, `clef@2` on `@cf/cloudflare/clef`), through the AI binding `make up` deploys. Both run on the account's Workers AI usage, billed in Neurons per the [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) page; check each model's rate there before raising judge volume. Until a judge has enough outcomes it is untrusted, and cinder applies that kind's safe default (for example, an untrusted risk judgment routes a change to a person). An untrusted judge still answers every time, and each answer is scored against what happened under the default, so it earns trust without acting: `lease` by the symbols a verified change touched, `collision` by a merge-tree probe, `seam` by whether a stacked change or its base changed a collided symbol's signature, `split` by whether the change was split or merged whole, `flake` by a rerun on the same commit, `guard` by the push scan's findings and by a clean merge, `risk` by reverts within 14 days. The repo's trust threshold (`PUT /api/repos/<repo>/settings` `{"trust": {"min_outcomes": n, "min_races": n}}`, 200 outcomes by default) sets when it counts; the seed sets 20 on its repos. A change goes to agent review only when a trusted risk judgment asks for it and the `reviewer` agent has a stable or canary version; otherwise it waits for a person, with the reason on the change. See each judge's accuracy under **Judges** in the UI.

To answer a kind from your own System One server instead, point it at the URL (`<repo>` is the repo name):

```sh
cd worker
npx wrangler d1 execute cinder --remote --command "UPDATE judge_config SET backend = 'systemone-http', model_version = '<model>@<version>', base_url = 'https://<your-s1>' WHERE kind = 'risk' AND repo_id = (SELECT id FROM repos WHERE name = '<repo>')"
```

A repo's `.cinder.yml` can also set judges; each entry is applied when the default branch moves (Add judge and Swap model in the UI open a change that edits it). Kinds it leaves out keep their setting, and a kind configured for the first time starts in airlock:

```yaml
judges:
  risk:
    backend: clef
    model_version: clef@2
    min_confidence: 0.7   # optional: below it the judge abstains
    min_outcomes: 100     # optional: this judge's trust threshold, else the repo's
```

A `clef` judge takes `clef@2` or `clef@1`, a `clef-flash` judge `clef-flash@2` or `clef-flash@1`; any other version is rejected when saved. `@2` sends the state and questions to the Clef decision model as they are; `@1` stays callable so judges already on it keep their scored series.

A judge's own airlock (Judges ▸ a judge ▸ Airlock, or `PUT /api/repos/<repo>/judges/<kind>/airlock {"on": true}`) keeps it scoring while its verdict never counts; it is separate from the repo airlock below.

To run System One on a self-hosted machine, publish it through Cloudflare Tunnel and let only the Worker in with an Access service token:

1. On that machine, with System One (or a codesoda/systemone shim) listening on `localhost:8080`: `cloudflared tunnel create s1`, then `cloudflared tunnel route dns s1 s1.<your-domain>` and `cloudflared tunnel run --url http://localhost:8080 s1` (or install it as a service).
2. In Zero Trust, add an Access application for `s1.<your-domain>` with a **Service Auth** policy, and create a service token for it.
3. Give the Worker the token, once: `npx wrangler secret put S1_ACCESS_CLIENT_ID` and `npx wrangler secret put S1_ACCESS_CLIENT_SECRET`. Every `systemone-http` call then sends it.
4. Point the kind at `https://s1.<your-domain>` with the command above (or `go run ./cmd/cinder repo judge set <repo> risk --backend systemone-http --model <model>@<version> --base-url https://s1.<your-domain>`). Its judgments show under **Judges** as `systemone-http` once they have outcomes.

For TypeSafe's hosted backend set `backend = 'jev'` and save the key in Settings ▸ Keystore as `TYPESAFE_API_KEY` (scope global, or the repo). To keep a repo's judges on your own infrastructure (`systemone-http` and `stat` only), turn on airlock:

```sh
npx wrangler d1 execute cinder --remote --command "INSERT INTO airlock_repos (repo_id) SELECT id FROM repos WHERE name = '<repo>'"
```

To turn airlock on for every repo at once, set the Worker var `AIRLOCK` to `true` (in `worker/wrangler.jsonc` `vars`, then deploy). Hosted backends (Clef, `jev`) are then refused everywhere and their kinds fall back to their safe defaults; only `systemone-http` and `stat` judges are asked.

## Reconcile

`make up` and every release create resources with `deploy/reconcile.sh`. It creates any missing AI Gateway, Secrets Store store, D1 database, queue, R2 bucket or Vectorize index bound in `worker/wrangler.jsonc`, checks that the token can reach each Artifacts namespace, creates the org wiki repo `cinder-wiki` in it, deploys the `cinder-secrets` Worker when it is missing, and never deletes or changes an existing resource, except that it links the AI Gateway to the Secrets Store store and turns on the gateway's authentication when either is missing, and sets the cinder Access app's cookie to `SameSite=Lax` (keeping its policies) when it is not already. Agent model calls reach the gateway through the Worker's `AI` binding, which the account authenticates, so no gateway token is created or set. It writes this account's D1 database id and account id into the deploy config (`worker/wrangler.jsonc`) so the release deploys to the account it runs on, and puts any Worker secret that is missing (`OWNER_TOKEN`, generated or taken from `CINDER_OWNER_TOKEN`; `CF_DEPLOY_TOKEN`, the CI token; `OWNERS`; the Access team domain and audience) without overwriting one that exists. A Worker that is not deployed yet gets its secrets from the reconcile that follows the deploy. It also creates the Secrets Store secrets `cinder_merge_signing_key` and `cinder_live_ticket_key` with random values, and writes the Worker's `MERGE_SIGNING_KEY` and `LIVE_TICKET_KEY` bindings to them into the deploy config. `LIVE_TICKET_KEY` signs the 60-second tickets that open a repo's live-update socket; on a deploy without it, `POST /api/live-ticket` answers 204 and pages run with live updates off. When the token lacks a permission it stops and names it, for example `reconcile: can't create Queue cinder-events: the token needs Queues: Edit`.

Run it on its own with the saved token:

```sh
set -a; . ~/.config/cinder/cloudflare.env; set +a
deploy/reconcile.sh
```

## Keystore bindings

Keystore and webhook secret values stay in Secrets Store. Each one is bound on the `cinder-secrets` Worker (`worker/secrets/`), which has no Durable Objects, containers, route or `workers.dev` URL; cinder reads values through its `SECRETS` service binding. Adding or removing a secret or webhook re-binds `cinder-secrets` with a settings PATCH, which rolls a new `cinder-secrets` version and leaves cinder's Durable Objects, runner containers and claimed jobs running. A deploy of either Worker drops the `KS_*` bindings made at runtime: the next secret read answers 503 `binding_pending` and the next webhook delivery retries, while cinder re-binds them on `cinder-secrets`. `make deploy` and `make up` deploy `cinder-secrets` before cinder, and the release's reconcile step creates it when it is missing. `POST /api/keystore/rebind` (owner token) re-binds every `KS_*` binding at once; call it after a `cinder-secrets` deploy so no read waits on a re-bind.

Planned: the release deploys `cinder-secrets` before cinder on every run.

## Security headers

Every response carries `Content-Security-Policy` with `frame-ancestors 'none'`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: strict-origin-when-cross-origin`. The Worker sets them on `/api/*` (`worker/src/index.js`, except WebSocket upgrades); `web/public/_headers` sets them on the SPA's static assets. A page that loads anything from another origin needs its source added to the CSP in `_headers`.

Version preview URLs are off (`"preview_urls": false` in `worker/wrangler.jsonc`), so the only host serving cinder is the one behind the Access app.

## Rotate the owner token

`OWNER_TOKEN` is the Worker secret that grants every owner capability. The release workflow sends the same value as the GitHub secret `CINDER_OWNER_TOKEN`, and `~/.config/cinder/live.env` keeps it as `CINDER_TOKEN`. Reconcile never overwrites an existing secret, so rotate all of them together:

```sh
new=$(openssl rand -hex 32)
printf '%s' "$new" | npx --prefix worker wrangler --cwd worker secret put OWNER_TOKEN
printf '%s' "$new" | gh secret set CINDER_OWNER_TOKEN
printf '%s' "$new" > ~/.config/cinder/owner-token
sed -i "s/^CINDER_TOKEN=.*/CINDER_TOKEN=$new/" ~/.config/cinder/live.env
```

The old token stops working as soon as `wrangler secret put` finishes. Rotate on a schedule and whenever the token may have leaked; anything else holding the old `CINDER_TOKEN` must be given the new one.

## Slow Artifacts calls

A call to Artifacts that gets no answer is cut off after 5 s (reads) or 30 s (pushes) and sent once more; a second failure shows the page's usual error with Retry. A push is resent only when no response came back, and if the resend is refused because the branch already sits at the pushed commit, it counts as done. Answers, refusals included, are never retried.

## Reset and reseed the nonprod deployment

The committed `worker/wrangler.jsonc` sets `vars.CINDER_ENV` to `nonprod`, so the current deployment can be returned to an empty state and reseeded as often as a test pass needs. The seed writes repo history through `POST /api/repos/:name/seed`, which answers 404 on any deployment whose `CINDER_ENV` is not `nonprod`:

```sh
set -a; . ~/.config/cinder/live.env; set +a   # CINDER_URL, CINDER_TOKEN (owner) and the Access service token
node seed/seed.mjs --reset          # reset, then the default sections
node seed/seed.mjs --reset --full   # reset, then every section
```

Without a local checkout, an owner can click **Reset and reseed** under Settings › Access & people › Demo data (the `cinder-seed` Workflow, see [seed/README.md](../../seed/README.md)), or run the **reseed** workflow from the Actions tab (`.github/workflows/reseed.yml`): it runs `node seed/seed.mjs --reset --full` against the deployment with no deploy, and waits for any release in progress.

`--reset` calls `POST /api/admin/reset` (owner only), which answers 202 with a reset id and empties the stores in the `cinder-reset` Workflow, in steps of at most 50 objects, repos or log objects each. The seed polls `GET /api/admin/reset/:id` every second until its `status` is `done` (it stops on `failed`, naming the step and error) and only then seeds, so two runs in a row end in the same state. The status reports the step reached and, per store, what the reset cleared so far:

- D1: every row of every table except `d1_migrations` and `resets`, which holds each reset's progress (the schema stays; the default `account` row is put back).
- RepoDO, ChangeDO and DispatchDO: the storage and alarm of every instance that D1 or the Artifacts namespace names.
- Artifacts: every repo in the `cinder` namespace, with `cinder-agents`, `cinder-wiki` and every repo D1 names deleted by name too, since the namespace lists one page. `cinder-wiki` is created again empty; `cinder-agents` is created again with the baked-in agents on the next agents call.
- R2 `cinder-logs`: every object.
- Secrets Store: only the secrets cinder made (keystore and webhook secrets, people's model keys with their AI Gateway provider configs). Infrastructure secrets such as `cinder_merge_signing_key` and the gateway's own provider keys stay.
- Jobs: every queued or claimed job is removed with the runner tokens, so no runner can claim, heartbeat or report one afterwards; runners are registered again after a reset.

Owner and Access configuration, Worker secrets, the AI Gateway and the Secrets Store store are left alone. Any other `CINDER_ENV` value, or none, means production: the route answers 403 and nothing is touched.

The reset also removes the managed worker pools. Every seed run, reset or not, creates whichever of the two is missing: `build` (basic, min 0, max 12) and `toolchains` (standard-2, min 0, max 12, labels `linux` and `full-image`), each keeping a worker 10 minutes after its job, both serving every job kind. A pool already there is left as it is. With min 0, a container runs only while a job is queued.

## Tear down

`make down` (`deploy/teardown.sh`) deletes what `make up` and cinder itself created on the account. `make down DRY=--dry-run` lists the deletions only. It asks you to type the account id once; `CINDER_YES=1` skips that. A resource that is already gone is skipped, so a failed run is finished by running it again. The order:

1. Artifacts repos in the `cinder` namespace (the seed repos, every change fork `<repo>--c<id>`, `cinder-agents`, `cinder-wiki`), listed through the Artifacts REST API, then the namespace if it is empty.
2. Workers `cinder` and `cinder-secrets`.
3. Preview, staging and production Workers, D1 databases and KV namespaces cinder made for `pulse` and `web-store` (`pulse-*-<env>`, `<env>` being preview, staging, production or `c<8 hex>`).
4. Container apps named `cinder*`, Workflows `cinder-pipeline`, `cinder-reset` and `cinder-seed`, the four queues, D1 `cinder`, Vectorize `cinder-vulns`.
5. R2 buckets `cinder-ci-cache` and `cinder-logs`, each emptied first (1000 objects per call) because R2 refuses to delete a bucket with objects.
6. The AI Gateway `cinder` with its provider configs, then every `cinder_*` secret in the Secrets Store. The store stays.
7. The Access app `cinder` and the `cinder-runners` service token. The Zero Trust organization stays.
8. `live.env` and `access.env` in `~/.config/cinder/`. `cloudflare.env` stays.

Not deleted: Analytics Engine data (it has no delete API) and images in Cloudflare's managed container registry.

`.github/workflows/teardown.yml` runs `make down` every night at 23:59 Pacific (06:59 UTC) with the release secrets, and can be run by hand from the Actions tab. It waits for a release or reseed in progress. To bring cinder back, run `make up` and `make seed`. A push to `main` also redeploys the Worker and its resources through the release, but without seed data.

## Smoke test

`make smoke` (`scripts/smoke.sh`) runs against the deployment in `~/.config/cinder/live.env` (or `CINDER_URL` and `CINDER_TOKEN`). `SMOKE_VERIFY_TIMEOUT` (900 s) and `SMOKE_AGENT_TIMEOUT` (900 s) bound the waits for a worker. The checks, each PASS or FAIL with evidence:

1. Sign-in and API health.
2. The seed repos exist, with their branches.
3. A plain `git push` to `refs/for/main` of svc-orders-go opens a change titled by the commit subject.
4. The guard is clear on it, and a planted fake `sk_live_` key on a second change is quarantined.
5. Verify passes.
6. The change merges with no person: while the risk judge is untrusted the reviewer agent reviews it, and its pass queues it.
7. The merge commit's subject is `<KEY>: <title>`, it has `Cinder-Change` and `Cinder-Agent` trailers, and `refs/cinder/changes/<id>` has `intent.md` and `judgments.jsonl`.
8. The judgments API lists lease and risk judgments for the smoke changes.
9. An agent change (Workers AI) reaches `verifying`, and at least two agent changes are started at once.
10. A later push to `refs/for/main` is accepted.

It closes the changes it opened that are not merged. The merged commit stays on svc-orders-go main.

## Releases

Work merges into the long-lived `develop` branch, which deploys nowhere. A push to `main` runs the release, so `develop` merges into `main` only when a bulk of work is ready to test on the one nonprod deployment. A push to a repo forwards to `cinder-events` and starts no sandbox check.

Release secrets are set on the GitHub repo by hand, or by `make up` when you run it with `CINDER_GH_SECRETS=1` (it sets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CINDER_OWNER_TOKEN`, `CINDER_ACCESS_CLIENT_ID` and `CINDER_ACCESS_CLIENT_SECRET` from `~/.config/cinder/`). Without it, `make up` sends nothing to GitHub.

`.github/workflows/release.yml` builds the SPA, reconciles Cloudflare resources, applies D1 migrations, deploys the Worker, checks `/api/health` through Access, requests each repo's main pages once (warm) and tags it `release-<date>`. It uses the repo secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`: the same token `make up` saved, with every permission in the [README table](../../README.md#prerequisites). The health check and warm step also need `CINDER_ACCESS_CLIENT_ID`, `CINDER_ACCESS_CLIENT_SECRET` and `CINDER_OWNER_TOKEN`, set by `make up` from `~/.config/cinder/live.env` when `gh` is signed in for the repo (`CINDER_OWNER_TOKEN` is its `CINDER_TOKEN`); otherwise it prints which to set. The Worker URL is read from the deploy output, so a release works on any account. The workflows run on GitHub-hosted runners (`ubuntu-latest`). When the token lacks a permission, the release fails at the step that needs it. A release never seeds and never changes repo data: the seed (`node seed/seed.mjs --full`, run by `make seed`, the **reseed** workflow or Settings › Demo data) imports every repo in `seed/repos/` with its history, flows, issues and releases, and deletes the fixture repos older seeds made, with everything hanging off them (`DELETE /api/repos/:name`, owner only).

The release deploys with `wrangler deploy --containers-rollout none`, which builds and pushes no runner image and rolls no container, when `runner/` is unchanged since the latest `release-*` tag; the containers keep the images already in place. It rolls them (the default gradual rollout, 10-12 minutes, during which a running job is killed) when `runner/` changed or no release tag exists. A release that failed before its tag leaves the previous tag in place, so the next release compares with the last tag that was applied. A change only to the container entries in `worker/wrangler.jsonc` (instance type, instance count) takes effect at the next release that changes `runner/`.

`make e2e-live SPECS=budgets.live.test.js`, run by hand against a seeded deployment, runs `e2e/budgets.live.test.js`: it walks every page in [docs/usage/README.md](../usage/README.md) on each seed repo, and fails when:

- a page takes longer than 1500 ms from navigation to drawn content (no `.bone`, no busy region, layout still for 3 frames) with an empty cache, 800 ms for the repo root, Code, Changes and Change detail, or 800 ms on a warm reload;
- a page logs a console error or a page error, or an API call answers 400 or above;
- an action takes longer than its budget from click to drawn: branch menu open 150 ms, file switch 400 ms, board card to Change detail 600 ms, Change detail tab switch 200 ms, sidebar navigation 600 ms, Designer flow select 300 ms;
- the SPA or an API response lacks `Content-Security-Policy` with `frame-ancestors`, `X-Content-Type-Options: nosniff` or `Referrer-Policy`.

Each budget is a constant at the top of the spec. A failing run prints a table of each page or action with its measured value and budget.

After the seed, `node seed/activity.mjs` (same environment) puts real work through the seeded repos: each repo's first open issue with no change becomes a change linked to it, which an agent develops on the runner pool; each repo gets a Watchtower scan and a run of each of its flows (each repo has a dry-run flow on a change, on push, on a daily cron schedule and a manual-only one; they plan, build and test with the repo's own toolchain); pushes to a default branch start that repo's push flows. It deploys nothing and creates no Cloudflare resource, and it reports or claims no job itself, nor does the seed: the changes the seed filed are left to the pools too. The agent work needs the owner's own model credential: before starting anything it exits non-zero when the owner's source on My model access (`/me/models`) is not Mine with a connected provider, when no online worker or pool takes develop jobs (runner pools) or none takes flow jobs (the flow executor); the message names each one missing. It waits up to an hour for each of its own and the seed's open changes to reach merged, failed, needs_fix or closed (a draft, or a change awaiting a person's approval, counts as settled), and each flow run (its own and the seed's `ci` run on svc-orders-go, if still going) and scan to finish, then prints each outcome with the change's judgment count. Every flow run must pass, except svc-orders-go `ci` failing only at `integration`, a deliberate failure on the repo's open gap that its flow file marks; any other failure exits non-zero with the run, the step and the tail of its logs. It then exits non-zero naming each page it feeds that is still empty: Changes (a picked change with no judgment), Agents (no run in the last 24 h on `GET /api/fleet`), Watchtower (a scan not done) and Flows (a repo with no run). On a timeout it exits non-zero naming what is still pending.

## Public repo settings

The repository is public, so only its owner can push, and nothing a stranger sends sees a secret. Set these on GitHub (Settings):

- **Rules › Rulesets**, one ruleset on `main` and `develop`, enforcement Active, with the owner (Repository admin) as the only bypass: restrict deletions, block force pushes, require a pull request before merging, and require the `ci` status checks to pass.
- **Collaborators**: no one but the owner has write access. Without write access no one can push a branch to this repo; they fork and open a pull request.
- **Actions › General**:
  - Fork pull request workflows from outside collaborators: **Require approval for all outside collaborators**.
  - Workflow permissions: **Read repository contents and packages permissions**, and leave "Allow GitHub Actions to create and approve pull requests" off.
  - Leave "Send secrets and variables to workflows from fork pull requests" off (it is off by default).
- **Actions › Runners**: none. Every workflow runs on GitHub-hosted runners; `release.yml` and `reseed.yml` run only on pushes to `main` or a manual run, and `teardown.yml` on its nightly schedule or a manual run, which only the owner can start.
- **Secrets and variables › Actions**: the release secrets above live only as repository secrets. A fork's pull request never receives them.
- **Code security**: private vulnerability reporting on, Dependabot alerts on.
