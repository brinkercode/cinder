# Agents

- **Route:** `/automation/agents`, `/automation/agents/:name/:tab?` (`runs`, `versions` is History and the default, `settings`, `races`)
- **Sidebar:** Automation ▸ Agents
- **Backed by:** agent versions as tags in the `cinder-agents` Artifacts repo, indexed in D1; model calls and run detail from AI Gateway `cinder` ([map](../../ARCHITECTURE-CLOUDFLARE.md#2-page-by-page-map))

**Setup:** the seeded fleet's versions, channels and roles (developer v2 with canary v3 at 20%, reviewer v2, resolver v2, dev-open v1; each prompt has a Reading documentation section and every seeded version reads the web as Markdown); its runs, tokens and races come only from real runs, so AGT-25 to AGT-28, AGT-31 and AGT-32 need one. The owner's model access as seeded (credits, every other provider missing). Name test agents `manual-<n>`.

## Index

| ID | Check | Expected |
|---|---|---|
| AGT-01 | Open `/automation/agents`. | Title "Agents" with View docs and **New agent**; search and refresh; one card per agent; the Fleet aside. |
| AGT-02 | Look at an agent card. | Name, version tag, channel pill, a canary pill when one is out, role, harness and repo count, running or idle; footer with win rate, tokens, merged and races. |
| AGT-03 | Look at an agent with under 20 races. | The win rate shows the untrusted line, never a percentage. |
| AGT-04 | Type part of a name in search. | Cards filter as you type. |
| AGT-05 | Click refresh. | The list reloads in place. |
| AGT-1400.1 | Set a token budget below this month's spend (When agents reach it: Pause agents) and open `/automation/agents`. | A banner "Agents paused: budget reached · … tokens · resumes &lt;date&gt; or when an owner raises it" with **Raise budget** (opens Needs you); each agent card shows `paused · budget` and "Paused: budget reached · resumes &lt;date&gt;". |
| AGT-1400.2 | As a non-owner, open `/automation/agents` while paused. | **Raise budget** is disabled, with "Only owners can raise the budget: &lt;owners&gt;" and **Ask &lt;owner&gt;**. |
| AGT-06 | Click an agent's name. | Opens its detail on Runs. |

## Fleet aside

| ID | Check | Expected |
|---|---|---|
| AGT-07 | Look at the aside. | "Fleet": Running and Races · 24h tiles, a tokens ring with the top agent's share, and the Canary auto-promote toggle. |
| AGT-08 | Toggle **Canary auto-promote**, then reload. | The new state is kept. |
| AGT-09 | Toggle it while the API refuses (block `PUT /api/fleet`). | It flips back and the reason shows. |

## New agent wizard

| ID | Check | Expected |
|---|---|---|
| AGT-10 | Click **New agent**. | A 900px dialog with a step indicator (Harness, Model, Limits) on step 1: four harness cards. |
| AGT-11 | Pick a harness and click **Continue**. | Step 2 lists that harness's models, hosted ones first and tagged suggested, with "Browse all models ↗" above. |
| AGT-12 | Look at a model row. | Id, provider, context window, price per M tokens, a credential chip, **Catalog ↗**, and **Try in playground ↗** on hosted models. |
| AGT-13 | Click **Catalog ↗**, **Try in playground ↗** and **Browse all models ↗**. | Each opens in a new tab; **Catalog ↗** opens that model's own catalog page. |
| AGT-14 | Pick a model whose provider has no credential. | A warning bar with **Connect in My model access**; Continue is disabled. |
| AGT-42 | With an Anthropic credential connected, pick Claude Code and click **Continue**. | Anthropic models (`anthropic/...`) are listed and Continue is enabled. Codex lists OpenAI models the same way. |
| AGT-43 | Pick a harness with no models in the catalog. | "No <harness> models in the catalog."; no credential warning; Continue is disabled. |
| AGT-15 | Click **Connect in My model access**. | Opens `/me/models`. |
| AGT-16 | Connect that provider in My model access, reopen the wizard, pick the same model. | The chip shows the new credential and Continue is enabled. |
| AGT-17 | Go back to step 1 and pick another harness. | Step 2's model resets to that harness's first model. |
| AGT-18 | Click **Back** on step 2. | Returns to step 1 with the harness still picked. |
| AGT-19 | On step 3, enter name `manual-1`, max spend, max repairs, channel, click **Create agent**. | The dialog closes; a status line says the release is queued; the agent appears once a worker records it. |
| AGT-20 | Try to create an agent with an existing name. | Refused with a message in the dialog; nothing is created. |
| AGT-21 | Close the wizard with ×. | Nothing is created. |
| AGT-22 | Make the catalog request fail, open the wizard, go to step 2. | An error with Retry; Retry loads the catalog. |

## Detail

| ID | Check | Expected |
|---|---|---|
| AGT-23 | Open `developer`. | Name, version, channel, and History / Runs / Settings & prompt / Races. |
| AGT-24 | Click each tab, then reload. | Exactly one tab shows; the URL ends in the tab; reload keeps it. |
| AGT-25 | Look at Runs. | Tiles (Runs · 24h, Tokens · 24h, Cost · 24h, Win rate); a run card with a per-call table (model, call, input, output, cost, latency) and a totals row "from AI Gateway". |
| AGT-26 | Click **View trace**. | Opens the trace for the run (the change it worked on). |
| AGT-27 | Click **View gateway log**. | The AI Gateway logs open in the dashboard in a new tab. |
| AGT-28 | Compare the run's totals with the gateway log for that run. | Tokens and cost match. |
| AGT-29 | Open Settings & prompt. | A model picker with the credential chip, and the prompt. |
| AGT-30 | Pick another model in Settings & prompt, then reload. | The pick is kept as the draft for the next release; the chip follows the model. |
| AGT-31 | Open Races. | Tiles, the rate-limit note (20 requests a minute, 50 with credits), a leg table (leg, model, tokens, time, tests, p(merge), rate, won, lost or pending) and recent races. |
| AGT-32 | Look at a leg close to its rate limit. | Its rate shows with an amber warning. |
| AGT-33 | Open an agent with no runs. | "No runs yet". |
| AGT-34 | Open an agent with no races. | "No races yet". |
| AGT-39 | Open Races on an agent whose race has no winner yet. | Its legs and its Recent races row show "pending", never "lost". |
| AGT-40 | Open Runs on an agent with tokens in the last 24h. | Runs · 24h is at least 1 and a run card shows. |
| AGT-44 | After a real agent run, wait one pull (10 minutes) and open that agent's Runs. | The run card lists one call per AI Gateway log of the run, and its calls' tokens sum to the run's tokens. |
| AGT-46 | As a Maintainer, click **Promote to stable** on v3, then describe a new change. | v3 shows stable; the new change's card names developer@v3; older changes keep developer@v2. |
| AGT-1389.1 | Open `developer` › Versions. | One row per version, newest first: version, channel, traffic, win rate, web, released and an action. developer@v3 canary has a traffic slider at 20%, developer@v2 stable shows 80%, v1 0%. Under 20 outcomes the win rate shows `untrusted: n outcomes`. |
| AGT-1959.1 | Open `developer` › Versions after a run of a version on `markdown` that read a docs page. | Its **Web** cell reads `markdown · <n> converted · <bytes> bytes saved`; a `raw` version, or one with no conversions, shows only its setting. |
| AGT-1959.2 | Save a draft of a `raw` version without changing its web setting. | The draft card's diff to the shown version has `-web: raw` and `+web: markdown` (the default for new versions). |
| AGT-1389.2 | Drag (or arrow-key) the canary slider to 35% and let go, then reload. | Stable shows 65%; after reload the slider is at 35%, and Release history has "Canary v3 at 35%" by you. |
| AGT-1389.3 | Click **Promote to stable** on a canary with under 20 outcomes. | A confirm warns that its win rate is untrusted; Cancel changes nothing; **Promote to stable** makes it stable. |
| AGT-1389.4 | Click **Roll back to v1** on an older version, then confirm. | The confirm says stable moves from v2 to v1 and runs already going finish on v2; v1 shows stable, the next new change names developer@v1, and Release history has "Rolled back stable to v1". |
| AGT-1586.1 | As a Maintainer, set the developer canary's traffic to 50%, then describe ten new changes. | Some cards name the canary version and the rest the stable version; each change keeps its version when reopened. |
| AGT-48 | As a Contributor, click **Promote to stable**. | Refused; the reason shows under the table and the channels don't change. |
| AGT-1337.1 | As a Maintainer, click **Promote to stable** on a `reviewer` (or `resolver`) version, then let a change reach agent review (or a conflict). | The new review (or resolve) job's run names that version; jobs queued before the promote keep the version they were queued with. |
| AGT-1392.1 | On Settings & prompt, add `*.github.com` to the Network allowlist, then remove another host. | Each edit saves the draft (`PUT /api/agents/<name>/draft`); the list shows the draft; the released versions don't change until a release. |
| AGT-1392.2 | Add `evil.example/x`. | Refused; the reason shows under the cards and the list doesn't change. |
| AGT-1390.1 | In Settings & prompt, click **Edit** on the Prompt card, change the text, click **Save draft**. | The prompt shows the edit; a Draft card `<name>@v<next>-draft` says "not running anywhere" with a diff to the shown version (prompt lines and allowlist hosts, `+` green, `-` red). Channels on Versions don't move and new runs keep the released version. |
| AGT-1390.2 | Click **Discard draft**, then Cancel; click it again and confirm. | Cancel keeps the draft; confirming removes the card and the prompt shows the released one. |
| AGT-1390.3 | With a draft, click **Release v<next>…**, pick **stable**, add a note, click **Release v<next>**. | The draft card goes away; once a runner records the release, Versions lists v<next> on stable and the canary is unchanged. Picking **canary** instead moves canary to it at the existing share. |
| AGT-1390.4 | Make the diff request fail (block `GET /api/agents/:name/diff`). | The Draft card shows the error with Retry; Retry loads the diff. |
| AGT-1980.1 | On `developer` › Versions, click `developer@v6`. | A card `developer@v6` above the table lists its model, harness, effort, tools, limits, egress and web, and its prompt rendered as Markdown; **Raw** shows the prompt text as committed. The URL ends in `?v=6`, and reloading keeps it open. |
| AGT-2069.1 | Open `developer` with no tab. | It opens on **History**: one row per version with version, channel, released time and **By** (who released it; `cinder` for a baked-in version). |
| AGT-2069.2 | Click `developer@v3` in History. | Its prompt and lock show above the table with a diff from v2 (prompt lines, `+` green, `-` red); v1 says it is the first version. **Compare with…** changes the base. |
| AGT-1980.2 | With v6 open, pick v8 in **Compare with…**. | A diff from v6 to v8: prompt lines, then each changed lock field (`-model: …` / `+model: …`, egress host by host), `+` green, `-` red. |
| AGT-1980.3 | With v6 open, click **Edit from this version**. | Settings & prompt opens with a Draft card "Draft saved · …" whose prompt and lock are v6's and a diff to stable; with a draft already saved, a confirm asks to replace it first. Releasing it adds a new version; v6 is unchanged. |
| AGT-1980.4 | Click a leg's `name@vN` on Races, or the run's version on Runs. | Opens that version on Versions. |
| AGT-41 | Open Settings & prompt on an agent whose saved model its harness can't run (e.g. Claude Code with an `@cf/...` model). | That model shows selected, with "Not available for this harness" in the header and on its row. |
| AGT-2070.1 | Install an agent from the marketplace, then open its Settings & prompt. | The prompt shows read-only with "Installed from the marketplace; its prompt is locked." and no **Edit** button. |
| AGT-2070.2 | `PUT /api/agents/<installed>/draft` with a changed prompt, then with only a changed limit. | The changed prompt is refused (HTTP 409, `prompt_locked`); the limit change saves. |

## States

| ID | Check | Expected |
|---|---|---|
| AGT-35 | Reload the index throttled. | The disabled toolbar and skeleton cards (4 on a first visit); the aside's tile and ring bones. |
| AGT-36 | Reload a detail page throttled. | Header bones, 4 tile bones and a calls table skeleton. |
| AGT-1674.1 | Open `/automation/agents` directly in a new tab with `/api/**` delayed 3s. | The sidebar, the title and the AGT-35 skeleton with **New agent** disabled show at once ("Loading Agents" status); the main area is never blank. |
| AGT-1846.1 | With `/api/**` delayed 3s, reach `/automation/agents` from the sidebar. | **New agent** stays disabled (aria-disabled, tooltip "Available once the agents list loads") until the data arrives, then enable. |
| AGT-1674.2 | Open `/automation/agents/<name>` directly in a new tab with `/api/**` delayed 3s. | The sidebar and the AGT-36 skeleton show at once ("Loading Agent" status); the main area is never blank. |
| AGT-37 | On an account with no agents, open the index. | "No agents registered" with **New agent**. |
| AGT-38 | Block `GET /api/agents` and reload. | "Couldn't load agents" with Retry. |
| AGT-1389.5 | Open Versions throttled, then with `GET /api/agents/:name/versions` blocked. | A table skeleton with the column headers; blocked, "Couldn't load versions" with Retry while the header and tabs stay. |

## Known gaps

- **AGT-26:** View trace opens the change the run worked on, not Observability › Agents.

## Planned

- Releasing a version on the managed pool (it needs an online runner today).

## Retired

- **AGT-45:** the Versions table no longer shows commit, runs and p(merge); AGT-1389.1 replaces it.
- **AGT-47:** Roll back now asks to confirm; AGT-1389.4 replaces it.
