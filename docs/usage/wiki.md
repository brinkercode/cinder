# Wiki

## Purpose

Written docs for the whole organization, with page history. Each repository has its own folder in the wiki.

## Where

Git ▸ Wiki, after the Code group; it opens `/wiki`, the list of repository folders, and a folder opens at `/wiki/:repo`. The top bar reads `Wiki › repo ▾`; the repo menu switches folders, and there is no branch switcher

## What you can do

- On a repository with no code: an empty state with **Create the first page** (opens the wiki with its new-page form) and **Quick setup** (opens Code).
- On **Wiki**, open a repository's folder.
- The page reads in three columns: the page tree, the reading column (up to 760px wide) and the page rail. Below 1280px wide the rail moves under the page as a grid; below 900px everything stacks.
- **Search the wiki**: hits show the title, the page path and the matched text highlighted.
- The page tree: folders, and pages with sub-pages, are rows with a chevron, the name in small capitals and the child count, and collapse on click (a page's name in its row opens the page); pages flagged as agent context carry a small robot mark. The open page is the highlighted row and is not a link; every other page is.
- **New page** creates an untitled page under the current page's folder and opens it in Edit. An empty wiki offers **Write the first page**.
- On a page: the breadcrumb (repository › folders › page), **History** (click again to close), **Edit** and the **⋯** menu (**Move** jumps to Location, **Copy link**, **Delete**). Under the title: "Updated … by … · v…" and an **Agent context** chip when the page is flagged.
- Markdown (a README, a markdown file's **Preview**, wiki pages and release notes) renders headings, bulleted, numbered, nested and task lists, quotes, tables, rules, images, links, bold, italic, strikethrough and fenced code, which is coloured by the fence's language (`js`, `bash`, `yaml`, …) once its grammar loads. Raw HTML a README uses for layout (`<p align>`, `<img width>`, `<details>`, `<kbd>`, `<br>` and similar) renders; scripts, styles, event handlers and unsafe links are dropped.
- The page rail:
  - **Page info**: edited by, last edited, views, words and read time.
  - **Agent context**: a switch, "Agents read this page · about N tokens added to each plan" (N is the page's size in bytes divided by 4, rounded up). It flips at once and flips back with an error if the save fails.
  - **Location**: a parent select with **Move**; the page itself and its children aren't offered.
  - **On this page**: the page's headings; a click scrolls the page to that heading.
  - **History**: the last 3 versions and **All N versions**.
- **Edit** opens the editor:
  - A toolbar of icon buttons: Bold, Italic, Heading, List, Quote, Code, Link and Table, each wrapping the selected text in its Markdown. Hovering a button names its action and shortcut; `Ctrl B`, `Ctrl I` and `Ctrl K` (`⌘` on a Mac) apply Bold, Italic and Link.
  - **Write**, **Split** (the default: text and a live preview side by side) and **Preview**.
  - The title as a large input, then the text, then a footer with the Note (shown in page history), **Cancel** and **Save page**.
  - `Ctrl S` (`⌘ S` on a Mac) saves; `Esc` cancels. Cancel asks first when the title or text changed.
  - A save with no change to the title or text sends nothing and returns to the page. When someone saved the page since you opened it, the save is refused with a conflict message and your text stays in the editor.
- **History**: every version newest first with its message, editor and date, the current one tagged **current**. A version shows its line diff against the one before it with + and − counts; **Restore vN** on an older version saves its text as a new version.
- Comments, under the page in the reading column: **Comment** (the box clears once the comment is posted and keeps its text if the post fails), **Save comment**, **Delete comment** (its author or an owner).

## Backed by

The Artifacts git repo `cinder-wiki`, which `deploy/reconcile.sh` creates. Each page is the markdown file `<repo>/<page id>.md`, and every save or restore is a commit, so history, diff and restore read from git. D1 keeps the page tree, comments and the full-text search index. When the wiki repo was first used, pages saved before then were committed into their repository's folder.

A page flagged as agent context (D1 `wiki_agent_context`) goes to every develop run on its repository, before pages matched on the intent, within 32 KiB; `GET /api/repos/:name/wiki/context` lists the flagged pages in tree order, up to 24,000 tokens. Each run records the pages and versions it was given (D1 `job_wiki_context`), and the change lists them. Reads are counted once per person per page per day (D1 `wiki_views`).

Cloudflare map for this page: [ARCHITECTURE-CLOUDFLARE.md §2](../ARCHITECTURE-CLOUDFLARE.md#2-page-by-page-map).

## Planned

- `###` headings render as headings (today only `#` and `##` do, so On this page can list a `###` heading it can't scroll to).
- **Delete page** also removes the page's file from the wiki repo (today it leaves the file and its history).
- One page tree and search across every folder.
