# Watchtower

## Purpose

Dependency, secret, code and egress security for the repo.

## Where

Code ▸ *repo* ▸ Watchtower (`/:repo/watchtower`)

## What you can do

- On a repository with no code: an empty state with **Quick setup** (opens Code) instead of the page's data.
- Tabs **Overview**, **Dependencies** and **Network**; **Scan again** shows when the last scan ran. While a scan is queued or running the button reads "Scanning…" and is disabled, and the header refreshes on its own when the scan finishes; a queued scan with no scan worker online shows "Waiting for a scan worker".
- Overview: tiles (Open advisories counts each advisory; Auto-fix changes open counts open changes auto-fix opened), open advisories by severity, top advisories (one row per advisory) with **Open fix change** (a finding whose fix change is still open opens that change, never a second one), and **Pause scans** / **Resume scans**.
- Overview, **Findings**: secret, code and dependency findings grouped (Secrets, Code, one group per package) with Severity, Finding, Fix and Age. Filter by source (each with its count), by severity, or by text; groups past 5 rows show "Show N more…". Dismissed findings are listed with a tag; fixed ones are not. A scan marks a secret, dependency or code finding fixed when it no longer reports it; a code finding from an uploaded SARIF log stays open, since it came from another tool.
- Click a finding to open its detail rail (`?finding=<id>`): rule, severity, location (`path:line`), what to do about it, and **Fix with an agent** (opens a change; **Open fix change** once one exists), **Dismiss** with a reason, **Mark revoked — credential rotated** for secrets, and **Reopen** for a dismissed finding.
- A finding on a file whose change was judged to resemble a known vulnerability, seen at that change's head, belongs to that judgment: while open it blocks merging the change, and dismissing it as **False positive** records "no" as the judgment's outcome.
- Dependencies: the inventory (from lockfiles, or from `package.json` when the repo has no lockfile) with an **Auto-fix** toggle per package, and **Export SBOM**.
- Auto-fix: when a scan finds an advisory on a package with Auto-fix on and a fixed version, cinder opens a change that bumps the package to that version, including an advisory an earlier scan already found, unless the finding already has a fix change. A later scan of the same finding opens no second change.
- Every fix change, from auto-fix, **Open fix change** or **Fix with an agent**, goes through review before it merges: at least an agent review, or a person's approval when the branch rule routes it to one or no reviewer agent has a released version. A passing verify alone never queues it.
- Network: egress per agent version, allowed and denied hosts, and **Allowlist** to edit the agent's egress.
- Network, **Deny** on an allowed host and **Allow** on a denied one: a confirm dialog says this releases a new version, `name@vN`, a copy of the chosen channel's version with the host removed from or added to its allowlist. Pick the channel: **canary** (at its share of changes; stable stays on its version until you promote) or **stable**. A channel the agent has no version on is disabled. Allowing a `169.254.*` host warns that 169.254.169.254 is the cloud metadata address. Confirming queues the release and shows "Released name@vN to channel"; no released version is edited.
- Network, **Allow** on a denied host of the runner's default agent (`@v0`): a confirm dialog lists the pools with an allowlist that run this repo; confirming adds the host to each one's egress allowlist (a pool with an empty list keeps the default hosts) and shows "<host> allowed on <pools>". Allowed hosts of `@v0` show no button. With no such pool the dialog says so and Allow is disabled.
- Network: a long host name ends in an ellipsis inside its column, clear of the count; hover shows the full name.

## Backed by

D1 (scans, findings, egress verdicts), cron for the daily scan, scan jobs on a runner, and OSV for advisories.

Cloudflare map for this page: [ARCHITECTURE-CLOUDFLARE.md §2](../ARCHITECTURE-CLOUDFLARE.md#2-page-by-page-map).

## Planned

- Vectorize-backed "resembles a vulnerability" judging.
- Scans on the managed pool; today they need a BYO `cinder-verify` runner.
