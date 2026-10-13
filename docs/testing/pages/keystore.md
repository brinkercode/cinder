# Keystore

- **Route:** `/settings/keystore`
- **Sidebar:** Settings ▸ Keystore
- **Backed by:** Cloudflare Secrets Store, one binding per secret on the `cinder-secrets` Worker; cinder keeps only references and metadata in D1 ([map](../../ARCHITECTURE-CLOUDFLARE.md#2-page-by-page-map))

**Setup:** one secret of each scope (org, repo, environment, flow), added with **Add** (the seed stores none). Name test secrets `MANUAL_TEST_<n>` and use a value you'll recognise, such as `manual-secret-value-<n>`.

## Secrets

| ID | Check | Expected |
|---|---|---|
| KEY-01 | Open `/settings/keystore`. | Title "Keystore" with **Add secret**; a usage line (n of m secrets used); search and All scopes; the secrets table; the Org model keys row; no Runner tokens card. |
| KEY-02 | Look at the table. | Name (mono), Scope tag (org, repo, environment, flow), Applies to, Last used, Changed by · when, then "set ••••", **Replace** and ⋯. |
| KEY-03 | Type part of a name in search. | Rows filter as you type. |
| KEY-04 | Pick `flow` in the scope filter. | Only flow-scoped secrets show. |
| KEY-05 | Click **Add secret**. | A modal: Name, Scope, the note "Agents never receive Keystore secrets", Repo, Environment (the default scope), Value (a password field, "Never shown again after saving."), Cancel and **Add secret**. |
| KEY-06 | Type a value in Value. | The characters are masked. |
| KEY-07 | Save `MANUAL_TEST_1` with scope repo, repo `svc-orders-go`. | A row with the repo tag and "svc-orders-go" under Applies to; a reload keeps it. |
| KEY-08 | Reopen **Add secret**. | Every field is empty; the earlier value isn't there. |
| KEY-09 | In the network tab, read the `GET /api/keystore` response. | Names and metadata only; `manual-secret-value-1` appears nowhere. |
| KEY-10 | Click **Replace** on `MANUAL_TEST_1`, enter a new value, click **Replace**. | "Changed by · when" updates to you, just now; the value never shows. |
| KEY-11 | Open a row's ⋯. | Kind, owner and expiry. |
| KEY-12 | Click **Remove** on `MANUAL_TEST_1`, then **Cancel**. | A confirm titled "Remove MANUAL_TEST_1?" names where it applies (svc-orders-go) and says it can't be undone; after Cancel the row stays and no `DELETE` is sent. |
| KEY-27 | Click **Remove** on `MANUAL_TEST_1`, then **Remove** in the confirm. | `DELETE /api/keystore/<id>` is sent; the row goes; a reload confirms. |
| KEY-13 | Use a flow-scoped secret in a flow step and read the step's log. | The value is masked. |
| KEY-14 | Open the Secrets Store in the Cloudflare dashboard. | Each secret on this page has a matching Secrets Store secret; removing one here removes it there. |
| KEY-1371.1 | Add an environment-scoped secret `MANUAL_TEST_5` for a repo's `production`, declare it under that environment's `secrets:` in `.cinder.yml`, then sync production. | The deploy succeeds and the deployed Worker reads `MANUAL_TEST_5` as a secret with the saved value; with no such secret in scope, the sync fails naming it as unset. |
| KEY-1436.1 | In **Add secret**, switch Scope through org, repo, environment and flow. | org shows "Applies to all repos."; repo shows a Repo select; environment and flow add a select of that repo's environments or flows, empty until a repo is picked. |
| KEY-1436.2 | In **Add secret**, type the name of a saved secret and pick its scope and target. | The name is marked invalid with "… already exists for … Replace it from its row, or pick another name." and **Add secret** is disabled; another target re-enables it. |
| KEY-1436.3 | Click **Replace** on a secret. | The title names it; its scope and Applies to are shown, not editable; New value with "Rotates now. Runs that already started keep the old value." |
| KEY-30 | Run a flow whose step needs a secret Keystore doesn't hold, so the step fails reporting it missing; open Keystore. | **Wanted by flows** lists the secret with repo › flow › step; the link opens that run; **Add** opens Add secret with the name filled in; after saving it, the row is gone. |
| KEY-1570.1 | With an environment-scoped secret for `production`, run a flow that deploys to `production` by hand on a feature branch, then on the default branch. | On the feature branch the step reports the secret missing; on the default branch it receives the value. |
| KEY-1570.2 | Push a change whose fork's flow deploys to `production` and asks for that secret. | The change's flow run reports the secret missing; no value appears in its log. |
| KEY-1772.1 | Save a repo secret and a global secret (neither with `forks: true`), then push a change whose fork's `on: [change]` flow asks for both. | The change's flow run reports both secrets missing; no value appears in its log. |

## Org keys

Retired IDs (never reused): KEY-19, KEY-20, KEY-21, KEY-28, KEY-29 (the Runner tokens card, removed).

| ID | Check | Expected |
|---|---|---|
| KEY-15 | Look at the Org model keys row. | It says org keys live in AI Gateway, links **AI Gateway › Provider Keys ↗**, and points to My model access. |
| KEY-16 | Click **AI Gateway › Provider Keys ↗**. | The AI Gateway page of the dashboard opens in a new tab. |
| KEY-17 | Click the My model access link. | Opens `/me/models`. |
| KEY-18 | Look for any personal model key in the table. | None; personal keys never list here. |

## States

| ID | Check | Expected |
|---|---|---|
| KEY-22 | Reload throttled. | A bone in the usage line's place, the disabled toolbar and a table skeleton with the last row count and widths; the Org model keys row. |
| KEY-1674.1 | Open `/settings/keystore` directly in a new tab with `/api/**` delayed 3s. | The sidebar, the title and the KEY-22 skeleton with **Add secret** disabled show at once ("Loading Keystore" status); the main area is never blank. |
| KEY-1846.1 | With `/api/**` delayed 3s, reach `/settings/keystore` from the sidebar. | **Add secret** stays disabled (aria-disabled, tooltip "Available once the secrets list loads") until the data arrives, then enable. |
| KEY-23 | With no secrets stored (test account), open the page. | "No secrets stored" with Add secret. |
| KEY-24 | Block `GET /api/keystore` and reload. | "Couldn't load the keystore" with Retry under the disabled toolbar. |
| KEY-25 | Click **Backed by Secrets Store** in the top bar. | The Secrets Store page of the dashboard opens in a new tab. |
| KEY-1641.1 | Sync an environment whose `.cinder.yml` lists a Keystore secret under `secrets:`, then reload. | That secret's Last used shows the sync time; its audit ends with a `read` by `sync:<sync id>`. |
| KEY-1557.1 | Delay `GET /api/keystore/usage` 3s and reload. | The secrets table draws at once with a bone in the usage line; the line fills in when usage answers. The response carries a `Server-Timing` header. |
| KEY-26 | Delay `/api/**` 3s and open Keystore from the sidebar. | The toolbar and cards don't move when the data lands. |

## Known gaps

- None known.

## Planned

- None.

## Retired

None.
