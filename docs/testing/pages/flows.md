# Flows

- **Route:** `/:repo/flows[?target=][&view=designer][&flow=][&run=][&range=]`, `/:repo/flows/runs/:id[?job=]`
- **Sidebar:** Automation ▸ Flows (repo from the top bar)
- **Backed by:** D1 `flow_runs` and `flow_jobs`, with a D1 job per queued flow job, run by a runner that takes `flow` jobs; Cloudflare steps through Workflows (`cinder-pipeline`); approvals through Needs you; secrets through Secrets Store ([map](../../ARCHITECTURE-CLOUDFLARE.md#2-page-by-page-map))

**Setup:** `web-store`, `svc-orders-go` or `infra-cloudflare-tf` (each with a `change`, a `push`, a `cron` and a manual-only flow, and one run of each from `node seed/activity.mjs`); an empty repo named `manual-empty-<n>` made with New repository and deleted afterwards for no flows. Name new flows `manual-<n>` and only save them as changes you then close.

## Bar

| ID | Check | Expected |
|---|---|---|
| FLOW-01 | Open `/web-store/flows`. | Runs / Designer, "repo · target &lt;branch&gt;", a time range (Runs only) and **Run flow**. |
| FLOW-02 | Click **Designer**, then **Runs**. | Exactly one view shows; the URL carries `?view=`; reload keeps it. |
| FLOW-03 | Click **Run flow**. | A new run starts and opens in run detail. |
| FLOW-1729.1 | Open `/web-store/flows` with the browser's network panel open, then reload. | `GET /api/repos/web-store/flows?ref=` starts before `/api/me/accounts` and `/api/repos` finish; the flows draw without waiting for the sidebar's account list. |
| FLOW-47 | Pick a branch that holds flows (other than the default) in the top-bar branch picker, or open `?target=<branch>&view=designer`. | The bar reads "repo · target &lt;branch&gt;"; Designer lists that branch's flows; **Run flow** starts a run of the flow at that branch's head. |

## Runs

| ID | Check | Expected |
|---|---|---|
| FLOW-04 | Look at the tiles. | Runs, Pass rate (untrusted under 20 runs), Median duration, Waiting for approval. |
| FLOW-1377.1 | Start a run whose approval step is waiting on Needs you, and let another run finish. | Waiting for approval counts the waiting run; Median duration shows the finished runs' median with n=; on a range with no runs both read —. |
| FLOW-05 | Look at the run detail card. | Each step: number or ✓, name, a Cloudflare Workflow tag or target-cloud pill, the state pill (queued, running, waiting for approval, done, failed) and duration. |
| FLOW-06 | Look at a Cloudflare Workflow step. | The workflow id with "step n of m" and **View in Compute › Workflows**, which opens that Workflow in the dashboard. |
| FLOW-07 | Look at a run waiting on an approval gate. | The gate step shows **Approve** and **Reject** with the approver role. |
| FLOW-08 | Click **Approve** on the gate. | The gate passes and the next step starts running; a reload keeps it. |
| FLOW-09 | Click **Reject** on a gate in another run. | The gate fails and the run fails. |
| FLOW-10 | Look at the queued run. | Its steps show Queued with a note that no executor has picked it up yet. |
| FLOW-11 | Look at Runs per hour. | Stacked passed / failed bars over 24 hours with a legend; y-axis labels are whole numbers, none repeated. |
| FLOW-12 | Click a run card in the list. | The run page opens at `/:repo/flows/runs/<id>`. |
| FLOW-13 | Type a run id in Search runs. | The list filters. |
| FLOW-52 | Push twice so two push-triggered runs exist. | Each run card shows its own id (a 36-character id inside it shows its first 8 characters); searching one id lists only that run. |
| FLOW-14 | Pick one flow in the flow select. | Only that flow's runs show. |
| FLOW-15 | Pick Last 7 days. | The tiles and list cover 7 days. |
| FLOW-16 | Hide run detail with ×. | Detail hides. |
| FLOW-1546.1 | Look at the run cards of a flow with several stages. | Each card shows one pip per stage, coloured by the stage's status. |
| FLOW-17 | Add `secrets: [NAME]` to a flow step that prints `$NAME`, run it, and read the step's log. | The value is masked in the log. |
| FLOW-53 | Give one step `secrets: [NAME]` with NAME not saved in Keystore, beside an independent step and a step that needs it; run the flow. | The step fails alone: its log reads `missing secret NAME: save it in Keystore` and run detail shows Missing secret NAME with **Save it in Keystore** linking to `/settings/keystore`; its dependant is skipped and the independent step still runs. |
| FLOW-1650.1 | Give two steps of one job (`job: build`) each a `secrets:` entry not saved in Keystore, the second needing the first; run the flow. | Run detail lists every missing secret of both steps on the build job, each once, including the skipped second step's. |
| FLOW-1397.1 | With a test quarantined, open a run (light and dark, and at 390px). | A **Quarantined** card lists the test with this run's result, flake rate and since; **Manage** opens Repo settings at Flaky checks. With none quarantined there is no card; a blocked `GET …/flakes` shows "Couldn't load quarantined tests." with Retry. |
| FLOW-18 | Run a flow with a Cloudflare deploy step. | The environment syncs; Environments shows the new version and the Worker's Deployments list a new version. |
| FLOW-54 | Run a flow whose steps use `job` and `matrix: { node: [20, 22] }` in a first stage and a second stage after it. | Run detail lists one row per job and leg (`<job> (node 20)`, `<job> (node 22)`); the second stage stays Queued until every first-stage job passes; a failed first-stage job marks the second stage Skipped and the run Failed. |

## Run page

| ID | Check | Expected |
|---|---|---|
| FLOW-1546.2 | Open a finished failed run from the runs list (light and dark). | Back, status icon, `flow #n`, a Failed pill, the triggering change's id and title, **Re-run failed jobs**, **Re-run all** and the graph toggle; the meta row shows branch, commit, actor, started, wall time, worker pool and repo. |
| FLOW-1845.1 | Push a commit to a change whose repo has an `on: [change]` flow, then open the run it starts. | The header shows the change's id and title; the meta row's branch is the change's branch. |
| FLOW-1546.3 | At a 1440×900 window, scroll the stage graph and the area below it. | Each pane scrolls on its own; the page itself never scrolls. Make the window under 860px tall: the meta row hides. |
| FLOW-1546.4 | Look at the stage graph of a run with two or more stages, then resize the window. | A column per stage with its passed/total and job chips; connectors join each column's chips to the next and are redrawn after the resize. |
| FLOW-1546.5 | Click a job chip. | The chip is highlighted and the URL carries `?job=<job key>`. |
| FLOW-1546.6 | Click **Re-run failed jobs**. | The pill reads Queued and the failed jobs' chips show Queued at once, then the run's real status follows; if the server refuses (e.g. the run is still going), the old status returns with the error. |
| FLOW-1546.7 | Start a run and open it while it is queued or running; click **Cancel run**. | **Cancel run** shows instead of the re-run buttons; the run ends Failed with its open jobs cancelled. |
| FLOW-1546.8 | Click the graph toggle. | The stage graph hides and shows again. |
| FLOW-1546.9 | Open `/web-store/flows/runs/no-such-run`. | A **Run not found** card with **All runs**. |
| FLOW-1546.10 | Open a run at 390px. | The header wraps onto several lines; nothing is cut off. |
| FLOW-1547.1 | Open a failed run without `?job=`. | The job tree shows **Summary**, each stage with its jobs' status and duration, and the first failed job selected with its steps listed. A run with no failed job selects its first running job; a passed run selects Summary. |
| FLOW-1547.2 | Click a stage header in the job tree, then click it again. | Its jobs hide, then show again. |
| FLOW-1547.3 | Press `]` and `[`. | The next and previous job are selected (wrapping at the ends); the URL's `?job=` follows. |
| FLOW-1547.4 | Select **Summary** and look at it (light and dark). | Tiles Status, Wall time, Sandbox time and Judge tokens; Annotations with error and warning counts; Jobs, Steps, Tests (per suite and job) and Artifacts tables; empty sections say so. |
| FLOW-1547.5 | Click an annotation, a Jobs row and an artifact's **Download**. | The annotation and the row select their job; the artifact downloads. |
| FLOW-1547.6 | Keep a running run open while a job finishes. | The job's tree entry and chip and its stage's status change without a reload; a new annotation appears in the Summary. |
| FLOW-1547.7 | Open a run at 1280 wide, then at 390px. | At 1280 the page itself never scrolls; at 390 the tree is a 220px scrolling list above the content area. |
| FLOW-1262.1 | Select a finished failed job (light and dark). | The log header shows stage / job, status and duration, instance type, worker (managed or BYO) and attempt with **Re-run job**; the failed step is open with numbered lines, `$` before `[command]` lines, and a tinted "Error:" row for each `##[error]`. |
| FLOW-1262.2 | Press `/`, type a word that appears in a closed step, then press Enter, Shift+Enter, ▲ and ▼. | Within a moment the step and any group holding a match open; the n/m counter's m equals the highlighted matches, and each key moves the current match and scrolls to it. |
| FLOW-1262.3 | Click a line number, copy the URL and open it in a new tab. | The URL carries `?job=…&L=<job>-<step>-<line>`; the new tab opens that step and its groups, scrolls to the line and highlights it. |
| FLOW-1262.4 | Click a row in the annotations strip. | Its step and group open and its line is scrolled to and highlighted. |
| FLOW-1262.5 | Look at a step with nested `##[group]`s; click a group's caret. | Group lines indent 18px, nested ones 36px; a group holding an error is open, others closed; the caret folds and unfolds it. |
| FLOW-1262.6 | Toggle the **Timestamps** (clock) and **Wrap long lines** icons, then **Expand all** and **Collapse all**. | An `HH:MM:SS` gutter shows and hides; long lines wrap; every step and group opens, then closes. |
| FLOW-1902.1 | Hover the two icon toggles left of **Expand all**. | Each shows its tooltip, Timestamps and Wrap long lines; a toggle that is on is tinted. |
| FLOW-1902.2 | Open the `terraform init` job of an `infra-cloudflare-tf` run. | "Initializing provider plugins..." is bold and "Success!" green and bold; no `[0m`, `[1m` or other escape text shows. |
| FLOW-1902.3 | Look at a long log line with Wrap off, then on. | Each line number sits in the gutter on the same row as its text's first line; with Wrap on the text wraps beside the gutter. |
| FLOW-1262.7 | Open a running job. | **Follow** is on and the newest lines stream in at the bottom under the running step, which ends in "waiting for output…". Scroll up: **Follow** turns off and new lines no longer move the view. |
| FLOW-1262.8 | Click **Raw**. | The job's `log.txt` downloads, every step's lines in order. |
| FLOW-1262.9 | Open a job with a 20,000-line step and scroll through it. | Scrolling stays smooth; each step's header stays pinned at the top while its lines pass. |
| FLOW-1903.1 | Open a finished job of a run (one with `job:` or stages). | **Set up job** is the first step and **Complete job** the last, each with a status and duration; Set up job lists the runner name, operating system, workflow directory with the commit and the job name; Complete job reads "Removed workspace …" and "Steps took …". |
| FLOW-1903.2 | Give the flow `secrets: [NAME]` saved in Keystore, run it and open Set up job. | It reads "Secret source: Keystore · injected 1 (NAME)"; the secret's value appears nowhere in the step. |
| FLOW-1981.1 | Open a finished job of a run whose step has `junit:` and fails. | The steps read Set up job, Checkout, the job's steps, Upload artifacts, Complete job, each with status and duration; Checkout shows the repository, commit, depth and fetch time; Upload artifacts reads "Sent test report …" for the failed step. |
| FLOW-2024.1 | On `svc-orders-go`, open a finished `check` run's **test** step. | The log has a `=== RUN` and `--- PASS` line for each test, then `ok example.com/svc-orders-go`. |
| FLOW-1981.2 | Give the flow `secrets: [NAME]`, run it and open Set up job. | The **Environment** group is collapsed; expanded it reads `NAME=***` and the value appears nowhere. Set up job also lists the egress mode and allowed hosts. |
| FLOW-1981.3 | Select **Summary** on that run. | A **Steps** table lists every job's steps, including Set up job, Checkout, Upload artifacts and Complete job, with the job and duration. |
| FLOW-1981.4 | Run a flow with a `uses: cloudflare/workflow` step and open its log. | It shows the Workflow instance id with "step n of m", then one line per Workflow step reading done or pending. |
| FLOW-1833.1 | Run a flow with no `job`, `matrix`, `shard`, `stages`, `retries` or `concurrency` whose steps print a few lines, a masked secret and an `##[warning]`; open it while it runs and after it ends. | Each step's lines stream in while it runs and stay after it ends (the tree counts them, **Raw** holds them in order, once each); the secret shows as `***`; the warning appears in the Summary without a reload. |

## Designer

| ID | Check | Expected |
|---|---|---|
| FLOW-19 | Open Designer. | Three columns: Flows rail (name, trigger, last run status, **+**), the canvas card, the inspector. |
| FLOW-1264.1 | Open `/svc-orders-go/flows?view=designer` (`check` on change, `deploy` on push, `daily` on cron, `ci` manual-only) after `node seed/activity.mjs` (light and dark, and at 390px). | The rail groups cards under On a change, On push, Scheduled and Manual; each card shows the last run's status icon, name, triggers, "n runs" and a green/red bar split by passed and failed runs. |
| FLOW-1264.2 | On `/svc-orders-go/flows?view=designer`, look at `daily` (one run, under the default threshold of 200 outcomes). | Its card reads "untrusted: n outcomes" under the bar. |
| FLOW-1264.3 | Keep `/web-store/flows?view=designer` open and start a run of `build` from another tab (`/web-store/flows?flow=build`, **Run flow**); let it finish. | That flow's card shows the new last-run status and its bar and runs count update without a reload. |
| FLOW-1264.4 | Open `/web-store/flows?view=designer` with the network panel open, then pick a branch with a long name. | Flows load with one `GET …/flows?ref=` (its `Server-Timing` lists head, tree and files) and no `/tree` request; the first flow opens from that response, and only another opened flow sends one `GET …/flows/<flow>?ref=`; the bar's target is cut in the middle and the full name shows on hover. |
| FLOW-1558.1 | Reload `/web-store/flows?view=designer` with the network panel open. | The rail's cards draw before the opened flow's file answers; `GET …/branches` starts alongside `GET …/flows?ref=`, not after it. |
| FLOW-20 | Click a flow in the rail. | The canvas loads it; the URL carries `?flow=`. |
| FLOW-21 | Look at the canvas header. | Name, file path, step count, Undo, Redo, −, zoom %, +, Fit, Auto layout, Validate, Dry run, Graph / Split / YAML, **Save as change**. |
| FLOW-22 | Look at a node. | 208×84: type icon, name, subtitle, last-run row (status, word, duration, or "not run yet"), type tag, in and out ports; a Cloudflare Workflow node has an orange outline. |
| FLOW-23 | Drag a node. | It moves and snaps to an 8px grid; Auto layout becomes enabled. |
| FLOW-24 | Click **Auto layout**. | Manual positions clear; columns follow the longest path. |
| FLOW-25 | Drag from a node's out-port onto another node. | A new edge with an arrowhead; the target's Runs after gains the source. |
| FLOW-26 | Click an edge. | The inspector shows "b runs after a" and **Remove dependency**. |
| FLOW-27 | Click **Remove dependency**. | The edge goes. |
| FLOW-28 | Select a node and press Delete (or Backspace). | The step and its edges go. |
| FLOW-29 | Add an edge that closes a loop. | Every edge of the loop is dashed red and a banner names them; the page doesn't hang. |
| FLOW-48 | Click **Validate** on a clean graph, then add an edge that closes a loop, then remove it. | The Valid banner gives way to the cycle banner; once the loop is gone no cycle banner remains. |
| FLOW-49 | In YAML, give a step `needs: [b]` with no step `b`. | A banner reads `steps.<name>.needs: other steps of this flow`; Save as change is disabled. |
| FLOW-31 | Click **YAML**. | The `.cinder/flows/<name>.yml` text for the graph shows; Graph returns to the canvas. |
| FLOW-32 | Edit the YAML (rename a step), switch to Graph. | The graph shows the edit; switching back shows identical YAML (nothing lost). |
| FLOW-33 | Break the YAML (unbalanced brace). | A banner says it doesn't parse; the graph and inspector are read-only; Save as change is disabled. |
| FLOW-34 | Click each step type in the Add a step column. | Command, Verify, Cloudflare Workflow, Deploy and Approval gate each add a node of that type. |
| FLOW-1265.1 | Move a node, add a step, then press `Ctrl Z` twice and `Ctrl Shift Z` twice (and use the Undo / Redo buttons). | Each undo restores the previous steps, edges and positions exactly; redo re-applies them; Undo disables after 50 undos. |
| FLOW-1265.2 | Zoom with − / + and `Ctrl`+wheel, then click Fit and the zoom %. | Zoom stays within 50%–150%; the wheel keeps the point under the pointer still; Fit fits the graph; the % resets to 100%. |
| FLOW-1265.3 | At 50% and at 150%, after panning, drag Command from the palette onto the canvas, drag a node and drag-connect two nodes. | The new node is centred on the drop point; drags and connections land on the node under the pointer. |
| FLOW-1265.4 | Look at the canvas of a flow with a matrix step during a run. | Lanes Trigger, Stage 1 … n; the trigger node's dashed edges feed the first stage and a click shows the flow's triggers; the matrix step shows `×n` with a stacked shadow; the edge into the running step is animated, and static with reduced motion on. |
| FLOW-1265.5 | Drag the empty canvas, then click the minimap. | The canvas pans; the minimap outlines the visible area and a click centres the view there. |
| FLOW-1265.6 | Hover a node and click its **+**. | A Command step is added after it, connected and selected. |
| FLOW-1265.7 | Narrow the window below 1000px (and at 390px). | Flows, canvas and inspector stack; Add a step is a row of types above the canvas. |
| FLOW-35 | Select a Command step. | Step / Flow tabs; Name, Type, Run, Matrix, Runs after checkboxes, Condition, Worker pool, Timeout, Retries, Secrets, **Delete step**. |
| FLOW-1375.1 | On a Command step, type `node: [18, 20]` in Matrix and click **Save as change**; then type `node: [18` instead. | The saved YAML has `matrix: { node: [18, 20] }`; the second shows a banner naming `steps.<step>.matrix` and Save as change is disabled. |
| FLOW-1267.1 | Click **Validate** on a flow with a cycle, then on a clean flow, with the network panel open. | The banner shows the validation messages word for word (`steps: dependency cycle through …`), then "Valid. n steps, m dependencies, no cycles."; no request is sent. |
| FLOW-1267.2 | Click **Dry run** on a flow with an approval gate, with the network panel open. | Stage by stage, about 0.7 s each, steps go queued → running → passed and the gate shows skipped; the banner ends "Dry run passed. N steps in Xs. Gates were skipped."; no request is sent. |
| FLOW-1267.3 | Close a loop, then click **Dry run**. | "Fix the cycle before a dry run."; no step changes state. |
| FLOW-1267.4 | Select a step and click **Split**. | Graph and YAML side by side; the YAML has line numbers and the step's line is highlighted; it is the exact text **Save as change** writes. |
| FLOW-1267.5 | Select a Command step, pick a Worker pool, set Timeout and Retries, and tick a secret. | Pools from Workers (managed and BYO); secrets are the Keystore names for this repo and global ones, with "Injected from Keystore at run time."; the YAML gains `runs-on`, `timeout`, `retries` and `secrets` on that step. |
| FLOW-1267.6 | Deselect everything. | The usage hint and a count of steps per type plus dependencies. |
| FLOW-1267.7 | Open the **Flow** tab; tick On a schedule, type a cron, pick a Concurrency and a Default worker pool. | The YAML gains `on: [… cron]`, `cron:`, `concurrency:` and `runs-on:`; the tab notes that flows are read from the target branch. |
| FLOW-1267.8 | Load Designer, push a commit to the target branch, then click **Save as change**. | The banner says the target moved since the page loaded and the designer reloads at the new head. |
| FLOW-1604.1 | Run a flow whose only step is `run: "false"` with `retries: "2"`. | The job runs three times (attempt 3 in run detail), then the run fails. |
| FLOW-1604.2 | Give a flow `concurrency: queue` and start it twice by hand. | The second run stays queued until the first finishes, then starts. |
| FLOW-1604.3 | Give a flow `concurrency: cancel`, start it, and start it again while the first runs. | The first run's jobs are cancelled and it fails; the second runs. |
| FLOW-36 | Select a Deploy step and open Target. | Five targets including Cloudflare and Bring your own (SSH); plus Environment. |
| FLOW-1421.1 | On a Deploy step, set Environment and Retries, then switch Target to AWS, Google Cloud, Azure and Bring your own (SSH) in turn. | Each target shows its own fields below Target and Environment (AWS: Authentication, Role ARN, Region, Service, Resource; SSH: Host, User, Command, Known host fingerprint, Key secret); Environment and Retries keep their values. |
| FLOW-1421.2 | On an AWS Deploy step pick Authentication › Access key from Keystore; on an SSH step open Key secret. | Both are a list of this repo's and global Keystore names, with no text box; the YAML holds only the picked name. |
| FLOW-37 | Select an Approval gate. | An Approvers field. |
| FLOW-38 | Rename a step in the inspector and tab away. | The node and every edge into it follow the new name. |
| FLOW-39 | Change Condition to Always. | The YAML shows `if: always()`. |
| FLOW-40 | Click **Save as change**. | A banner names the opened change with `.cinder/flows/<name>.yml`; the change shows on the board with the verifier running it. |
| FLOW-50 | Click **Save as change** with the network throttled. | The button reads "Saving…" and is disabled until the change opens or fails. |
| FLOW-51 | In YAML view, give a `run` step `setup: { go: "1.24.13" }` and click **Validate**; then change `go` to `cobol`. | The first validates; the second shows a banner naming `steps.<step>.setup`. |
| FLOW-41 | Click **+** in the rail. | A new unsaved flow `flow-n` from the template; the rail shows "not saved yet". |

## States

| ID | Check | Expected |
|---|---|---|
| FLOW-42 | Reload Runs throttled. | 4 tile bones, 7 step rows, a chart bone, 5 run-card bones. |
| FLOW-43 | Reload Designer throttled. | The dotted grid with 5 ghost node outlines and faint edges; the Add a step palette stays real. |
| FLOW-1673.1 | Reload Designer throttled, then let it load. | The Add a step palette sits in a column left of the canvas, as in the loaded designer; nothing shifts when the flow lands. |
| FLOW-44 | Open Designer on the empty `manual-empty-<n>` repo from Setup. | "Add your first flow" with ci and deploy template buttons; a template opens on the canvas. |
| FLOW-45 | Open Runs on a repo with no runs. | "No runs yet". |
| FLOW-46 | Block the runs request and reload. | "Couldn't load runs." with Retry. |
| FLOW-1359.1 | Save and run a flow whose step is `deploy: production`, `target: "Bring your own (SSH)"`, `ssh: { host: <host>, user: <user>, command: "<cmd>", fingerprint: "SHA256:…" }` (no `key_secret`). | The run is refused with an error naming `steps.<step>.ssh.key_secret`. |
| FLOW-1359.2 | Add `key_secret: <NAME>` with that key saved in Keystore and run it on a worker with `ssh`. | The step runs `ssh` with the key, its output streams as the step log with the key masked, and the step passes or fails with the command. |
| FLOW-1359.3 | Run an AWS deploy step (`aws: { … }` with a `run` command) on a worker without the `aws` CLI. | The step fails with "aws CLI not found on this worker's PATH: install it to run this deploy step". |
| FLOW-1733.1 | Run a flow whose Deploy step has Target AWS with Assume role (OIDC), no `AWS_WEB_IDENTITY_TOKEN` in Keystore, and a `run` command. | The step fails with "missing secret AWS_WEB_IDENTITY_TOKEN: save it in Keystore" and run detail shows **Missing secret** AWS_WEB_IDENTITY_TOKEN. |
| FLOW-1733.2 | Run an SSH Deploy step whose Known host fingerprint is not the host's key. | The step fails with "host key of <host> does not match the saved fingerprint …: refusing to connect"; no command runs on the host. |
| FLOW-1733.3 | Run an AWS, Google Cloud or Azure Deploy step without a `run` command. | The step fails with "deploy to <target>: set the step's run command, run after signing in". |
| FLOW-2037.1 | Push a second commit to a change while its first commit's check run is queued or running. | The first run shows failed with its jobs cancelled; the new head's check run is queued. |
| FLOW-2037.2 | Open the run list after a flow job has run for more than 2 hours. | The job shows failed and the worker holding it is free again within one heartbeat. |
| FLOW-2098.1 | Open a finished job with a long log, click **Re-run job** and watch the log. | The log clears and shows only the new attempt's lines. |
| FLOW-2113.1 | Push to a change a `.cinder/flows/ci.yml` with `on: push` and a step written `need: []`. | A failed run of ci with one job, **Validate flow**: its log lists `.cinder/flows/ci.yml:2: on: …`, `…:4: steps.<step>.need: unknown key; did you mean needs?` and `…:4: steps.<step>.needs: required …`, each also an error annotation; the change's Checks list ci as failed. |
| FLOW-2113.2 | On that run, click **Re-run all**. | Refused: "this flow failed validation; fix the file and push". |
| FLOW-2113.3 | Commit that file to a branch, then **Run flow** it from Runs. | Refused with every error of the file, each as `file:line: field: problem`. |
| FLOW-2113.4 | In the Designer YAML view, add a key `stpes:` to a valid flow. | The error banner reads `stpes: unknown key; did you mean steps?` and **Save as change** stays disabled. |
| FLOW-2097.1 | Sign in as a Contributor and open Flows ▸ Designer, then a step's inspector. | The page loads; **Secrets** lists no Keystore names. |

## Known gaps

- **FLOW-05:** steps show no duration and no Workflow id with "step n of m".
- **FLOW-07, FLOW-08, FLOW-09:** run detail has no Approve or Reject; approve a gate from its Needs you item.
- **FLOW-17:** the architecture map records step logs stored unmasked in D1; a secret a step prints can show in its log.

## Planned

- Runs started on push, change and schedule by every runner (today the managed pool runs agent jobs only).
- External deploy credentials injected by the outbound proxy instead of as step environment variables.
- A Designer field for an external deploy's command (set it in YAML today).
- Runs acting on `timeout` (saved in the file today).

## Retired

- **FLOW-30:** Validate no longer names unconnected steps; it shows the flow's validation messages (FLOW-1267.1).
