# Access & people

- **Route:** `/settings/access`
- **Sidebar:** Settings ▸ Access & people (also in the user menu)
- **Backed by:** Cloudflare Access (Zero Trust) for sign-in; roles, group mappings and allowed service tokens in D1 ([map](../../ARCHITECTURE-CLOUDFLARE.md#2-page-by-page-map))

**Setup:** no seeded mappings (map one with ACC-07 before ACC-03 to ACC-05); the seeded people `ana.ruiz@example.com` (Maintainer), `ben.okafor@example.com` and `chen.wu@example.com` (developer), `dara.novak@example.com` (Contributor) and `emeka.obi@example.com` (viewer), plus the owner once signed in. Use group names `manual-group-<n>` and invite `manual+<n>@` addresses on your own domain.

| ID | Check | Expected |
|---|---|---|
| ACC-01 | Open `/settings/access`. | Title "Access & people" with **Zero Trust › Access ↗** and **Invite**; the Group → role mapping table; People; the roles explainer. |
| ACC-02 | Click **Zero Trust › Access ↗**. | The Zero Trust dashboard opens in a new tab. |
| ACC-03 | Look at the mapping table. | Source, Group (mono), Cinder role (a select), Repos ("all repos" when none), ⋯. |
| ACC-04 | Change a mapping's role select. | It saves at once; a reload keeps the new role. |
| ACC-05 | Change a role while the API refuses (block `PUT /api/groups/*`). | The select returns to the saved role and the reason shows. |
| ACC-06 | Click **Map a group**. | A modal: Source (Access group, IdP group, Cloudflare User Group), Group, Cinder role (Contributor selected), Repositories (All repositories or Selected), the next-sign-in note, Cancel and **Map group**. |
| ACC-07 | Map `manual-group-1` as Contributor for `svc-orders-go`. | A new row with that source, role and repo; a reload keeps it. |
| ACC-08 | Open the new row's ⋯ and click **Remove mapping**. | The row goes and stays gone after a reload. |
| ACC-09 | Look at People. | A chip with each person's initial and name, email, a role select (an Owner tag for an `OWNERS` email), last seen ("never" if they haven't signed in) and ⋯. |
| ACC-10 | Click **Invite**, enter an email and pick Maintainer, click **Send invites**. | The person appears in People with Maintainer selected; a reload keeps it. In Zero Trust the cinder app's owners policy now includes the email, and the person can sign in. |
| ACC-11 | Open Invite and click **Cancel**. | Nobody is invited. |
| ACC-12 | Sign in as an invited Contributor and open this page. | The page loads, but role changes, Map a group and Invite are refused with the reason. |
| ACC-13 | Delete every mapping (on a test account), then open the page. | A hint: "No mappings yet. Map an Access group, IdP group or Cloudflare User Group to a cinder role." |
| ACC-14 | Reload throttled. | Table skeletons for mappings, people and service tokens with the last row counts (4, 6 and 2 on a first visit); Map a group and Allow a token disabled. |
| ACC-1847.1 | Visit the page once, then reload throttled and watch the data land. | Each card keeps its height and position: the skeleton has the same cards and row counts, and loaded rows are as tall as skeleton rows. |
| ACC-1674.1 | Open `/settings/access` directly in a new tab with `/api/**` delayed 3s. | The sidebar, the title and the ACC-14 skeleton with **Add account** and **Invite** disabled show at once ("Loading Access & people" status); the main area is never blank. |
| ACC-1846.1 | With `/api/**` delayed 3s, reach `/settings/access` from the sidebar. | **Add account** and **Invite** stay disabled (aria-disabled, tooltip "Available once access loads") until the data arrives, then enable. |
| ACC-15 | Block `GET /api/people` and reload. | "Couldn't load access" with Retry; the title and its buttons stay. |
| ACC-16 | Click **Backed by Zero Trust app** in the top bar. | The Access apps page of the dashboard opens in a new tab. |
| ACC-17 | Click **Allow a token**, enter a service token's client ID and the name `ci-bot`, click **Allow**, call `GET /api/repos` with its `CF-Access-Client-Id`/`CF-Access-Client-Secret` headers, then reload this page. | People lists `ci-bot@service-token`; with the Viewer role the call answers 200. A token not in the allowlist gets 401 `access_no_email`. |
| ACC-18 | Click **Map a group**, type only `manual-group-2` and click **Map group**. | A new row with role Contributor and "all repos". |
| ACC-19 | Click **Invite**. | Cinder role shows Contributor. |
| ACC-20 | Remove an invited person (`DELETE /api/people/<email>`). | The email is gone from the owners policy in Zero Trust and they can no longer sign in. An `OWNERS` email stays in the policy. |
| ACC-21 | Under Service tokens, click **Remove** on `ci-bot`. | The row goes; the token's next request gets 401 `access_no_email`. |
| ACC-1352.1 | Map an Access group you belong to as Contributor, sign in as a member with no invite and open Repos; then remove the mapping and reload. | Repos loads while the mapping exists; after removal the next request is refused. |
| ACC-1600.1 | With the API, map a group you belong to with source `IdP group (<another provider>)`, then sign in as a member and open Repos. | Repos is refused: the mapping names a different identity provider. |
| ACC-1778.1 | With the API, map a group you belong to with source `IdP group (<your provider's id>)`, then sign in through a second provider of the same type that also sends that group, and open Repos. | Repos is refused: the mapping names the first provider's id, not its type. |
| ACC-1352.2 | With `OWNERS` empty and one Owner, remove that Owner or change their role (`DELETE /api/people/<email>`, `POST /api/people`). | 409 `last_owner`; the Owner keeps the role. |
| ACC-1828.1 | With `OWNERS` empty, no Owner person and `manual-group-4` mapped to Owner on all repos, change its role to Maintainer, then click **Remove mapping**. | Each time the page shows `last_owner`'s reason above the cards and the mapping stays Owner. With that mapping in place, an Owner person can be removed. |
| ACC-1828.2 | With `OWNERS` set to one email and no other owner, `DELETE /api/people/<that email>`, then `PATCH` it with `{"role": "viewer"}`. | Both answer 409 `last_owner` and the People row stays. After making another person Owner, the `DELETE` answers 204. |
| ACC-1415.1 | In People, change a non-owner's role select to Maintainer, then reload. | It saves at once and the reload keeps Maintainer. |
| ACC-1415.2 | With `OWNERS` empty and one Owner, change that Owner's role select, then open their ⋯ and click **Remove**. | Each time a dialog "Can't change <name>'s role" / "Can't remove <name>" says they're the only owner; OK closes it, the select stays Owner and no request is sent. |
| ACC-1415.3 | Open a non-owner's ⋯, click **Remove <name>**, then **Remove**. | A confirm explains what they lose; after Remove the row goes and stays gone after a reload. Cancel removes nobody. |
| ACC-1415.4 | Click **Invite**, enter two `manual+<n>@` emails on separate lines, pick Maintainer and Selected `svc-orders-go`, click **Send invites**. | Both appear in People; each has Maintainer on `svc-orders-go` only. The note about the Access policy shows under the fields. |
| ACC-1415.5 | Click **Map a group**, map `manual-group-3` as Contributor with Selected `svc-orders-go`, then sign in as a member. | The row shows `svc-orders-go`; the member gets Contributor there at their next sign-in. |
| ACC-1968.1 | On a nonprod deployment, as an owner, click **Reset and reseed…**, read the dialog, click **Reset and reseed**. | The dialog names what is erased. The card shows `Running: reset…`, then `Running: seed…`, then the reseeded result; Repositories lists web-store, svc-orders-go and infra-cloudflare-tf. Cancel starts nothing. |
| ACC-1968.2 | On a nonprod deployment with a worker pool, click **Start the demo scenario**. | The card shows `Running: demo…`, then the result; `pulse` has twelve intents on `develop`. |
| ACC-1968.3 | Open the page as a non-owner, or on a deployment whose `CINDER_ENV` is not `nonprod`. | No Demo data card; `POST /api/admin/seed` and `/api/admin/demo` answer 403. |
| ACC-1279.1 | Click **Add account**, enter name `Manual Labs`, slug `manual-labs-<n>` and organization `Nimbus Edge`, click **Add account**. | The account appears under Nimbus Edge in the sidebar account popover. A slug already in use shows the 409 error and adds nothing. |

## Known gaps

- None known.

## Planned

- None.

## Retired

None.
| ACC-2086.1 | Add an email to the cinder Access app's owners policy in the Cloudflare dashboard (not from cinder), then reload Access & people. | The email lists under People with no role and "Invited in Cloudflare Access · not signed in"; choosing Maintainer keeps it after a reload. |
| ACC-2086.2 | Click **Invite** on the People card. | The Invite people dialog opens. |
