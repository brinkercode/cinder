# Repositories

- **Route:** `/`
- **Sidebar:** Code ▸ All repositories
- **Backed by:** D1 for the repo list and account settings; Artifacts for each repo's git storage and imports ([map](../../ARCHITECTURE-CLOUDFLARE.md#2-page-by-page-map))

**Setup:** the seeded repos (each with a description and language from the seed), the account's token budget; create throwaway repos named `test-manual-<n>`.

## List

| ID | Check | Expected |
|---|---|---|
| REPO-01 | Open `/`. | Title "Repositories" with View docs, a description and **New repository**; a toolbar; one card per repo; a pager; the Usage aside on the right. |
| REPO-02 | Look at a repo card. | Book icon, name, description, pushed time, ⋯; footer with default branch (mono), language, open changes, verifier pass rate and agent count. |
| REPO-03 | Look at a repo with fewer than 20 verifier outcomes. | The pass rate reads "untrusted: n outcomes" (or "no outcomes yet"), never a percentage. |
| REPO-04 | Click a repo's name. | Opens `/:repo/code/<default branch>`. |
| REPO-05 | Type part of a description in the search. | Cards filter as you type by name and description; the pager reads "Showing 1–n of n". |
| REPO-06 | Search for `zzzz`. | "No repositories match". |
| REPO-41 | Compare a repo card's "n open" with the Open tile on its Changes page. | Both agree; failed changes count as open until they are closed. |
| REPO-07 | Open the **Show all** select; it offers Show all and Archived. Pick Archived, then Show all. | The list changes at once, with no network requests; the URL carries `?show=`. Reload keeps the filter. |
| REPO-08 | Open the **Last pushed** select and pick Name. | Cards sort A–Z; reload keeps the order (`?sort=name`). |
| REPO-09 | Click refresh. | The list reloads in place. |
| REPO-10 | Open a card's ⋯ and click **Open**. | Opens the repo's Code. |
| REPO-11 | Open a card's ⋯ and click **Settings**. | Opens `/:repo/settings`. |
| REPO-12 | On `test-manual-1`, open ⋯ and click **Archive**; cancel the confirm, then repeat and click OK. | The confirm reads "Archive test-manual-1? Pushes will be refused until it is unarchived." Cancel leaves the card; OK removes it from the list without a reload. |
| REPO-13 | Pick **Archived** in the Show select. | Archived repos list with an `archived` tag, the archive time and **Unarchive**. |
| REPO-14 | Click **Unarchive** on `test-manual-1`. | It returns to the main list; still there after a reload. |
| REPO-15 | Push to an archived repo with git. | The push is refused. |
| REPO-1880.1 | Get a token with `cinder repo credentials <repo>`, archive the repo, run the command again, then push `HEAD:refs/for/main` with the first token. | The second request answers 409 `archived` with no token; the pushed ref is gone shortly after and no change opens. |
| REPO-40 | As an owner, pick **Archived** and click **Delete…** on `test-manual-1`; type a wrong name, then the exact name, and click **Delete**. | **Delete** stays disabled until the name matches; then "Deleted test-manual-1." shows and the row is gone after a reload. As a non-owner there is no **Delete…**. |

## New repository

| ID | Check | Expected |
|---|---|---|
| REPO-16 | Click **New repository**. | A panel slides open under the title: Name, Default branch, Strategy, Import from (optional), Token (optional), Cancel and **Create repository**. |
| REPO-17 | Click **Cancel**. | The panel closes. |
| REPO-18 | Enter `Bad Name` and submit. | The form refuses it (lowercase letters, digits and dashes, 2–63 characters). |
| REPO-19 | Create `test-manual-2` with default branch `main`, strategy trunk. | The panel closes and the card appears; it's still there after a reload, and its Code page opens. |
| REPO-20 | Create a repo with an existing name. | The server's message shows in the panel; nothing is created. |
| REPO-21 | In New repository, enter a name and a public clone URL in Import from, and submit. | The repo appears as importing, then its files show in Code once the import lands. |
| REPO-22 | Import with a token for a private repo. | The import works; the token isn't shown anywhere afterwards and the token field is empty; Keystore lists `IMPORT_TOKEN` (import credential) for the repo. |
| REPO-1379.1 | In New repository, read the Token (optional) field's placeholder. | It says "kept encrypted in Keystore for re-imports; remove it there". |
| REPO-42 | Create `test-manual-3` with default branch `main`, strategy gitflow, and open its `.cinder.yml` in Code. | It lists `develop` and `main` as integration branches; a trunk repo created the same way is empty and opens on Quick setup. |

## Usage aside

| ID | Check | Expected |
|---|---|---|
| REPO-23 | Look at the aside. | "Usage" heading; Token budget card (ring with %, used, "of n tokens · resets &lt;date&gt;"); the period; 2×2 tiles (Changes merged, Verifier runs, Lease conflicts, Calibration); Account details; "Verifier owns every merge". |
| REPO-24 | Enter a monthly token budget and click **Set budget**. | The ring and "of n tokens" update; the value is still there after a reload. |
| REPO-1399.1 | Click **Add budget alert**. | A dialog with an "Alert at" slider (10–100% in steps of 5, the value shown beside it), the existing alerts, Scope "Whole account" and Notify "Needs you (always)" checked and disabled; Cancel and Esc close it; keyboard moves the slider with visible focus. |
| REPO-1399.2 | Pick 65% and click **Add alert**. | The dialog closes and an "alert at 65%" tag joins the card's list; it stays after a reload. |
| REPO-1676.1 | Sign in as a member who is not an owner and look at the Token budget card. | **Set budget** and **Add budget alert** are disabled. |
| REPO-1400.1 | On the Budget settings card, pick **Alert only** and click **Save**, then reload. | **Alert only** stays picked; with spend over the budget agent jobs still claim and no banner shows. The owners who can raise the budget are named. |
| REPO-1400.2 | Open `/` as a non-owner. | **When agents reach it** and **Save** are disabled. |
| REPO-27 | Click the copy button next to Account ID. | The ID is on the clipboard; the button's label reads Copied. |
| REPO-28 | Click the edit button next to Git host, change it, click **Save Git host**. | The new host shows; it's still there after a reload. |
| REPO-29 | Look at the Calibration tile with under 20 outcomes. | It shows the untrusted line, not a number. |
| REPO-30 | Look at "Verifier owns every merge". | The toggle is on and can't be turned off. |
| REPO-31 | Click the arrow on the Token budget card. | Opens Insights. |

## States

| ID | Check | Expected |
|---|---|---|
| REPO-32 | Reload throttled on a first visit. | 4 skeleton cards; the aside shows an empty ring and 4 tile bones. |
| REPO-33 | Block `GET /api/overview` and reload. | A card error "Couldn't load repositories" with Retry, under the disabled toolbar. |
| REPO-34 | On an account with no repos (or by filtering the API response away), open `/`. | "No repositories yet" with **New repository** and the `cinder repo add` hint. |
| REPO-35 | Watch the page while another tab pushes to a repo. | The card's pushed time updates without a reload. |
| REPO-2097.1 | Sign in as someone invited as Contributor on one selected repository and open `/`. | The page loads and lists only that repository. |

## Repo paths

| ID | Check | Expected |
|---|---|---|
| REPO-1364.1 | Open `/svc-orders-go`, `/svc-orders-go/nonexistent-page` and `/svc-orders-go/queues`. | Each opens the repo's Code on its default branch. |

## Known gaps

- **REPO-01, REPO-05:** the pager's buttons are always disabled (every repo shows on one page).

## Planned

- None.

## Retired

- REPO-25, REPO-26: the threshold menu became the Add budget alert dialog (REPO-1399.1, REPO-1399.2).
- REPO-36, REPO-37, REPO-38, REPO-39: the repo overview page was removed; `/:repo` opens Code.
