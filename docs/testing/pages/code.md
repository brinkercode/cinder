# Code

- **Route:** `/:repo/code/:ref/*`
- **Sidebar:** Code ▸ *repo picker* ▸ Code
- **Backed by:** the repo's Artifacts repo (git storage); tags, authorship and symbols indexed in D1 ([map](../../ARCHITECTURE-CLOUDFLARE.md#2-page-by-page-map))

**Setup:** `infra-cloudflare-tf` on main (history, symbols, an agent's lease on `main.tf` and a person's lease on `tests/plan.tftest.hcl`); `svc-orders-go` on main (`orders.go` with authorship and a lease rail); an empty repo named `manual-empty-<n>` made with New repository and deleted afterwards. Write edits only to throwaway paths such as `test/manual-<n>.md`.

## Toolbar

| ID | Check | Expected |
|---|---|---|
| CODE-01 | Open `/infra-cloudflare-tf/code/main`. | Row 1: a full-width search, **Releases**, **Add file**, **Clone** and **New change**. Then the Commits card, then files / viewer / Active in repo. |
| CODE-02 | Type `backoff` in Search in code and press Enter. | The viewer lists matches as `path:line` with the matching line, each line once; each opens the file. |
| CODE-03 | Search for `zzqqzz`. | "No matches." |
| CODE-04 | Click **Clone**, then its copy button. | A popover with the HTTPS URL and a copy button, the token command `cinder repo credentials <repo>`, Push a branch (`git push origin my-branch`, naming the protected branches that roll back direct pushes) and Propose straight from git (`git push origin HEAD:refs/for/<target>`). No other `cinder` command and no **Get git credentials** button show. Copying puts the URL on the clipboard and shows a "Copied the clone URL" toast. |
| CODE-74 | Block clipboard access for the site, then click the copy button in the Clone popover. | No toast; the URL is selected in the popover, ready to copy by hand. |
| CODE-1777.1 | With `CINDER_URL` and `CINDER_TOKEN` set, run `cinder repo credentials <repo>`, then clone with any username and the printed token as password. | The CLI prints `{remote, token, expires_at}`; the clone succeeds; the URL itself carries no token. |
| CODE-1777.2 | Signed in in the browser, run `fetch("/api/repos/<repo>/git-credentials", {method: "POST"})` in the console. | 403 `cli_only`, naming `cinder repo credentials <repo>`; no token. |
| CODE-1830.1 | With `CINDER_URL`, `CINDER_ACCESS_CLIENT_ID` and `CINDER_ACCESS_CLIENT_SECRET` set (an allowlisted service token) and no `CINDER_TOKEN`, run `cinder repo credentials <repo>`, then clone and push a branch with any username and the printed token as password. | The CLI prints `{remote, token, expires_at}`; no 403 `cli_only`; the clone and the push succeed. |
| CODE-54 | In the clone, `git switch -c test-branch`, commit, `git push origin test-branch`. | Within a few seconds `test-branch` is in the branch menu and the Branches modal; no runner job needed. |
| CODE-55 | `git push origin HEAD:main` with a new commit. | Git reports success, then within seconds main is back at its previous commit; the commit lands only through a change. |
| CODE-58 | Open a leased file (e.g. `main.tf` in `infra-cloudflare-tf`), note a line's y position, then click **Edit**. | The lease strip and band show in Edit too, and no line moves, not even by 1 px. |
| CODE-59 | Open a 5-line file, click **Edit**; then open a 200-line file and click **Edit**. | The editor is as tall as the short file's five lines (no layout shift from View) and 560 px for the long one (it scrolls inside); the footer sits directly under it. |
| CODE-06 | Click **New change**. | Opens the repo's New change page. |
| CODE-1243.1 | Open Code on a repo with tags at 1440px wide, then click **Releases**. | **Releases** sits between search and **Add file** with the newest tag as a chip; the toolbar draws before the chip arrives. The link opens the repo's Releases. |
| CODE-1243.2 | Open Code on a repo with no tags. | **Releases** shows with no chip. |
| CODE-1243.3 | Open Code on a repo with tags at 1000px wide. | **Releases** shows with no chip. |
| CODE-56 | Open `/checkout-js/code/main/src/cart/total.js` at 390px wide. | Search in code takes the full row with its placeholder visible; Add file, Clone and New change wrap below it. |

## Commits card

| ID | Check | Expected |
|---|---|---|
| CODE-07 | Look at the closed Commits card. | "Latest: &lt;sha&gt; &lt;message&gt; · &lt;age&gt;" and the commit count ("1 commit", "n commits"). |
| CODE-08 | Open the card. | 10 commits per page in one-line rows: sha, message (ellipsis), author, change, verifier, age; then the pager. |
| CODE-09 | Click page 2, then ›, », ‹ and «. | Each loads the right page; the buttons that would go nowhere are disabled; "Showing x–y of n" updates. |
| CODE-10 | Open the card on page 2, reload, then open another file. | The card stays open on page 2 for this session. |
| CODE-11 | Click a commit's sha. | The viewer shows that commit's diff, a file per section, with **All commits**. |
| CODE-12 | Click a commit's change id. | Opens that change. |
| CODE-67 | Open a change workspace on Code; look at the Commits card, a lease strip, the workspace note, the Files header and the branch menu's Change workspaces. | The workspace's change shows its key (PULSE-12) in the Commits card header, the workspace note, the Files header and Change workspaces (whose search also matches the key), with the full id on hover. Other change ids show their first 8 characters; hovering shows the full id, and copying it copies the full id. |
| CODE-65 | In a commit's diff, click **All commits**. | The viewer reads "Commits on &lt;ref&gt;" and lists the ref's commits, 10 a page, with the pager. |
| CODE-13 | Narrow the window below 760px, then below 520px. | Author and change hide first, then verifier; rows stay on one line. |

## Files tree

| ID | Check | Expected |
|---|---|---|
| CODE-14 | Look at the Files card. | Folders first, then files; the ref name in the header. |
| CODE-15 | Type `test` in Find a file. | The tree filters to matching paths; "No files match." when none do. |
| CODE-16 | Click a folder. | It folds and unfolds. |
| CODE-17 | Click a file. | The URL changes to the file's path and the viewer opens it; the file is marked current. |
| CODE-18 | Look at a leased file. | A lease dot: blue for an agent's lease, orange for a person's. |

## Viewer

| ID | Check | Expected |
|---|---|---|
| CODE-19 | Open the repo root. | The README renders as markdown. |
| CODE-20 | Open a source file. | Path, line count, Code / Blame / History, Edit, Copy; then code with a gutter and syntax colours (also for `.ts`, `.tsx`, `.py`, `.cs` and `.tf`). |
| CODE-21 | Click **Blame**. | An author · change · age column; the URL gains `?v=blame` and a reload keeps it. Before the blame job has reported for the file: one "Blame not computed yet. It is queued…" note and no blank column. |
| CODE-22 | Click **History**. | The file's commits, each with sha, change link, author and age. |
| CODE-23 | Click **Copy**. | The file's text is on the clipboard. |
| CODE-24 | Open a leased file in `infra-cloudflare-tf`. | A lease strip above the leased symbol ("leased by &lt;change&gt; · &lt;holder&gt; · mode") and lease-band highlighting on its lines. |
| CODE-25 | Have an agent take or release a lease while the file is open. | The band and strip update without a reload. |
| CODE-26 | Open a binary file (an image). | Its size and a **Download** link instead of code. |
| CODE-27 | Open `/infra-cloudflare-tf/code/main/no/such/file`. | "File no/such/file not found" with **Back to files**. |
| CODE-28 | Open `/infra-cloudflare-tf/code/no-such-branch`. | "Branch not found: no-such-branch. Showing &lt;default&gt;"; the branch trigger in the top bar reads &lt;default&gt;. |

## Active in repo

| ID | Check | Expected |
|---|---|---|
| CODE-29 | Look at the right column on the repo root. | "Active in &lt;repo&gt;" with a live label: at most 3 active leases, one row per change (its symbol lease before a file-level one), each with its change title (a link), holder (the driving agent, or the person who took over), file and symbol; "See all &lt;n&gt;" opens Changes when more are held; "No active leases." when none are. |
| CODE-30 | Open a leased file. | "Live on this file": each holder, path:lines and time left. |
| CODE-68 | Open a file where one change holds a symbol lease and a file lease. | "Live on this file" lists the change once, showing its symbol lease. |
| CODE-69 | Open a file leased by a change a runner has claimed. | Its holder reads `<agent>@<version>`, not "agent@pending". |
| CODE-31 | Open an unleased file. | "No one holds a lease here. Edit freely; your change takes the leases it needs." |

## Edit and commit

| ID | Check | Expected |
|---|---|---|
| CODE-32 | On a file on main, click **Edit**. | Under the editor: **Message** with its hint on the left (no link to New change); **Where it goes** on the right with **Open a change · you drive** checked, **Hand to an agent**, and **Commit directly to main** dimmed with "Unavailable: the verifier owns every merge into integration branches." Then **Rename, move or delete** (closed), and a bottom bar under a border: "No edits yet", **Cancel**, **Stage**, **Open change**. Under 1100 px the message and destination stack. |
| CODE-85 | In Edit, Tab through the footer. | Focus moves through Message, the two enabled radio cards (arrow keys switch them) and the bar's buttons; the disabled commit card is never focused. The checked card has an interactive-coloured border and tint, in light and dark. |
| CODE-86 | In Edit, change two lines; then pick each destination. | The bar reads "2 lines changed"; only the path changed reads "Renamed". The primary button reads **Open change**, **Hand to agent** or **Commit to** *branch*, and stays disabled until there is an edit and a message, its tooltip saying which is missing. |
| CODE-88 | Edit a file an agent holds a lease on. | A note under the footer names the leased symbol and its holder and says the change waits for the lease or asks its holder to hand over. |
| CODE-89 | Edit a file, enter a message, pick **Hand to an agent** and click **Hand to agent**. | The change is created from the footer, without passing through New change, and opens: written by an agent, starting from the edit, with the message as its intent. |
| CODE-2019.1 | Edit a file, pick **Hand to an agent** and leave the message empty; then type one. | **Hand to agent** is disabled and the bar reads "Add a message: it becomes the agent's intent"; with a message the button enables and the reason goes. |
| CODE-33 | Edit, then click a sidebar link. | A confirm asks before leaving; Cancel keeps the edit. |
| CODE-71 | Scroll down a file, click **Edit**, then **Cancel** without typing. | The file's Code view returns with its original content at the same scroll position. |
| CODE-72 | Edit a file, type, click **Cancel**; click **Keep editing**; click **Cancel** again and **Discard**. | Cancel asks in the page (no browser dialog); Keep editing keeps the typed text in Edit; Discard returns to View with the original content. |
| CODE-73 | Click **Edit**, then press Escape with focus outside any dialog. | Same as **Cancel**: View returns, or the discard question shows when there are unsaved edits. |
| CODE-2020.1 | In Edit, clear the file name in the path field on the file line and type the start of a folder in the repo. | The field suggests the repo's folders; picking one and adding a name, then **Stage**, lists a "rename" in Staged with the old path. No rename, move or delete box shows under the editor. |
| CODE-81 | Click **Edit**. | The header shows the file path as an editable field, an **Editing** pill, **Stage delete** and **Cancel**; the view switch, **Edit** and copy are gone; the card border takes the brand colour. Never **Edit** and **Cancel** at once. |
| CODE-78 | In Edit, open the Clone popover and press Escape inside it. | The popover closes and Edit stays. |
| CODE-79 | In Edit, change only the rename path, then click a sidebar link. | A confirm asks before leaving; reloading the tab asks too. |
| CODE-80 | Open a `.md` file, switch **Preview**, **Source**, **History**. | Opens on the rendered markdown; Source shows the code with a gutter; no network requests on switching; the URL's `?v=` follows. |
| CODE-34 | On a non-integration branch, edit `test/manual-1.md`, enter a message, pick **Commit directly to** *branch* and click **Commit to** *branch*. | The file's History opens with the new commit at the top; reload keeps it; the Commits card count goes up by 1. |
| CODE-35 | Edit a file, enter a message, click **Open change**. | A new change you drive opens with the edit in Files changed. |
| CODE-36 | Edit a file in another tab and commit, then commit from the first tab. | Refused with "Someone committed first; reload to rebase your edit"; the edit stays in the form. |
| CODE-38 | On a non-integration branch, click **Add file**, enter `test/manual-2.md`, text and a message, click **Commit new file**. | The new file's History opens; the file is in the tree. |
| CODE-93 | On main, click **Add file**, enter `test/manual-3.md`, text and a message, click **Commit new file**. | Refused under the form with "main is an integration branch; open a change to land on it"; main's Commits card count is unchanged. |
| CODE-39 | In Add file, click **Upload** and pick two text files. | Both appear in Staged files under the typed folder. |
| CODE-66 | Open a `.ts` file with a multi-line comment, note its colours, then click **Edit**. | View and Edit look identical: same colours (the comment's later lines too), font, gutter and padding; only the cursor is new. |
| CODE-60 | With a file scrolled to the top, click **Edit**, then **Code** again (throttle the network for a first visit). | No layout shift: the line numbers and code stay put; while the editor loads, the lines show coloured, never as plain unstyled text. Below the editor the footer starts 16 px in from the card edge. |
| CODE-1861.1 | At 1440 px and at 390 px, in light and dark, open a file, then click **Edit**. | The line numbers sit 16 px from the code in both Code and Edit; switching moves neither the numbers nor the code. |

## Staged files

| ID | Check | Expected |
|---|---|---|
| CODE-40 | Edit a file and click **Stage**; open another file, **Edit** it and click **Stage delete** on the file line. | A Staged card above the file lists both with their icon, path, an "edit" and a "delete" tag and **Unstage**; the tree marks them `M` and `D`. |
| CODE-41 | Change the path field to a new path and click **Stage**; change it again and click **Stage**. | One entry, at the last path, reads "← &lt;old path&gt;" with a "rename" tag. Staging a path again replaces its entry. |
| CODE-42 | Click **Unstage** on one entry. | It leaves the list. |
| CODE-43 | Enter a message in the Staged card and click **Open change · n files**; with files staged again, click **Discard all**. | One change opens holding every staged file and moves to Verifying on that commit; Discard all empties the card. |
| CODE-44 | Stage a file, then switch the branch in the top bar. | A confirm warns the staged files will be lost. |

## Change workspaces

| ID | Check | Expected |
|---|---|---|
| CODE-45 | Pick a change workspace in the branch menu. | The tree is that change's; a note reads "Workspace of &lt;change&gt; · &lt;agent&gt; · &lt;state&gt;" with **Take over**. |
| CODE-46 | Click **Take over**. | "You are driving; the agent is paused." Edit becomes available; a reload keeps it. |
| CODE-47 | Edit a file in the workspace, pick **Commit to workspace** *change* and click **Commit to workspace**. | The edit commits into that change's workspace and the change opens. |
| CODE-61 | Open `/:repo/code/release/1.2` and `/:repo/code/release%2F1.2/src/a.ts` on a repo with branch `release/1.2`. | The root and then `src/a.ts` open on `release/1.2`; the branch menu reads `release/1.2`, the address shows `release%2F1.2`. Before the branch list answers, reads of `release` alone may 404; nothing else fails. |
| CODE-62 | From a file on `release/1.2`, pick `feature/x` in the branch menu, then reload. | The same file opens on `feature/x` before and after the reload. |

## States

| ID | Check | Expected |
|---|---|---|
| CODE-48 | Reload throttled. | Disabled toolbar, a Commits bone row, a 12-row tree, 24 code-line bones with gutter bones, 3 Active rows. |
| CODE-57 | Reload `/checkout-js/code/main` throttled at 1440px wide. | The skeleton toolbar has a full-width search, Add file, Clone and New change on one row, as when loaded; the Commits card doesn't move when the page loads. |
| CODE-82 | Open `/manual-empty-<n>/code/main` on the empty repo from Setup at 1440, 1024 and 390px, in light and dark. | **Quick setup**, centred in the work area and at most 760px wide: "manual-empty-<n> is empty…", the clone URL with copy, the `cinder repo credentials manual-empty-<n>` note, two command blocks, "or start in the browser", **Create a README** and **Add a file**, and the note on `refs/for/main`. No **Import** button; no console error. |
| CODE-83 | On Quick setup, copy the clone URL and each command block. | The URL and every command carry the repo's real clone URL, name and default branch; the page shows no token. |
| CODE-84 | On Quick setup, click **Create a README**, add a message and click **Commit new file**. | The editor opens with path `README.md` and `# manual-empty-<n>`; the commit creates the branch and the page leaves Quick setup for the file's history. **Add a file** opens the editor blank. |
| CODE-50 | Block the code API and reload. | "Couldn't load code" with the request (method and URL) and Retry, under the disabled toolbar. |
| CODE-51 | Throttle the network, open a file, then click another file in the tree. | The tree stays and is not requested again; the previous file stays in the viewer, dimmed and `aria-busy`, until the new one lands: no bones, never blank. |
| CODE-92 | Open two files, then click between them in the tree several times. | The new file swaps in at once: no skeleton, no blank or dimmed frame, and the toolbar, tree, file header and rail don't flicker. |
| CODE-70 | With a file open, throttle the network to a slow connection and click another file in the tree; then click a third file. | The address, the tree's highlighted file and the heading move to the clicked file at once while the viewer is `aria-busy`; the second switch requests only the file (no `changes`, `lease-map` or `symbols`). |
| CODE-52 | With a file open, switch **Code**, **Blame** and **History**, then hover **Edit**. | The view switches with no network requests; hovering **Edit** starts loading the editor. |
| CODE-63 | Throttle the network, open a file, then click another file. | The content shows as soon as the `file` request lands, before its `log?path=` and `authorship` answer; no `tree` or `log?…&page=1` request is made. |
| CODE-64 | Open file A, then file B, then A again. | Returning to A makes no `file` request. **Blame** and **History** fill in once their own requests land. |
| CODE-76 | With a file open, let an agent take a lease or open a change, then click another file. | The event requests only the root `tree` level (no deeper `tree` or `file`); the click requests only the new file. After a push to the branch, the next event reloads the tree. |
| CODE-75 | Throttle the network and open a file. | The content shows before the `log?…&page=1` request answers; the Commits card fills in after it. |
| CODE-90 | Throttle the network and reload a file's link on `main`. | The `file` and `tree` requests start at once, without waiting for `branches`; the file shows before `branches` answers. |
| CODE-91 | Reload a commit's diff link (`?v=commits&sha=…`), then after a push to the branch click a commit's sha. | The `commits/<sha>` request starts with the `file` request, not after it; the diff shows even while the new `log?…&page=1` request is pending. |
| CODE-1435.1 | Open a change workspace (`/:repo/code/<change id>`). Click **Release lease**, then **Give it back**. Type a line in **Message agent** and send it. | The strip above the files names the agent, workspace, intent and leased symbols. Release reads "Lease released. The agent is paused…" and the button becomes **Give it back**; giving back re-grants the lease. The message reads "Sent “…”. The agent reads it before its next step." Release while the change is mid-commit reads "Couldn't release the lease: … is mid-commit…". |
| CODE-1432.1 | Open a file one change leases, then let another change's agent push a write to one of its symbols. | **Live on this file** shows "<other> is changing the signature of <symbol>, which <holder> leases" without a reload, and the holder's row reads its mode and "editing now". It goes after 10 minutes without a write. |
| CODE-1434.1 | Edit lines outside any leased symbol and press **Open change**. | No prompt; the change opens. |
| CODE-1434.2 | Edit inside a symbol another change leases, add a message and press **Open change**. | A prompt above the bottom bar shows the symbol and lines, the holder and its change, the lease expiry, and the three options (p(collision) on the parallel one). **Back to editing** closes it. |
| CODE-1434.3 | In the prompt choose **Stack on** or **Run in parallel**, then **Continue**. | The change opens, stacked on the holder, or leasing the symbol alongside it. |
| CODE-1434.4 | Choose **Send to the lease holder**, **Continue**, then **Cancel request**. | "Waiting for the holder" shows with **Cancel request**; cancelling returns to the options. |
| CODE-1434.5 | Send, and have the holder decline with a reason. | The prompt shows the reason with **Stack** and **Keep editing**. |
| CODE-1434.6 | Send, and let the lease expire unanswered. | The change opens stacked on the holder. |
| CODE-1872.1 | Open a file another change leases whole (its lease names the file, not a symbol), then **Edit**; rename it and press **Open change**, then **Stage delete** and **Open change · 1 file**. | A lease strip names the file above line 1 and its band covers every line; both submits show the lease prompt first. |
| CODE-1660.1 | On a file whose symbol another change leases, **Stage delete** (or rename and **Stage**), add a message in **Staged** and press **Open change · n files**. | The lease prompt shows above the Staged card before anything is sent; **Continue** opens the change with the chosen mode, **Back to editing** closes the prompt. |
| CODE-1660.2 | On that file, change the path on the file line, add a message and press **Open change**. | The lease prompt shows instead of opening the change. |
| CODE-1974.1 | Open a `Dockerfile`, a `Makefile` and a `go.mod`. | Each is coloured: Dockerfile instructions (FROM, RUN, AS) as keywords, `#` comments muted, and `go 1.27`'s version as a number. |
| CODE-1974.2 | Open a `.go` file in Code, then Edit, then open a change diff of it. | Function names, types (built-in and capitalised), builtins (`len`, `nil`) and numbers each have their own colour, the same in View, Edit and the diff, in light and dark. |
| CODE-2021.2 | Open a `.tf`, a `.tsx`, a `.yaml`, a `.sql`, a `.json` and a `.md` file, each then in **Edit**. | Terraform block types, labels and attribute names; TSX function names, types, JSX tags and attributes; YAML and JSON keys apart from values; SQL keywords and numbers; Markdown headings and code spans: each coloured, the same in View and in Edit. |
| CODE-2040.1 | Open a `.py`, `.rs`, `.java`, `.kt`, `.swift`, `.rb`, `.php`, `.scala`, `.lua` and `.ps1` file from any repo (or commit one in a test repo). | Each is coloured (keywords, strings, comments, functions, types, numbers), not plain text. |
| CODE-2040.2 | Open a `Jenkinsfile`, a `CODEOWNERS`, a `.bashrc` and a `CMakeLists.txt`, then **Edit** one of them. | Each is coloured by its language (Groovy, CODEOWNERS, shell, CMake); Edit shows the same colours as View, in light and dark. |

## Known gaps

- **CODE-08:** commit rows have sha, message, author and change; there's no verifier or age column.
- **CODE-20, CODE-23:** the viewer has no Copy button.
- **CODE-26:** binary files have no size-and-Download view.
- **CODE-30:** the per-file panel shows holder, state, intent and symbol, not path:lines or time left.
- **Request lease** (spec: opens the negotiation flow) has no control yet, so it has no check.

## Planned

- Tags pushed with git showing on Code and Releases (only tags made through cinder are recorded).
- Uploading binary files (Upload takes text files only).

## Retired

- **CODE-37:** **Delete file** in Edit; **Stage delete** replaces it (CODE-40).
- **CODE-49:** the empty-repo "This branch has no files yet" state; Quick setup replaces it (CODE-82 to CODE-84).
- **CODE-05:** **Get git credentials** in the clone popover; the browser gets no git token, the CLI does (CODE-1777.1).
- **CODE-53:** a viewer's **Get git credentials**; the button is gone, the CLI gets the same 403 (CODE-1777.1).
- **CODE-87:** the "Rather describe it in prose?" link that opened New change with the message filled in; **Hand to an agent** creates the change in place (CODE-89, CODE-2019.1).
- **CODE-2021.1:** Go package qualifiers coloured from the file's imports; the TextMate Go grammar colours `fmt.Println`'s call, not the package (CODE-1974.2, CODE-2040.1).
