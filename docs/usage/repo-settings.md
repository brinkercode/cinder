# Repo settings

## Purpose

One repo's settings on a single scrolling page of cards: About, Repository, Branch policy (with what else is read from `.cinder.yml`), Repo roles, Label routing (with Groups with access), Flaky checks, Webhooks, Environments, Mirror, Import and Danger zone. A section nav sits beside the cards. The head reads "Configuration for *repo*. Branch policy and judges also live in `.cinder.yml`."

## Where

Code ▸ *repo* ▸ Settings (`/:repo/settings`; `#about`, `#repository`, `#repo-roles`, `#webhooks`, `#environments`, `#danger-zone` or `#branch-policy` scrolls to that card)

## What you can do

- The section nav (About, Repository, Branch policy, Repo roles, Label routing, Flaky checks, Webhooks, Environments, Mirror, Import, Danger zone) stays in view and highlights the section you're reading; click one to jump to it. On a narrow screen it's a row above the cards that scrolls sideways.
- **About:** the repo's name (read-only), description (one line, up to 280 characters) and language (up to 40; blank clears it), then **Save about**, which turns on once a field changes.
- **Repository:** default branch (one of the repo's branches), branching strategy (trunk, gitflow, release or custom), the integration branches as lock chips (only the verifier merges into them) and the line "Verifier owns every merge on integration branches." **Save repository** turns on once the branch or strategy changes.
  Branch policy then re-reads from the default branch. When the new default branch has no `.cinder.yml`, the old one's file is committed onto it first, and the change is recorded in the repo's audit. Changing the default branch or strategy needs `branch.write`; anyone else gets 403 and nothing changes.
  - **Branching strategy** names the branches the policy holds:

    | Strategy | Integration branches | Release branches |
    |---|---|---|
    | trunk | the default branch | none |
    | gitflow | `develop` and the default branch | none |
    | release | the default branch | `release/*` |
    | custom | whatever `.cinder.yml` says | whatever `.cinder.yml` says |

    **Save repository** stores the strategy only; it doesn't change `.cinder.yml`. A new gitflow or release repo from Repositories ▸ **New repository** starts with a `.cinder.yml` holding its strategy's branches (a trunk or custom repo starts empty). A policy saved by hand whose branches no longer match the strategy sets the strategy to custom.
- **Repo roles:** Who, Role and From for each person with a repo role, shown only to people with `people.manage` or `org.manage`. Change a person's repo role inline, remove it, or add one for someone who has none yet. A repo role adds to the person's own role.
- **Webhooks:** add one (https URL and change, verdict or judgment events), edit its events, rotate its signing secret or delete it. The secret shows once, in the modal, and is gone when the modal closes. Each row shows its latest delivery: delivered, failing or never, with the HTTP code or error. The list and an events edit show only each URL's scheme and host (`https://hooks.example/…`). Listing, adding, editing, rotating and deleting webhooks need `people.manage` or `org.manage`.
- **Environments:** environments come from `.cinder.yml` under `deploy`; the link opens Automation › Environments.
- **Danger zone:** **Archive** after a confirmation; owners also see **Delete…**, which needs the repo's name typed exactly. Deleting removes the repo's Keystore secrets too, its import token included, from the Secrets Store.
- **Branch policy**
  - With no `.cinder.yml` yet, a hint says the values are the defaults and saving commits one.
  - **Branching strategy:** Trunk, Gitflow, Release branches or Custom. Picking another strategy shows a preview: the current and the resulting branch tables (Branch, Role, Promotes to: the environments whose `deploy` branch it is), with **Keep mine** or **Apply**. **Apply** commits the strategy's branches to `.cinder.yml` on the default branch, keeping its check and the rules of branches that stay. Gitflow's preview notes that develop → main is an ordinary change from develop into main. The control reads Custom once the integration or release tables are edited by hand.
  - Edit the integration branches (merge queue, trusted judges needed 1–4, auto-merge risk 1–50%, paths routed to a person), release branch patterns and check command. A `branches.promote` key in `.cinder.yml` is ignored, and a save drops it; `stack` and `routing` keys are ignored and a save leaves them as they are. Each value shows where it comes from: `repo`, `global` or `default`.
  - **Save policy** turns on once the draft differs and commits `.cinder.yml` to the default branch as you. If the branch moved since the page loaded, nothing is committed: "&lt;branch&gt; moved since this page loaded." shows with **Reload**, which re-reads the policy and keeps your draft. Saving the policy, **Apply** included, needs `branch.write` (a maintainer, admin or owner, or such a repo role); anyone else gets the refusal inline and nothing is committed. The same holds for any commit that changes `.cinder.yml`, from Code or the commit API; an agent's commit to its change's fork lands through the change.
  - **Flaky checks:** **Quarantine automatically** (on by default) and the flake quarantine threshold. While it is on, on each verify report a failing test whose flake rate (over its last 50 runs) is at or above the threshold is quarantined and raises a Test quarantined item in Needs you. Turning it off quarantines no new tests; tests already quarantined stay quarantined. A verify whose only failing tests are quarantined passes; a quarantined test shows as `quarantined` in the change's checks. The card lists the quarantined tests with their flake rate (flakes/runs), since when and by whom (the verifier), each with **Release from quarantine**; with none it reads "No tests are quarantined. Every test counts in the verdict." A released test counts in the verdict from the next run and isn't quarantined again on its own. The same through the API: `GET /api/repos/<repo>/flakes` (`quarantined` is true exactly while the test is quarantined, with `quarantined_since` and `quarantined_by`), `POST /api/repos/<repo>/flakes/<test>/release` (repo write), `PUT …/settings {"auto_quarantine": false}`.
  - When `.cinder.yml` on the default branch doesn't parse, the card shows the parse message with its line number and a link to edit the file in Code.
  - A read-only list of the other `.cinder.yml` keys (stages, overlap, unresolved threads block merge, wiki context) with a link to edit the file in Code.
  - **Label routes** live in `.cinder.yml` as `routes`, a list of `{label, agent | driver | reviewer}`, for example `- { label: payments, agent: payments@stable }`. When a change is created or its labels change, the first rule whose label it carries applies: `agent` sets the agent that develops it (only before a develop job is claimed), `driver` makes it that person's change, `reviewer` requests that reviewer (a person's email or an agent version). The change's timeline gets a routed event naming the rule. A rule with no label, or with none or more than one target, makes the policy invalid: reading it and creating changes on the repo answer 422 until the file is fixed.
- **Label routing:** a table of rules, each a label, a route (Agent, Person or Reviewer) and who, with × to remove it, and an add row below. Agent: it picks the intent up (its change is developed by that agent version). Person: assigned to drive it (an intent's assignee, a change's driver). Reviewer: requested on the change. First matching rule wins: these rules are checked before the `.cinder.yml` routes, and a rule fires when a label is added that makes it the first match. The same through the API: `GET` and `PUT /api/repos/<repo>/routing {"rules": [{"label": "payments", "agent": "payments@stable"}]}` (repo write).
- **Groups with access:** the group mappings that apply to this repo (edit them in Access & people).
- **Mirror:** an https URL merged changes are pushed to.
- **Re-import** a repo that holds nothing but `.cinder.yml`, keeping the policy (owners). Leave the token blank to reuse the one kept from the repo's last private import; a token you enter replaces it. The field empties after each try. The repo takes the source's default branch, and the kept policy is committed back onto it once the import lands. A failed re-import lists the repo as failed with the reason, keeps the policy, and a retry re-imports with it.

Each card loads on its own: a card that fails shows its error with **Retry** while the others show their data.

Importing another repo is in Repositories ▸ **New repository** (clone URL and an optional token, kept for the repo in the Keystore once a private import lands). Owners delete archived repos from Repositories ▸ Archived with the same typed-name confirmation.

## Backed by

D1 (settings, audit, repo roles, label routing rules, webhooks and their delivery attempts, deletions), `.cinder.yml` in Artifacts for the branch policy, the Secrets Store for webhook secrets, and the `cinder-webhooks` Queue for delivery.

Cloudflare map for this page: [ARCHITECTURE-CLOUDFLARE.md §2](../ARCHITECTURE-CLOUDFLARE.md#2-page-by-page-map).

## Planned

- A Website field and renaming the repo from About.
