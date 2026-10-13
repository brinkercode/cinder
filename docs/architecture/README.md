# Architecture

Cloudflare is the backing of every resource cinder uses. One Worker serves the app and the API behind Cloudflare Access. Git lives in Artifacts, state in D1 and Durable Objects, and jobs run on ephemeral, autoscaled Containers instances. Models are called through AI Gateway, and secrets are held in Secrets Store. Cinder itself never stores, encrypts or logs a secret value. Dashed outlines mark parts that are planned but not yet live. [ARCHITECTURE-CLOUDFLARE.md](../ARCHITECTURE-CLOUDFLARE.md) has the binding table, the page-by-page map and the background services.

**System overview.** Browsers, the CLI and BYO runners reach the cinder Worker through Access. Behind it, every product is a Cloudflare one, and deploys go to Cloudflare or to other clouds.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="system-overview-dark.svg">
  <img src="system-overview-light.svg" width="100%" alt="Browser, cinder CLI and BYO runner pools pass through Cloudflare Access to the cinder Worker, which serves the React SPA and the API and runs container egress, pool autoscale and merge signing. Behind the Worker: State (D1, Durable Objects RepoDO, ChangeDO and DispatchDO, Artifacts, R2 cinder-ci-cache and cinder-logs); Execution (Queues, Workflows, Cron Triggers, rate limits, the Containers runner pool); AI (Workers AI for Clef judges, agent models, embeddings and Markdown conversion; AI Gateway; Vectorize); Secrets Store, Workers Logs and Analytics Engine. Workflows deploy to Cloudflare targets; the runner pool deploys to AWS, Google Cloud, Azure and SSH.">
</picture>

**Job execution.** The Worker starts an ephemeral instance in the autoscaled pool for each queued job, and DispatchDO serialises the claims. Model keys never reach the instance: its egress sends model calls to AI Gateway.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="job-execution-dark.svg">
  <img src="job-execution-light.svg" width="100%" alt="A change, push or Flow run becomes a job row in D1; the Worker starts an instance in the Containers runner pool for each queued job, keeps an optional warm buffer and scales to zero, one job per instance, and DispatchDO serialises claims with gate jobs first. Egress goes through the Worker's container egress: a per-job host allowlist, web pages as Markdown, and model calls to AI Gateway, which adds the stored key. Flow secrets are read from Secrets Store for the job's lease and masked. Results go back as git commits to Artifacts and masked logs to R2 and Workers Logs. Cloudflare deploy steps go through Workflows to Cloudflare targets; other clouds deploy from the job.">
</picture>

**Git and change lifecycle.** Each push becomes guard and verify jobs, Clef judges route each step, and collisions settle by stacking or a seam. The Worker signs the merge commit, so runners never hold the key.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="git-lifecycle-dark.svg">
  <img src="git-lifecycle-light.svg" width="100%" alt="A git push lands in Artifacts, which emits cf.artifacts.repo.pushed and starts the cinder-pipeline Workflow; it hands the push to the cinder-events Queue, whose consumer queues guard and verify jobs. Their results move a change from leased and developing to verifying, in_queue and merged; needs_fix, conflict, resolving and waiting sit off the path. An untrusted risk judge routes a verified change to the reviewer agent, a trusted high answer to a person. RepoDO holds symbol leases and settles collisions by stacking or a seam; ChangeDO holds the change and its merge queue entry; Clef judges on Workers AI are scored against outcomes. At merge, the cinder Worker signs the merge commit with a key from Secrets Store, the target branch moves in Artifacts, and a history job writes the change's trailers and refs/cinder/changes record.">
</picture>

**Secrets and model access.** Personal and org keys are encrypted and held by Cloudflare, and cinder keeps only references. Values never land in D1, logs, queues or job payloads.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="secrets-model-access-dark.svg">
  <img src="secrets-model-access-light.svg" width="100%" alt="Your own provider key from My model access and the org's deploy, signing and webhook secrets go into Secrets Store; org model keys go into AI Gateway stored keys, which call Anthropic, OpenAI, Google, xAI and Workers AI. The cinder Worker and D1 keep only references: name, version, owner and audit trail. An ephemeral job instance never holds a model key: its egress sends model calls to AI Gateway, which adds the stored key, and a flow job reads its own secrets for its lease with output masked. Values never land in D1 rows, Workers Logs or R2 logs, queue messages, job payloads, git or the browser.">
</picture>

**Pages and their Cloudflare resources.** Each sidebar page is backed by the resources listed on its card; pages folded into a host page are named on the host's card.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="page-resource-map-dark.svg">
  <img src="page-resource-map-light.svg" width="100%" alt="Repo pages under Code ▸ repo: Code, with Releases on its toolbar, on Artifacts, RepoDO and a D1 index with tags and releases; Changes, which holds the repo's issues, on D1, RepoDO, ChangeDO and guard and verify jobs; Watchtower on D1, scan jobs, Vectorize and Clef; Insights on Analytics Engine and AI Gateway logs; Repo settings on D1, .cinder.yml and the webhooks Queue. Automation: Agents on Artifacts cinder-agents, D1 and AI Gateway; Marketplace on D1 and release jobs; Judges & calibration on Clef on Workers AI via AI Gateway and D1; Flows on runner pool jobs, Workflows and R2 logs; Environments on Workflows and Workers API deploys; Workers on the Containers pool and DispatchDO. Organization: Repositories on D1 and Artifacts; Wiki on an org Artifacts repo with a D1 index; Needs you on D1 and ChangeDO; Access & people on Cloudflare Access and D1 roles; Keystore on Secrets Store via cinder-secrets; My model access on Secrets Store and AI Gateway keys. Issues and Releases are folded into Changes and Code.">
</picture>

The SVGs are generated by [gen.py](gen.py).
