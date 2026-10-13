# cinder

A git platform where agents are the authors. Many agents work on one repo at once, each in its own fork on Cloudflare Artifacts. A verifier owns the only path to merge, through a queue that sends conflicts back to an agent. Agents are versioned, so every merged change records the agent version and model that wrote it. Built for the Cloudflare "Build the Next-Gen Git Platform" competition. Licensed Apache-2.0.

## Architecture

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/architecture/system-overview-dark.svg">
  <img src="docs/architecture/system-overview-light.svg" width="100%" alt="Browser, cinder CLI and BYO runner pools pass through Cloudflare Access to the cinder Worker, which serves the React SPA and the API and runs container egress, pool autoscale and merge signing. Behind the Worker: State (D1, Durable Objects RepoDO, ChangeDO and DispatchDO, Artifacts, R2 cinder-ci-cache and cinder-logs); Execution (Queues, Workflows, Cron Triggers, rate limits, the Containers runner pool); AI (Workers AI for Clef judges, agent models, embeddings and Markdown conversion; AI Gateway; Vectorize); Secrets Store, Workers Logs and Analytics Engine. Workflows deploy to Cloudflare targets; the runner pool deploys to AWS, Google Cloud, Azure and SSH.">
</picture>

The other four diagrams (job execution, git lifecycle, secrets and model access, pages to resources) are in [docs/architecture/README.md](docs/architecture/README.md).

## Prerequisites

- A Cloudflare account on the Workers Paid plan, with Zero Trust available (the free plan is enough; `make up` creates the organization when there is none).
- Node 22+, `jq`, `curl`, `python3` and `openssl`.
- An account-owned API token, scoped to that one account, with exactly these permissions:

| Permission group | Access | Why |
|---|---|---|
| Account Settings | Read | find the account |
| Workers Scripts | Edit | deploy the Worker, Durable Objects, Workflows, secrets |
| Workers KV Storage | Edit | KV namespaces |
| D1 | Edit | the cinder database and migrations |
| Queues | Edit | event and webhook queues |
| Workers R2 Storage | Edit | CI cache and log buckets |
| Workers AI | Read | judges and embeddings |
| AI Gateway | Edit | create the gateway, stored provider keys, read usage logs |
| Vectorize | Edit | the vulnerability index |
| Containers | Edit | runner pools and CI sandbox |
| Secrets Store | Edit | every secret cinder references |
| Artifacts | Edit | git repositories |
| Access: Apps and Policies | Edit | the sign-in app and policies |
| Access: Service Tokens | Edit | the runner service token |
| Account Analytics | Read | Insights (Analytics Engine SQL) |
| Organizations | Read (optional) | the hourly account sync reads your organization, its accounts and members; without it cinder uses this one account |

`make up` opens a link to the Cloudflare dashboard with every row above filled in. Create the token and paste it once: that is the only step you do. It is kept in `~/.config/cinder/cloudflare.env` (mode 600).

When a permission is missing, `make up` stops and names it (for example `reconcile: can't create Queue cinder-events: the token needs Queues: Edit`). A release fails at the step that needs it.

## Deploy

```sh
npm ci
make up      # deploy everything to your account
make seed    # fill it with the seeded repositories and their activity
make smoke   # PASS/FAIL checks against the deployment
make down    # delete everything make up created
```

`make up` creates every missing Cloudflare resource cinder uses, applies migrations, deploys the Worker and builds the container images, then creates the Zero Trust organization and the Access sign-in when they are missing. It then waits until the Worker answers and the five container apps exist. It deploys only.

`make seed` seeds the deployment's repositories (`node seed/seed.mjs --full`), imports pulse and deploys its staging and production environments to your account as Workers `pulse-staging` and `pulse-production` (`make down` deletes them), and warms the pages. Set `CINDER_DEMO=1` to also file the demo scenario's intents on pulse. Re-running it is safe: what is already seeded is skipped.

No GitHub is involved. Re-running `make up` is safe and redeploys. After `make up`, you can also reseed from Settings › Access & people › Demo data (**Reset and reseed**, **Start the demo scenario**), with no checkout or terminal. Agent model calls reach AI Gateway through the Worker's AI binding, so there is no gateway token to create.

`make smoke` prints PASS or FAIL with one line of evidence for each check and exits non-zero if any failed. It uses only the API and plain `git` with the credentials `make up` wrote to `~/.config/cinder/`, and closes the changes it opened. See [operations](docs/operations/README.md#smoke-test).

`make down` deletes every cinder resource on the account after you type the account id (`CINDER_YES=1` skips the prompt; `make down DRY=--dry-run` lists what it would delete). The API token in `~/.config/cinder/cloudflare.env` is kept. See [operations](docs/operations/README.md#tear-down).

Expect 25 to 45 minutes on a new account: most of it is the first container image build and the smoke test waiting for a worker to take verify. A re-run on a deployed account takes about 10 minutes. The account needs the Workers Paid plan and access to the Artifacts beta, and the token the link pre-fills (Prerequisites above).

```
cinder is live: https://cinder.<you>.workers.dev
```

## Access

Open the printed URL and sign in through Cloudflare Access with an email one-time code. Only allowed emails can sign in: `OWNERS`, which defaults to your `git config user.email` (set `OWNERS=a@x.com,b@y.com` before `make up` to change it).

The owner token (`OWNER_TOKEN`, used by the `cinder` CLI) acts as the first email in `OWNERS`, so changes it starts are that owner's and use the model keys they saved in the browser.

To add someone, invite them with a role under Settings › Access & people: cinder adds their email to the cinder Access app's owners policy.

A change made with the Access sign-in cookie (any request other than GET) must come from cinder's own pages: one sent from another site answers `403 cross_origin`. The Access app's cookie is `SameSite=Lax`.

Group mappings under Settings › Access & people grant roles too: a signed-in person whose Access identity's `groups` claim lists a mapped group gets that group's role, from their next request. The group must still be allowed to sign in by the Access policy.

Anyone whose role grants `repo.write` on a repo may commit to it from the browser (never onto an integration branch: those change only through a change) and request reviewers on its changes. A change's author and driver may request reviewers on it too.

To let a service token (a CI job, a script) use cinder as a person:
1. Include the token in the owners policy (Include → Service Token), as for an email.
2. Allow it under Settings › Access & people › Service tokens with its client ID and a name, for example `abc123.access` as `ci-bot`.
3. After its first request it is listed as `ci-bot@service-token` in Settings › Access & people; give it a role there.

A service token that isn't allowlisted is refused, and the page says "This Access identity has no email".

Owners and anyone whose role grants `org.manage` can mint a 24-hour pool token for a bring-your-own runner pool. Whoever holds it can register runners into that pool, and do nothing else ([operations](docs/operations/README.md#bring-your-own-pool-on-self-hosted-machines)).

Never edit the "runners" policy: it lets the runner service token in. Removing someone in Access & people also takes their email out of the owners policy.

## Docs

- [Using cinder, page by page](docs/usage/README.md)
- [Architecture](docs/architecture/README.md)
- [Operations: runners, judges, releases, reconcile](docs/operations/README.md)
- [Contributing](CONTRIBUTING.md)
