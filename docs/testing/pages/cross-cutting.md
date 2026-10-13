# Cross-cutting

- **Route:** every page
- **Sidebar:** every page, once per pass
- **Backed by:** the `cinder` Worker serving the static app; shape hints live only in the browser's localStorage ([map](../../ARCHITECTURE-CLOUDFLARE.md#2-page-by-page-map))
- **Spec:** [Using cinder › Loading](../../usage/README.md#loading)

**Setup:** any seeded repo with data (`svc-orders-go`), one with little data (`infra-cloudflare-tf`), and an empty repo named `manual-empty-<n>` made with New repository and deleted afterwards. Use the browser's device toolbar for widths, its network throttling for slow loads, and its console.

## Layout alignment

Run each width row on every page in the [page list](../README.md#pages).

| ID | Check | Expected |
|---|---|---|
| XC-01 | At 1440px, compare the title (or toolbar), the toolbar and the first card. | All three share one left edge; nothing scrolls sideways. |
| XC-02 | At 1100px, repeat XC-01. | Same shared left edge. Repositories' and the Agents index's aside drops below the main column. |
| XC-03 | At 900px, repeat XC-01. | Same shared left edge; single column; page actions wrap under the toolbar; tables scroll inside their card, never the page. |
| XC-04 | At 390px, repeat XC-01. | Same shared left edge with 16px side padding; no sideways page scroll anywhere. |
| XC-05 | Open the Changes board and the Issues board at 1440×900. | The page doesn't scroll; each column scrolls on its own. |
| XC-06 | Open Code, Change detail and the Flows designer at 1300px, then 1000px. | At 1300px the left rail becomes a strip; at 1000px everything stacks. |
| XC-40 | At 1920px, open every page, Watchtower and Code included. | The content stops at 1440px wide, centred; the title, the first card and the last page action sit on the same edges on every page. |
| XC-41 | At 1440px, repeat XC-40. | The content fills the width less the 32px side padding; the edges match on every page. |
| XC-42 | At 1280px, repeat XC-40. | Same edges on every page; Repositories' and the Agents index's aside sits inside the content width. |
| XC-43 | At 390px, repeat XC-40. | Same edges with 16px side padding; wide boards, tables, the flow canvas and log lines scroll inside their own box, never the page. |

## Loading states

| ID | Check | Expected |
|---|---|---|
| XC-08 | Throttle to Slow 3G and open each page. | A skeleton draws first: the real frame, card titles, table headers, column names and segmented controls, with bones only where data goes. |
| XC-36 | Delay `/api/**` 4s and load `/needs`, `/automation/agents` and `/settings/keystore` directly. | The sidebar and top bar draw at once, never a blank page; pages with a first-load skeleton (Needs you, Change detail, Flows) show it; the console has no HydrateFallback warning. |
| XC-38 | Delay only `/api/repos` 4s and load `/`, `/automation/judges` and `/settings/access` directly. | Each page draws its skeleton at once inside the shell; the sidebar's repo list fills in when `/api/repos` answers. |
| XC-09 | Watch a page go from skeleton to data. | Nothing moves when the data lands: no card, header or button shifts. |
| XC-10 | Open a page whose data is empty (Releases on `svc-orders-go`, Changes on the empty `manual-empty-<n>` repo from Setup). | The empty state sits where the skeleton's first card was; no shift. |
| XC-39 | Open `acme/status-page` (a repo with no code) and visit Changes, Issues, Releases, Watchtower, Wiki, Insights, Flows and Environments. | Each shows one card with a centred icon, title, one sentence and **Quick setup** (opens Code); Changes adds **Describe a change**, Issues **New issue**, Wiki **Create the first page**. No list, chart or 0% shows. |
| XC-1378.1 | Make `manual-empty-<n>` with New repository (strategy trunk) and open its Wiki; then push a first commit to `main` and reload. | Before the push: the empty state with **Create the first page** and **Quick setup**. After it: the wiki's page list, no empty state. |
| XC-11 | Look at a skeleton's bones. | Flat tint, pulsing gently and staggered by row; no shimmer gradient. |
| XC-12 | Turn on reduced motion in the OS and reload a slow page. | Bones sit still at a lower opacity; menus and group headers don't animate. |
| XC-13 | On a fast connection, open a page. | No skeleton flashes for loads under 150ms; once shown, a skeleton stays at least 300ms. |
| XC-14 | Block an API request so a page never answers, and wait 10 seconds. | "Still loading…" appears with Retry. |
| XC-15 | With a screen reader or the accessibility tree, load a page. | One hidden "Loading &lt;page&gt;" status line and `aria-busy` on the loading region. |

## Last-known shape

| ID | Check | Expected |
|---|---|---|
| XC-16 | Open Needs you (n items), then reload with throttling on. | The skeleton shows n bone cards, matching the last visit. |
| XC-17 | Open a repo's Changes board, note each column's count, reload throttled. | Each column's skeleton shows the same number of cards as before. |
| XC-18 | Open Keystore, then reload throttled. | The skeleton table uses the same row count and column widths as the real table. |
| XC-19 | Open a page that was empty last visit (Releases on `svc-orders-go`), reload throttled. | The empty state shows at once, with no bones. |
| XC-20 | In a private window (empty storage), load each page throttled. | The default counts draw (for example 4 repo cards, 3 Needs-you cards). |
| XC-21 | In devtools, look at localStorage keys starting `shape:`. | They hold counts and widths only, never names, text or any other data. |

## Error states

| ID | Check | Expected |
|---|---|---|
| XC-22 | Block one page's API request (devtools request blocking) and reload. | A card error with a danger dot, the message and **Retry**, in the first card's place; the title and toolbar stay. |
| XC-23 | Unblock it and click **Retry**. | The data loads in place without a full reload. |
| XC-24 | Let the Access session expire (or clear the Access cookie), then click around. | "Session expired, sign in again" with **Sign in**; it goes through Access and back. |
| XC-35 | Open `/no-such-repo/insights`, then `/automation/environments`. | "Page not found" with "404 Repo not found" and an **All repositories** link inside the shell (sidebar and top bar stay), never "[object Object]"; the second lands on the current repo's Environments. |

## Theme

| ID | Check | Expected |
|---|---|---|
| XC-25 | Clear `cinder.theme` from localStorage, set the OS to dark, reload. | The site opens dark. |
| XC-26 | Toggle to light, reload. | Stays light (the choice beats the OS setting). |
| XC-27 | Visit every page in dark, then in light. | Text, borders, charts, pills and code stay readable; no white flash on navigation; no hard-coded colour stands out. |

## Keyboard and focus

| ID | Check | Expected |
|---|---|---|
| XC-28 | On each page, Tab from the top. | Every button, link, field and toggle is reachable in a sensible order, with a visible focus ring. |
| XC-29 | On a segmented control (Board / List, Overview / Usage), press the arrow keys. | The selection moves; the focused tab is the selected one. |
| XC-30 | Open each modal and dialog, then press Esc. | Focus moves into it on open; Esc closes it. |
| XC-31 | Open each popover menu (⋯, Promote, filters), then press Esc. | It closes and focus returns to its button. |

## Console and network

| ID | Check | Expected |
|---|---|---|
| XC-32 | With the console open, visit every page and use its main controls. | No errors and no unhandled promise rejections. |
| XC-33 | Watch the network tab while visiting every page. | No 4xx or 5xx responses other than ones a check provokes on purpose. |
| XC-34 | Search every response body in the network tab for a saved secret value or model key. | It never appears. |

## Change ids

| ID | Check | Expected |
|---|---|---|
| XC-37 | Look at change ids on Changes (board and list, including a card's why-line), a change's header, Needs you (including an item's text), New change, Flows (after saving a flow, and run ids that contain one), Code's workspace strip and collision line, the Collisions page and an agent run. Hover one, then select and copy it. | A change with a key (Changes cards and rows, the change header, a flow-save toast, Code's workspace views) shows its key in mono with the full id on hover, and its links open `/<repo>/changes/<KEY>`. Any other id shows its first 8 characters in mono, never a 36-character id; the tooltip and the copied text are the full id; links open the full-id URL. |

## Known gaps

- **XC-13, XC-14:** skeletons show at once and never add "Still loading…"; the timing helper isn't wired into the pages yet.

## Planned

- None.

## Retired

- **XC-07:** read pages at 1200px and work pages at 1600px; every page shares one 1440px width now (XC-40 to XC-43).
