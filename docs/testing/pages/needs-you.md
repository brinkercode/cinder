# Needs you

- **Route:** `/needs`
- **Sidebar:** Needs you (with its count), and the bell in the top bar
- **Backed by:** D1 and the ChangeDO Durable Object ([map](../../ARCHITECTURE-CLOUDFLARE.md#2-page-by-page-map))

**Setup:** the seed raises no items. Start a flow run that reaches an approval gate and promote a release to an environment without auto-sync, so the inbox holds a Flow approval and a Release approval.

| ID | Check | Expected |
|---|---|---|
| NEED-01 | Open `/needs`. | Title "Needs you" with View docs and a description, no primary action; one card per item. |
| NEED-02 | Look at each kind. | A severity icon (warning for Judges disagree, danger for Critical advisory, info for the rest), the kind, a repo tag, the 8-character change id (full id on hover) and the text. |
| NEED-03 | Look at a card's footer. | The item's action buttons (the first primary) and **Dismiss** on the right. |
| NEED-04 | Compare the sidebar count, the bell dot and the number of cards. | The sidebar count equals the cards; the bell has a dot while any remain. |
| NEED-15 | Click **Open change** on an item. | Change detail opens for its change; back on `/needs` the item is still there. |
| NEED-07 | Click **Dismiss** on an item. | The card disappears; a reload confirms it's gone. |
| NEED-08 | Resolve an item in another tab. | This tab's sidebar count updates without a reload. |
| NEED-09 | Make an action fail (block `POST /api/needs/*`). | The reason shows on that card; the card stays. |
| NEED-10 | On a Flow approval item, click **Approve**. | The flow's gate passes and its next step runs. |
| NEED-22 | Promote a release to an environment without auto-sync, then click **Approve** on its Release approval item. | The card disappears and the environment's deploy of the release starts; **Reject** instead resolves it with no deploy. |
| NEED-23 | As the owner, take over a change another person drives. | A Lease takeover item for that change offers **Grant to <that person>**; releasing the change removes it. |
| NEED-24 | Scan a repo whose lockfile pins a dependency with a critical advisory. | A Critical advisory item names the package, version and advisory; after a scan without it, the item is gone. |
| NEED-25 | Look at an item about a change an agent wrote. | The card names that agent@version next to the change id. |
| NEED-26 | On an Untrusted judge item for a verified change, click **Approve change**. | The card disappears; the change's detail rail shows "In merge queue" and no agent review runs. |
| NEED-27 | On a Judges disagree item for a change routed to agent review, click **Merge**. | The reason shows on the card and the card stays; the change records no approval. |
| NEED-1334.1 | As a viewer, edit a wiki page; as another person, comment on it. | The editor sees a Wiki comment item naming the commenter and the comment, with **Open page** and **Resolve**; the commenter doesn't see it. **Open page** opens the page. |
| NEED-1334.2 | Merge a change to a symbol a wiki page names. | One Stale wiki page item for that page and change; **Mark reviewed** removes it and the page's stale flag; **Hand to agent** instead opens a change "Update wiki page <title>". |
| NEED-1334.3 | Set an 80% budget alert and let this month's spend pass it. | One Budget alert item (repo tag `account`) with a neutral bell icon; **Open Insights** opens Insights; more spend this month raises no second item. |
| NEED-1400.1 | With a Budget reached item open, look at it as an owner. | The paused agents as pills; "Raise to [n] M tokens" defaulting to one million above spent; **Raise budget** enabled; **Resume** disabled. |
| NEED-1400.2 | Enter an amount above spent and click **Raise budget**, then **Resume**. | The item stays with **Resume** enabled; **Resume** resolves it and agent jobs claim again. |
| NEED-1400.3 | Open the same item as a non-owner. | The field, **Raise budget** and **Resume** are disabled, with "Only owners can raise the budget: &lt;owners&gt;" and **Ask &lt;owner&gt;**. |
| NEED-1351.1 | Set a token budget below this month's model spend and wait for the next cron tick. | One Budget reached item (repo tag `account`) with **Raise budget** and **Resume**; no develop job is claimed while it is open, verify jobs still are. **Resume** refuses with "over_budget" until the budget is raised above spend; then it resolves the item and agent jobs claim again. |
| NEED-1399.1 | On a Budget alert item, click **Raise budget**, then **Open Insights**, then **Edit alerts**. | Raise budget and Edit alerts open Repositories (the Token budget card); Open Insights opens Insights; the item stays. |
| NEED-1399.2 | On a Wiki comment item, type a reply and press Enter (or click **Reply**). | "Replied “…”" shows on the card and the reply is the newest comment on the wiki page; the item stays until **Resolve**. An empty reply shows "Write a reply first". |
| NEED-1399.3 | On a Stale wiki page item, click **Edit**; back on `/needs`, open **Hand to an agent** and pick an agent. | Edit opens the page in the editor; the picker lists each agent at its stable version, the pick opens "Update wiki page <title>" for that agent and the item resolves. |
| NEED-1662.1 | On a Judges disagree item, click **Reject**. | The card disappears; the change is closed. |
| NEED-1662.2 | On a Critical advisory item, click **Watchtower**. | The repo's Watchtower opens; back on `/needs` the item is still there. |
| NEED-28 | On a Critical advisory item whose finding already has an open fix change, click **Open fix change**. | The card resolves and names that fix change; no second change opens. |
| NEED-11 | Reload throttled. | Skeleton cards, as many as last time (3 on a first visit). |
| NEED-12 | Resolve every item. | "Nothing needs you"; the sidebar count and the bell dot are gone. |
| NEED-13 | Block `GET /api/needs` and reload. | "Couldn't load Needs you" with Retry. |
| NEED-1348.1 | On a Test quarantined item, click **Release**. | The item resolves; `GET /api/repos/<repo>/quarantine` no longer lists the test. |
| NEED-1361.1 | Push a change the guard quarantines (e.g. a secret-like line). | One Change quarantined item with **Release** and **Keep**; **Release** resolves it and the change's merge blockers no longer list `guard_quarantined`. |
| NEED-1361.2 | Push a change that adds two new packages. | One Dependency needs approval item naming both with their versions; **Approve** resolves it and the `dependency_unapproved` blockers are gone; on a fresh item **Reject** sends the change to Changes requested. |
| NEED-1361.3 | Close a change with open Change quarantined and Dependency needs approval items. | Both items disappear. |
| NEED-1426.1 | Open a Dependency needs approval item. | Its text starts with the change's "Blocked: new dependency … needs approval" line; it has **Approve**, **Reject**, **Open change** and a **Reason** field. Type a reason and click **Reject**: the change's timeline shows "Dependency rejected: <reason>". |
| NEED-1426.2 | Open a Test quarantined item. | **Release** and **Keep**, with "Release: it counts in the verdict again. Keep: it stays out of verdicts." |
| NEED-1360.1 | Gate an environment with `approvers: production owners`; promote a release to it; sign in as a developer without that role and click Approve, then Dismiss, on the Release approval. | Each shows "not_an_approver" on the card and the item stays; signed in as a holder of the role, Approve starts the deploy. |
| NEED-1423.1 | As NEED-1360.1, sign in as the developer and open Needs you. | The Release approval's **Approve** and **Reject** are disabled and it reads "Only production owners can approve:" with the role holders' names; as a holder of the role both are enabled and the note is gone. |
| NEED-1866.1 | With items of several kinds open, look at the tabs above the list. | **All** first, then one tab per kind group with items (Approvals, Judges, Security, Budget, Wiki, Leases), each with its count; All's count equals the sidebar count. Clicking a tab shows only its kinds' cards, unchanged. |
| NEED-1866.2 | Select **Judges**, then reload. | The URL has `?tab=judges`; after the reload Judges is still selected and only its cards show. Resolve the tab's last item: the tab stays selected with count 0 and "Nothing here". |
| NEED-2104.1 | Close a change that has a Judges disagree item, then reload Needs you. | The item is gone. |
| NEED-2104.2 | Send a verifying change with a Judges disagree item back to needs_fix, then reload. | No Merge/Reject item for that change shows. |
| NEED-14 | Delay `/api/**` 3s; from `/wiki`, click Needs you. | The title, description and skeleton cards show at once ("Loading Needs you" status, `aria-busy`); the Wiki list doesn't stay on screen. |

## Planned

- None.

## Retired

- NEED-05 (Open change resolved the item): replaced by NEED-15.
- NEED-06 (any action only removed the card): replaced by NEED-16 to NEED-20.
- NEED-16 to NEED-21 (actions on seeded Judges disagree, Untrusted judge, Lease takeover and Critical advisory items): replaced by NEED-23, NEED-24, NEED-26 to NEED-28, NEED-1662.1 and NEED-1662.2.
