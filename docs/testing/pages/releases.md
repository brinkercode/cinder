# Releases

- **Route:** `/:repo/releases`
- **Sidebar:** Code ▸ *repo picker* ▸ Releases
- **Backed by:** D1 (tags, releases, deploy history) ([map](../../ARCHITECTURE-CLOUDFLARE.md#2-page-by-page-map))

**Setup:** `web-store` (v1.0.0 and v1.1.0 published, v1.2.0-rc.1 a draft, none deployed until `node seed/activity.mjs` promotes the latest to staging; dev, staging and production environments); `svc-orders-go` or `infra-cloudflare-tf` for a trunk repo (v1.0.0 and v1.1.0 published); an empty repo named `manual-empty-<n>` made with New repository and deleted afterwards for the empty list. Name throwaway tags `v0.0.<n>-manual`.

## List

| ID | Check | Expected |
|---|---|---|
| REL-01 | Open `/web-store/releases`. | A bar with "Releases", **New tag** and **Draft release**; a toolbar with search and Show; one card per release. |
| REL-02 | Look at a release card. | Tag icon, version (mono), a `draft` tag or a green `published` pill, the release title, the notes rendered as markdown, age, ⋯; footer with the branch, "Live in" chips or "Not deployed", and Publish on drafts; no Promote button. |
| REL-1393.1 | Click a "Live in" chip on a release card. | Environments opens. |
| REL-1393.2 | Look at a published release that is live nowhere. | A **Promote in Environments** link that opens Environments. |
| REL-1579.1 | With git credentials for the repo, force-push a published release's tag to another commit (`git push -f origin <commit>:refs/tags/<tag>`), then fetch tags and reload. | The tag is back at its commit (`git ls-remote --tags origin`); the release card is unchanged. |
| REL-1603.1 | With git credentials for the repo, push a throwaway tag (`git push origin <commit>:refs/tags/v0.0.<n>-manual`), reload, then delete it (`git push origin :refs/tags/v0.0.<n>-manual`) and reload. | The tag's card appears after the push and is gone after the delete. |
| REL-03 | Compare the draft and a published release. | Visually distinct: a plain `draft` tag against a pill with a green dot. |
| REL-27 | After `seed/activity.mjs` and its staging Release approval, look at v1.1.0's footer. | "Live in staging" once staging's deploy of its commit succeeds; "Not deployed" before. |
| REL-05 | Type `rc` in search. | Only v1.2.0-rc.1 shows. |
| REL-06 | Pick Drafts, then Published, in the Show select. | Only drafts, then only published releases. |
| REL-07 | Open a card's ⋯ and click **Browse files at &lt;tag&gt;**. | Code opens at that tag. |
| REL-26 | Type `zzzz` in search. | "No tags or releases match" in the first card's place. |

## New tag

| ID | Check | Expected |
|---|---|---|
| REL-1394.1 | Click **New tag**. | A modal with Tag name (a semver hint naming the latest tag), Commit (**Recent on a branch** / **Paste a SHA**), an optional Message, Cancel and **Create tag**, disabled until a name and a commit are chosen. |
| REL-1394.2 | Under Recent on a branch, pick another branch. | Its recent commits list with short SHA, message and age; a skeleton while they load. |
| REL-1394.3 | Type an existing tag's name. | As you type: "&lt;name&gt; already exists, at &lt;sha&gt;. Tags can't move" in red, and **Create tag** is disabled. |
| REL-1394.4 | Paste a SHA, paste the first 7 characters of a commit on any branch, then `12ab34c`, then `xyz`. | The commit shows with its message; then "No commit 12ab34c in &lt;repo&gt;…"; then "A SHA is 7 to 40 hex characters"; Create stays disabled on the errors. |
| REL-1394.6 | Tab through the modal in light and dark, and at 390px. | Every control is reachable with a visible focus ring; the commit rows wrap without overflow. |
| REL-09 | Click **Cancel**, then press Esc on a reopened modal. | Both close it; no tag is created. |
| REL-10 | Create `v0.0.1-manual` on the newest commit of the default branch, with a message. | The modal closes; "Tag v0.0.1-manual created" shows and a card with a `tag` label appears for it; the tag is offered in Draft release's Tag select; both are still there after a reload. |
| REL-1342.1 | After REL-10, open Code ▸ Branches. | `v0.0.1-manual` points at the default branch's head commit; no `release/v0.0.1-manual` branch exists. |

## Draft release

| ID | Check | Expected |
|---|---|---|
| REL-12 | Click **Draft release**. | A modal: Tag select, Title, Notes with Write / Preview, Cancel and **Save draft**. |
| REL-13 | Type `**bold** *it*` and `- item` in Notes and click **Preview**. | Bold, italic and a list render; Write returns to the text. |
| REL-14 | Pick `v0.0.1-manual`, enter a title and notes, click **Save draft**. | A new card with a `draft` tag; still there after a reload. |
| REL-15 | On a repo with no tags, open Draft release. | **Save draft** is disabled. |

## Publish

| ID | Check | Expected |
|---|---|---|
| REL-16 | Click **Publish** on the draft and cancel the confirm. | Nothing changes. |
| REL-17 | Click **Publish** and confirm. | The card shows the published pill and loses Publish; a reload keeps it. |

## States

| ID | Check | Expected |
|---|---|---|
| REL-23 | Reload throttled on a first visit. | The bar and toolbar stay, disabled; 3 skeleton cards. |
| REL-1847.1 | Open `/web-store/releases` directly in a new tab with `/api/**` delayed 3s. | The bar, toolbar and skeleton cards show at once, before the repository list answers; the main area is never blank. |
| REL-24 | Open `/svc-orders-go/releases`. | "No releases yet" with **New tag**. |
| REL-25 | Block `GET …/releases` and reload. | "Couldn't load releases" with Retry under the disabled toolbar. |

## Known gaps

- None known.

## Planned

- Tags pushed with git showing here (only tags made through cinder are recorded).

## Breadcrumb

| ID | Check | Expected |
|---|---|---|
| REL-1243.1 | Open a repo's Releases, then click **Code** in the page bar. | The page bar reads `Code › Releases`; **Code** opens the repo's Code. |

## Retired

- REL-1394.5 (the verifier-failed warning): commits carry no verifier status.
- REL-04 (v1.1.0 Live in staging from seeded history): the seed records no deploy; REL-27 checks it after a real one.
- REL-08 (a modal with Tag and Message): replaced by REL-1394.1.
- REL-11 (the server's message for an existing tag): the modal catches it as you type, REL-1394.3.
- REL-18 to REL-22 (the Promote to environment menu, promoting from it, its gate and its no-environments note): promotion is on Environments only.
