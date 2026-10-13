# Repo settings

- **Route:** `/:repo/settings[#about|#repository|#repo-roles|#webhooks|#environments|#danger-zone|#branch-policy]`
- **Sidebar:** Code ▸ *repo picker* ▸ Settings
- **Backed by:** D1 for settings, roles and webhook delivery status; `.cinder.yml` committed to the repo's Artifacts repo for branch policy; webhook signing secrets in Secrets Store ([map](../../ARCHITECTURE-CLOUDFLARE.md#2-page-by-page-map))

**Setup:** `web-store` (gitflow: develop, main, release/*); `svc-orders-go` (trunk on main); a repo with no `.cinder.yml` for the defaults; create `test-manual-settings` from Repositories for Archive, Delete and Re-import. Use a request-bin https URL you control for webhooks.

## Page

| ID | Check | Expected |
|---|---|---|
| SET-1437.1 | Open `/web-store/settings`. | Head "Settings" with "Configuration for web-store. Branch policy and judges also live in `.cinder.yml`."; cards About, Repository, Branch policy, Also read from `.cinder.yml`, Repo roles, Label routing, Groups with access, Flaky checks, Webhooks, Environments, Mirror, Import and Danger zone in that order; a section nav beside them (About, Repository, Branch policy, Repo roles, Label routing, Flaky checks, Webhooks, Environments, Mirror, Import, Danger zone) whose links jump to the matching card; no tabs, no section headings. |
| SET-1362.2 | Open `/web-store/settings#webhooks`. | The page scrolls to Webhooks. Scrolling doesn't rewrite the URL's hash. |
| SET-1362.3 | Look at the About card. | Name (the repo's name, read-only), Description and Language. |
| SET-1362.4 | Look at the Repository card on `web-store`. | Default branch, strategy, integration branches as lock pills and the sentence "Verifier owns every merge on integration branches."; no switch or checkbox, no Visibility row. |
| SET-1362.5 | Look at the Environments card, click Automation › Environments. | "Environments come from `.cinder.yml` under `deploy`." with the link; it opens the repo's Environments. |
| SET-1362.6 | Look at the page for Topics or Visibility. | Neither is shown. |

## About and Repository

| ID | Check | Expected |
|---|---|---|
| SET-04 | Change Description and Language, click **Save about**. | "Saved." inline; Repositories shows the new description and language; a reload keeps them. |
| SET-05 | Clear Language and save. | The language disappears from the repo's card. |
| SET-06 | Enter a 281-character description. | The field stops at 280. |
| SET-17 | On `svc-orders-go`, pick another branch as Default branch and a strategy, click **Save repository**. | "Saved."; the top bar and Repositories show the new default; Branch policy re-reads from the new default branch. |
| SET-18 | After SET-17, open the new default branch's `.cinder.yml` in Code. | The policy was committed onto it, so it carries over. |
| SET-2096.1 | As a contributor, change Default branch or strategy and click **Save repository**. | Refused with 403; the default branch and strategy stay as they were. |
| SET-19 | Look at Created. | A read-only date. |

## Branch policy

| ID | Check | Expected |
|---|---|---|
| SET-20 | Open Settings on a repo with no `.cinder.yml`. | A hint card ("No `.cinder.yml` yet. These are the defaults; saving commits one to &lt;default&gt;.") and the policy pill reads "defaults"; Source tags read `default`. |
| SET-21 | Open `web-store`'s Branch policy. | The pill reads "from `.cinder.yml`"; an Integration branches table (Branch, Merge queue, Trusted judges needed, Auto-merge if risk ≤ %, Route to a person, Source, ⋯). |
| SET-22 | Look at **Save policy** before editing. | Disabled. |
| SET-23 | Change Trusted judges needed on develop to 2. | **Save policy** becomes enabled. |
| SET-24 | Try judges 5, then risk 0. | Each is refused (judges 1–4, risk 1–50). |
| SET-25 | Add integration branch `release/manual` with **Add**. | A row with the queue on, 1 judge, 10% and no route. |
| SET-26 | Remove a row with ⋯ › Remove. | The row leaves the draft. |
| SET-28 | Look at Check command. | It has its Source tag and is required; there is no Stack field. |
| SET-29 | Click **Save policy**. | "Committed `.cinder.yml` · &lt;sha&gt;"; every edited Source tag reads `repo`; a reload shows the saved values. |
| SET-30 | Open `.cinder.yml` in Code after SET-29. | A commit by you with the rules you saved; `deploy:` and every other key not in the policy are unchanged. |
| SET-31 | Edit the policy, push a commit to the default branch from another tab, then Save. | "&lt;branch&gt; moved since this page loaded." with **Reload**; Reload keeps your draft. |
| SET-32 | Save as a Contributor. | "saving the branch policy of &lt;repo&gt; needs branch.write" shows inline; nothing is committed. |
| SET-33 | Queue a change on develop after SET-23. | It waits for 2 trusted judges, per develop's rule. |
| SET-34 | Change Flaky checks to 30% and click **Save**. | It saves; a reload shows 30%. |
| SET-35 | Look at "Also read from `.cinder.yml`". | A read-only list (Stages, Overlap, Unresolved threads block merge, Wiki context) with values or "not set"; no inputs. |
| SET-36 | Click "Edit `.cinder.yml` in Code ↗". | Code opens `.cinder.yml` on the default branch. |
| SET-37 | Break `.cinder.yml` on the default branch, then open Settings. | The Branch policy card shows the parse message naming the line (an unclosed `[` on line 3 reads `.cinder.yml: yaml: line 3: unclosed "["`) with the Code link instead of Retry. |

## Access

| ID | Check | Expected |
|---|---|---|
| SET-38 | Look at Groups with access. | Source, Group, Role tag, Scope ("this repo" or "all repos"); only mappings that apply to this repo; no inputs. |
| SET-39 | Click "Settings › Access & people →". | Opens Access & people. |
| SET-40 | Add a repo role: pick a person and a role, click **Add role**. | A row with the person, role, "Set by you · just now"; a reload keeps it. |
| SET-41 | Open the Person select again. | People who already hold a repo role aren't offered. |
| SET-42 | Change a row's Role select. | It saves at once; a reload keeps it. |
| SET-43 | Remove a role with ⋯ › Remove and confirm. | The row goes and stays gone. |
| SET-44 | Look at the Role select's options. | Built-in roles first, then any custom roles. |
| SET-45 | As a person without people management, try SET-40 and SET-43. | Refused with the reason. |

## Integrations

| ID | Check | Expected |
|---|---|---|
| SET-46 | Click **Add webhook**, enter your https URL, tick change and verdict, click **Add**. | The modal shows a read-only Signing secret with a copy button, "Shown once. Store it where your receiver reads it." and **Done**. |
| SET-47 | Click **Done**, then reopen Add webhook. | The secret is gone; the new row lists the URL, the two event tags, "never" for Last delivery, and Created. |
| SET-48 | Try Add with no event ticked. | Refused (at least one event). |
| SET-49 | Trigger a change event on the repo. | Your receiver gets a signed request; Last delivery reads "delivered" with the code and time. |
| SET-50 | Point a webhook at a URL that returns 500 and trigger an event. | Last delivery reads "failing" with 500 and the time. |
| SET-51 | Read the `GET …/webhooks` response in the network tab. | No secret in it. |
| SET-1583.1 | As an owner, add a webhook with a path, then read `GET …/webhooks`; repeat as a viewer. | The owner sees the URL as scheme and host followed by `/…`, never its path; the viewer gets 403. |
| SET-2096.2 | As an owner, edit a webhook's events and read the `PATCH` response; as a contributor, send `PATCH` and `POST …/rotate` for it. | The owner's response shows the URL as scheme and host followed by `/…`; the contributor gets 403 for both. |
| SET-52 | Click **Rotate secret** and confirm **Rotate**. | The new secret shows once; the next delivery signs with it; the old one no longer verifies. |
| SET-53 | Edit a webhook's events in place. | The new events save without deleting the webhook. |
| SET-54 | Delete a webhook with ⋯ › Delete and confirm. | The row goes; its Secrets Store secret is gone. |
| SET-55 | Enter an https mirror URL and click **Save**. | It saves; merged changes are pushed there. |
| SET-57 | On `test-manual-settings` (only `.cinder.yml`), click **Re-import…**, enter a clone URL and token, click **Re-import**. | The modal closes; "Importing from &lt;url&gt;. Code shows the files once it lands."; the files appear in Code. |
| SET-58 | Reopen Re-import. | The token field is empty. |
| SET-59 | On a repo with files, look at Re-import. | Disabled with "This repo has files, so it can't be re-imported." |
| SET-60 | Re-import with a bad URL. | The error shows inside the modal (with any token masked); the token field is cleared. |
| SET-70 | After SET-60, re-import again with a good URL. | It imports; Code shows the files and `.cinder.yml` still holds the policy from before the failed try. |
| SET-1834.1 | Re-import `test-manual-settings` from a source whose default branch is `master`. | The modal closes with no "already exists" error; the default branch becomes `master`; Code shows the files and `.cinder.yml` holds the kept policy; Repositories lists the repo as ready. |
| SET-1834.2 | Re-import with an unreachable https URL, then open Repositories. | The modal shows the error; the repo lists as failed, not importing; re-importing with a good URL brings it back to ready. |
| SET-71 | On a repo whose earlier private import landed (only `.cinder.yml` left), re-import its private URL with the token field blank. | It imports with the kept token; Keystore lists one `IMPORT_TOKEN` for the repo. |
| SET-1379.1 | Open **Re-import…** and read the Token field's placeholder. | It says "kept encrypted in Keystore for re-imports; remove it there". |

## Danger zone

| ID | Check | Expected |
|---|---|---|
| SET-61 | Look at Danger zone. | After Environments: Archive this repo and, for owners, Delete this repo. |
| SET-62 | Click **Archive** on `test-manual-settings`, then Cancel. | Nothing changes. |
| SET-63 | Archive it and confirm. | You land on `/`; it's listed under Archived; git pushes to it are refused. |
| SET-64 | On another throwaway repo, click **Delete…** and type a wrong name. | **Delete** stays disabled. |
| SET-65 | Type the exact repo name and click **Delete**. | You land on `/` with "Deleted &lt;repo&gt;."; the repo, its changes and webhooks are gone after a reload. |
| SET-1879.1 | Delete a repo that was imported with a token, then open Keystore. | No `IMPORT_TOKEN` or other secret is listed for the deleted repo. |
| SET-66 | Sign in as a Maintainer and open Settings. | No Delete this repo row. |

## States

| ID | Check | Expected |
|---|---|---|
| SET-67 | Reload throttled. | Section headings, card titles, table headers and disabled buttons stay real; each card shows its own bones, as many rows as last time. |
| SET-68 | Look at empty cards on a repo with nothing set. | Each card's own empty line (no webhooks, no repo roles, no group grants this repo). |
| SET-69 | Block `GET …/webhooks` and reload. | Only the Webhooks card shows "Couldn't load webhooks: GET …" with Retry; the other cards show data. |
| SET-74 | Scroll the page, then click **Webhooks** in the section nav. | The nav stays in view and highlights the section at the top as you scroll; the click jumps to Webhooks and highlights it. |
| SET-75 | At 390px wide, look at the section nav. | A single row above the cards that scrolls sideways, no scrollbar. |
| SET-76 | Look at **Save about** and **Save repository**, then change a field in each. | Both are disabled until a field in their card changes. |
| SET-78 | Add release pattern `hotfix/*`. | A row appears in Release branches; Branch policy has no promotions table. |
| SET-1348.1 | Set Flaky checks to 20% and save; report a verify where a test with a flake rate of 20% or more is the only failure. | The verify passes; `GET /api/repos/<repo>/quarantine` lists the test and the change's checks show it as `quarantined`. |
| SET-1397.1 | With a test quarantined, open Flaky checks (light and dark, and at 390px). | **Quarantine automatically** is on; the list shows the test, flake rate with flakes/runs, since and `verifier`, with **Release from quarantine**, all reachable by keyboard with visible focus. Block `GET …/flakes`: only the list shows "Couldn't load flaky tests" with Retry. |
| SET-1397.2 | Click **Release from quarantine**, then report a verify where that test fails. | The list reads "No tests are quarantined. Every test counts in the verdict."; the verify fails. |
| SET-1397.3 | Turn **Quarantine automatically** off and reload; report a verify where a quarantined test is the only failure. | The toggle stays off; the verify passes. A newly flaky test isn't quarantined. |
| SET-79 | On a gitflow repo, save the Branch policy with only the default branch as integration branch, then reload. | The Repository card's strategy reads custom. |
| SET-1396.1 | On a trunk repo whose `.cinder.yml` deploys `main` to production, click **Gitflow** in Branch policy. | A "Preview: Gitflow" block with Now (Trunk) and After (Gitflow) tables (Branch, Role, Promotes to; main → production), the note that develop → main is an ordinary change from develop into main, **Keep mine** and **Apply Gitflow**. |
| SET-1396.2 | After SET-1396.1, click **Apply Gitflow**. | "Applied Gitflow: committed `.cinder.yml` to main."; the integration table lists develop and main; `.cinder.yml` in Code holds both; the control reads Gitflow. |
| SET-1396.3 | Pick **Release branches**, then **Keep mine**. | The preview closes and nothing is committed. |
| SET-1396.4 | Add a release pattern without saving. | The strategy control reads Custom with "Custom: the tables were edited by hand." |
| SET-1396.5 | Throttle or block `GET …/policy/preview`, then pick a strategy. | The preview shows bones, then "Couldn't preview …" with Retry; **Apply** stays disabled. |
| SET-1395.1 | In **Label routing**, add a rule (label, Agent, Person or Reviewer, who), then remove one. | The table lists label → route → who in order, each with remove; "First matching rule wins." sits under the add row. |
| SET-1395.2 | Add a Person rule for a label, then add that label to an intent and to a change. | The intent's assignee and the change's driver become that person. |

## Known gaps

- **SET-40:** "Set by" shows the email of whoever set the role, not "you".
- **SET-67:** the Save buttons of About, Repository, Flaky checks, Mirror and Re-import appear once their card has loaded, rather than disabled during loading.

## Planned

- None.

## Retired

- SET-03 (cheer pill), SET-07 to SET-09 (Instance visibility), SET-10 to SET-16 (topics and topic suggestions): removed with Community and Explore.
- SET-01, SET-02 (General / Branch policy / Access / Integrations headings and `#integrations`): replaced by SET-1362.1 and SET-1362.2.
- SET-56 (environments table) and SET-77 (Visibility row and verifier switch): replaced by SET-1362.5 and SET-1362.4.
- SET-1362.1 (section order with Branch policy, Flaky checks, Mirror and Import below Danger zone): replaced by SET-1437.1.
- SET-27 (add a promotion): branch promotions are removed; SET-78 covers the release pattern.
