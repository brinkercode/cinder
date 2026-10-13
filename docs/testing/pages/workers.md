# Workers

- **Route:** `/automation/workers`
- **Sidebar:** Automation ▸ Workers
- **Backed by:** Cloudflare Containers for the managed pool; D1 for pools, members and runner token hashes; the DispatchDO Durable Object for job claims ([map](../../ARCHITECTURE-CLOUDFLARE.md#2-page-by-page-map))

**Setup:** the managed `build` and `toolchains` pools every install starts with. For WRK-05 and WRK-06, create the bring-your-own pool `manual-0` with two runners per [Operations](../../operations/README.md#bring-your-own-pool-on-self-hosted-machines), running `cinder-verify` with one token only. Name test pools `manual-<n>`.

| ID | Check | Expected |
|---|---|---|
| WRK-01 | Open `/automation/workers`. | Title "Workers" with View docs and **Add worker pool**; one card per pool, each with **Edit**. |
| WRK-02 | Look at the managed cards. | Each has a CPU icon, "Managed · <pool name>", a `default` tag on the oldest pool only, the description (one sandbox per run, destroyed afterwards, credentials injected), a health pill; footer with Size as text (no list), runs per hour and median start. |
| WRK-04 | Look for a delete action on the managed pool, on its card and in its **Edit** modal. | None; its modal's danger zone has only **Drain** or **Resume**. |
| WRK-05 | Look at `manual-0` while its one `cinder-verify` runs. | Name, a `bring your own` tag, the purpose (more than 4 vCPU or 20 GB disk, or a GPU), "1 of 2 online"; footer with labels and heartbeat. |
| WRK-06 | Stop that `cinder-verify`, wait two minutes and look at `manual-0`. | A red `offline` pill and its last heartbeat. |
| WRK-10 | Register a runner with a token from Keystore and this pool's name. | Within a minute the card shows "1 of 1 online" and a fresh heartbeat. |
| WRK-11 | Click **Backed by Containers** in the top bar. | The Containers page of the dashboard opens in a new tab. |
| WRK-12 | Reload throttled. | Skeleton cards, as many as last time (2 on a first visit). |
| WRK-1674.1 | Open `/automation/workers` directly in a new tab with `/api/**` delayed 3s. | The sidebar, the title and the WRK-12 skeleton with **Add worker pool** disabled show at once ("Loading Workers" status); the main area is never blank. |
| WRK-1846.1 | With `/api/**` delayed 3s, reach `/automation/workers` from the sidebar. | **Add worker pool** stays disabled (aria-disabled, tooltip "Available once the worker pools load") until the data arrives, then enable. |
| WRK-13 | Block the pools request and reload. | "Couldn't load runner pools" with Retry. |
| WRK-14 | Look at a managed pool scaled to zero with nothing queued. | A grey "Idle, scales on demand" pill, not a red one. |
| WRK-15 | Drain a managed pool (`POST /api/workers/pools/:id/drain`), reload, then click **Resume** on its card. | The card shows `draining` and **Resume**; after Resume the pill returns to its health or idle state and a reload keeps it. |
| WRK-16 | With both managed pools at zero, propose a change on a file in `svc-orders-go`. | A `toolchains` worker starts and the commit lands; `build` starts none for it. |
| WRK-18 | Open **Edit** on the `toolchains` card and look at **Instance type**. | It shows `standard-2` (1 vCPU · 6 GB · 12 GB disk) selected, alongside `lite`, `basic` and `standard-4`; no `standard-1`. |
| WRK-1272.1 | Click **Add worker pool**. | A wide modal "Add worker pool" with focus in **Name**; Kind cards Managed and Bring your own; Basics, Instance type, Scaling, Placement, Network egress, Who can use it; a footer with the sandbox-seconds note, **Cancel** and **Create pool** that stays visible while the body scrolls. |
| WRK-1272.2 | Type a name, add labels `gpu` (Enter) and `arm64` (comma), pick egress **None** and **Selected** with one repo, then switch Kind to **Bring your own**. | Name, both chips, None and the repo stay; Cloud, Region and Register workers replace the managed sections; the footer note says your machines. Click × on `gpu`: the chip goes. |
| WRK-1272.3 | Press Esc, then reopen **Add worker pool**; type a name and click **Cancel**, then reopen. | Each reopen starts empty; nothing was created. |
| WRK-1272.4 | Create a bring-your-own pool named `build`. | An inline "A pool named build already exists." under Name; the modal stays open. |
| WRK-1272.5 | Create bring-your-own pool `manual-1` with label `gpu`. | The modal turns into "Edit manual-1" with Register workers. **Mint token** shows a token, a copy button and the install and `cinder runner register … --pool-token <token>` commands; the status reads "Waiting for the first heartbeat…". |
| WRK-1272.6 | Run the register command on a machine and start `cinder-verify` with the runner token it prints, keeping the modal open. | Within a minute the status reads "1 of 1 online". |
| WRK-1272.7 | Close the modal and open **Edit** on `manual-1` again. | The token is gone; **Mint token** is back. |
| WRK-1416.1 | **Edit** `manual-1` after WRK-1272.6. | **Issued tokens** lists the minted token as `<prefix> ••••` with "… ago · <you>" and a first-used time. In a pool with no tokens it reads "No tokens issued for this pool. Mint one above to register a worker." |
| WRK-1416.2 | With a job running on the WRK-1272.6 worker, click **Revoke** on its token, then **Click again to revoke**. | The first click only changes the button; the second removes the row. The running job finishes; at its next claim the worker logs 401 `token_revoked` and drops off the pool ("0 of 0 online"). |
| WRK-1416.3 | Tab through **Issued tokens** at 390px in light and dark. | Each **Revoke** shows a visible focus ring; the table scrolls inside the modal, not the page. |
| WRK-1573.1 | Run the WRK-1272.6 register command again with the same pool token, then once with a fresh token and `--kinds merge`. | Both are refused: the first with 401 `bad_pool_token`, the second with 400 `bad_request`; neither adds a worker to `manual-1`. |
| WRK-1865.1 | **Edit** the `build` pool, pick another **Instance type**, **Save changes** and reload. | The card's footer shows the new size; the card has no Size list. |
| WRK-1976.1 | With the `build` pool running a worker, **Edit** it and pick another **Instance type**. | A note says "1 running worker will finish its current job and restart on <size>"; picking the current size again removes it. |
| WRK-2073.1 | **Edit** a pool that has labels and look at its label chips. | Each label reads centred, vertically and horizontally, in its bubble, with the remove button beside it. |
| WRK-2049.1 | Set the `build` pool to `lite` and the `toolchains` pool to `standard-2`, then file a change on pulse. | The change's develop job is claimed by a `toolchains` worker, never a `build` one, and the `build` pool starts no worker for it. |
| WRK-1976.2 | **Save changes** on that new size, then wait a minute and reload. | No 409: the size saves, the old worker stops once idle, and the pool's workers come back on the new size. |
| WRK-1272.8 | **Edit** the `build` pool, add label `e2e`, **Save changes**, reload and open **Edit** again. | Name is disabled; the `e2e` chip is kept. The danger zone has **Drain** and no Delete. |
| WRK-1272.9 | **Edit** `manual-1` and click **Delete** in the danger zone, then **Click again to delete**. | The first click only changes the button; the second removes the card, and a reload keeps it gone. Its runners still list in Keystore. |
| WRK-2098.1 | Create a managed pool `manual-2` with egress **Allowlist** and an invalid host, then fix the host and click **Save changes**; close the modal. | The refused save leaves the modal open as "Edit manual-2" with the error; the retry saves without "A pool named manual-2 already exists"; on close the list shows `manual-2`. |

## Planned

None.

## Retired

- WRK-07, WRK-08, WRK-09: the old Add runner pool dialog (replaced by WRK-1272.1 to WRK-1272.5).
- WRK-03: changing Size from the card (replaced by WRK-1865.1).
- WRK-17: Delete with a browser confirm on the card (replaced by WRK-1272.9).
