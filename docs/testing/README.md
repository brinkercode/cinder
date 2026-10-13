# Manual test checklists

One checklist per page of the live site, for hands-on functional testing. Each check is one behaviour a person can see. The lists follow the approved specs, so a check can fail because the page doesn't match its spec yet; those are called out as **known gaps** on each page.

## Run a manual pass

1. **Open the live site.** The URL is the one `make up` prints when it deploys (see [README › Deploy](../../README.md#deploy)). Releases deploy to the same URL.
2. **Sign in through Cloudflare Access** with an email one-time code. Only emails in the Access owners policy can sign in ([README › Access](../../README.md#access)).
3. **Use the seeded data.** Each release runs `node seed/seed.mjs --full` against the live Worker before it finishes, so every page has real repos, changes, runs and settings to test against. The seed is idempotent; re-run it by hand to restore a page you changed (see [seed/README.md](../../seed/README.md) for which repo backs which page). Each checklist's **Setup** line names the repo or data to use.
4. **Work through a page top to bottom.** Do each row's steps, compare with **Expected**, and note any row that doesn't match. Skip the **Planned** section: those features aren't live.
5. **Run the cross-cutting list once per pass** ([cross-cutting.md](pages/cross-cutting.md)): widths, loading, theme, keyboard and console.

Permission checks need a second person with a lower role. Invite one under Settings › Access & people as Contributor, add their email to the Access owners policy, and sign in as them in a private window.

## Checklist format

Every page file starts with a header:

- **Route:** the URL pattern.
- **Sidebar:** how to reach it.
- **Backed by:** the Cloudflare resource behind the page, linked to [ARCHITECTURE-CLOUDFLARE.md](../ARCHITECTURE-CLOUDFLARE.md#2-page-by-page-map).
- **Setup:** the seeded repo or data to use.

Then the checks, as a table:

| ID | Check | Expected |
|---|---|---|
| CODE-07 | Short imperative steps. | The observable result, including that it persists after a reload where relevant. |

- **IDs** are a page prefix plus a number. They're stable: a removed check's ID is retired (listed under **Retired** at the bottom of its page) and never reused. New checks take the next free number.
- **One behaviour per row.**
- **Known gaps:** checks written to the spec where the page doesn't match it yet. A gap check is expected to fail; report it anyway so it's tracked.
- **Planned:** features that aren't live. They have no IDs; don't test them.

## Report a failure

File an issue for each failed check:

```
CODE-07 failed
What happened: Commit to main left the editor open; the file's history didn't show the new commit.
Where: https://<live url>/infra-cloudflare-tf/code/main/main.tf?v=edit
Screenshot: attached
```

- The **check ID**.
- **What happened**, against the Expected column.
- A **screenshot** or the **page URL** (both when you can).

## Keeping the lists current

When a page's behaviour, controls or states change, the same change updates its checklist: add a row for a new control, change a row whose behaviour changed, and retire the ID of a removed one. See [CONTRIBUTING.md](../../CONTRIBUTING.md#rules-every-change-follows).

## Pages

| Checklist | Route | Covers |
|---|---|---|
| [Shell](pages/shell.md) | every page | Sidebar, top bar, repo picker, branch dropdown, Branches modal, user menu, quick search |
| [Cross-cutting](pages/cross-cutting.md) | every page | Widths, loading and shape, theme, keyboard, console |
| [Repositories](pages/repositories.md) | `/` | Repository list, usage aside, repo overview |
| [Code](pages/code.md) | `/:repo/code/:ref/*` | Files, viewer, editor, commits, staging |
| [Changes board](pages/changes-board.md) | `/:repo/changes` | Board, list, tiles, new change |
| [Collisions](pages/collisions.md) | `/:repo/changes/collisions` | Pairs at risk, leases by file, resolve with preview |
| [Change detail](pages/change-detail.md) | `/:repo/changes/:id` | Review, takeover, files, checks, merge readiness |
| [Releases](pages/releases.md) | `/:repo/releases` | Tags, drafts, publish, promote |
| [Watchtower](pages/watchtower.md) | `/:repo/watchtower` | Overview, Dependencies, Network |
| [Insights](pages/insights.md) | `/:repo/insights` | Overview and Usage lenses |
| [Flows](pages/flows.md) | `/:repo/flows` | Runs, designer |
| [Environments](pages/environments.md) | `/:repo/environments` | Environment cards, services, promote |
| [Wiki](pages/wiki.md) | `/wiki`, `/wiki/:repo/:id?` | Folders, pages, edit, history, comments |
| [Needs you](pages/needs-you.md) | `/needs` | Inbox items and counts |
| [Agents](pages/agents.md) | `/automation/agents[/:name]` | Index, fleet, wizard, detail tabs |
| [Judges & calibration](pages/judges.md) | `/automation/judges` | Judge cards and health |
| [Workers](pages/workers.md) | `/automation/workers` | Managed and bring-your-own pools |
| [Access & people](pages/access.md) | `/settings/access` | Group mappings, people, invite |
| [Keystore](pages/keystore.md) | `/settings/keystore` | Secrets, org keys, runner tokens |
| [My model access](pages/model-access.md) | `/me/models` | Credential sources, providers, usage |
| [Repo settings](pages/repo-settings.md) | `/:repo/settings` | General, branch policy, access, integrations, danger zone |
