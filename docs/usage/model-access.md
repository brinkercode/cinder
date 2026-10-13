# My model access

## Purpose

Your own model credentials and usage.

## Where

User menu (avatar) ▸ My model access (`/me/models`)

## What you can do

- Pick a credential source: Cloudflare credits, the org key, or your own key or login.
- Read which account Cloudflare credits are billed to, and which providers have an org key in AI Gateway. If cinder can't read the gateway, the org row says so.
- Per provider: **Connect**, **Replace**, **Remove**, **View in AI Gateway**. Saving a key or login also picks your own key or login as your credential source.
- See each provider's status: saving a key checks it at once with a free call through the gateway (token counting or moderation), which marks it **connected**, or **failing** with the reason when the provider refuses it (HTTP 401 or 403) or its credits are empty (HTTP 402). Each model call made with it updates the status the same way. A key stays **unchecked** only when that check couldn't run. A run on Cloudflare credits or the org key never changes your key's status. A provider you never saved a key for shows **Connect**, whatever runs used it.
- **My usage this month**: tokens, spend and runs that runners report after each agent run of a change you requested, including failed runs that used no tokens. A run with no requester counts against its runner, not a person.

If saving or removing a key fails, the page shows the reason above the cards. That includes Cloudflare's own message and code when Cloudflare refuses the request, for example a gateway with no Secrets Store.

## Backed by

Your key is a Secrets Store secret named `cinder_<provider>_<alias>`, used by an AI Gateway provider config under your alias; cinder never reads it or keeps it in D1. Replacing a key stores the new one before it deletes the old one, so a replace that fails leaves the old key working; removing a key deletes both. If a secret with your key's name is already there without a saved key (an interrupted save), saving replaces its value instead of failing. When your source is your own key, model calls for the changes you request on cinder's managed pools go through the gateway with your alias, so they use your key; a BYO pool calls its provider with the machine's own key, never yours. A runner can't pick whose key it uses: cinder ties each call to the job the runner holds and that job's requester. The requester is whoever created the change, even when an owner names another person as its author; a change started with the owner token is requested by the first email in `OWNERS`.

A subscription login (Anthropic only: the token `claude setup-token` prints) is a Secrets Store secret bound to cinder's secrets Worker, not a gateway key. It is used only on model calls of jobs whose change you requested, while your source is your own key or login; it is never used for system-created changes or anyone else's work. Those calls carry it as Anthropic's OAuth bearer through the gateway. The login's status comes from those calls: **connected** when Anthropic accepts it, **failing** with the HTTP status when Anthropic refuses it.

Cloudflare map for this page: [ARCHITECTURE-CLOUDFLARE.md §2](../ARCHITECTURE-CLOUDFLARE.md#2-page-by-page-map).

## Planned

- **Set a limit** (shown disabled).
