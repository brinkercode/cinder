# Repositories

## Purpose

The account's repositories and its monthly agent-token budget.

## Where

Code ▸ All repositories (`/`).

## What you can do

- The list holds the repositories you can read: owners and every-repo roles see all, someone with roles on selected repositories sees only those.
- **Search repositories** filters by name and description. **Show all** or **Archived** picks the list; sort by **Last pushed** or **Name**. **Refresh** reloads the list.
- Each repository card links to its Code page and shows its default branch, language, open changes, verifier pass rate and agents. Its **⋯** menu has **Open**, **Settings** and **Archive**.
- **Archive** asks you to confirm, then archives the repository: pushes are refused until it is unarchived. Archived repositories leave **Show all** and appear under **Archived**, each with **Unarchive** and, for owners, **Delete…**. A failed archive shows its error on the card.
- **New repository** opens a panel under the page head: **Name** (2 to 63 lowercase letters, digits or hyphens), **Default branch** (`main` if left empty), **Strategy**, **Import from (optional)** (an `https:` git URL; any other scheme is refused) and **Token (optional)**, kept encrypted in Keystore for re-imports. **Create repository** creates it, or imports it when a URL is given; the list refreshes while the import runs. **Cancel** closes the panel. With no repositories the list shows **No repositories yet** with the same button.
- The **Usage** aside:
  - **Token budget**: this month's agent-token spend as a ring and a total, with the reset date; the arrow opens Insights. **Set budget** (owners) sets the account's monthly token budget; for anyone else it is disabled.
  - **Add budget alert** (owners; disabled for anyone else) opens a dialog: pick a threshold from 10 to 100% with the slider and click **Add alert**. Alerts cover the whole account and raise a **Budget alert** in [Needs you](needs-you.md); the card lists every alert set.
  - Tiles for the account's **Changes merged**, **Verifier runs**, **Lease conflicts** and **Calibration**.
  - **Account details**: the account name, its ID (**Copy account ID**) and its Git host (**Edit Git host**). **Verifier owns every merge** is always on.
  - **Budget settings**: **When agents reach it** (owners save it): **Pause agents** (the default) or **Alert only**, where agents keep running past the budget and only the alerts fire. It names the owners who can raise the budget, with a link to Access & people.
- With **Pause agents**, the budget stops agents: once this UTC month's model spend reported by runners reaches it, no develop, resolve, review or merge job starts (repair rounds included) until the budget is raised or the month resets. Verify, scan and flow jobs keep running. A **Budget reached** item in [Needs you](needs-you.md) raises the budget and resumes.

## Backed by

D1 (the account row, `budget_policy` for the when-reached choice, `usage_logs` for this month's spend, the same total that pauses agents) and Artifacts for each repo's git storage. Cloudflare map for this page: [ARCHITECTURE-CLOUDFLARE.md §2](../ARCHITECTURE-CLOUDFLARE.md#2-page-by-page-map).

## Planned

- Budget alerts by email to owners.
