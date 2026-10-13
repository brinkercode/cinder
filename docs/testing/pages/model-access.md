# My model access

- **Route:** `/me/models`
- **Sidebar:** User menu (avatar) ▸ My model access
- **Backed by:** your key is a Secrets Store secret `cinder_<provider>_<alias>` used by an AI Gateway provider config under your alias; D1 keeps only the references ([map](../../ARCHITECTURE-CLOUDFLARE.md#2-page-by-page-map))

**Setup:** the seed saves no keys and records no runs: Cloudflare credits connected, every other provider missing, no usage this month. MOD-06 to MOD-08 need a key you saved, a failing one and an org key. Use a throwaway key value you'll recognise, such as `manual-key-<n>`.

## Credential sources

| ID | Check | Expected |
|---|---|---|
| MOD-01 | Open `/me/models`. | Title "My model access" with a description and no action; Credential sources; Providers; My usage this month. |
| MOD-02 | Look at Credential sources. | Three radio rows in order: Use Cloudflare credits (`default`), Use org key (`read-only`, the org's providers, an AI Gateway link), Add my own key or login. |
| MOD-03 | Pick **Use org key**, then reload. | The pick is kept. |
| MOD-04 | Click the AI Gateway › Provider Keys link in the org row. | The dashboard opens in a new tab. |
| MOD-1381.1 | Read the Use Cloudflare credits row. | "Billed to" names the account you're in (the account switcher's), then "No key needed. Hosted models only."; no requests-per-minute figure. |
| MOD-1381.2 | Add an org provider key in AI Gateway › Provider Keys, then reload. | The Use org key row lists that provider, though you saved no key for it; the `GET /api/me/models` response has its id in `org_keys` and no key value. |

## Providers

| ID | Check | Expected |
|---|---|---|
| MOD-05 | Look at the Providers table. | Provider (with method), Source, a status pill (unchecked, connected, missing, failing), Last used, and an action. |
| MOD-06 | Look at the failing provider. | A red pill and the failure reason inline. |
| MOD-07 | Look at a provider with your own key. | "set ••••" with **Replace** and **Remove**; never the key. |
| MOD-08 | Look at the org-key provider. | **View in AI Gateway**, which opens the gateway in a new tab. |
| MOD-09 | Click **Connect** on the missing provider. | The dialog opens with that provider already picked. |
| MOD-10 | In the dialog, switch API key / Subscription login. | The field label changes between "API key" and "Login token". |
| MOD-11 | Type a key. | The characters are masked. |
| MOD-12 | Save `manual-key-1`. | The provider's source becomes My key, and its status is set by the check on save: failing (the provider refuses this fake key). A reload keeps it. |
| MOD-13 | Reopen the dialog with **Replace**. | The provider is picked and the key field is empty. |
| MOD-14 | In the network tab, read the `GET /api/me/models` response. | `manual-key-1` appears nowhere; only the method and status. |
| MOD-15 | Open the Secrets Store in the dashboard. | A secret named `cinder_<provider>_<alias>` exists for the key you saved. |
| MOD-16 | Click **Remove** and cancel the confirm. | Nothing changes. |
| MOD-17 | Click **Remove** and confirm. | The provider returns to missing with **Connect**; its Secrets Store secret is gone. |
| MOD-18 | Save a key Cloudflare refuses (for example on a gateway with no Secrets Store). | The reason, including Cloudflare's message and code, shows above the cards. |
| MOD-19 | Click **Add key or login** in the Providers header. | The dialog opens with no provider forced. |
| MOD-26 | Save an Anthropic **Subscription login** from `claude setup-token`, pick your own key or login, then request a change. | The row shows Subscription login, connected once the check on save accepts it; each model call keeps the status current. Saving a login for any other provider is refused. |
| MOD-27 | Have another person request a change while your login is saved. | Their run doesn't use your login; your Last used doesn't move. |
| MOD-2095.1 | With Use Cloudflare credits picked, save an Anthropic API key, then reload. | Add my own key or login is now picked; the next change you request runs with your key. |
| MOD-2095.2 | Signed in as the first email in `OWNERS`, save a key, then start a change with the `cinder` CLI (the owner token). | The change's agent runs use that key. |
| MOD-2095.3 | **Replace** a saved key while Cloudflare refuses the save. | The reason shows; the provider keeps its old key and the next run still uses it. |
| MOD-2101.1 | Pick Use Cloudflare credits with an Anthropic key saved, then request a change and let its agent run. | Anthropic stays unchecked (or as it was); its Last used doesn't move. |
| MOD-2101.2 | Save an Anthropic key the provider refuses, then request a change. | After the first model call Anthropic shows failing with "Anthropic refused the key (HTTP 401)". |
| MOD-2101.3 | With no key saved, request a change and let its agent run, then reload. | Anthropic still shows missing with **Connect**; Agent runs goes up by 1. |
| MOD-20 | Close the dialog with Cancel and with Esc. | Nothing saved either way; the field is cleared. |

## Usage

| ID | Check | Expected |
|---|---|---|
| MOD-21 | Look at My usage this month. | The month's date range; Tokens, Spend and Agent runs tiles from runners' reports (0 on a fresh seed); a Personal budget tile tagged `proposed`. |
| MOD-22 | Request a change, let its agent run finish, then reload. | Agent runs goes up by 1 and Tokens and Spend rise; a provider with your own key shows the status of its last model call. |

## States

| ID | Check | Expected |
|---|---|---|
| MOD-23 | Reload throttled. | Credential-source bones, a providers table skeleton with **Add key or login** disabled, and the four usage tiles as bones. |
| MOD-1674.1 | Open `/me/models` directly in a new tab with `/api/**` delayed 3s. | The sidebar, the title and the MOD-23 skeleton show at once ("Loading My model access" status); the main area is never blank. |
| MOD-24 | Block `GET /api/me/models` and reload. | "Couldn't load model access" with Retry; the title stays. |
| MOD-25 | Return to the New agent wizard after connecting a provider here. | The wizard's credential chip shows it at once. |

## Known gaps

- **MOD-22:** usage comes from runners' own reports, not from the gateway's logs.

## Planned

- **Set a limit** on the Personal budget tile (shown disabled).

## Retired

None.
