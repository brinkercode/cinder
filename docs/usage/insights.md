# Insights

## Purpose

Outcome and usage metrics for the repo.

## Where

Code ▸ *repo* ▸ Insights (`/:repo/insights`)

## What you can do

- On a repository with no code: an empty state with **Quick setup** (opens Code) instead of the page's data.
- Tabs **Overview** and **Usage**, a time range, a branch menu listing every integration branch in the repo's policy, and **Refresh**.
- Overview: Changes merged (expand the chart), Verifier runs, calibration, races and tokens by agent (runs outside cinder are tagged).
- Usage: tokens and cost by agent version, by person and by change, from AI Gateway.
- Cost per merged change is the AI Gateway cost logged against the changes merged in the range, divided by the merges. Conflict rate is the share of merged changes that hit a conflict, each counted once.
- Each tile that has a list or control links to it, on the page's branch: Verifier runs → **Open runs** (Flows with the same range), Brier score and the Calibration header → **Open judge** (Judges & calibration), Lease conflicts → **Open collisions** (`/:repo/changes/collisions`), Change failure rate → **View failing changes** (Changes filtered to failed).
- A By agent version row's **⋯** menu: **Set a token limit** (per run in k tokens and per month in M tokens; opens with the version's current limits and saves on that version; empty means no limit), **Swap model** (the agent's Settings & prompt) and **Open agent**.

## Each metric's list

The insights response names, per metric, the API list that holds its items (`lists: [{metric, list: {path, query}}]`):

| Metric | List |
|---|---|
| Change failure rate | `GET /api/repos/:name/changes?state=failed&since=<from>`: failed changes, newest first, 50 per page with a `next` cursor |
| Lease conflicts | `GET /api/repos/:name/lease-map` |
| Calibration | `GET /api/repos/:name/judges` |
| Cost by agent version | `GET /api/agents` |

Each By agent version row carries its version's current `limits` from D1 `agent_versions`. Token limits are saved with `PUT /api/agents/:name/versions/:version/limits {max_tokens, max_tokens_month}` into the version's limits in D1 `agent_versions`, next to `max_cost_usd`. A develop or resolve run of that version fails with "max tokens reached" when it uses more than `max_tokens`, or when it takes the version's tokens for the UTC calendar month past `max_tokens_month`. The limit is checked when the run ends, so its last turn can go over.

The all-repos insights have no lists. `state=closed` and `state=merged` page the same way; merged changes sort by merge time.

## Backed by

D1 rollups and AI Gateway logs. The page's **Backed by** link opens the AI Gateway logs.

Cloudflare map for this page: [ARCHITECTURE-CLOUDFLARE.md §2](../ARCHITECTURE-CLOUDFLARE.md#2-page-by-page-map).

## Planned

- Time series in Workers Analytics Engine, queried through its SQL API.
- Judge and non-Claude harness calls through the gateway, so Usage is complete.
- The collisions list that **Open collisions** opens.
- Runs that stop at their token limits; the limits are saved but not enforced yet.
