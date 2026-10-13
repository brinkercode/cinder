# Wiki

- **Route:** `/wiki` (folders), `/wiki/:repo/:id?[?v=edit|history][&q=]`
- **Sidebar:** Wiki, below Needs you
- **Backed by:** the Artifacts git repo `cinder-wiki` (each page is `<repo>/<id>.md`; every save is a commit); D1 for the page tree, comments and the search index ([map](../../ARCHITECTURE-CLOUDFLARE.md#2-page-by-page-map))
- **Spec:** [ARCHITECTURE-CLOUDFLARE › rules](../../ARCHITECTURE-CLOUDFLARE.md#0-rules)

**Setup:** the seeded org pages and `svc-orders-go`'s runbook (versions, a comment, search hits). Create throwaway pages with **New page** and title them `Manual test <n>`.

## Folders

| ID | Check | Expected |
|---|---|---|
| WIKI-01 | Click **Wiki** in the sidebar. | `/wiki` lists one folder per repository. |
| WIKI-02 | Click `svc-orders-go`. | Opens `/wiki/svc-orders-go` on its first page, with the Pages tree on the left. |
| WIKI-03 | Open `/svc-orders-go/wiki`. | Redirects to `/wiki/svc-orders-go`. |

## Pages tree and search

| ID | Check | Expected |
|---|---|---|
| WIKI-04 | Click a page in the tree. | It opens; its row is marked current and is no longer a link. |
| WIKI-05 | Type `runbook` in Search the wiki and press Enter. | Hits list with title, path and the matched text highlighted; each opens its page. |
| WIKI-06 | Search for `zzqqzz`. | "No pages match." |
| WIKI-1252.1 | Open a page inside a folder and click **New page**. | An "Untitled" page opens in Edit; after Save it sits in that folder in the tree. |
| WIKI-1856.1 | Look at a folder, or a page with sub-pages, in the tree, then click its chevron. | A folder row: chevron, folder icon, name in small capitals and its child count; the click collapses and expands it. A page's name in the row opens the page. |
| WIKI-1252.3 | Flag a page as agent context, then reload. | The page carries a robot mark in the tree. |

## Page view

| ID | Check | Expected |
|---|---|---|
| WIKI-1252.4 | Look at a page at full width. | Page tree, reading column and rail side by side; breadcrumb `repo › folder › page` with **History**, **Edit** and **⋯**; the title, then "Updated … by … · v…". |
| WIKI-1252.5 | Narrow the window below 1280px, then below 900px. | The rail moves under the page as a grid; then everything stacks in one column. |
| WIKI-1252.6 | Look at the rail's Page info. | Edited by, last edited, views, words and read time. |
| WIKI-1252.7 | Turn on **Agents read this page**. | It flips at once, an **Agent context** chip shows under the title, and "about N tokens" is within 10% of the page's tokens in `GET /api/repos/:name/wiki/context`; a reload keeps it. |
| WIKI-1252.8 | With the network offline in dev tools, flip the agent context switch. | It flips, then flips back with an error. |
| WIKI-1252.9 | On a page with `##` headings, click one under On this page. | The page scrolls to that heading. |
| WIKI-1252.10 | Look at the rail's History; click **All N versions**. | The last 3 versions; the link opens History. |
| WIKI-1252.11 | Open **⋯**: click **Copy link**, then **Move**. | The page link is on the clipboard; Move jumps to the rail's Location. |
| WIKI-10 | Pick a new parent in the rail's Location and click **Move**. | The page moves in the tree; a reload keeps it. |
| WIKI-11 | Check the parent select on a page with children. | The page itself and its own children aren't offered. |
| WIKI-12 | Open **⋯**, click **Delete** on `Manual test 1` and confirm. | The page and its sub-pages leave the tree; you land on the folder. |

## Edit

| ID | Check | Expected |
|---|---|---|
| WIKI-13 | Click **Edit**, change the text, add a Note, click **Save page**. | The Page view shows the new text; History lists a new version with your message; a reload keeps it. |
| WIKI-1253.1 | Click **Edit**. | A toolbar (Bold to Table) with Write / Split / Preview, the title as a large input, the text beside a live preview, and a footer with Note, "Markdown · Esc to cancel", **Cancel** and **Save page**. |
| WIKI-1900.1 | In Edit, look at the toolbar and hover each button. | Eight icon buttons, Bold to Table, with no words; each tooltip names the action, and Bold, Italic and Link also name `Ctrl B`, `Ctrl I` and `Ctrl K`. |
| WIKI-1900.2 | Select a word and press `Ctrl B`, `Ctrl I`, then `Ctrl K`. | Each wraps the word as its toolbar button does. |
| WIKI-1253.2 | Select a word and click each toolbar button in turn. | Each wraps the word in its Markdown (`**`, `_`, `## `, `- `, `> `, backticks, a link, a table). |
| WIKI-1253.3 | Type in Split, then switch to Write and Preview. | The preview follows each keystroke; Write shows only the text, Preview only the rendered page. |
| WIKI-1253.4 | Change the text and press `Ctrl S`. | The page saves as with **Save page**; the browser's save dialog doesn't open. |
| WIKI-1253.5 | Change the text and press `Esc`; decline, then press `Esc` again and accept. | It asks first; declining keeps the text, accepting returns to the page unchanged and History has no new version. |
| WIKI-1253.6 | Click **Edit**, change nothing and click **Save page**. | Back on the page with no request sent (network tab) and no new version. |
| WIKI-27 | In Edit, change the Title and click **Save page**. | The new title shows on the page and in the tree. |
| WIKI-14 | Open Edit in two tabs, save in one, then save in the other. | The second save is refused with the conflict message; its text stays in the editor. |

## History

| ID | Check | Expected |
|---|---|---|
| WIKI-1253.7 | Click **History**. | Versions newest first (v-number, message, editor and date), the current one tagged **current**; the diff against the previous version with its + and − counts. |
| WIKI-16 | Click an older version. | The diff shows that version against the one before it. |
| WIKI-1253.8 | Open an older version and click **Restore vN**. | A new current version with the old text, "Restored to vN"; the Page view shows it after a reload. The current version has no Restore. |
| WIKI-18 | Open the first version. | "v1 is the first version; nothing to compare." |
| WIKI-19 | Look at the `cinder-wiki` Artifacts repo after a save. | A new commit on `<repo>/<id>.md` for the save. |

## Comments

| ID | Check | Expected |
|---|---|---|
| WIKI-20 | Type a comment and click **Comment**. | It shows with your name and date and the comment box is empty; a reload keeps it. |
| WIKI-21 | Open **Edit** on a comment, change it, click **Save comment**. | The new text shows, marked "edited". |
| WIKI-22 | Click **Delete comment**. | It's gone after a reload. |
| WIKI-1383.1 | Signed in as a member who is not an owner, click **Delete comment** on someone else's comment. | Cinder refuses with an error, and the comment is still there after a reload. |

## States

| ID | Check | Expected |
|---|---|---|
| WIKI-1252.12 | Open a folder with no pages. | "No wiki pages yet" with **Write the first page**, which opens a new untitled page in Edit. |
| WIKI-24 | Open `/wiki/svc-orders-go/no-such-page`. | "Page no-such-page not found" with **Back to the wiki**. |

## Known gaps

- None known.

## Planned

- **Delete page** also removing the page's file from `cinder-wiki` (today the file and its history stay).
- One page tree and search across every folder.

## Retired

- WIKI-07, WIKI-08: New page no longer takes a title and parent; see WIKI-1252.1.
- WIKI-09: the page is no longer a card; see WIKI-1252.4.
- WIKI-23: the empty wiki has an action now; see WIKI-1252.12.
- WIKI-25, WIKI-26: the editor was redesigned; see WIKI-1253.1 and WIKI-1253.5.
- WIKI-15, WIKI-17: History was redesigned; see WIKI-1253.7 and WIKI-1253.8.
- WIKI-1252.2: pages with sub-pages are folder rows too, with a chevron; see WIKI-1856.1.
