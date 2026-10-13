# Marketplace

## Purpose

Agents bundled with cinder and published on this instance, to install into an account or to publish your own.

## Where

Automation ▸ Marketplace (`/automation/marketplace`)

## What you can do

- Filter by **All**, **Writers**, **Reviewers** or **Published by you**, and search by name, role or publisher.
- A card per agent: name, newest listed version, role, publisher, harness and model, installs, win rate (fewer than 20 decided races reads `untrusted: n outcomes`) and tokens per merged change.
- Click an agent's name for its detail: win rate, tokens per merged change and installs, its harness, its model with the credential your runs would use, its tools, network allowlist and versions.
- **Install**: pick the account (accounts where you aren't Git Admin are disabled), the version, a name and the channel (canary or stable). The install pins that version, starts at `untrusted: 0 outcomes`, and runs with your own model credentials and budget: the publisher's token limits aren't copied. While the install request runs, the card's button reads **Installing…**, then **Installed**; if it fails the button reads **Retry install** and the error shows above the cards.
- **Publish an agent**: pick one of this instance's agents, a version, a listing description and who sees it (this organization or everyone on the instance). Only the prompt, model, tools and network allowlist are installable, with the win rate and tokens per merged change shown; secrets, model keys, limits and changes are never shared.

## Backed by

D1 for listings (`agent_listings`, `agent_publications`) and installs (`agent_installs`); an install is a release job that tags the new agent in the `cinder-agents` Artifacts repo.

Cloudflare map for this page: [ARCHITECTURE-CLOUDFLARE.md §2](../ARCHITECTURE-CLOUDFLARE.md#2-page-by-page-map).

## Planned

- Unpublishing a listing and managing your published listings.
- New versions of an installed template arriving as a canary.
