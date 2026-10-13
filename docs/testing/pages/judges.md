# Judges & calibration

- **Route:** `/automation/judges/:id?`
- **Sidebar:** Automation ▸ Judges & calibration
- **Backed by:** Workers AI for the judge models; D1 for judgments and outcomes ([map](../../ARCHITECTURE-CLOUDFLARE.md#2-page-by-page-map))

**Setup:** the seed records no judge history: judges appear from the seeded changes' risk labels and reviews, and from real runs. JDG-02 to JDG-05 need judges with real outcomes, an untrusted one (fewer outcomes than the repo's trust minimum) and a degraded one with default verdicts.

| ID | Check | Expected |
|---|---|---|
| JDG-01 | Open `/automation/judges`. | Title "Judges & calibration" with a description and **Add judge**; one tab per kind with a judge, with its count; the kind's question; Reliability and Brier over 12 weeks cards; a leaderboard row per judge. |
| JDG-02 | Look at a trusted judge's leaderboard row. | Swatch, judge, model, Brier score with a bar, outcomes, a 12-week sparkline, the largest miss and a health dot with its label. |
| JDG-03 | Look at the untrusted judge's row. | "learning: n of N outcomes" (N the trust threshold, 20 on seeded repos) instead of a Brier score, even past 20 outcomes; largest miss "—"; it sorts last, and its curve is dashed and dimmed. |
| JDG-04 | Look at the degraded judge's health cell. | An amber dot, "Model degraded", the reason, and an "n default verdicts" pill. |
| JDG-05 | Look at a healthy judge's health cell. | A green dot and "Model healthy"; no default-verdicts pill. |
| JDG-06 | Click a judge in the leaderboard. | Its detail opens: the judge's name, question and model, the calibration chart (or "Not enough outcomes" with "n of N" progress while untrusted), Brier over time, Models and up to ten recent verdicts with change (or "inherited") and the agent@version that wrote it, p, outcome and when. |
| JDG-07 | Click **Backed by Workers AI** in the top bar. | The Workers AI page of the dashboard opens in a new tab. |
| JDG-08 | Reload throttled. | Reliability and Brier card bones, then skeleton rows, as many as last time (3 on a first visit). |
| JDG-1674.1 | Open `/automation/judges` directly in a new tab with `/api/**` delayed 3s. | The sidebar, the title and the JDG-08 skeleton with **Add judge** disabled show at once ("Loading Judges" status); the main area is never blank. |
| JDG-09 | Block the judges request and reload. | "Couldn't load judges" with Retry. |
| JDG-10 | On an account with no judges, open the page. | "No judges yet". |
| JDG-1419.1 | Click **Add judge**, pick a repo, a kind, a model and a minimum confidence, then **Add judge**. | The dialog shows the judge id, each model with its credential chip and the airlock note; New change opens with the intent "Set judges.&lt;kind&gt; in .cinder.yml to { backend, model_version, min_confidence }". |
| JDG-1419.2 | Open the judge a kind runs now and use **Swap model**, then pick another model. | New change opens with the intent to set that kind's backend and model in `.cinder.yml`. |
| JDG-1419.3 | On that judge, turn **Airlock** on in the head, then open a new change on the repo. | The head and Settings toggles both show on, and stay on after reload; the change's risk route reads "judge not yet trusted" while airlock is on. |
| JDG-1419.4 | Open a degraded or failing judge. | A red row under the head with the cause and **Swap model**, or **Bind index** when the cause is an unbound index. |
| JDG-1419.5 | At 390px, in light and dark, tab through the dialog and the Settings card. | Every control is reachable with a visible focus ring; nothing overflows. |
| JDG-1578.1 | Add a judge (or create a repo) and open the page before any of its changes has an outcome. | The judge's row is there with "learning: 0 of N outcomes, all time". |
| JDG-2026.1 | Open Judges & calibration on a seeded deployment. | One tab per judge kind; one row per model (pooled across repos) and one per reviewer; no tab for a kind no repo configures. |
| JDG-2084.1 | Open `/automation/judges?kind=guard`, then reload. | The guard tab stays selected. |
| JDG-2084.2 | On a kind whose model runs on two repos, read its row. | One row; outcomes are the sum, Brier the outcome-weighted mean. |
| JDG-2084.3 | Open a judge's **Settings** at the bottom of its detail. | Trust threshold, model and the same Airlock state as the head. |
| JDG-2026.2 | Swap a judge's model, let a change get scored, then open it. | The judge shows the new model; the old one is a row under **Models** with its own outcomes, its curve dashed behind the new one, and a "Swapped to …" mark on Brier over time; not a separate judge. |
| JDG-2109.1 | On the risk tab with judges on two repos, click one repo's row. | The detail shows only that judge: one head, one calibration, one verdict list, one Models table; no other repo's judge. |
| JDG-2109.2 | Open `/automation/judges/risk`. | The list opens with the risk tab selected (`?kind=risk`), not a detail. |
| JDG-2109.3 | Click a row whose model runs on two repos. | One pooled detail for that model, with recent verdicts from both repos and no Swap model, Airlock or Settings. |
| JDG-2110.1 | On a trusted judge's detail with outcomes older than 30 days, switch the Brier over time window from **90d** to **30d**. | The address gets `?window=30d`; the Calibration card's n, bins, Brier and largest miss drop to the last 30 days' outcomes; the head still reads "trusted · n=… all time". |
| JDG-2110.2 | From that detail, click **All judges**. | The list keeps `?window=30d`; the leaderboard's outcomes and Brier cover the last 30 days; an untrusted row reads "learning: n of N outcomes, all time". |
| JDG-2109.4 | On a judge's detail, open **Swap model** in the head, then in Settings. | Each opens its own menu under its button. |

## Planned

- Judge calls through AI Gateway.

## Retired

- JDG-2098.1: a detail no longer shows several repos' judges; JDG-2109.4 covers the Swap menus.
