# Environments

## Purpose

Where the repo is deployed, what version is live, and drift from `.cinder.yml`.

## Where

Automation ▸ Environments, for the current repo (`/:repo/environments`; `/environments` opens the current repo's); the top bar reads Automation › Environments › *repo* › *branch*

## What you can do

- On a repository with no code: an empty state with **Quick setup** (opens Code) instead of the page's data.
- Tabs **Environments** and **Services**.
- **Services** lists each service found on the default branch (a Wrangler config, a Dockerfile or Cloudflare Terraform at the root or one directory down): name, kind, path, id, the suggested Cloudflare resources (suggestions only, nothing is created) and the generated deploy flow. **Add deploy flow** opens a change that adds the flow as `.cinder/flows/<flow>.yml` and links to it; it reads **Flow added** once that file exists. No service found shows "No services detected".
- A card per environment: branch, version, deployed, gate, rollout, its deploy history (newest first: commit, status, who, when, and why when the sync recorded a reason: a failed health check and its rollback, a held approval, a sync window, a manual rollback's reason), the resource tree with drift marks (filled in once it loads; the card draws without waiting for it or for Services), **Edit in .cinder.yml**.
- An environment on another cloud uses the same card, with the cloud in the target pill and a link to that provider's console. With the target's config in `.cinder.yml`, the link opens the deployed resource: `aws: { role_arn | secret, region, service: lambda|ecs|apprunner, resource }`, `gcp: { provider | secret, region, service: run|functions, name }`, `azure: { secret?, subscription, resource_group, service: containerapps|functions, app }`. An environment with `ssh: { host, user, key_secret, command, fingerprint }` shows its host instead of a link. Credentials are Keystore secret names. A flow's `deploy: { target: aws|gcp|azure|ssh, environment, … }` step ([Flows](flows.md)) deploys it: each run of the step is a row in its history, and Version shows the commit it deployed. Declare the environment's `target` in `.cinder.yml` so drift checks leave it alone and a promote, Sync now or branch push only records an OutOfSync row in its history, without a Cloudflare deploy.
- An environment whose branch doesn't exist yet gets its own card marked **Branch not found**; the other cards load as usual.
- A card turns amber with a drift banner when resources differ from `.cinder.yml` or its newest history row is the drift check's OutOfSync (`cinder-drift`). **Reconcile** opens a change that declares or removes the differing resources, or declares the live changes.
- **Promote a release**, or **Promote** on a card: pick the release, the environment and the rollout (**Gradual**, in the environment's `gradual` steps, or **All at once**); the gate is shown below. An environment with auto-sync deploys the release at once; one with a manual gate raises a Release approval on Needs you and deploys only after **Approve**. An environment's `approvers: <role>` in `.cinder.yml` limits Approve, Reject and Dismiss to owners and holders of that role; without it, anyone who may promote decides. A release whose commit lacks its Worker config's `main` file is refused with the missing path. An environment's first deploy creates its Worker, `<worker name>-<environment>`.
- A Cloudflare environment's Worker answers on its workers.dev URL (`<worker>-<environment>.<account subdomain>.workers.dev`), where the health check probes it; a `wrangler.jsonc` with `workers_dev: false` keeps that URL off.
- **Sync now** on a card re-deploys the release the environment runs, gated like Promote. An environment that runs no release syncs to its branch head. While a deploy runs, the card shows a spinner and "Syncing · step *n*%". Each sync, promote and rollback is a run of the `deploy-<environment>` flow; its job shows **Set up job** (plan, secrets, resources, migrations, uploaded version), one step per traffic percentage (the split deployed and the health check) and **Complete job** (synced, failed or rolled back), each with its own log.
- **Roll back** on a card asks to confirm, naming the release live before the current one, then restores it. The gate still applies; gradual rollout is skipped. It is disabled when there is no earlier release.
- A card with an open Release approval shows a strip per approval: the release, the gate and who may approve (owners and the environment's `approvers` role, or without one anyone who may promote; someone who approves through an Access group mapping sees themselves listed), its age, and **Reject** or **Approve**. For someone who may not decide it, both are disabled and the strip reads "Only approvers can approve".
- Secrets an environment declares under `secrets:` in `.cinder.yml` live in [Keystore](keystore.md), scoped to the environment (or the repo, or global); each deploy passes them to the Worker. Each card shows "*n* secrets · Keystore →": the Keystore secrets scoped to that environment, linking to Keystore.
- Version shows the release whose commit the environment's current deploy runs; Deployed is when that deploy succeeded.

## Backed by

The `cinder-pipeline` Workflow and the Cloudflare API for deploys; a flow's runner for deploys outside Cloudflare; history in D1. Services are read from the repo in Artifacts.

Cloudflare map for this page: [ARCHITECTURE-CLOUDFLARE.md §2](../ARCHITECTURE-CLOUDFLARE.md#2-page-by-page-map).

## Planned

- **Add environment** (environments are declared in `.cinder.yml`).
- Creating a service's suggested resources.
