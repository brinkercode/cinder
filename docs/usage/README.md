# Using cinder

One page per screen. Sign in first ([README](../../README.md#access)). Repo pages sit under Code ▸ *repo* in the sidebar (Code, Changes, Watchtower, Insights, Settings, then All repositories) and follow the target branch picked in the top bar. Above them a context card holds a repo row (opens the repo menu) and a branch row (opens the target-branch menu; **B** opens it); a long branch name keeps its start and its end with an ellipsis between. Releases is marked as Code, and Wiki is its own item after the Code group. Sidebar items show no background on hover or when current: only the icon and its arrow turn from grey to white (to the sidebar's ink in the light theme); keyboard focus shows the focus ring.

| Page | Sidebar | Purpose |
|---|---|---|
| [Repositories](repositories.md) | Code ▸ All repositories | The account's repositories and its monthly agent-token budget. |
| [Code](code.md) | Code ▸ *repo* ▸ Code | Browse, edit and commit the files of a repo on the target branch, or on a change's workspace; its tags and releases open from **Releases** in the toolbar. |
| [Changes](changes.md) | Code ▸ *repo* ▸ Changes | Every intent and change on the repo, from draft to merge, on one board that also holds the repo's issues. The verifier owns the merge. |
| [Collisions](collisions.md) | Code ▸ *repo* ▸ Changes ▸ **Collisions** | Pairs of changes predicted to collide, their leases, and resolving the collisions that happened. |
| [Watchtower](watchtower.md) | Code ▸ *repo* ▸ Watchtower | Dependency and egress security for the repo. |
| [Insights](insights.md) | Code ▸ *repo* ▸ Insights | Outcome and usage metrics for the repo. |
| [Flows](flows.md) | Automation ▸ Flows | The repo's pipelines: a DAG of steps saved as `.cinder/flows/<name>.yml`, and their runs. |
| [Flow run](flows.md#what-you-can-do) | Automation ▸ Flows ▸ a run card (`/:repo/flows/runs/:id`) | One run's stage graph, jobs, logs, tests and artifacts. |
| [Designer](flows.md#what-you-can-do) | Automation ▸ Flows ▸ **Designer** tab (`/:repo/flows?view=designer`) | Edit a flow as a graph or YAML and save it as a change. |
| [Repo settings](repo-settings.md) | Code ▸ *repo* ▸ Settings | One repo's description, default branch, merge rules, roles, webhooks, re-import, archive and deletion. |
| [Environments](environments.md) | Automation ▸ Environments | Where the repo is deployed, what version is live, and drift from `.cinder.yml`. |
| [Wiki](wiki.md) | Git ▸ Wiki, after Code | Written docs for the organization, a folder per repository, with page history. |
| [Agents](agents.md) | Automation ▸ Agents | The versioned agents that write changes. |
| [Marketplace](marketplace.md) | Automation ▸ Marketplace | Agents to install into an account, and publishing your own. |
| [Judges & calibration](judges.md) | Automation ▸ Judges & calibration | Who scores changes before the verifier merges, and how well their probabilities match outcomes. |
| [Workers](workers.md) | Automation ▸ Workers | The runner pools that run jobs: the managed Cloudflare pool and bring-your-own pools. |
| [Needs you](needs-you.md) | Git ▸ Needs you | The inbox of decisions the verifier and judges can't make alone. Everything else merges without you. |
| [Access & people](access.md) | Settings ▸ Access & people | Who can use cinder and with which role. Sign-in itself is Cloudflare Access; roles are cinder's. |
| [Keystore](keystore.md) | Settings ▸ Keystore | Every secret cinder uses, by scope. Values are never shown after they are saved. |
| [My model access](model-access.md) | User menu (avatar) ▸ My model access | Your own model credentials and usage. |

## Loading

The sidebar and top bar draw at once, and the repository list fills in when it arrives; a page outside a repository draws its placeholders without waiting for it. While a section loads, it draws placeholders in the shape it had the last time you saw it in this browser: the same number of rows, cards or board cards, and the same table column widths. A section that was empty last time shows its empty state at once. On a first visit, or when the browser blocks storage, sections draw a default count. The shape is kept in this browser's localStorage under `shape:` keys and holds counts and widths only, never data.

## Account popover

Click the account name in the sidebar header for your accounts: your organization's name, then its accounts, each with your Git role there, "via organization" when your access comes through the organization, and its repo count; then "Outside an organization" with the account you hold outside it. The active account has a check. Clicking another account makes it active at once (an HttpOnly `cinder_account` cookie) and reloads the page's data, so All repositories lists only that account's repos; if the switch fails, the previous account comes back and a toast says so. **Members** and **Account settings** open Settings ▸ Access & people. Backed by D1 (`accounts`, `organizations`, `account_members`, `repo_accounts`).

## User menu

The avatar at the far right of the top bar shows your initial. Click it for:

- Your name and the email you signed in with. Cloudflare Access gives cinder only the email, so the name is the part before the `@`.
- **My model access** (tagged `new`): opens `/me/models`.
- **Toggle theme**: swaps light and dark, like the top-bar toggle.
- **Access & people**: opens `/settings/access`.
- **Sign out**: signs you out of Cloudflare Access (`/cdn-cgi/access/logout`).

Backed by `GET /api/me`, which reads the Access identity ([architecture](../ARCHITECTURE-CLOUDFLARE.md)).
