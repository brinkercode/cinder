# Access & people

## Purpose

Who can use cinder and with which role. Sign-in itself is Cloudflare Access; roles are cinder's.

## Where

Settings ▸ Access & people (`/settings/access`)

## What you can do

- **Zero Trust › Access** opens the sign-in app in the dashboard.
- **Invite people:** one or more emails (commas or new lines), a role (Owner, Maintainer, Contributor; Contributor is preselected) and repositories (all, or the selected repo names). Each email is added to the cinder Access app's owners policy, so they can sign in at once; anyone not in the policy stays blocked. **Invite** sits in the page head and on the People card.
- **People from Cloudflare Access:** People also lists every email the cinder Access app's allow policies admit, including emails added in the Cloudflare dashboard and members of Access groups those policies include. Someone who hasn't signed in shows "Invited in Cloudflare Access · not signed in" and no role; picking a role gives them that role in cinder. If the Access API can't be read, People lists cinder's own records.
- **Map a group** (Access group, IdP group or Cloudflare User Group) to a role (Contributor is preselected) on all repositories or selected ones, change a mapping's role inline, or **Remove mapping**. A signed-in person whose Access identity lists a mapped group in its `groups` claim gets that role on the mapping's repos, without an invite; with several roles the strongest wins. A mapping counts only for its own identity provider: a source naming a provider's id in parentheses (`IdP group (<IdP id>)`) matches only sign-ins whose Access identity reports that provider id (`idp.id`, case-insensitive), so two providers of the same type never share group names, and a source naming none matches only sign-ins that report no provider. Members get the role at their next sign-in.
- The people table: name, email, a role select that saves at once, last seen, and **⋯ › Remove** with a confirm. Removing a person drops their roles and takes their email out of the Access policy; a group mapping that still includes them gives its role back at their next sign-in. An `OWNERS` email shows an Owner tag and no controls.
- **Last owner:** the only Owner can't be given another role or removed. An Owner is an `OWNERS` email, a person with the Owner role or a group mapped to Owner on all repositories. For a person the page explains why in a dialog and sends nothing; for a group mapping it shows the server's reason above the cards. The API answers 409 `last_owner`.
- An allowed Access service token appears as `<name>@service-token` after its first request and takes a role like any person.
- **Add account:** a name, a slug (lowercase letters, digits and dashes) and, optionally, an organization by name (an existing one, or a new one). The account is cinder-local until an hourly sync links it to a Cloudflare account; it then shows in the sidebar account popover.
- **Service tokens:** **Allow a token** by client ID and name, or **Remove** one; a removed token is refused from its next request.
- **Demo data** (owners, on a nonprod deployment only): **Reset and reseed…** asks for confirmation, naming what is erased, then empties the deployment and runs every seed section; **Start the demo scenario** adds the `pulse` repo and files its twelve demo intents once a worker pool has indexed it. The card shows the step running and then the result or the error. Neither needs a repo checkout.

## Backed by

Cloudflare Access (Zero Trust) at the edge, roles and allowed service tokens in D1. Invites and removals edit the Access policy through the Cloudflare API. The page's **Backed by** link opens the Zero Trust app.

Demo data runs in the `cinder-seed` Workflow, which drives the Worker's own API as the owner with the seed sources bundled into the Worker.

Cloudflare map for this page: [ARCHITECTURE-CLOUDFLARE.md §2](../ARCHITECTURE-CLOUDFLARE.md#2-page-by-page-map).

## Planned

- Naming the identity provider when mapping a group on this page; the API accepts a source such as `IdP group (<IdP id>)`.
- Allowing a service token here does not add it to the Access policy; include it in the owners policy in Zero Trust.
