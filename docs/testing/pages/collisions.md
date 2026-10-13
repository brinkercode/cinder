# Collisions

- **Route:** `/:repo/changes/collisions`
- **Sidebar:** Code ▸ *repo* ▸ Changes ▸ **Collisions**
- **Backed by:** D1 `collisions` and the RepoDO leases ([map](../../ARCHITECTURE-CLOUDFLARE.md#2-page-by-page-map))

**Setup:** a seeded deployment; web-store has one open and one resolved collision. Checks in light and dark, and at 390px.

| ID | Check | Expected |
|---|---|---|
| COL-2085.1 | Open `/web-store/changes/collisions`. | "Collisions" with a description naming the target branch, `live`, **Changes**; tiles Open, Resolved · 24h, Conflict rate · 7 days ("n of m merges") and Median time to resolve; **Pairs at risk** and **Leases by file** in the main column; the open collision, then Resolved, on the right. No graph. |
| COL-2085.2 | Look at **Pairs at risk**. | Overlapping leases come first with a **leases overlap** pill and no %; then judged pairs by calibrated %, highest first, with a coloured bar; untrusted pairs come last as "untrusted: n outcomes", with no bar and no %. Hovering a % shows raw and calibrated. Each row has a why line and its judge; a pair with an open collision reads "collided n ago" on a red row. |
| COL-2085.3 | Look at **Leases by file**. | Symbols grouped by file; each has its holder with a mode icon and its waiting changes (dashed), with a warning icon on one that has an open collision. |
| COL-2085.4 | On the open collision, pick each of Stack, Seam, Hand over and Go first, with the keyboard too. | The picked option is highlighted; the preview, **Merge order after** and the button label change with it ("Stack <change> on <holder>", "Propose a seam", "Hand <symbol> to <change>", "Let <change> go first"). Stack's order is holder → change → the changes stacked on or waiting for it. |
| COL-2085.5 | Press the button. | The collision moves to Resolved ("Stacked: <change> on <holder>"), without a reload; the other tab's board and change page update too. |
| COL-2085.6 | Resolve the same collision from another tab first, then press the button here. | The card shows "<change> is no longer in conflict: cinder or another person settled it" and the page refetches. |
| COL-2085.7 | On a collision cinder has advice for, look at Resolve. | Its option is preselected with an orange dot and **Suggested** with the reason. Without advice, Stack is selected and nothing is marked. |
| COL-2085.8 | Switch the target branch in the top bar. | The description names the new branch; pairs, leases and collisions reload for it. |
| COL-2085.9 | Open Collisions in a repo with no collisions in 7 days, then throttle the network and reload; then make the lease map fail. | "No collisions in the last 7 days", "No pairs at risk", "No leases held"; while loading, tile and card bones; a failed request shows an error with Retry in its column while the other column still shows. |
| COL-2085.10 | At 390px. | Tiles 2×2, then pairs (ids and judge, then the bar, then the why line), leases, the right column; Resolve options 2×2. |
