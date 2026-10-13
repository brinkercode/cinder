# Environments

- **Route:** `/:repo/environments[?view=prev|services]`
- **Sidebar:** Automation ▸ Environments (repo from the top bar)
- **Backed by:** the `cinder-pipeline` Workflow and the Cloudflare API for deploys (Worker versions, deployments); deploy history in D1 ([map](../../ARCHITECTURE-CLOUDFLARE.md#2-page-by-page-map))

**Setup:** `pulse` (staging from develop and production from main, deployed by `make seed`); `web-store` (dev, staging and production; published releases); `svc-orders-go` and `infra-cloudflare-tf` (staging and production); an empty repo named `manual-empty-<n>` made with New repository and deleted afterwards for no environments. Deploy history comes only from real deploys: run `node seed/activity.mjs` after the seed (each repo's deploy flow, and its latest release promoted to staging).

## Bar and cards

| ID | Check | Expected |
|---|---|---|
| ENV-01 | Open `/web-store/environments`. | Environments / Services, **Promote a release**, **Add environment**; one card per environment, auto-fitting at least 300px wide. |
| ENV-02 | Look at a card. | A dot (green, amber on drift), the name, a target-cloud pill; Branch, Version, Deployed, Gate, Rollout; footer with "Worker › Deployments ↗" and **Promote →**. |
| ENV-28 | After `seed/activity.mjs`, look at staging's Version and history. | Each entry is a deploy that ran; once the latest release's promote deploys (after its Release approval), Version reads that release. |
| ENV-2024.1 | After `make seed`, open `/pulse/environments`. | staging and production each show a deployed Version, Deployed time and a Synced entry in history; the account has Workers `pulse-staging` and `pulse-production`. |
| ENV-2105.1 | Sync an environment whose `health` path fails, then reload. | Its newest history entry reads Degraded with the reason: "health check … failed at *n*%: *status*; rolled back to …". A sync held for approval reads "awaiting a person's approval: …". |
| ENV-2105.2 | After ENV-2105.1, open the sync's flow run. | Its deploy step reads failed and its log ends with the health check error; Complete job names the rollback. |
| ENV-1436.1 | Look at a card's body. | "*n* secrets · Keystore →", *n* being the secrets scoped to that environment in Keystore; it opens `/settings/keystore`. |
| ENV-05 | Look at the resource tree on a card. | The Worker script with its live version id, then each binding with type, resource and a drift mark where it differs. |
| ENV-06 | Open a card's ⋯ and click **Edit in .cinder.yml**. | Code opens `.cinder.yml` on the default branch. |
| ENV-07 | Click **Add environment**. | Code opens `.cinder.yml`, where environments are declared. |

## Drift

| ID | Check | Expected |
|---|---|---|
| ENV-08 | Add a binding to a deployed Worker by hand in the dashboard, wait for the next drift check (up to 10 minutes), reload. | The card's dot turns amber and a drift banner reads "Drift: the live Worker differs from .cinder.yml", with **Reconcile**; its history's newest row is OutOfSync · cinder-drift. |
| ENV-09 | Click **Reconcile**. | New change opens with an intent naming the differing resources, or asking to declare the environment's live changes when the drift check found them. |

## Promote

| ID | Check | Expected |
|---|---|---|
| ENV-10 | Click **Promote →** on staging. | A modal with Environment (staging picked), Release (published releases), Rollout (Gradual picked, or All at once) and the environment's gate. |
| ENV-11 | Click **Cancel**. | Nothing is promoted. |
| ENV-12 | Promote v1.0.0 to staging and approve the Release approval on Needs you. | The card's Version becomes v1.0.0 once the deploy succeeds; Deployed reads just now; a reload keeps it; Releases shows v1.0.0 "Live in staging". |
| ENV-13 | After ENV-12, open staging's Worker › Deployments. | A new Worker version for the promotion is listed. |
| ENV-14 | Click **Promote a release** in the bar. | The same modal, with the first environment picked. |
| ENV-15 | On a repo with no published release, open Promote. | "Publish a release first." and Promote disabled. |
| ENV-16 | Promote to an environment with an approval gate. | An approval item lands on Needs you; the version changes only after it's approved. |
| ENV-1393.1 | After ENV-16, look at that environment's card. | A strip: "Waiting for approval", the release, the gate and its approvers, the age, **Reject** and **Approve**. |
| ENV-1393.2 | Click **Approve** on the strip. | The strip goes; the deploy starts and the Needs you item is resolved. |
| ENV-1652.1 | Give an environment `approvers: <role>` in `.cinder.yml`, promote to it and look at its card. | The strip lists owners and holders of that role only, not every maintainer. |
| ENV-1652.2 | After ENV-1652.1, sign in as someone holding the role only through an Access group mapping and look at the card. | Their email is in the strip's approvers and **Approve** is enabled. |
| ENV-1638.1 | After ENV-16, sign in as a person who may not promote to that environment and look at its card. | The strip shows "Only approvers can approve"; **Reject** and **Approve** are disabled. |
| ENV-1393.3 | Click **Sync now** on a card. | The dot becomes a spinner with "Syncing · step *n*%"; Sync now is disabled until the deploy ends. |
| ENV-1393.4 | On a card with an earlier release, click **Roll back**. | A confirm "Roll back *env*?" naming the previous release and saying the gate applies and gradual rollout is skipped; confirming restores that release (through its gate). Cancel does nothing. |
| ENV-1393.5 | Look at **Roll back** on a card with no earlier release. | Disabled. |
| ENV-1393.6 | Tab through a card's footer at 390px, in light and dark. | Sync now, Roll back and Promote each show a focus ring and wrap without overflow. |

## Services

| ID | Check | Expected |
|---|---|---|
| ENV-29 | Open `/web-store/environments?view=services`, throttled. | The bar and tabs show at once with Services selected; card bones, then one card per detected service. |
| ENV-30 | Look at a service card. | Name, kind pill, path and id; "Suggested resources (not created)" with each type and name; **Deploy flow** expands to the flow's YAML. |
| ENV-31 | Click **Add deploy flow**. | The button reads "Adding…" at once, then "Flow added" with a link to the new change, which adds `.cinder/flows/<flow>.yml` on the default branch. |
| ENV-32 | After the ENV-31 change merges, reload the Services tab. | That service's button reads **Flow added**, disabled. |
| ENV-33 | Open Services on a repo with no Wrangler config, Dockerfile or Cloudflare Terraform. | "No services detected". |

## Other targets

| ID | Check | Expected |
|---|---|---|
| ENV-1359.1 | Run a flow whose `deploy: <env>` step with an `ssh: { … }` map deploys an environment declared with `target: SSH` in `.cinder.yml`, then open Environments. | The environment's card shows the deploy in its history (Synced or Failed, actor `flow:<flow>`) and Version shows its commit. |
| ENV-22 | Look at an environment whose target isn't Cloudflare. | The same card with the cloud in the target pill and an "Open in &lt;cloud&gt; console" link. |
| ENV-1421.1 | Declare an environment with `target: AWS, aws: { role_arn: …, region: eu-west-1, service: lambda, resource: <fn> }` (and likewise `gcp:` with `service: run`, `azure:` with `service: containerapps`), then open Environments. | Each card's console link opens that resource's page in its provider console (the Lambda function, the Cloud Run service, the Container App). |
| ENV-1421.2 | Declare an environment with `target: SSH, ssh: { host: <host>, … }`. | Its card footer shows the host in place of a console link. |
| ENV-1421.3 | Look below the cards. | No "Targets outside Cloudflare" note card. |

## States

| ID | Check | Expected |
|---|---|---|
| ENV-23 | Reload throttled on a first visit. | The bar stays; 3 card bones with 5 detail rows each. |
| ENV-1847.1 | Open `/web-store/environments`, then `/web-store/environments?view=services`, each directly in a new tab with `/api/**` delayed 3s. | The bar (Add environment disabled) and the card bones show at once, before the repository list answers; the main area is never blank. |
| ENV-24 | Open `/svc-orders-go/environments`. | "No environments" with "Declare environments in `.cinder.yml`"; Promote a release is disabled. |
| ENV-25 | Block `GET …/environments` and reload. | "Couldn't load environments" with Retry. |
| ENV-26 | Block one environment's resource-tree request. | That card stays up with "Couldn't load the resource tree"; the other cards are complete. |
| ENV-27 | Declare an environment in `.cinder.yml` whose branch doesn't exist and reload. | That card shows an amber dot and "Branch not found: *branch* has no commits on the remote"; the other cards are complete. |
| ENV-1559.1 | Throttle `GET …/services` and the resource-tree requests, then reload. | The environment cards draw as soon as the environments list answers; each resource tree fills in its card when it arrives. |
| ENV-1559.2 | In DevTools › Network, open `GET …/environments` and `GET …/services` › Timing. | Both carry Server-Timing (`manifest`/`state` and `total` durations). |
| ENV-1576.1 | In a repo whose `.cinder.yml` declares an environment with `target: AWS`, promote a release to it. | Its history gains an OutOfSync row for the release's commit; no Worker version is uploaded in Cloudflare. |
| ENV-1852.1 | In a repo where several environments share one branch (e.g. `aws-stg` and `azure-1` on `main`), promote a release to the second one. | The OutOfSync row lands in `azure-1`'s history; `aws-stg`'s history is unchanged. |
| ENV-1875.1 | Promote a release to an environment whose Worker doesn't exist yet in Cloudflare. | The deploy creates `<worker name>-<environment>` and the card reaches Synced; a deploy token without Workers Scripts: Edit fails the sync with a reason naming the token. |
| ENV-1875.2 | Promote a release whose commit lacks the Worker config's `main` file (e.g. web-store v1.0.0). | Promote is refused with "`<main>` is missing at `<sha>`"; no approval, sync or Cloudflare call follows. |

## Known gaps

- None known.

## Planned


## Retired

- ENV-17, ENV-18, ENV-19, ENV-20 (the Previews tab): changes get no Worker preview, so the tab is gone.
- ENV-04 (a prod card's Worker › Deployments link): no seeded repo has a Worker config, so no card links to the dashboard.
- ENV-03 (production's seeded promote, Degraded sync, rollback and drift entry): the seed records no deploy history; ENV-28 checks real deploys.
