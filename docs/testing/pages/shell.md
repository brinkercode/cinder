# Shell

- **Route:** every page
- **Sidebar:** the sidebar itself, the top bar, and the menus they open
- **Backed by:** the `cinder` Worker; the repo list from D1, Needs-you counts from D1 and the ChangeDO Durable Object, live updates over the RepoDO WebSocket ([map](../../ARCHITECTURE-CLOUDFLARE.md#2-page-by-page-map))

**Setup:** the seeded repos; `svc-orders-go` or `infra-cloudflare-tf` for branches (main and two feature branches) and `web-store` for integration branches (develop, main, release/1.2).

## Sidebar

| ID | Check | Expected |
|---|---|---|
| SHELL-01 | Load any page at 1440px wide. | A 260px sidebar: a header with the mark and account name, a scrolling middle with no visible scrollbar, and a footer with the collapse button. |
| SHELL-68 | Load any page at 1000px and 1100px wide. | The sidebar stays 260px; group labels and the repo picker don't wrap or shrink. |
| SHELL-02 | Click the **Code** group header, then the **Automation** header. | Only one group is open at a time; opening Automation closes Code. The body slides open and shut. |
| SHELL-1243.1 | Open a repo page, then look at the Code group and the item after it. | The repo picker, then Code, Changes, Watchtower, Insights, Settings (no Issues, Releases, Wiki, Flows or Environments), then All repositories with a count. **Wiki** follows the Code group, before Automation. |
| SHELL-1243.2 | Open a repo's Releases, then a wiki page. | Releases marks **Code** current; the wiki page marks **Wiki**. |
| SHELL-04 | Open the Automation group. | Agents, Marketplace, Judges & calibration, Flows, Environments, Workers. |
| SHELL-05 | Open the Settings group. | Access & people, Keystore. |
| SHELL-06 | Click each item in the Code, Automation and Settings groups in turn. | Each opens its page; the clicked item is marked current. |
| SHELL-1243.3 | Look between the Automation group and Settings. | **Needs you** (with a count when there are items); it opens its page and is marked current there. |
| SHELL-08 | Click **Observability**, **Compute**, **AI**, **Storage & databases**, **Zero Trust** and **Account home** in the platform list. | Each opens the Cloudflare dashboard in a new tab, on cinder's own Worker observability, Worker, AI Gateway, D1, Access apps and account home. |
| SHELL-10 | Click **All repositories**. | Opens Repositories (`/`); the count matches the number of repos listed there. |
| SHELL-1243.4 | On a repo page, click **Wiki**. | Opens `/wiki/<repo>` for that repo; Wiki is marked current. |
| SHELL-69 | Open a repo's Flows, then its Environments. | Automation ▸ Flows (then Environments) is marked current; no repo item is. |
| SHELL-1661.1 | With a slow network, reload Automation › Workers and open a pool's modal before the sidebar's repos appear. | The repos fill in and the modal stays open with what was typed. |
| SHELL-1730.1 | With DevTools › Network open and the cache disabled, load `/` cold. | The first page loads the entry script and Repositories' own chunk only; no other page's chunk (Code, Changes, Flows, ...) and no editor script is fetched. |
| SHELL-1730.2 | Then hover **Needs you** in the sidebar (or Tab to it) without clicking. | Its page chunk is fetched on hover or focus; clicking it afterwards opens the page without fetching that chunk again. |

## Repo picker

| ID | Check | Expected |
|---|---|---|
| SHELL-11 | Retired: replaced by SHELL-1244.1. | |
| SHELL-1244.1 | Look at the context card on a repo page. | A bordered card: a 40px repo row (letter avatar, repo name cut with an ellipsis and the full name on hover, ⇅) over a 32px branch row (branch icon, target branch, chevron). |
| SHELL-1244.2 | Press **Tab** through the sidebar. | The repo row and the branch row are separate tab stops. |
| SHELL-1244.3 | Press **B**, then Esc; then press **R**; then click into a search field and press **B**. | B opens the target-branch menu; R does nothing; B does nothing while typing in a field. |
| SHELL-1539.1 | In light and dark, and in the 390px drawer, hover over a platform item, a group header, a Git item and the context card's repo and branch rows, then look at the current item. | No item gets a background or tint, on hover or when current. Only the item's icon and its arrow or chevron turn from grey to white (to the sidebar's ink in light); the text colour doesn't change. A group holding the current item shows its icon and chevron white too. Tab through the sidebar: the focus ring still shows, with no background. |
| SHELL-1244.4 | Open `?target=release/2026.10-dunning-retry-window-backports` at a 240px sidebar, then in the 390px drawer. | The sidebar's branch row and the top bar's target switcher keep the start (`release/…`) and the last 12 characters; hovering shows the full name; nothing overflows. A name under 23 characters shows whole. |
| SHELL-12 | Click the picker. | A menu lists every repo with a check on the current one. |
| SHELL-13 | On `web-store` › Changes, pick `svc-orders-go` in the picker. | Lands on svc-orders-go's Changes, not its Code. |
| SHELL-14 | On a repo's Flows page, pick another repo. | Lands on the other repo's Flows. |
| SHELL-15 | Open a repo, go to Repositories, reload, then click Code in the sidebar. | The picker and the sidebar items follow the last repo you opened, after the reload. |
| SHELL-16 | With the network throttled, reload a repo page. | While repos load, the picker shows the last repo's name from storage. |
| SHELL-17 | Make `GET /api/repos` fail (offline after load, then reload), then open the picker. | The picker shows a danger dot; the menu offers Retry. |

## Top bar

| ID | Check | Expected |
|---|---|---|
| SHELL-18 | Open any repo page. | The top bar reads `[book] repo › [branch] target <branch> ⌄`. No page body has its own repo header row. |
| SHELL-19 | Open Agents, Judges, Workers, Access & people and Keystore. | The top bar reads `Section › Page` (for example `Automation › Agents`). |
| SHELL-20 | Open a repo's Flows and Environments. | The top bar reads `Automation › Flows › repo ⌄ › ⑂ branch ⌄` (Environments likewise). |
| SHELL-21 | Open Code, Changes, Flows, Insights, Judges, Workers, Access & people and Keystore. | Each shows **Backed by &lt;resource&gt;**; clicking it opens the Cloudflare dashboard in a new tab on that resource (the repo's Artifacts repo, Durable Objects, Workflow `cinder-pipeline`, AI Gateway logs, Workers AI, Containers, the Zero Trust app, Secrets Store). |
| SHELL-22 | Look at the top right of the top bar with the site open. | No "live" badge; Backed by and Support remain. |
| SHELL-24 | Click **Support**. | A menu lists keyboard shortcuts (Branch menu B). |
| SHELL-25 | With Needs you holding items, look at the bell. | An orange dot on the bell; clicking it opens Needs you. |
| SHELL-71 | Make `GET /api/needs` answer 500 and reload. | The Needs you item shows a `!` badge; the console has no uncaught error. |
| SHELL-26 | Resolve every Needs-you item, then look at the bell. | The dot is gone without a reload. |
| SHELL-27 | Make the Needs-you request fail and reload. | The sidebar's Needs-you count shows `!` with a tooltip saying it couldn't load. |
| SHELL-28 | Click the theme toggle. | Light and dark swap; the choice survives a reload. |
| SHELL-74 | At 1000px wide, open `svc-orders-go` › Code. | The top-bar crumb stays on one line; a long name is cut off rather than wrapped. |
| SHELL-1243.5 | Open `/wiki/svc-orders-go`, then pick another repo from the top bar's repo menu. | The top bar reads `Wiki › svc-orders-go ▾` with no branch switcher; picking a repo opens its wiki folder. |

## Branch dropdown

| ID | Check | Expected |
|---|---|---|
| SHELL-29 | On `web-store` › Code, click the branch trigger. | A menu opens under it with the Find a branch field focused. |
| SHELL-79 | Open a repo page, wait a second, throttle the network, then open the branch menu; close it and open it again. | Each open shows the branch and tag list at once, with no "Loading branches and tags…"; a `branches` request refreshes it in the background. |
| SHELL-30 | With focus outside any text field, press **B**. | The branch menu opens. Pressing B inside a text field types a "b" instead. |
| SHELL-31 | Look at the Integration section. | develop and main, each on one row: icon, name in mono, a role chip (`default` on the default branch), `↑n ↓n` against the default branch, right-aligned, then the check column. A long name is cut off with an ellipsis; the chip and counts stay in place. |
| SHELL-76 | Look at the current target's row, in light and dark. | It has the active background and a check mark; a screen reader reads it as checked. |
| SHELL-77 | Open the menu, press ↓ and ↑, then Enter; reopen it and press Esc. | The arrows move focus through the rows (from the search field too); Enter sets the focused branch as the target; Esc closes the menu and focus is back on the trigger. |
| SHELL-66 | On `web-store`, open the branch menu with no runner online. | Below Integration, a Branches section lists release/1.2 and the feature branch, and a Tags section lists v1.0.0, v1.1.0 and v1.2.0-rc.1. |
| SHELL-32 | Type part of a branch name in Find a branch, then a name nothing has. | Every section filters as you type and an empty section hides; with no match the menu reads "No branches match". |
| SHELL-33 | Pick `main` on Code. | Code browses main; the URL is `/web-store/code/main/...`. |
| SHELL-34 | Pick `main` on Changes. | The URL gains `?target=main` and the board shows changes targeting main. |
| SHELL-35 | Set the target to main on Changes, then open Watchtower, Insights and Code from the sidebar. | Each keeps main as the target. |
| SHELL-36 | Set web-store's target to main, switch to svc-orders-go, then back. | Each repo keeps its own target for the session. |
| SHELL-37 | On Code, open the branch menu while you have a draft change and others in queue or needs fix. | Change workspaces lists only the draft changes, each as id and title; picking one browses that change's tree. |
| SHELL-38 | On Changes, open the branch menu. | No Change workspaces section. |
| SHELL-78 | Look at the menu header and footer. | The header reads "Target branch" and "Every page in &lt;repo&gt; follows it"; the footer has **All branches** (`B`) and **New branch**, both opening the Branches modal. |
| SHELL-40 | Open the menu on `svc-orders-go` (one integration branch). | The menu still opens, with All branches. |
| SHELL-41 | Make the branches request fail, then open the menu. | "Couldn't load branches" with Retry; Retry reloads the list. |
| SHELL-70 | Delay `/api/repos/*/branches` 3s and open the menu. | Below Integration, "Loading branches and tags…" shows until the Branches and Tags sections arrive. |
| SHELL-64 | Open the menu on a repo with many changes or branches in a short window. | The menu opens under the trigger; its sections scroll inside it, and the header, search and footer stay visible. |
| SHELL-42 | Put a deleted branch in the URL (`?target=gone`). | The page falls back to the default branch and a toast says so. |

## Branches modal

| ID | Check | Expected |
|---|---|---|
| SHELL-43 | In the branch menu, click **See all branches…**. | A modal lists every branch: Branch (a lock on protected ones), Role, Ahead / behind, Updated, and actions. |
| SHELL-67 | Open the modal on `web-store`, then push a new branch with `git push` and reopen it. | Every branch is in the table and the tags are in a separate Tags table with their commit; the pushed branch is listed after reopening. |
| SHELL-65 | Type part of a branch name in the modal's search. | Only matching branches stay in the list. |
| SHELL-44 | Click **Set as target** on a branch. | The modal closes and the page follows that branch; the current target shows a `target` tag instead of the button. |
| SHELL-45 | Type `test/manual-1` in the new-branch field and click **Create branch**. | The branch appears in the list. It's still there after reopening the modal. |
| SHELL-46 | Click **Delete** on `test/manual-1` and confirm. | The row disappears and stays gone after a reload. |
| SHELL-47 | Look at develop and main. | Protected (lock), with no Delete button. |
| SHELL-48 | Click **New change** on a feature branch. | Opens New change with that branch as head and the default branch as target. |
| SHELL-49 | As a Contributor, try Create branch and Delete. | Refused; the reason shows in the modal. |
| SHELL-50 | Open the modal, move through it with Tab, then press Esc. | Every control is reachable by keyboard; Esc closes the modal. |

## Account popover

**Setup:** the `accounts` seed section (organization `Nimbus Edge` with three accounts).

| ID | Check | Expected |
|---|---|---|
| SHELL-1279.1 | Click the account name in the sidebar header. | A popover: "Nimbus Edge · Organization", then Nimbus Edge Staging, Nimbus Edge Team and Nimbus Labs, each with its Git role, "via organization" when the access comes through the organization, and its repo count; then "Outside an organization" with the instance's account; then **Members** and **Account settings**. The active account has a check. |
| SHELL-1279.2 | Click another account. | The check moves at once, the header shows its name, and the page reloads its data: All repositories lists only that account's repos. |
| SHELL-1279.3 | With the network offline, click another account. | The check goes back to the previous account and a toast says "Couldn't switch to <account>". |
| SHELL-1279.4 | Click **Members**, then reopen the popover and click **Account settings**. | Each opens `/settings/access`. |

## User menu

| ID | Check | Expected |
|---|---|---|
| SHELL-51 | Click the user icon at the far right. | A menu with your name and email, My model access (with a `new` tag), Toggle theme, Access & people and Sign out. |
| SHELL-52 | Click **My model access**. | Opens `/me/models` and the menu closes. |
| SHELL-53 | Click **Toggle theme** in the menu. | The theme swaps, as with the top-bar toggle. |
| SHELL-54 | Click **Access & people** in the menu. | Opens `/settings/access`. |
| SHELL-55 | Click **Sign out**. | You're signed out of Access; reloading asks you to sign in again. |

## Mobile drawer

| ID | Check | Expected |
|---|---|---|
| SHELL-61 | At 390px wide, look at the top bar. | A hamburger button; no sidebar; Support is hidden; the crumbs truncate. |
| SHELL-62 | Tap the hamburger, then tap a sidebar item. | A 280px drawer opens with the full sidebar; tapping an item navigates and closes it. |
| SHELL-63 | Open the drawer and tap outside it. | The drawer closes. |

## Sign-in states

| ID | Check | Expected |
|---|---|---|
| SHELL-73 | Load a page with only the headers of a service token that isn't allowed in Settings › Access & people. | "This Access identity has no email" with a line that an owner must allowlist the service token; no "Session expired" and no Sign in button. |

## Known gaps

The current shell differs from the spec in these checks; they're expected to fail until it's built.

- **SHELL-16, SHELL-17:** the picker has no loading name or error state of its own.
- **SHELL-20:** the repo in the top bar has no ⌄ menu of its own; repos switch from the sidebar's picker.
- **SHELL-42:** a deleted target branch shows Code's "Branch not found" note; other pages show no toast.
- **SHELL-43:** the modal has separate Ahead and Behind columns and no Updated column.

## Planned

- Collapsing the sidebar with the footer button.
- The account switcher in the sidebar header.

## Retired

- SHELL-09: the inert platform items; the sidebar lists only items that open cinder's resources.
- SHELL-39: the footer note; the menu header now says what the target sets (SHELL-78).
- SHELL-03, SHELL-07, SHELL-72, SHELL-75: Issues, Releases and Wiki left the repo's items; replaced by SHELL-1243.1 to SHELL-1243.5.
- SHELL-56, SHELL-57, SHELL-58, SHELL-59, SHELL-60: Ctrl K and the sidebar's Quick search were removed; the app has no global search. In-page filters stay.
