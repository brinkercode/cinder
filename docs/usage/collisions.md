# Collisions

## Purpose

Where two changes reach for the same symbol on the target branch: the pairs predicted to collide, the leases they hold, and the collisions that happened with what each agent was told.

## Where

Code ▸ *repo* ▸ Changes ▸ **Collisions** (`/:repo/changes/collisions`). The page follows the target branch picked in the top bar; its description names it.

## What you can do

- **Head:** a `live` indicator and **Changes** back to the board. The feed and the lease map both refetch on every repo event and whenever the target branch changes.
- **Tiles:** Open, Resolved · 24h, Conflict rate · 7 days ("n of m merges") and Median time to resolve, which reads "untrusted: n outcomes" until it has 20. A tile with nothing to compute shows `—`.
- **Pairs at risk:** one row per pair from the lease map. Pairs whose leases overlap come first with a **leases overlap** pill and no percentage; then judged pairs by their calibrated probability (the raw probability when there is none), highest first, with a bar coloured under 20%, 20–50% and over 50%; then pairs whose judge is untrusted, which read "untrusted: n outcomes" with no bar and no percentage. Hovering a percentage shows the raw and calibrated values. Each row names its judge and a why line: "<change> waits on <symbol>", "both lease in <file>", "no shared lease · predicted from intent", or "collided n ago" (the row turns red) when the pair has an open collision. Empty: "No pairs at risk".
- **Leases by file:** each file's leased symbols, the holder with its mode (exclusive, shared, seam) and the changes waiting on it (dashed, with a warning icon when that change has an open collision). Empty: "No leases held".
- **Open collision:** the newest open collision: who changed what, the holder, file and age, its severity, what the agent was told and what it did. **Resolve** offers Stack, Seam, Hand over and Go first. Picking one fills a preview: what happens, the **Merge order after** (from the lease map's stacks and waiting changes) and who waits. The button names the choice ("Stack <change> on <holder>") and resolves every open collision of that change. When cinder has advice for the collision, its option is preselected and marked **Suggested** with the reason; otherwise Stack is selected and nothing is marked. If the change is no longer in conflict (cinder or another person settled it) the card says so and the page refetches; any other failure shows the error under the options.
- Other open collisions show as compact cards; **Resolve…** makes one the expanded card.
- **Resolved:** each resolved collision of the last 7 days: "Stacked: <change> on <holder>", who resolved it when known, how long ago and how long it took.
- **Empty:** "No collisions in the last 7 days"; with only resolved ones, "Nothing open". A failed feed or lease map shows an error with Retry in its own column while the other still shows.
- On a change's page, the collision card's **Resolve** has the same options and preview.

## Backed by

D1 `collisions` and the RepoDO leases, through `GET /api/repos/:name/collisions`, `GET /api/repos/:name/lease-map` (both with `?target=`) and `POST /api/changes/:id/collisions/resolve {action}`. Cloudflare map: [ARCHITECTURE-CLOUDFLARE.md §2](../ARCHITECTURE-CLOUDFLARE.md#2-page-by-page-map).

## Planned

- A footer naming the other holders when a change collides with more than one.
- The resolved card turning green with what each agent was told, before the feed refetches.
- An exact merge-order preview from the worker; today the order for Hand over and Seam is an approximation.
