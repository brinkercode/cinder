# Insights

- **Route:** `/:repo/insights[?lens=usage][&range=][&target=]`
- **Sidebar:** Code ▸ *repo picker* ▸ Insights
- **Backed by:** D1 rollups for outcomes; AI Gateway `cinder` logs for tokens and cost ([map](../../ARCHITECTURE-CLOUDFLARE.md#2-page-by-page-map))

**Setup:** `svc-orders-go` (merges from the seeded changes; calibration and gateway usage only from real runs, so INS-10, INS-11 and INS-16 need them, one run outside cinder among them); `web-store` (under 20 outcomes); an empty repo named `manual-empty-<n>` made with New repository and deleted afterwards (no activity).

## Bar

| ID | Check | Expected |
|---|---|---|
| INS-01 | Open `/svc-orders-go/insights`. | Overview / Usage, a branch button, refresh and "Last 24 hours"; the Overview lens shows. |
| INS-02 | Click **Usage**, then **Overview**. | Exactly one lens shows; the URL carries `?lens=`; reload keeps it. |
| INS-03 | Open the range menu and pick Last 7 days. | The numbers re-query for 7 days; the URL carries `range=`; reload keeps it. |
| INS-04 | Open the branch menu and pick another integration branch. | The menu lists every integration branch in the repo's policy; the numbers re-query for that branch; the legend shows it. |
| INS-05 | Click refresh. | The data reloads in place. |

## Overview

| ID | Check | Expected |
|---|---|---|
| INS-06 | Look at the tiles. | Changes merged, Verifier runs, Agent tokens, Brier score (with n), Lease conflicts ("of n leases"), each with a sparkline where it has a series. |
| INS-07 | Look at the Changes merged chart. | A full-width bar chart with the legend "repo → branch total", an expand button and "Time (UTC)". |
| INS-08 | Click the expand button. | The chart opens full-screen in a dialog; its close button and Esc close it. |
| INS-09 | Look at Verifier runs. | Stacked passed / failed bars with a legend of both totals; y-axis labels are whole numbers, none repeated. |
| INS-10 | Look at Calibration. | A reliability diagram with a dashed diagonal and a "Brier x · n=y" pill. |
| INS-11 | Look at Tokens by agent. | One bar per agent, longest first, with the range in the header; a row from a run outside cinder carries the "outside cinder" tag. |
| INS-12 | On `web-store`, look at Brier score and Calibration. | The untrusted line instead of a score; Calibration shows "Not enough outcomes". |
| INS-1417.1 | Pick Last 7 days and branch `develop`, then click **Open runs** under Verifier runs. | Flows opens on Runs with Last 7 days and `develop`. |
| INS-1417.2 | Click **Open collisions** under Lease conflicts. | `/:repo/changes/collisions?target=<branch>` opens. |
| INS-1417.3 | Click **Open judge** under Brier score, then the one in the Calibration header. | Both open Judges & calibration. |
| INS-1417.4 | Tab through the tiles in light and dark, and at 390px. | Each tile link takes focus with a visible ring and stays inside its tile. |

## Usage

| ID | Check | Expected |
|---|---|---|
| INS-13 | Open Usage. | Tiles: Tokens, Cost, Cost per merged change, Change failure rate. |
| INS-14 | Look under the tiles. | A source note ("From AI Gateway…") with **Observability › Agents** and **AI Gateway › Logs**. |
| INS-15 | Click each of the two links. | Each opens the Cloudflare dashboard in a new tab on that view. |
| INS-16 | Look at the By agent version and By person tables. | Tokens and cost per row; a row from a run outside cinder carries the "outside cinder" tag. |
| INS-17 | Compare the Usage tokens with the AI Gateway logs for the range. | The totals match the gateway's logs for cinder's metadata. |
| INS-18 | Look at By change. | The top 5 changes by cost as bars. |
| INS-19 | Look at Change failure rate with under 20 outcomes. | The untrusted line, not a percentage. |
| INS-1417.5 | Click **View failing changes** under Change failure rate. | Changes opens on the same branch showing only failed changes. |
| INS-1417.6 | On a By agent version row, open **⋯**. | **Set a token limit**, **Swap model** (opens the agent's Settings & prompt) and **Open agent**; a row from outside cinder has no menu. |
| INS-1417.7 | Set a token limit of 150 k per run and 2 M per month, then **Save limit**. | "Saved on the agent version"; the version's limits read `max_tokens` 150000 and `max_tokens_month` 2000000. Empty fields clear a limit. |
| INS-1609.1 | After saving INS-1417.7, reload Insights › Usage and open **Set a token limit** on the same row. | The dialog opens with 150 per run and 2 per month filled in; a version with no limits opens with empty fields. |
| INS-1417.8 | Block `PUT …/limits` and save. | "Couldn't save the limit: …" in the dialog; the dialog stays open. |
| INS-23 | At 1440px, switch between Overview and Usage. | The frame keeps its width and the toolbar doesn't move. |
| INS-24 | Open Usage on a range with no per-person usage. | "By person" heading sits level with "By agent version"; the card says "No usage in this range". |

## States

| ID | Check | Expected |
|---|---|---|
| INS-20 | Reload throttled on a first visit. | 5 tile bones, a 220px chart bone, two 180px chart bones (calibration keeps its axes and diagonal), 5 bar rows. |
| INS-21 | Open `/manual-empty-<n>/insights` on the empty repo from Setup. | "No activity in this range" with a hint to pick a longer range or another branch. |
| INS-22 | Block `GET …/insights` and reload. | "Couldn't load insights" with the request and Retry. |

## Known gaps

- **INS-17:** judge calls and two of the harnesses still bypass the gateway, so Usage undercounts against the gateway's logs.

## Planned

- Time series in Workers Analytics Engine.
- Every judge and harness call through AI Gateway, so Usage is complete.

## Retired

None.
