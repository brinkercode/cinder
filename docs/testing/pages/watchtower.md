# Watchtower

- **Route:** `/:repo/watchtower[?tab=dependencies|network][&sev=][&source=&fsev=&q=&finding=]`
- **Sidebar:** Code ▸ *repo picker* ▸ Watchtower
- **Backed by:** D1 (scans, findings, dependency inventory, egress verdicts); a Cron Trigger for the daily scan; scan jobs on a runner ([map](../../ARCHITECTURE-CLOUDFLARE.md#2-page-by-page-map))

**Setup:** a full seed, then `seed/activity.mjs`. Each seed repo (`web-store`, `svc-orders-go`, `infra-cloudflare-tf`) then has a passing scan, a secret (`artifacts_token` in `.env.example`), a code finding with a line (the seed's SARIF upload), a dependency advisory (`web-store`: lodash 4.17.20, `svc-orders-go`: golang.org/x/text v0.3.7, `infra-cloudflare-tf`: esbuild 0.24.2), an SBOM, and on Network an agent card with `osv.dev` denied beside the hosts it was allowed. `web-store` has auto-fix on three packages. For the empty states, open `cinder-agents`, which the seed never scans and no agent works in.

## Bar

| ID | Check | Expected |
|---|---|---|
| WT-01 | Open `/web-store/watchtower`. | Overview / Dependencies / Network, "Last scan n ago" and **Scan again**; the Overview tab shows. |
| WT-02 | Click each tab. | Exactly one tab's content shows; the URL carries `?tab=`; a reload keeps the tab. |
| WT-03 | Click **Scan again**. | The button shows progress ("Scanning…") and is disabled while the scan is queued or running; when it finishes, without a reload, the button reads **Scan again** and "Last scan" shows the finished scan. |
| WT-27 | With no scan worker online, click **Scan again**. | The button stays "Scanning…" and the bar shows "Waiting for a scan worker"; `GET …/scans` lists the scan as queued. |
| WT-04 | Make the latest scan fail (no online scan runner), then open the page. | A danger banner "The last scan failed." with **Retry**. |

## Overview

| ID | Check | Expected |
|---|---|---|
| WT-05 | Look at the tiles. | Dependencies, Open advisories (one per advisory: a package with 5 advisories counts 5), Auto-fix changes open (open changes auto-fix opened; a fix opened by hand or turning a toggle on alone doesn't change it), Denied egress · 24h. |
| WT-06 | Look at "Open advisories by severity". | A bar split by critical, high, medium and low, with a legend; the segments add up to the Open advisories tile. |
| WT-07 | Look at Top advisories on `web-store`. | One row per advisory: a severity swatch, package and version, advisory id, "fixed in", a severity pill, and **Open fix change** where a fix exists. |
| WT-08 | Click **Open fix change** on lodash. | A change opens that bumps the package to the fixed version; clicking it again opens the same change, not a second one. |
| WT-09 | Click **All dependencies →**. | Switches to the Dependencies tab. |
| WT-10 | Click **Pause scans**. | The button reads **Resume scans**; a reload keeps it; no scheduled scan runs while paused. |
| WT-11 | Click **Resume scans**. | Back to Pause scans; scheduled scans resume. |
| WT-12 | Open `cinder-agents`, a repo with no advisories. | "No open advisories." |

## Findings

| ID | Check | Expected |
|---|---|---|
| WT-29 | Look at the Findings card on `web-store`. | Source seg All / Dependencies / Secrets / Code with counts, a severity select, a search; a Secrets group with `artifacts_token`, a Code group, one group per vulnerable package; columns Severity, Finding, Fix, Age. |
| WT-30 | Pick Secrets, then a severity, then type in the search. | Only matching rows; the URL carries `source`, `fsev` and `q`; with nothing left, "No findings match these filters." |
| WT-31 | Click the code finding on `svc-orders-go` (`orders.go:37`). | The rail opens with rule, severity, `path:line` and remediation; the row is highlighted; the URL carries `?finding=`. |
| WT-32 | Click **Fix with an agent**. | A change opens for the finding; back on Watchtower its rail shows **Open fix change**. |
| WT-33 | On `web-store`, pick False positive and click **Dismiss** on its code finding; on the `artifacts_token` secret, click **Mark revoked — credential rotated**. | The row stays, tagged Dismissed; its rail shows the reason and **Reopen**. |
| WT-34 | Click **Reopen**. | The finding is open again with Fix with an agent and Dismiss. |
| WT-35 | Open `cinder-agents`, a repo with no findings. | "No findings yet. Scan again to check this repository." |

## Dependencies

| ID | Check | Expected |
|---|---|---|
| WT-13 | Open Dependencies. | A severity filter (All, Critical, High, Medium, Low, Clean), **Export SBOM**, and an inventory: Package, Version, Advisory, Severity, Fixed in, Auto-fix. |
| WT-14 | Click High. | Only high-severity rows; the URL carries `?sev=high`; reload keeps it. |
| WT-15 | On `svc-orders-go`, pick a severity with no rows (Critical). | "Nothing at this severity." |
| WT-16 | Turn a package's Auto-fix toggle on, then reload. | Still on. |
| WT-17 | Turn it off again, then reload. | Still off. |
| WT-36 | Scan a repo with a `package.json` and no lockfile, then open Dependencies. | The inventory lists the `package.json` dependencies. |
| WT-37 | Turn Auto-fix on for a package with an advisory that has a fixed version and no fix change yet (a finding from an earlier scan counts), then **Scan again**. | A fix change opens that bumps the package; Auto-fix changes open goes up by one. A second scan opens no other change. |
| WT-38 | Let that auto-fix change pass verify. | It waits for review (agent review, or a person when the branch rule asks) instead of joining the merge queue. |
| WT-18 | Click **Export SBOM** on `infra-cloudflare-tf`. | An SBOM file downloads; it lists the inventory's packages. |

## Network

| ID | Check | Expected |
|---|---|---|
| WT-19 | Open Network on `svc-orders-go`. | One card per agent version: a pill (clean or "n denied"), **Allowlist**, and two columns of host bars, Allowed and Denied (red). |
| WT-20 | Compare a denied host's bar with the Denied egress tile. | The tile's 24h total equals the sum of denied counts. |
| WT-21 | Click **Allowlist**. | Opens that agent's **Settings & prompt** tab, where its egress allowlist is edited. |
| WT-22 | Open Network on `cinder-agents`, a repo with no agent traffic. | "No agent egress". |
| WT-1392.1 | On an agent card, click **Deny** on an allowed host. | A dialog: "Deny <host> for <agent>?", "releases a new version: <agent>@v<N+1>", canary preselected with its share and "Stable stays on v<stable>". Cancel sends nothing. |
| WT-1392.2 | On `svc-orders-go`, click **Allow** on the denied `osv.dev`, pick **stable**, confirm. | "Released <agent>@v<N+1> to stable · <host> allowed"; the agent's Versions tab shows the new version on stable once the release lands; earlier versions keep their allowlist. |
| WT-1392.3 | Click **Allow** on a denied `169.254.169.254`. | The dialog warns that it is the cloud metadata address. |
| WT-1392.4 | Open the dialog with `GET /api/agents/<name>/versions` blocked. | "Couldn't load <agent>'s versions" and the release button is disabled. |
| WT-1899.1 | On the `cinder-agent@v0` card, click **Allow** on a denied host and confirm. | The dialog names each allowlist pool running the repo; after confirming, "<host> allowed on <pools>" shows and the pools' egress allowlists list the host. Allowed `@v0` hosts have no button. |
| WT-1899.2 | Look at a host name longer than its column at 1440 and 390 px. | It ends in an ellipsis and never overlaps the count bar; hovering shows the full name. |

## States

| ID | Check | Expected |
|---|---|---|
| WT-23 | Reload Overview throttled. | 4 tile bones, a severity-bar bone, 4 advisory-row bones. |
| WT-24 | Reload Dependencies throttled. | The filter and a disabled Export SBOM stay; 8 table bone rows. |
| WT-25 | Reload Network throttled. | 3 agent-card bones. |
| WT-26 | Block `GET …/watchtower` and reload. | "Couldn't load Watchtower" with Retry. |

## Planned

- Judging code against known vulnerabilities through the vulnerability index.
- Scans on the managed pool; today they need a bring-your-own scan runner.

## Retired

None.
