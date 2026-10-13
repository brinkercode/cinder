# Needs you

## Purpose

The inbox of decisions the verifier and judges can't make alone. Everything else merges without you.

## Where

Git ▸ Needs you (`/needs`), and the bell in the top bar

## What you can do

- Tabs across the top filter the items by kind, each with its count: **All**, then **Approvals** (Flow approval, Release approval), **Judges** (Judges disagree, Untrusted judge), **Security** (Critical advisory, Change quarantined, Dependency needs approval, Test quarantined), **Budget** (Budget alert, Budget reached), **Wiki** (Wiki comment, Stale wiki page) and **Leases** (Lease takeover). A kind's tab shows only while it has items, or while it is selected; a selected tab with no items shows "Nothing here". The selected tab is kept in the URL (`?tab=`), so a reload or a shared link opens it; an unknown `?tab=` opens All. Left and Right arrow keys move between tabs.
- Any item about a change clears when the change closes or merges.
- Each item shows its kind (Judges disagree, Lease takeover, Untrusted judge, Critical advisory, Flow approval, Release approval, Wiki comment, Stale wiki page, Test quarantined, Change quarantined, Dependency needs approval, Budget alert, Budget reached), repo (`account` for a Budget alert or Budget reached), change, the agent@version that wrote the change (when an agent did) and text.
- Items are only what cinder raised; nothing else adds one. cinder raises them from what happens, and resolves them by itself once the condition is gone:
  - **Judges disagree:** one judge's latest risk judgment on a change calls it risky and another's calls it safe; cleared when they agree again. Shown only while the change is verifying.
  - **Lease takeover:** a person takes over a change another person was driving; the item offers the lease back to that person. Cleared when the change is taken over again or released.
  - **Untrusted judge:** the risk judge has too few outcomes to be trusted and no reviewer agent is released to review the change in its place; cleared when the change is routed again to an agent or by a trusted judge.
  - **Critical advisory:** a scan finds a dependency with a critical advisory; cleared when a fully checked scan no longer reports it.
  - **Wiki comment:** someone comments on a wiki page; only the page's last editor sees it, and not for their own comment.
  - **Stale wiki page:** a merged change touches code a wiki page names; one item per page per merge.
  - **Test quarantined:** a verify report quarantined a failing test over the repo's flake threshold (Repo settings ▸ Flaky checks); once per test.
  - **Change quarantined:** the guard quarantines a push to a change; each guard run raises its own item and clears the change's earlier one. Cleared when the change closes or merges.
  - **Dependency needs approval:** the guard finds dependencies the change adds that no owner has approved yet; one item per change names each package and version. Cleared the same way.
  - A Change quarantined or Dependency needs approval item's text starts with the change's why-line ("Blocked: new dependency p-retry 6.2.1 needs approval"), the same text its board card and Merge readiness show.
  - **Budget alert:** this month's token spend reaches one of the account's alert thresholds; once per threshold per month.
  - **Budget reached:** this month's model spend reaches the account's token budget; agent jobs stop starting until spend is below the budget again ([Repositories](repositories.md)). One item per budget per month.
- Decide with the item's own buttons. Each runs the real operation and resolves the item only when it succeeds; a failure shows the reason on the card and the item stays:
  - **Approve** passes the flow's gate or starts the release's deploy.
  - Only the gate's approvers resolve a Flow approval or Release approval, with any button including **Dismiss**: owners, and people holding the role the flow step's `approval:` or the environment's `approvers:` names. An environment without `approvers:` takes anyone who may promote to it. Anyone else gets "not_an_approver" and the item stays open. `GET /api/needs` gives these items `approvers` (the role, or null), `approver_names` (the people who are one) and `can_resolve` (whether you are one). When you aren't one, **Approve** and **Reject** are disabled and the item reads "Only <role> can approve: <names>".
  - **Mark reviewed** clears the page's stale flag; **Hand to an agent** picks an agent (each at its stable version) and opens a change "Update wiki page <title>" for it; **Resolve** resolves a wiki comment.
  - **Reply** (Wiki comment) posts your reply as a comment on the wiki page; the card shows it and the item stays open.
  - **Approve change** (Untrusted judge) approves a change the untrusted risk judge routed to a person: the change joins the merge queue at once when verified (even with auto-queue off, as **Add to merge queue** does), or when its running verify passes.
  - **Open fix change** (Critical advisory) opens the fix change for the package's open critical finding, the one already open when there is one, and the item shows it.
  - **Release** (Test quarantined) takes the test out of quarantine, so its failures fail verify again; **Keep** leaves it quarantined. The item says what each does.
  - **Release** (Change quarantined) clears the quarantine so the change can verify and merge; **Keep** leaves it quarantined.
  - **Approve** (Dependency needs approval) approves the change's dependencies so they no longer block its merge; **Reject** requests changes on the change with the **Reason** you type (else the item's text); **Open change** opens the change.
  - **Budget reached** lists the paused agents, a "Raise to __ M tokens" field (at least one million above what's spent), **Raise budget** and **Resume**. **Raise budget** (owners and others with org.manage) sets the token budget to the field's amount; the item stays open. **Resume** is enabled once the budget is above what's spent and resolves the item; the server refuses it while spend is still at or over the budget. A person who isn't an owner sees the field and both buttons disabled, with "Only owners can raise the budget: <owners>" and **Ask <owner>** (an email to the first owner).
  - **Merge** (Judges disagree) approves the change and adds it to the merge queue together; when it can't queue, nothing is recorded and the item stays.
- **Open change** opens Change detail, **Watchtower** the repo's Watchtower, **Open page** the wiki page, **Edit** (Stale wiki page) the page's editor, **Open Insights** Insights, and **Raise budget** and **Edit alerts** (Budget alert) the Token budget card on [Repositories](repositories.md); none resolves the item.
- A kind the page has no card style for shows with a neutral bell icon.
- **Dismiss** resolves the item without acting.
- The sidebar count and the bell dot update as items resolve, including in this browser's other open tabs.
- While the inbox loads, skeleton cards show under the title, on a direct load and on navigation.

## Backed by

D1 and the ChangeDO Durable Object.

Cloudflare map for this page: [ARCHITECTURE-CLOUDFLARE.md §2](../ARCHITECTURE-CLOUDFLARE.md#2-page-by-page-map).

## Planned

- Nothing yet.
