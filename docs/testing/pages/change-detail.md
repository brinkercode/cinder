# Change detail

- **Route:** `/:repo/changes/:id/:tab?`
- **Sidebar:** Code ▸ *repo picker* ▸ Changes, then a card
- **Backed by:** the ChangeDO Durable Object (change, events, messages); D1 (card, checks); the `cinder-pipeline` Workflow and CI container for checks ([map](../../ARCHITECTURE-CLOUDFLARE.md#2-page-by-page-map))

**Setup:** in `svc-orders-go`, the change "Return 404 for an unknown order instead of an empty order" (awaiting approval), its merged change and its blocked one. For write checks, launch a throwaway change from New change first.

## Header

| ID | Check | Expected |
|---|---|---|
| CHD-01 | Open the awaiting-approval change. | "‹ Changes · n of m open" (failed changes count as open), the title, the change key in mono (PULSE-12; the 8-character id for a change without a key) and a copy button that copies the full id, then the state pill, author chip, "wants to merge &lt;key&gt; → &lt;target&gt;", the commit count from the Commits tab ("1 commit", "2 commits") and updated time. |
| CHD-2111.1 | Open `/svc-orders-go/changes/<KEY>` (the change's key, e.g. `SVCORDERSGO-3`), then the same change by its id. | Both open the change; its links, tabs and the board's card all use the key. A key with no change in that repo shows the not-found state. |
| CHD-2111.2 | Merge a change, then open the target branch's latest commit. | Its subject is `<KEY>: <title>` and its `Cinder-Change` trailer is the change's id. |
| CHD-55 | Open a change just made with **Hand to agent**, then one made with **Open change**. | The first shows its intent and the picked agent@version with the robot icon as author, and no lease strip; the second shows its intent and "&lt;you&gt; holds the lease", with Lease held by you. |
| CHD-02 | Click **‹ Changes**. | Back to the board. |
| CHD-03 | On an agent's change, click **Take over**. | The agent pauses; a lease strip says you hold the lease with **Edit in Code**; the button becomes **Hand back to &lt;agent&gt;**; a reload keeps it. |
| CHD-04 | Click **Edit in Code** on the lease strip. | Code opens on the change's workspace with editing on. |
| CHD-05 | Click **Hand back to &lt;agent&gt;**. | The strip goes; the agent resumes; the button reads Take over again. |
| CHD-06 | On a change written by a person, look at the action. | **Hand to an agent**; clicking it assigns an agent. |

## Review

| ID | Check | Expected |
|---|---|---|
| CHD-07 | Click **Review ⌄**. | A popover: an optional comment, Comment / Approve / Request changes with a line each, and **Submit review**. |
| CHD-08 | Submit **Approve** on the awaiting-approval change. | Human approval turns green in Merge readiness; you appear as Approved under Reviewers; a review card joins the timeline; no reload needed. |
| CHD-53 | Submit **Approve** on a verifying change not routed to a person and with no requested reviewers. | Human approval reads "Human approval given"; you appear as Approved under Reviewers; the state doesn't change and the change isn't queued. |
| CHD-59 | On a verified change with Auto-queue on and you as its only requested reviewer, submit **Approve**. | Before: it stays Verifying. After: it moves to the merge queue. |
| CHD-09 | Submit **Request changes** with a comment. | The state pill reads Changes requested; readiness shows it with your reason; the card moves to Changes requested on the board. |
| CHD-10 | Submit **Comment** with text. | A comment card joins the timeline; the state doesn't change; the popover closes and reopens empty with Comment selected. |
| CHD-11 | Reload after each review. | The reviews, reviewer statuses and state are all still there. |

## Conversation

| ID | Check | Expected |
|---|---|---|
| CHD-12 | Open the Conversation tab. | The intent card (intent and the files the diff touches), the deploy plan, then timeline events (push, verifier, judge) and reviews in time order. |
| CHD-1241.1 | At 1920px, look at the intent card's text. | The intent and files lines stop at 760px wide, starting on the frame's left edge; the timeline below keeps the full width. |
| CHD-14 | Type a comment and click **Comment**. | It appears in the timeline and stays after a reload. |
| CHD-15 | Write `@<agent>` in a comment. | The agent is steered (its next event answers it). |
| CHD-16 | On a throwaway change, click **Close change**. | The change closes; it leaves the board's open columns; the page turns read-only. |
| CHD-17 | Look at a change with a deploy plan that drops a resource. | A "destructive" tag on the dropping step and an alert line above. |
| CHD-1645.1 | Look at a change whose deploy files can't be read at the target branch or the head. | The Deploy plan card reads "Routed to human: deploy plan could not be read: the deploy files at the target branch or the change head are unavailable", with no raw storage error. |

## Files changed

| ID | Check | Expected |
|---|---|---|
| CHD-18 | Open Files changed on a change with commits: one opened from a branch, one from Submit or Propose change in Code, one from a push and one an agent wrote. | A 220px sticky file list and one card per file its commits change against the target: fold, path, +/−, Viewed. The tab shows the file count; the row's right side shows the +/− total. |
| CHD-19 | Click a file in the list. | The page scrolls to that file's card. |
| CHD-20 | Click a file's fold button, then reload. | The file stays folded. |
| CHD-21 | Tick **Viewed** on a file, then reload. | Still ticked; the file list shows a ✓. |
| CHD-22 | Click a line number. | A comment box opens under the line. |
| CHD-23 | Type a comment and click **Comment**. | The comment shows under the line; still there after a reload. |
| CHD-24 | Open a line comment and click **Cancel**. | The box goes; nothing saved. |
| CHD-25 | Look at the diff rows. | Old and new line numbers, green tint on additions, red on deletions. |

## Commits and checks

| ID | Check | Expected |
|---|---|---|
| CHD-26 | Open Commits. | A compact table of the change's commits not on its target: short sha, subject, author. The count matches the header's "n commits". |
| CHD-27 | Open Checks. | One row per check on the head (pipeline, verify, guard, SARIF): a status icon, name, kind, duration when known, "View log ↗" when the check has a log. |
| CHD-28 | Click a check row. | It expands in place with its status and the sha it ran on. |
| CHD-30 | Use a repo secret in a check's command, then read the check's log. | The secret value is masked in the log. |
| CHD-1397.1 | Open Checks on a change whose head has a quarantined test failing. | A `quarantined` row with flake %, since and "excluded from the verdict", and **Manage** (opens Repo settings at Flaky checks); the Verifier row doesn't count it as failed. |
| CHD-31 | Look at the tab bar, then switch through every tab. | Each tab shows its count (Conversation, Files changed, Commits, Checks); exactly one pane shows at a time. |

## Merge readiness rail

| ID | Check | Expected |
|---|---|---|
| CHD-32 | Look at the rail. | Merge readiness (Verifier with "n of m checks passed", Judges, Human approval, Conflicts) with a Ready / Not ready pill (Queued in the merge queue, Merged once merged); then Reviewers, Lease, and Preview when the change has a preview URL. |
| CHD-33 | On a change with any readiness row not green, look at the button. | **Add to merge queue** is disabled and the line under it reads "Blocked: <what blocks the queue, else the first row not green>." |
| CHD-1832.1 | On a change approved at its head whose verify on the head hasn't passed yet, look at the rail. | Not ready; **Add to merge queue** is disabled and the line under it reads "Blocked: Verifier hasn't passed the head." Once the verify passes it reads Ready and the click queues it. |
| CHD-34 | Approve a change whose checks pass, then click **Add to merge queue**. | The rail shows "In merge queue"; the card moves to Merge queue on the board. |
| CHD-35 | Toggle **Auto-queue** on, then reload. | Still on. A change with it on queues by itself once every row is green. |
| CHD-1408.1 | On a verified change with Auto-queue off and nothing else holding it, toggle **Auto-queue** on. | The change moves to the merge queue. |
| CHD-1337.1 | On a verified change with Auto-queue off and nothing else holding it, toggle **Auto-queue** on. | The change moves to the merge queue. |
| CHD-1387.1 | On a verified change with Auto-queue on and jon, sam requested, neither having approved the head. | Readiness shows "Waiting on jon, sam (requested)" with "Auto-queue holds until requested reviewers approve the head"; under Auto-queue "Queues when requested reviewers approve"; Not ready; the change stays Verifying. |
| CHD-1387.2 | Have jon approve the head, then push a new head. | After the approval: "Waiting on sam (requested)" with "jon approved <sha> · auto-queue waits for the rest". After the push jon is waiting again. |
| CHD-1387.3 | Have every requested reviewer approve the head. | The row turns green "Requested reviewers approved"; under Auto-queue "Requested reviewers approved · queues when the rest is green". |
| CHD-1387.4 | Remove sam (`DELETE /api/changes/:id/reviewers/sam`), then the last pending reviewer. | The timeline shows "removed sam from requested reviewers · auto-queue now waits on jon"; after the last removal the row is gone and the change moves to the merge queue. |
| CHD-56 | Toggle **Auto-queue** off and on. | Only the toggle changes; the header, tabs, timeline and rail stay where they are and the page doesn't show a loading state. |
| CHD-1388.1 | On an open change, click **Request** under Reviewers and pick a person. | The picker closes; they show under Reviewers with `requested`, Pending and **×**; Human approval reads "Requested from &lt;them&gt;" without a reload. |
| CHD-1388.2 | Open the picker on a change with a requested reviewer who owns touched paths. | Suggested lists owners with "owns n · touched m" but not the one already requested; Judges rows read "scores, doesn't approve". |
| CHD-1388.3 | In the picker, type `zed`. Then block `GET /api/people` and open it again. | "No person or judge matches “zed”. Invite people in Access & people."; then an inline error inside the picker. |
| CHD-1388.4 | Open the picker with the keyboard, Tab through it, press Esc. Then click **×** on a requested reviewer. | Focus starts in the search field and every row is reachable with visible focus; Esc closes it and focus returns to **Request**. × removes the reviewer. Light and dark, and at 390px the picker stays on screen. |
| CHD-36 | Look for a merge button anywhere on the page. | None; merging always goes through the verifier queue. |
| CHD-52 | Open a change saved with labels (New change, labels `qa`). | The rail shows Labels with `qa`; a change without labels has no Labels section. |
| CHD-45 | Open a change in the merge queue. | No "Not ready" pill; the rail reads "In merge queue · position n of m". |
| CHD-46 | Open a change sent back by a failed verify. | The Verifier row reads "Verifier failed" with the failed check count; Human approval follows the latest review. |
| CHD-1426.1 | Open a change the guard quarantined or that adds an unapproved package. | Merge readiness has a red row with the same "Blocked: …" text as its board card, with **Decide in Needs you** linking to `/needs`; the pill reads Not ready. Resolving the item removes the row. |

## States

| ID | Check | Expected |
|---|---|---|
| CHD-39 | Open the merged change. | Read-only: no Take over, Review, comment box or line comments; the rail says "Merged by the verifier &lt;age&gt; ago". |
| CHD-40 | Open the blocked change. | The block reason shows in words in the Verifier or Conflicts readiness row, never the bare state name. |
| CHD-54 | Open a change that failed at develop. | The first Merge readiness row reads "Failed at develop" with the reason the runner reported, not "Verifier blocked". |
| CHD-1386.1 | Open a change that failed at verify. | The pill reads Failed; a red strip reads "Failed at verify." with the reason, **Retry verify** and **Close change…**. No Take over, Review or comment box. |
| CHD-1903.1 | Open a change whose verify failed with a short check output. | The "Failed at verify." reason is the check's output; it carries no `##[group]Fetch change` or `Check leases` lines. |
| CHD-1386.2 | Click **Retry verify** on a failed change with a failing test. | The pill reads Verifying; a strip with a spinner reads "Re-running the failed check <test>; the n passing checks are kept"; the Verifier row reads "Verifier running · checks n/m". |
| CHD-1386.3 | Block `POST …/retry` and click **Retry verify**. | "Retry didn't start: … The change stays failed." shows under the header; the pill still reads Failed. |
| CHD-1386.4 | Click **Close change…**, type a reason, then **Close change**. | Nothing closes until you confirm; the dialog warns leases release, the agent stops and it can't be undone. Then the pill reads Closed, the strip reads "Closed by <you> … · <reason>. Closed changes can't reopen." with **New change from intent**, the rail shows no queue or Auto-queue controls, the comment box is replaced by "This change is closed…", and the timeline shows "closed → closed · <reason>". |
| CHD-1433.1 | Open a draft change and click **Mark ready**. | The strip first reads "Draft. The verifier doesn't run on a draft…". After the click the pill reads Verifying, the strip reads "Verifier starting on <sha> · usually under 10s" and the Verifier row reads "Verifier queued". If the call fails the strip reads "Couldn't start the verifier… The change stays a draft." with **Try again**. |
| CHD-41 | Reload throttled, and click a change card on the board with the network throttled. | Inside the sidebar and top bar, a title bone and 5 meta pills, an intent card and 3 timeline bones, a rail with 4 readiness rows and a full-width button bone. |
| CHD-42 | Open `/svc-orders-go/changes/no-such-id`. | "Change not found" with **Back to Changes**. |
| CHD-43 | Block `GET /api/changes/:id` and reload. | "Couldn't load this change" with Retry. |
| CHD-44 | As a Contributor, submit a review and take over. | Each succeeds or shows the server's reason inline; nothing changes silently. |
| CHD-47 | Open a change with no commits, no checks and no diff, then each tab. | Files changed, Commits and Checks each show an empty state. |
| CHD-48 | Open a change merged over a day ago. | The state pill reads "Merged · &lt;age since the merge&gt;". |
| CHD-49 | Propose an edit from Code while no worker is online, then open the change. | The header pill reads "Committing your edit… · waiting for a worker"; Files changed shows "Committing your edit…" with the file waiting for a worker, not "No files changed". Once a worker claims it the pill reads "Committing your edit…". |
| CHD-50 | Open a change whose edit commit job failed. | The header pill reads "Edit commit failed"; Files changed names the file and offers **Retry in Code**, which opens the file in the change's workspace in Code. |
| CHD-51 | Throttle the network and click **Close change** on a throwaway change. | The button is disabled and the page body is `aria-busy` until the change reads closed; one close request is sent. |
| CHD-1339.1 | Open a change you opened from a branch, then push a new commit to that branch with git (once while it verifies, once after it reaches needs fix). | Without a reload the timeline gains a `pushed` event naming the new commit and the change reads verifying; the change has one verify job, on the newest commit. |
| CHD-1425.1 | In a repo with `lease: { idle_minutes: 10 }` in `.cinder.yml`, leave an agent change in needs fix with no worker online for over 10 minutes (the cron runs every 10). | The timeline gains a `lease_expired` event; a change waiting on the same symbols starts. Once a worker is online, the parked change's repair job runs only after it gets its lease back. |
| CHD-1425.2 | Let a queued change hit a conflict when the target moves, resolve it, and let it pass verify. | It returns to the merge queue at the position it had before the conflict, not at the back. |
| CHD-1342.2 | Open a change you opened from a branch, then push a new commit to that branch with git (once while it verifies, once after it reaches needs fix). | Without a reload the timeline gains a `pushed` event naming the new commit and the change reads verifying; the change has one verify job, on the newest commit. |
| CHD-1385.1 | Open an agent change while it repairs (light and dark, and at 390px). | The pill reads Repairing; a strip shows one pip per round (done, current, left), the agent, the check and the failing test, with **Open run** (opens Checks); the Verifier row reads "Verifier repairing · round n of max"; the timeline has one event per round in order with what the agent changed, the verifier result and tokens, the current one with a spinner. |
| CHD-1385.2 | Throttle or block `GET /api/changes/:id/repairs` and open a repairing change. | A **Repair rounds** card shows bones, or an inline error with Retry when blocked; the change's other events still show. |
| CHD-1385.3 | Open a change that failed its last repair round. | The pill reads Failed; a red strip reads "All max rounds used and &lt;check&gt; still fails. It needs a person." with **Retry verify** (back to Verifying), **Take over** and **Close…** (asks to confirm, then closes). All are reachable by keyboard with visible focus. |
| CHD-1423.1 | Sign in as a person whose roles lack `change.approve` (e.g. developer), open a change and click **Review**. | **Approve** and **Request changes** are disabled; the popover reads "Only approvers can approve or request changes: <names>. You can still comment."; **Comment** submits. As a maintainer neither is disabled and the note is gone. |
| CHD-1432.1 | On a seeded deployment (after a pool has verified the seed's changes and the seed has run again), open svc-orders-go's "Delete an order only when it exists", driven by ben.okafor. | Conversation has a collision card: the other change, the symbol and file, signature or body change, severity with p, what the agent was told and what it did. An open one has **Resolve** with Stack, Seam, Hand over and Go first, a preview of what each does and the merge order after, and a button named for the choice; **All collisions** opens the Collisions page. The rail's **Symbols** lists Leased (with mode), Touched and Collisions with their state, and Merge readiness' conflict row reads "Collision with <change> on <symbol>". |
| CHD-1432.2 | Pick **Hand over** on that change's card and press its button. svc-orders-go's "Return false for a negative order id" shows a collision the seed already handed over. | The change leaves Conflict and is scheduled again; the card reads "Resolved with Hand over", the readiness row clears, and the timeline shows the move, without a reload. |
| CHD-1395.1 | On an open change, add a label in the rail with **+ Add**, remove it with ×, then change **Priority**. | Each edit saves at once and the rail and the change's board card show it; "Higher priority queues first and is picked up first by agents." sits under Priority. Merged, closed or failed changes show their labels read-only. |
| CHD-1398.1 | Open a change you drive (opened from your branch) and use **Agents may push** under **Agent pushes** in the rail, after Lease. | The toggle shows the change's setting and saves on click; off reads "Only people push. Agent pushes are refused and logged.", on reads "<agent> can add commits to this branch." It is absent on a change an agent drives and on a merged, closed or failed change. A refused save shows its reason in the page's error line. |
| CHD-1398.2 | With **Agents may push** off, let the agent commit to the change (an `@agent` message or a develop job). | Without a reload the timeline shows the agent@version, a lock icon and "push refused: Agents may push is off · 1 commit not applied" (no count for a message) with **Allow agent pushes**; it turns the toggle on and the link goes. |
| CHD-1632.1 | After a refused develop job commit (CHD-1398.2), turn **Agents may push** on, then off and on again. | The change gets one new queued develop job for the agent; the second toggle queues no other. |
| CHD-1663.1 | Throttle the network to make a change load slowly, then open it. | Nothing shows in the page body for about 150ms, then the skeleton; after 10s "Still loading…" with **Retry** appears, and Retry reloads the change. |
| CHD-1818.1 | In DevTools, block or slow `GET /api/changes/:id/files`, then open a change. | The header, timeline and rail draw; Files changed has no count and its tab shows a loading placeholder until the files arrive, then the count, the diff and +/− totals appear. `GET /api/changes/:id` carries a `Server-Timing` header (`do`, `db`), and it starts alongside threads, commits, checks and files in the network waterfall. |
| CHD-1885.1 | Queue a change that was verified, then push a new commit to it (or leave its guard pending), and open it. | Its blockers name the missing verdict on the new head (`stale_verdict`) or `no guard result`, its queue row shows the same reason and no merge starts; once verify passes on the head, the guard is clean and any required approval is given, the blockers list is empty and the merge starts. |
| CHD-1988.1 | On a repo whose risk judge is still untrusted (a fresh install), with a released reviewer agent, let a change verify. | Its routed event reads "risk …, judge not yet trusted" with route agent, a review job runs, and after the review passes the change joins the queue and merges with no approval; no Untrusted judge item appears in Needs you. |
| CHD-1988.2 | On the same repo, push a change touching a path the branch rule routes to people. | It routes to a person: `approval_missing` blocks it until someone approves its head. |
| CHD-2300.1 | Let a change verify whose diff only edits comments or blank lines in code files, then one that only edits `*.md` files, then one that also changes a code line. | The first routed event reads "comment-only change" and the second "documentation-only change", both route auto (merge on green, no approval) whatever the risk judge answered; the third gets the risk judge's usual route and reason. |
| CHD-2026.1 | Open an agent change that has verified and been routed, and read its timeline. | Each event names who did it: the agent version (links to its Versions tab), the lease or risk judge (links to its calibration), the runner and pool for verify and develop jobs (links to Workers), "git push" for a push. Never "system" or "verifier" alone. |
| CHD-2103.1 | Open a verifying change that has no pushed head. | **Add to merge queue** is disabled and reads "Blocked: No head pushed."; Auto-queue doesn't queue it. |
| CHD-2103.2 | With a change at the head of a merge queue that has no pushed head and a verified change behind it, wait for the queue to re-evaluate. | The head goes back to `needs_fix` and leaves the queue; the change behind re-verifies and then gets its merge job. |
| CHD-2097.1 | Sign in as a Contributor (not a people manager) who authored a change and click **Request** under Reviewers. | The picker opens with Suggested and Judges and no load error; People is empty. |

## Known gaps

- **CHD-06:** a person's change shows **Take over** like an agent's; Hand to an agent appears only after a takeover.
- **CHD-30:** the architecture map records check output stored unmasked in D1; until that moves, a secret printed by a check can show in its log.

- CHD-1430.1: a change with open and resolved threads shows "n unresolved threads" in readiness ("All threads resolved" when none are open); a resolved thread starts collapsed as "Resolved by <who> · n comments".
- CHD-1430.2: Resolve and Reopen toggle a thread without a reload; Enter in Reply posts a comment.
- CHD-1430.3: Apply suggestion on a thread you drive commits once, the block reads "Applied in <sha>" and the verifier re-runs.

## Planned

- Check logs in R2 or Workers Logs, masked, instead of D1.

## Retired

- CHD-38 (the rail's Preview URL): changes get no Worker preview.
- CHD-57 (a failed change's Close change closed it at once): **Close change…** now asks first (CHD-1386.4).
- CHD-13 (judge review card), CHD-29 (Workflow instance link), CHD-37 (linked issue in the rail): the page no longer shows them.
