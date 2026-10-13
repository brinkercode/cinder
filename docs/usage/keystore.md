# Keystore

## Purpose

Every secret cinder uses, by scope. Values are never shown after they are saved.

## Where

Settings ▸ Keystore (`/settings/keystore`)

## What you can do

- See how many of the account's Secrets Store secrets are used against its cap; the line fills in once Secrets Store answers, after the secrets list has drawn.
- Search secrets by name or where they apply, and filter them by scope (org, repo, environment or flow).
- **Add secret**: a name, a scope (org, repo, environment or flow), the target the scope needs (a repo, then one of its environments or flows), and the value, which is never shown again. A name already saved at the same scope and target is refused, with a note to replace it from its row or pick another name.
- **Replace** keeps the name and scope and takes a new value; it rotates at once, and runs already started keep the old value.
- **Replace** or **Remove** one. **Remove** asks first: the confirm names the secret and where it applies, and a removed secret can't be recovered.
- **Wanted by flows** lists each secret a flow step failed without and no saved secret covers (a global one, or one of the step's repo): its name, the repo › flow › step that asked for it, linking to that run, and **Add**, which opens **Add secret** with the name filled in. Once the secret is saved it drops off the list.
- A private import's token is kept here as the repo's `IMPORT_TOKEN`; a judge on the `jev` backend reads its key from a `TYPESAFE_API_KEY` secret (the repo's, else the global one).
- An environment's deploy gets every secret its `.cinder.yml` entry lists under `secrets:`, each as a Worker secret of that name: the most specific unexpired match (environment, then repo, then global). A listed secret with no match fails the deploy, naming it. Each deploy read is a `read` in the secret's audit, by `sync:<sync id>`, and moves its Last used.
- Secrets reach flow and deploy jobs only; agents never receive them, at any scope: any other job asking for one is refused (HTTP 403). A secret of kind `agent_secret` can no longer be added (HTTP 400); any saved earlier stay listed.
- Environment- and flow-scoped secrets reach only runs of protected code: a push or cron run of the default branch, or a manual run of an integration or release branch. A run of a change, a manual run of any other ref, or a run with no trigger gets no such secret, and a repo or global secret only when it was saved with `forks: true` (`POST /api/keystore`); a withheld secret reads as missing (HTTP 404). A manual run always runs the branch of the name it is given, never a tag of the same name.
- Listing secrets, their audit and the cap usage needs `keystore.read`; adding, replacing, removing and rebinding need `keystore.write` (owners and admins, or a role that has it).
- Org model keys link out to **AI Gateway › Provider Keys**; personal keys are in [My model access](model-access.md).
- Runner tokens are not here: a worker registers with a pool token minted for its pool on Workers (see [Operations](../operations/README.md#register-a-runner)).

## Backed by

Cloudflare Secrets Store, one binding per secret on the `cinder-secrets` Worker, which cinder reads through a service binding; cinder keeps only references. The page's **Backed by** link opens Secrets Store. Each save first deletes Secrets Store secrets cinder created that no row references and that are over ten minutes old, such as one left by a save interrupted before its row was written; secrets cinder didn't create are never touched.

Cloudflare map for this page: [ARCHITECTURE-CLOUDFLARE.md §2](../ARCHITECTURE-CLOUDFLARE.md#2-page-by-page-map).

## Planned

- A **forks** choice in **Add secret**; today `forks: true` is set only through the API.
