# Workers

## Purpose

The runner pools that run jobs: the managed Cloudflare pool and bring-your-own pools.

## Where

Automation ▸ Workers (`/automation/workers`)

## What you can do

- A card per pool with its size, health and heartbeat. Every card has **Edit**; a pool's size changes only there, under **Instance type**. Picking a new size for a pool with running workers says how many will finish their current job and restart on it; on save, idle workers stop at once and new ones start on the new size.
- Each managed card shows `Managed · <pool name>`; only the oldest managed pool carries the `default` tag. Its footer shows the jobs its workers started in the last hour (**Runs per hour**) and the median seconds from queued to claimed (**Median start**, "none yet" without runs).
- Every install starts with two managed pools, `build` (basic) and `toolchains` (standard-2), scaled from 0 to 4 workers; an existing pool of the same name is left as it is. Each serves every job kind; builds for repos in any language other than JavaScript, TypeScript, CSS, HTML, Vue, Svelte or Shell run only on the standard-2 pool, whose image carries the other stacks' toolchains ([Operations](../operations/README.md#runner-images)). A managed pool created without kinds serves every kind.
- A managed pool's pill shows how many of its running workers have checked in. A pool with no running workers shows **Idle, scales on demand**: a queued job starts one.
- A managed worker not heard from in 15 minutes and holding no live job is stopped and its token removed, as is a worker named after a pool that belongs to none and never checked in.
- A draining pool shows a `draining` pill and **Resume**, which lets its workers claim again and starts workers for its queue.
- **Add worker pool** and **Edit** open one modal. Its body scrolls; the footer stays put with a billing note (sandbox seconds for Managed, your machines for bring-your-own), **Cancel** and **Create pool** or **Save changes**. Focus starts on **Name**. Esc, Cancel and × close it and drop the draft. Errors (an empty name, a name already taken, a failed save) are shown inline and announced to screen readers. A managed pool whose settings are refused after it was created stays open as **Edit**: fixing them and saving again saves only the settings, and the list shows the pool once the modal closes.
  - **Kind** (new pools only): **Managed** (Cloudflare Containers) or **Bring your own**. Switching keeps the name, labels, egress and repo scope.
  - **Name**: required and unique across all pools. A managed pool's name can't be changed after it is created.
  - **Labels**: type a label and press Enter or comma to add it; × removes it. Steps pick a pool with `runs-on: [labels]`.
  - Managed: **Instance type** (`lite`, `basic`, `standard-2`, `standard-4`, each with its specs), **Max sandboxes at once** (1 to 64), **Keep warm after a run** (0s, 1m, 5m, 15m) and **Placement**. A new managed pool starts at most 20 workers. A `lite` pool never takes agent work (develop, resolve, review): those jobs go to a `basic` or larger pool. An agent job that runs past its version's **Max minutes** fails as timed out.
  - Bring your own: **Cloud** and **Region**, and **Register workers**. Creating a bring-your-own pool keeps the modal open on that pool. **Mint token** shows a pool token once; it registers one worker within 24 hours, can be copied, and is gone when the modal closes. The modal then shows the commands that install the `cinder` CLI and register a machine with `--pool-token`, and the pool's status: "Waiting for the first heartbeat…" until a worker checks in, then "n of m online", refreshed every 3 seconds while the modal is open. **Issued tokens** lists the pool's tokens by prefix (`9f2c41ab ••••`) with when and by whom each was created and when it was first used ("never" until then), or "No tokens issued for this pool." **Revoke** asks for a second click (**Click again to revoke**); workers registered with that token finish their running jobs and are refused and removed at their next heartbeat. The list shows a skeleton while loading and an inline error with **Retry** if it fails.
  - **Network egress**: **Allow list** (with an **Allowed hosts** box, one host pattern per line), **None** or **Open**. Watchtower records hosts under every option.
  - **Who can use it**: **All repositories** or **Selected**, with a checklist of repos.
  - **Danger zone** (editing only): a managed pool has **Drain** (or **Resume** while draining) and can't be deleted. A bring-your-own pool has **Delete**, which asks for a second click (**Click again to delete**). Its runners keep their tokens and leave the pool.
- A pool's settings decide what its workers claim:
  - **Labels**: a flow job with `runs-on` goes only to a pool whose labels include every label it names ([Flows](flows.md)); a job without `runs-on` goes to any pool. A bring-your-own pool uses its own labels.
  - **Repos**: a pool limited to some repos claims only their jobs; queued jobs it can't take never start its workers.
  - **Max concurrent**: a bring-your-own pool holding that many claimed jobs claims nothing more until one finishes.
  - **Keep warm**: an idle managed worker stays up until that many seconds (default 60) after its last job, or its start before any.
  - **Egress**: flow steps reach the network through a per-job proxy. `allowlist` (default) allows the pool's host patterns, or the default registries and docs hosts when it lists none; `none` allows nothing extra; `open` allows every host and records those outside the list as would-deny. cinder and Artifacts are always reachable. Allowed, denied and would-deny hosts are reported per job.
- Pool tokens, on the API: `GET /api/workers/byo-pools/:id/tokens` lists a pool's tokens as `{prefix, created_by, created_at, used_at, expires_at}` (never the token) and `DELETE /api/workers/byo-pools/:id/tokens/:prefix` revokes one. Both need `org.manage`. See [Operations](../operations/README.md#register-a-runner).

## Backed by

Cloudflare Containers, D1 (pools, members, runner token hashes) and the DispatchDO Durable Object for claims. The page's **Backed by** link opens Containers. Registering a BYO runner is in [Operations](../operations/README.md#register-a-runner).

Cloudflare map for this page: [ARCHITECTURE-CLOUDFLARE.md §2](../ARCHITECTURE-CLOUDFLARE.md#2-page-by-page-map).

## Planned

- Placement is stored but not applied yet.
- A bring-your-own pool's max concurrency and the job kinds its workers may register for (without `flow` by default) are set through the API only (`PUT /api/workers/byo-pools/:id`).
