# Marketplace

- **Route:** `/automation/marketplace`
- **Sidebar:** Automation ▸ Marketplace
- **Backed by:** D1 for listings and installs; release jobs on the `cinder-agents` Artifacts repo ([map](../../ARCHITECTURE-CLOUDFLARE.md#2-page-by-page-map))

**Setup:** the bundled agents are listed on any instance. MKT-1428.5 needs a second account where you are only a Git Contributor.

| ID | Check | Expected |
|---|---|---|
| MKT-1428.1 | Open `/automation/marketplace`. | Title "Marketplace", **Publish an agent**, the four filters, search and one card per agent with version, role, publisher, harness, model, installs, win rate and tokens per merged change. |
| MKT-1428.2 | Look at an agent with fewer than 20 races. | Its win rate reads "untrusted: n outcomes". |
| MKT-1428.3 | Search for text no agent has. | "No agents match “text”" with **Clear search**, which brings the cards back. |
| MKT-1428.4 | Click an agent's name. | A dialog with win rate, tokens per merged change and installs tiles, harness, model with its credential chip, tools, network and versions; **Install** opens the install dialog. |
| MKT-1428.5 | Open **Install**. | Accounts without Git Admin show "(needs Git Admin)" and are disabled; version, name and channel pickers; the note that the install pins its version and starts at "untrusted: 0 outcomes". |
| MKT-1428.6 | Install a version into your account. | "Installing …" status; once the runner releases it, the new agent is on Agents at v1 with no races, on the chosen channel. |
| MKT-1428.7 | Open **Publish an agent**, pick an agent, version, description and "This organization", then Publish. | "Published …" status; the card shows "published by you"; secrets, model keys, limits and changes are listed as never shared. |
| MKT-1428.8 | Reload throttled. | Three skeleton cards while it loads. |
| MKT-1428.9 | Block `/api/marketplace` and reload. | "Couldn't load the marketplace. Installed agents keep running." with Retry. |
| MKT-1428.10 | At 390px, in light and dark, tab through the page. | Cards and dialogs fit; every control has a visible focus ring. |
| MKT-1901.1 | Install an agent from its card. | The card's button reads **Installing…** while the request runs, then **Installed** with a check; a failed install reads **Retry install** with the error above the cards. |
| MKT-1901.2 | In light and dark, look at a card's **Install** button. | A small filled primary button at the card's right edge, its label readable in both themes. |
