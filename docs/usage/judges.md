# Judges & calibration

## Purpose

Who scores changes before the verifier merges, and how well their probabilities match outcomes.

## Where

Automation ▸ Judges & calibration (`/automation/judges`)

## What you can do

- One tab per question (judgment kind) that has a judge, with its judge count; the selected tab is in the address (`?kind=risk`), and without one the first kind with an untrusted or unhealthy judge opens. Under the tabs, the question in plain words.
- **Reliability:** every judge answering the question on one chart (stated probability against what happened), with a band 10 points either side of the diagonal and dots sized by outcomes. Untrusted judges are dashed and dimmed, shown for shape only.
- **Brier over 12 weeks** (or the window's weeks): one line per judge, labelled with its latest value; a week with no outcomes is a gap, and "—" when there is no trend yet. A vertical mark shows where a judge's model was swapped.
- The list loads all time unless the address carries a window (`?window=30d`, kept by the tabs, the rows and the detail's **All judges** link); its counts, bins, Brier scores and trend then cover that window.
- **Leaderboard:** trusted judges first, then by Brier score. Each row has the judge, its model, its Brier score with a bar (or "learning: n of N outcomes" while untrusted, never a score), outcomes, a 12-week sparkline, the largest miss (the bin furthest from the diagonal: "said 45%, happened 50%"; "—" while untrusted), and its health with the reason and any default verdicts. A model running on several repos is one row: outcomes summed, bins, Brier and weekly Brier weighted by outcomes. Each person or agent reviewer is one row. With one judge on the question, a note says there is nothing to rank it against.
- Open a row for that one judge's detail (`/automation/judges/:id`): a row from one repo opens that repo's judge; a model pooled across repos opens it pooled (outcomes summed, recent verdicts from every repo), without the per-repo **Swap model**, **Airlock** and **Settings**. A link to a kind alone (`/automation/judges/risk`) opens the list on that kind's tab.
  - The head: the kind, judge, question, type, model and "trusted · n=… all time (… inherited)" or "learning: n of N outcomes, all time", with **Swap model** and the **Airlock** toggle. A degraded or failing judge shows a red row under the head with the cause and its fix: **Swap model**, or **Bind index** (opens Vectorize in the dashboard) when the cause is an unbound index.
  - **Calibration:** the reliability curve, the previous model's curve dashed behind it after a swap, outcomes per bin, the Brier score (and the previous model's), the largest miss and how many bins sit within 10 points. While untrusted: "Not enough outcomes" with progress toward the trust threshold, and no curve or score.
  - **Brier over time:** the weekly Brier score; after a swap, the earlier weeks are dashed with a "Swapped to …" mark. **30d**, **90d** (the default) and **All** pick the window, kept in the address (`?window=30d`): every outcome count, bin, Brier score and largest miss on the detail covers that window. The trust state ("trusted · n=… all time", "learning: n of N outcomes, all time" and the Not enough outcomes progress) always counts every outcome.
  - **Models:** the current model (now) and the ones it ran before a swap, each with its own outcomes, Brier score (or "learning") and when it ran.
  - **Recent verdicts:** the ten newest with their change (or "inherited" for imported history) and the agent@version that wrote it, p, outcome (correct, wrong or pending) and when, if the API sends it.
- **Add judge:** pick the repo, the question it answers (a judgment kind), a model (with the credential its calls use: `clef@2` and `clef-flash@2` run the Clef decision models on Workers AI; `clef@1` and `clef-flash@1` stay for judges already on them) and a minimum confidence (below it the judge abstains). It opens a new change that sets the kind under `judges` in `.cinder.yml`; the judge runs once that change merges. A kind configured for the first time starts in airlock.
- On the judge a kind runs now, **Settings** (collapsed at the bottom of its detail):
  - **Swap model** opens a `.cinder.yml` change to the picked model; the new model starts a new calibration series.
  - **Trust threshold:** the outcomes this judge needs before its verdict counts (empty uses the repo's). **Save as a change** opens a `.cinder.yml` change.
  - **Airlock:** the judge still scores every change, but its verdict doesn't count. It applies from the judge's next verdict, so routing and merge readiness reflect it at once. It is the same setting as the head's toggle.

## Backed by

Workers AI (Clef models), and D1 for judgments and outcomes. The page's **Backed by** link opens Workers AI. Configuring a judge's backend is in [Operations](../operations/README.md#configure-judges).

Cloudflare map for this page: [ARCHITECTURE-CLOUDFLARE.md §2](../ARCHITECTURE-CLOUDFLARE.md#2-page-by-page-map).

## Planned

- Judge calls through AI Gateway.
- **All** on Brier over time asking for a year of weeks; today it shows the weeks the API sends (12).
- A mark on the trend where a judge started failing.
