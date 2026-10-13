# Changes board

- **Route:** `/:repo/changes[?target=]`, and New change at `/:repo/changes/new`
- **Sidebar:** Code ▸ *repo picker* ▸ Changes
- **Backed by:** D1 (issues, change cards, queue entries; `GET /api/repos/:name/work`), the RepoDO and ChangeDO Durable Objects (leases, change state, live updates) ([map](../../ARCHITECTURE-CLOUDFLARE.md#2-page-by-page-map))

**Setup:** `svc-orders-go` (draft, planned, needs_fix, leased, verifying, awaiting approval, in queue, merged and blocked changes); `web-store` for a second target branch (develop); an empty repo named `manual-empty-<n>` made with New repository and deleted afterwards for the empty board. Write new changes with intents starting `Manual test`.

## Board

| ID | Check | Expected |
|---|---|---|
| CHB-03 | At 1440×900, scroll a long column. | The column scrolls inside itself; the page doesn't scroll; columns are at least 240px and the board scrolls sideways when they don't fit. |
| CHB-05 | Look at a Verifying card. | A progress bar with "checks x/5". |
| CHB-07 | Look at an empty column. | "Nothing here". |
| CHB-1850.1 | In light and dark, look at an empty column. | "Nothing here" is readable against the column in both themes. |
| CHB-08 | Click a card. | Opens `/svc-orders-go/changes/<KEY>` (e.g. `SVCORDERSGO-3`). |
| CHB-09 | Tab to a card and press Enter. | Opens the change. |
| CHB-10 | Leave the board open while a change moves stage (approve one in another tab). | The card moves column without a reload. |
| CHB-1385.1 | Fail verify on an agent change (with repairs left). | Its card stays in **Verifying** with "Repairing · round n of max · fixing verify" under the title. |
| CHB-1610.1 | Let a repaired agent change pass verify while it waits for review (or with auto-queue off). | Its card no longer shows "Repairing"; the change's pill no longer reads Repairing. |
| CHB-1385.2 | Let an agent change fail its last repair round. | Its card in **Verifying** reads "All max rounds used and verify still fails. It needs a person." with **Retry verify** and **Close…**; Retry verify moves it back to Verifying, Close… asks to confirm and then closes it. Neither opens the change. |
| CHB-1426.1 | Push a change that adds a new package no owner approved. | Its card shows a red "Blocked: new dependency <name> <version> needs approval", the same text its Needs you item starts with; after **Approve** in Needs you the line is gone. |
| CHB-1248.1 | Open `/svc-orders-go/changes`. | Board / Table, "Into <target>", **Collisions**, **From a branch**, **Describe a change**; five tiles; search with All · Agents · People · Needs you; six lanes. |
| CHB-1248.2 | Look at the lanes. | Intents, In progress, Verifying, Needs review, Merge queue, Merged · 24h, each with a dot and a count. Every open issue and live change shows once; a change linked to an issue shows its `#n` and that issue has no card. |
| CHB-1248.3 | Retired: replaced by CHB-1249.1. | — |
| CHB-1249.1 | Look at an intent card. | Dashed border, `#n`, priority, labels, "by <author> · <age>", a **Move to…** menu and **Hand to agent**. |
| CHB-1249.2 | Drag an intent from Intents to In progress. | The card moves at once with a claim chip (the top suggested agent once the claim answers); it stays an intent card. |
| CHB-1249.3 | Drag a claimed intent with no commit yet from In progress back to Intents. | It moves back at once and its agent's change is closed. |
| CHB-1249.4 | Drag any card into Verifying, Needs review, Merge queue or Merged · 24h. | A toast reads "Past In progress, only the verifier moves work."; nothing moves. |
| CHB-1249.5 | Try to drag a change card. | It doesn't drag. |
| CHB-1249.6 | Tab to an intent's **Move to…** menu and pick In progress with the keyboard. | Same as CHB-1249.2. |
| CHB-1249.7 | Drag an intent while offline; drag back an intent whose agent has just committed. | The card moves, then returns with the error; the second returns with "An agent already committed; the verifier owns it now." |
| CHB-1249.8 | Claim an intent in one browser with the board open in a second. | The second browser's card moves to In progress within 2 s; a race shows "racing 2". When the agent's first commit lands, the card becomes a change card in Verifying without a reload. |
| CHB-1249.9 | Click an intent card in Intents. | A right-hand drawer: body, labels, target branch; **Who writes it** with the best agent and its p(merge), **Race two agents** with the challenger's untrusted count, and **I'll write it**; **Close intent** and **Start**. |
| CHB-1249.10 | In the drawer pick **I'll write it** and **Start**; then reopen and **Start** with the best agent; then **Close intent** on another. | New change opens on I wrote it with the title starting `#n`; Start claims it like **Hand to agent**; the closed intent leaves the board. |
| CHB-1677.1 | Drag an intent to In progress and press **Refresh** before the claim answers. | The card stays in In progress with its agent once both finish; it doesn't jump back to Intents. |
| CHB-1249.11 | Sign in as a viewer (no repo.write). | Drag, **Move to…**, **Hand to agent**, **Close intent** and **Start** (except I'll write it) are disabled; their tooltip and a line above the board read "Moving intents needs repo.write on this repo." |
| CHB-1248.4 | Look at an agent's change card. | Change id, `#n` when linked, a p(merge) pill ("untrusted: n outcomes" while its agent version has under 20 decided changes, never 0% or 100%), title, author and age in the meta row, +/−, files and tokens. |
| CHB-1862.1 | Give a change a title of 200+ characters, a collision and a blocked why-line; look at its card at 1440 px, 900 px and 390 px wide. | The title shows two lines and the full title on hover; the meta row reads "<8-char id> #n · <author> · <age>"; labels, badges, the collision and why-lines wrap; no text leaves the card. |
| CHB-1765.1 | Open a board with several branch changes, with the browser's network panel open. | Each change card shows +/− and files; there is one `work` and one `changes` request and no `compare` request. The `changes` response has a `Server-Timing` header with `db` and `cards`. |
| CHB-1248.5 | Look at a failed or conflicting change. | It sits in Verifying with a red reason ("Failed at verify: …" or "Conflicts with its target"). |
| CHB-1248.6 | Click **+** on Intents, type a title and press Enter; then try again offline. | The intent shows at the top of Intents at once and is still there after a reload. Offline, the card goes and the error shows. Esc closes the field. |
| CHB-1248.7 | Watch an agent's change while it develops; then turn live updates off and change an issue in another tab. | Its card's live line follows what the agent does; with live off the board picks up the change within 15 s. |

## Tiles

| ID | Check | Expected |
|---|---|---|
| CHB-42 | Look at a failed change's card in Verifying. | The reason reads "Failed at <stage>: <reason>" (for example "Failed at verify: 3 tests failed"), or "Failed at <stage>" when the step gave none. |
| CHB-1639.1 | Look at the card of an agent change that failed past its repair limit. | The reason reads "Failed at repair limit: repairs exhausted (m of m): …", never "repairs_exhausted". |
| CHB-1248.8 | Look at the tiles. | Intents waiting, In flight, Needs review, Merged · 24h and Verifier pass rate. The counts match the lanes (In flight is In progress + Verifying + Merge queue); below the trust threshold the pass rate reads "—" with "untrusted: n outcomes". |
| CHB-1386.1 | Look at a failed change's card. | It shows **Retry verify** and **Close…**; clicking them doesn't open the change. Close… asks first. |

## Toolbar

| ID | Check | Expected |
|---|---|---|
| CHB-18 | Click refresh. | The board reloads in place. |
| CHB-1248.9 | With DevTools' Network open, search a title word, `#n`, a change id, an author and a label. | Cards and rows filter as you type; no request is sent. |
| CHB-1248.10 | Pick Agents, People, then Needs you. | Only agents' items, then people's; Needs you shows the Needs review lane and its count equals that lane's count. |

## Table

| ID | Check | Expected |
|---|---|---|
| CHB-21 | Click a row (not the id link). | Opens the change. |
| CHB-1248.11 | Click **Table**. | The board hides; a table of Item, Title, Stage, Who, p(merge), Diff, Tokens, Age, with closed changes at stage Closed. |
| CHB-22 | Switch Board → Table → Board. | Exactly one view is visible at a time. |

## New change

| ID | Check | Expected |
|---|---|---|
| CHB-23 | Click **New change**. | Two mode cards with **Describe it** selected; the Intent card with the target select, One change per bullet line, the Agent select, a collapsed "Acceptance criteria, labels, priority", Cancel, **Save draft**, **Hand to agent**; the Prediction rail. |
| CHB-24 | Type 7 characters. | Hand to agent and Save draft stay disabled; the rail asks you to keep typing. |
| CHB-25 | Type an intent of 8+ characters and pause. | The Prediction rail fills: predicted leases, collisions, risk (trusted or untrusted), similar changes, suggested files and owners, agent, launch summary. |
| CHB-26 | Type `@` in the intent. | A suggestion list of agent@version; arrows move, Enter picks, Esc closes. |
| CHB-51 | In Describe it, leave the Agent select on its stable default (developer), hand the change to the agent, then pick developer's canary for a second. | The first card names developer@v<stable>, the second developer@v<canary>; change detail shows the same agent@version as author. |
| CHB-27 | Type `#` in the intent. | A suggestion list of active changes. |
| CHB-28 | Fill priority and labels, then click **Save draft**. | Returns to the board with the new change in Draft; reload keeps it. |
| CHB-29 | Write an intent and click **Hand to agent**. | Returns to the board with the change in a working stage, its card names the agent, and a toast confirms "1 change handed to …". |
| CHB-1420.1 | Push a commit to a target with no change on it, then at once write an intent naming a symbol from that commit and click **Hand to agent**. | The card sits in Planned until a runner's index job for the new head finishes, then moves on with that symbol in its lease (lease map). |
| CHB-30 | Write three bullet lines, tick One change per bullet line, click Hand to agent. | Three changes, one per bullet. |
| CHB-32 | Click **Cancel**. | Back to the board; nothing created. |
| CHB-33 | Click **From a branch**, pick a pushed branch as head. | **I wrote it** is selected; the hint reads "or push to `refs/for/<target>`"; the branch's commits, files and +/− show; Title fills from the branch name; the What happens rail lists verifier, judges, reviewers, merge. |
| CHB-34 | Pick a reviewer and click **Open change**. | You land on the new change's page with a toast "Opened … · you drive". Its Commits and Files changed list the branch's commits and files. It is Verifying, with the verify check on the branch's head commit; no agent develops it. |
| CHB-52 | Click **Open as draft**, then mark it ready with `cinder change ready <id>` and reload its page. | The draft moves to Verifying, with the verify check on the branch's head commit; no agent develops it. |
| CHB-44 | Pick an agent, then click **Hand to agent**. | The new change's card names that agent and version, not "owner · person". |
| CHB-50 | Open a change from a branch, then look at its card. | The card shows the person icon and "written by hand"; an agent's card shows agent@version and its tokens (— when none). The new card is at the top of its column without a reload. |
| CHB-46 | In I wrote it, clear the title, then unpick every reviewer. | Open as draft and Open change are disabled; hovering says "Add a title", then "Pick a reviewer". |
| CHB-47 | Type an intent in Describe it, switch to I wrote it, type a description, switch back and forth. | Each mode keeps what you typed in it. |
| CHB-48 | Open New change, then switch the target in the top bar's branch switcher, in both modes. | The target select, the Prediction rail and the What happens rail follow the new target. |
| CHB-1658.1 | Block `GET …/branches` and open New change with an intent of 8+ characters. | The Prediction rail fills as usual; on **I wrote it** the head select offers only the head in the URL. |
| CHB-49 | Open a change from a branch with and without **Let agents push to it** ticked. | The change records you as its driver; agents may push to it only when ticked. |
| CHB-35 | Click **Edit in Code** in the composer. | Opens Code on the target branch. |
| CHB-45 | Double-click **Save draft**, or click **Launch** / **Open change** once. | Launch, Open change and Save draft are disabled and the clicked one is busy until the request settles; one click makes one change. |

## States

| ID | Check | Expected |
|---|---|---|
| CHB-38 | Block `GET …/work` and reload. | "Couldn't load changes: GET /api/… → &lt;status&gt; …" with the method once and Retry; the tiles read "—" and the toolbar is disabled. |
| CHB-1248.12 | Reload throttled on a first visit. | Five tile bones, the disabled search and refresh, and 2/2/2/1/2/2 card bones per lane with progress-bar bones on Verifying. |
| CHB-1248.13 | Open `/manual-empty-<n>/changes` on the empty repo from Setup. | "Nothing in flight" with **New intent** (opens the Intents title field) and **Describe a change**. |
| CHB-1400.1 | While the budget pauses agents, open a repo's Changes. | The "Agents paused: budget reached" banner sits above the toolbar with **Raise budget** (disabled for a non-owner, with the owners named); it is gone once the budget is raised. |
| CHB-39 | Push a commit to `refs/for/main` with git. | A new change appears on the board without a reload, in Verifying, marked written by hand, titled by the commit message's subject line (its detail shows the whole message as the intent); no agent develops it. |
| CHB-1417.1 | Open `/:repo/changes?state=failed`. | Only failed changes show, on the board and in Table. |
| CHB-1432.1 | On a seeded deployment (once a pool has verified the seed's changes), open web-store's board: "Treat negative stock as sold out" is the seeded open collision with "Stop adding a product past its stock" on `lib/cart.ts#addToCart`. | The colliding change's card shows "Collides with <change> on <symbol>" and the toolbar's **Collisions · n** button counts the open collisions; it opens `/:repo/changes/collisions`. After the collision is resolved the line and the count go without a reload. |
| CHB-1982.1 | Run the demo scenario (`CINDER_DEMO=1 make seed`) and open `/pulse/changes/collisions` once agents have pushed. | Every agent collision reads Resolved: stack (or seam) with an action such as "Stacked: the default while the seam judge isn't trusted"; none waits for a person. The stacked change shows Waiting on the board, then develops on the holder's head; its readiness lists "stacked on <change>, which merges first" until the holder merges. |
| CHB-2022.1 | On infra-cloudflare-tf, open two changes from branches off `main`: one edits the `description` of `variable "name"` in `variables.tf`, the other its `validation` block. Let a pool verify both. | Neither card shows "Collides with"; `/infra-cloudflare-tf/changes/collisions` lists no collision between them, and both reach the queue and merge one after the other. Two changes that edit the same `validation` line collide as before. |
| CHB-1992.1 | On a seeded repo, push an agent's change that verifies, then let its guard find a planted `sk_live_` key (or report a guard finding after verify passed). | The change goes back to `needs_fix` and a repair round starts; no **Change quarantined** item appears for it. A person's change in the same situation stays put with the **Change quarantined** item. |
| CHB-1992.2 | Make an agent's develop job fail (not on a spend or token limit), then open the change. | Its timeline shows a `retry` event naming the other version, and a new develop job runs on it; a second failure fails the change. |
| CHB-1349.1 | On a change opened from a branch without **Let agents push to it**, post a review comment with `@agent`. | A review thread from the agent answers it and the timeline shows `agent_push_refused`; no agent commit lands. |
| CHB-1395.1 | With labelled items, open **Label ▾**, type in its filter field, pick a label, then pick **P1** in **Priority ▾**. | Only items with that label and P1 remain; the buttons read the label and P1; **Any label** and **Any priority** clear them. |
| CHB-1395.2 | With both filters set, wait for a live update or press **Refresh**. | The filters stay set; an item that now matches appears and one that no longer matches leaves. |
| CHB-1395.3 | Pick each option in **Sort ▾**. | Lane order keeps the newest first in each lane; Priority puts P0 first and unprioritised items last; Oldest first reverses age. |
| CHB-1395.4 | Open **Label ▾** on a repo with no labels. | "No labels yet" explains labels show here once added, with **Open Settings** to Label routing. |
| CHB-1395.5 | Click an intent card, add a label with **+ Add** (pick one or type a new one and press Enter), remove one with ×, change **Priority**. | Each edit saves at once and the card shows the new labels and priority pill; a failure shows its message in the drawer. |
| CHB-1608.1 | With the board open in two tabs, close an open issue from the other tab (`PATCH /api/repos/:name/issues/:n {state: "closed"}`). | The intent leaves the first tab's board without a manual refresh. |
| CHB-1663.1 | Throttle the network to make the board load slowly, then reload Changes. | Nothing shows for about 150ms, then the board skeleton; after 10s "Still loading…" with **Retry** appears, and Retry reloads the board. |
| CHB-1818.1 | With the network panel open, hover a change card (or Tab to it), then click it. | `GET /api/changes/:id` and its lists start on hover or focus, once per card; the click opens the change without new requests for them. |

## Known gaps

- **CHB-05:** Verifying cards show no "checks x/5" progress bar.
- **CHB-33:** **From a branch** opens I wrote it with no head picked; choose the head in its select.

## Planned

- **Hand to agent**, dragging intents between Intents and In progress, and the intent drawer.
- Check logs kept in R2 or Workers Logs, masked (today they're in D1).

## Retired

- **CHB-01, CHB-02, CHB-04, CHB-06, CHB-11 to CHB-17, CHB-19, CHB-20, CHB-36, CHB-37, CHB-40, CHB-41, CHB-43, CHB-1386.2:** the seven-column board with its List, author select, sort and Open, Awaiting approval and Median time to merge tiles became the six-lane board (CHB-1248.1 to CHB-1248.13); Table still lists closed changes.
- **CHB-31:** New change has no repo select; switch repos in the top bar.
- **CHB-1432.2, CHB-1432.3, CHB-1432.4, CHB-1898.1, CHB-1898.2, CHB-2067.1:** the Collisions feed, its **Resolve ▾** menu and the collision graph became pairs at risk, leases by file and Resolve with a preview ([collisions.md](collisions.md), COL-2085.1 to COL-2085.10).
