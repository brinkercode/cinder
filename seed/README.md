# seed

Demo data through cinder's real API. Idempotent: a re-run creates nothing new. The seed files changes through
`POST /api/repos/:repo/changes` as drafts and never registers a runner, claims or reports a job: it queues no agent work
beyond the work section's two claimed intents.
A draft stays put until a person marks it ready (**Mark ready**), which queues it for the pools. Agent work comes only
from `seed/activity.mjs`. It imports the three full repos from `seed/repos/<name>` through the seed route. A repo seeded by an older seed keeps its old history; delete it, or use `--reset` on nonprod, to get the full one.

```sh
set -a; . ~/.config/cinder/live.env; set +a   # CINDER_URL, CINDER_TOKEN and the Access service token
node seed/seed.mjs          # the default sections
node seed/seed.mjs --full   # every section, for a pass over every page (seed(api, push, "all", commit, sources) in tests), then atlas-monorepo
node seed/seed.mjs --large  # only atlas-monorepo (see Large repo)
node seed/seed.mjs --reset  # nonprod only: empty the deployment first (POST /api/admin/reset, polled until done), then seed
```

Every run first creates the managed pools `build` and `toolchains` (min 0, max 4) if either is missing, as after a reset, so queued jobs have a pool to run them. While `toolchains` still has the default egress allowlist, the seed adds `registry.terraform.io`, `github.com` and `release-assets.githubusercontent.com` to it, so terraform can download its providers.

From the app, with no checkout: Settings › Access & people › **Demo data** (owner, nonprod only). **Reset and reseed** calls
`POST /api/admin/seed`, whose `cinder-seed` Workflow runs the same code as `node seed/seed.mjs --reset --full`;
**Start the demo scenario** calls `POST /api/admin/demo`, the same code as `node seed/demo.mjs`. Both answer 202 `{id}`;
`GET /api/admin/seed/:id` reports `status` (running, done, failed), `step` (reset, seed, demo) and `error`. The Worker
calls its own routes as the owner, with `seed/repos/` and `demo/pulse/` bundled in as data: `seed/bundle.mjs` writes
`seed/bundle.json` before every wrangler build.

`node seed/activity.mjs` (same environment, after the seed) drives real activity on the seed repos and prints the outcomes:
per repo one agent change (its intent asks the agent to read the repo's advisory on osv.dev, which is off every agent's egress allowlist, so Watchtower › Network shows that host denied), a Watchtower scan and a run of each of its flows (each repo has a dry-run flow on a
change, on push, on a daily cron schedule and a manual-only one; they plan, build and test with the repo's own toolchain and no credential, and all pass except svc-orders-go's `ci`, which fails at `integration` on purpose), and it waits for the repo's changes that are in flight (not the seed's drafts)
as it waits for its own, and for the seed's `ci` run if it has not settled. The agent work runs on the owner's own model credential: the owner's source on My model access
(`/me/models`) must be Mine with a connected provider. Neither the seed nor activity deploys anything or creates a
Cloudflare resource; see [After the seed in operations](../docs/operations/README.md).

The seed and activity retry transient failures (a 429, 500, 502, 503 or 504, or a dropped connection) with backoff, up to five
attempts, and print one line per retry to stderr.

## Demo

`node seed/demo.mjs` (same environment, nonprod only) loads `demo/pulse/` as the repo `pulse` through the seed route:
`main` with the app and `develop` from it, the default branch. It needs no GitHub token, and a `pulse` that already has
commits on `main` is left as it is. The seed route starts no deploy, so the D1 database and KV namespace in pulse's
`.cinder.yml` are not created. Once a runner has indexed `develop`, it files twelve intents on `develop` that stack,
start a seam, conflict, race, flake, trip the push guard and run in parallel. The race is between `developer@v2`
(gpt-oss-120b) and `dev-open@v1` (gpt-oss-20b), which the seed's agents section creates. A re-run files nothing new.

## Repos

`seed/repos/<name>/` holds three small, original projects to deliver with cinder. Each has a README (pinned
toolchain), a `.cinder.yml` branch policy with a rule that routes one file to a person and a `deploy` section, a
`.cinder/flows/deploy.yml` flow, tests, and open gaps (TODOs) for agents to pick up. They sit outside cinder's lint,
tests and dependency checks; `make check-seed` (`seed/repos.test.js`, `seed/repos-infra.test.js`) builds and tests each
one, skipping a repo whose toolchain is absent.

| Repo | Stack | Branches | Environments |
|---|---|---|---|
| web-store | Storefront Worker with static assets and D1 (TypeScript), vitest | gitflow: develop, main, release/* | dev, staging, production |
| svc-orders-go | Go stdlib HTTP orders service, `go test` | trunk: main | none (suggested: Cloudflare Containers) |
| infra-cloudflare-tf | Terraform for web-store's Worker, static assets and D1, plus an S3 mirror in `aws/`, `terraform test`; its deploy and destroy flows only plan | trunk: main | staging, production |

Where each feature is seeded (`--full`), per repo:

| Feature | web-store | svc-orders-go | infra-cloudflare-tf |
|---|---|---|---|
| Code: dated commits by five people, every one adding or changing the repo's files: trunk repos one commit per folder on a linear main with two feature branches, tags v1.0.0 and v1.1.0 | gitflow instead: the scaffold on main (v1.0.0); the Worker, `lib/`, `public/`, `migrations/`, tests and flows each on a `feature/*` branch merged into develop; release/1.1 merged into main (v1.1.0) and back into develop; release/1.2 (v1.2.0-rc.1); `feature/postcodes-outside-the-us` open, unmerged | ✓ plus the owner's edit to orders.go | ✓ plus a person's edit to the plan test, taken over |
| Changes: about a dozen intents filed as drafts, one closed; a person marks a draft ready to queue it | ✓ plus develop and release/1.2 targets | ✓ | ✓ |
| Review threads: a reply, a resolved thread, a suggestion, once a pool has the change verifying | ✓ | ✓ | ✓ |
| Releases: v1.0.0 and v1.1.0 published | ✓ plus v1.2.0-rc.1 draft | ✓ | ✓ |
| Flows: a change, a push, a daily cron and a manual-only flow, all dry-run; runs come from `seed/activity.mjs` | ✓ | ✓ | ✓ |
| Watchtower: scans come from a runner (`seed/activity.mjs`); a fake `art_v1_` token in `.env.example`, a SARIF code finding uploaded by the seed, a package pinned below its fix | ✓ lodash 4.17.20 plus auto-fix on three packages | ✓ golang.org/x/text v0.3.7 | ✓ esbuild 0.24.2 in `tests/package.json` |
| Wiki: a page with a comment | Overview | Runbook | Overview |
| Races: none; Races shows its empty state until a person files one | – | – | – |
| Needs you: none; flow and release approvals appear once a runner runs the flows (`seed/activity.mjs`) | – | – | – |
| Issues: a bug, its TODOs as features, a done issue | ✓ | ✓ | ✓ |

## Large repo

`atlas-monorepo` is large in history and moderate at its head, for partial clones: a blobless clone
(`git clone --filter=blob:none`) fetches commits and trees, and only the head's file contents on checkout. `seed/large.mjs`
generates it at seed time from a fixed seed, so every run writes the same repo; none of its files are checked in.

| | |
|---|---|
| Head | 1,004 files, about 3.3 MB: 40 packages (`packages/<name>/src/*.js`, 25 files each), a README, a `package.json` and two vendor bundles of 1.25 MB |
| History | 48 commits, about 62 MB of file contents (about 45 MB compressed): each commit after the first regenerates one vendor bundle and changes one module |

Only `--full` and `--large` seed it, through the seed route in 17 requests of at most 4 MB; Settings › Demo data does not.
A repo that already has commits on `main` is left as it is; delete it to seed it again.

## Sections → pages

| Section | Page |
|---|---|
| agents (with a git push, every run) | Agents (`/automation/agents`): only the agents cinder runs, each reading the web as Markdown: developer (stable v2, canary v3 on 20% of changes), reviewer v2 and resolver v2 on gpt-oss-120b, and dev-open v1 on gpt-oss-20b for races; their roles. No runs, tokens or races until real runners report them |
| changes | Changes (`/:repo/changes`) on every full repo: intents filed as drafts, one closed; once a person marks the detail intent ready, the next run turns its auto-queue off |
| gitflow | Settings (`/:repo/settings`), New change: draft intents on develop and release/1.2, two naming one symbol and two a seam |
| states | Changes on every full repo: a closed base, drafts, and a review sending one back once a pool has it verifying; Access (`/settings/access`): a change authored by a person |
| review | Change detail review tab on every full repo, once a pool has the change verifying (skipped until then): the owner and ana.ruiz requested as reviewers with an agent version, threads, a reply, a resolved thread, a suggestion |
| detail | Change detail (`/:repo/changes/:id`): the owner's review requested on each full repo's verified, unqueued change (skipped until a pool has it verifying) |
| code-page | Code (`/infra-cloudflare-tf/code/main`): its history and a person's edit to the plan test, taken over |
| people | Change detail (`/:repo/changes/:id`) and Collisions (`/:repo/changes/collisions`) on every full repo: three people each commit an edit of one symbol to their own `people/*` branch and open a change from it, which they drive, with auto-queue off. Once a pool has verified them, cinder records collisions on the first change's lease; the next run hands the latest one over and pushes that change's follow-up edit (its commit names the change with a `Cinder-Change:` trailer), so it verifies again, and leaves any other open. The same run approves the first change over its untrusted risk judge (its Untrusted judge item) and queues it, so a pool merges it; once the handed-over change has verified again, a later run gives the owner's verdict against the risk judge's, which raises Judges disagree beside that change's own Untrusted judge item |
| repos | Repositories (`/`): each seed repo's description and language, and the token budget, whose alerts fire from real AI Gateway usage |
| watchtower | Watchtower (`/:repo/watchtower`): web-store's auto-fix on three packages and one SARIF code finding per seed repo, uploaded through `POST /api/repos/:name/sarif` for a runner to ingest (skipped once the repo has a code finding). No scans or egress: `seed/activity.mjs` queues them for a runner |
| wiki | Wiki (`/wiki`): org pages on the stack, the orders service's runbook with versions, a comment, search hits; an overview with a comment on web-store and infra-cloudflare-tf |
| releases | Releases (`/:repo/releases`) on every full repo; no deploys (`seed/activity.mjs` runs them) |
| issues | Issues (`/:repo/issues`): every seed repo's backlog (a bug, its TODOs as features, a dependency chore, a done issue) with labels and assignees; svc-orders-go's feature links its change |
| work | Changes (`/infra-cloudflare-tf/changes`): four intents filed through the issues route; the first claimed by the top suggested agent and the second raced by the top two through the claim route, so real pools develop them |
| judges (every run) | Judges (`/automation/judges`): every repo's lease, collision, seam and split judges on `clef-flash@2` (minimum confidence 0.7), guard on `clef-flash@2` (0.6), risk and flake on `clef@2` (0.6) and resembles_vuln on `clef@2` (0.7), all on Workers AI; no judge history, so each shows "untrusted: 0 outcomes" until real judgments are scored |
| insights | Insights (`/:repo/insights`): no merges, verifier runs, usage or calibration until real runs (the Usage lens shows "No usage in this range") |
| access | Access & people (`/settings/access`): no group mappings; five placeholder people: `ana.ruiz@brinkercode.dev` (maintainer), `ben.okafor@brinkercode.dev` and `chen.wu@brinkercode.dev` (developers), `dara.novak@brinkercode.dev` (contributor), `emeka.obi@brinkercode.dev` (viewer). The owner (once signed in) and the four with write roles author the seed's commits; the viewer authors nothing |
| accounts | The sidebar account popover: organization `Nimbus Edge` with three cinder-local accounts (`nimbus-edge-team`, `nimbus-edge-staging`, `nimbus-labs`), each with two placeholder people as members by Git role; no Cloudflare account id until a sync links them |
| workers | Workers (`/automation/workers`): a BYO pool `self-hosted` labelled `linux` and `gpu` with no members until a real runner registers, and the `toolchains` managed pool labelled `linux` and `full-image` |
| ci (with the library import) | Flow run (`/svc-orders-go/flows/runs/:id`): one run of svc-orders-go's six-stage `ci` flow (build, test, integration, package, staging, release), and one of its `daily` flow, started through the run route for real runners to take; a re-run starts none for a flow that has a run |
| models | My model access (`/me/models`): no saved keys or runs; Cloudflare credits connected, every other provider missing, zero usage this month |
| code (with the library import) | Code (`/svc-orders-go/code/main/orders.go`): "Cancel open orders" filed as a draft and the owner's edit to Create; authorship comes from a runner's blame job |
