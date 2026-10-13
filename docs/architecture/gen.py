#!/usr/bin/env python3
"""Generate cinder architecture SVGs (light + dark). Geometry once, palette per variant."""
import os, sys
from xml.sax.saxutils import escape

OUT = sys.argv[1]
SANS = "Inter, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
MONO = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
SOURCE = """Colours and type follow Cloudflare's public brand references (checked 2026-10-06):
  - Cloudflare Orange #F38020, Tangerine #FAAE40 and dark gray #404041: the official logo colours,
    as published in the press kit logo files (https://www.cloudflare.com/press-kit/ , Logos.zip).
  - Naming: Cloudflare trademark guidelines (https://www.cloudflare.com/trademark/); product names are plain text.
  - Type: the font stack of Cloudflare's developer docs (https://developers.cloudflare.com/):
    Inter, system-ui ... sans-serif and JetBrains Mono, ui-monospace ... monospace.
  No Cloudflare logo, cloud mark or other artwork is used."""

PAL = {
    "light": dict(SURF="#F7F7F8", CLINE="#E4E4E7", BOX="#FFFFFF", LINE="#CFCFD4", INK="#404041",
                  MUT="#66666B", ACC="#F38020", TAN="#FAAE40", TINT="#FEF3E2"),
    "dark": dict(SURF="#1B1B1D", CLINE="#2E2E32", BOX="#242427", LINE="#45454B", INK="#F2F2F3",
                 MUT="#A3A3A9", ACC="#F38020", TAN="#FAAE40", TINT="#3A2A12"),
}

def style(p):
    return f"""<style>
.card{{fill:{p['SURF']};stroke:{p['CLINE']}}}
.box{{fill:{p['BOX']};stroke:{p['LINE']};stroke-width:1}}
.hub{{fill:{p['BOX']};stroke:{p['ACC']};stroke-width:1.5}}
.edge{{fill:{p['BOX']};stroke:{p['TAN']};stroke-width:1.5}}
.pill{{fill:{p['TINT']};stroke:{p['TAN']};stroke-width:1}}
.plan{{stroke-dasharray:5 4}}
.w{{fill:none;stroke:{p['MUT']};stroke-width:1.4}}
.as{{fill:none;stroke:{p['MUT']};stroke-width:1.2;stroke-dasharray:1 4;stroke-linecap:round}}
.ah{{fill:{p['MUT']}}}
text{{font-family:{SANS}}}
.t{{fill:{p['INK']};font-size:13.5px;font-weight:600}}
.s{{fill:{p['MUT']};font-size:12.5px}}
.m{{fill:{p['MUT']};font-family:{MONO};font-size:12px}}
.mi{{fill:{p['INK']};font-family:{MONO};font-size:12px}}
.e{{fill:{p['MUT']};font-family:{MONO};font-size:11px;font-weight:600;letter-spacing:.08em}}
.l{{fill:{p['MUT']};font-size:11.5px}}
</style>"""

WARN = []
def est(text, cls):
    k = {"t": 0.6 * 13.5, "s": 0.56 * 12.5, "m": 0.61 * 12, "mi": 0.61 * 12, "e": 0.7 * 11, "l": 0.56 * 11.5}[cls]
    return len(text) * k

class D:
    def __init__(s, name, w, h, label):
        s.name, s.w, s.h, s.label, s.o = name, w, h, label, []

    def text(s, x, y, t, cls="s", anchor=None, maxw=None):
        if maxw and est(t, cls) > maxw:
            WARN.append(f"{s.name}: '{t}' ~{est(t, cls):.0f}px > {maxw}")
        a = f' text-anchor="{anchor}"' if anchor else ""
        s.o.append(f'<text x="{x}" y="{y}" class="{cls}"{a}>{escape(t)}</text>')

    def box(s, x, y, w, h, title, lines=(), kind="box", plan=False, mono=()):
        c = kind + (" plan" if plan else "")
        s.o.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="10" class="{c}"/>')
        s.text(x + 14, y + 23, title, "t", maxw=w - 22)
        for i, ln in enumerate(lines):
            s.text(x + 14, y + 43 + i * 17, ln, "m" if i in mono else "s", maxw=w - 22)

    def pill(s, x, y, w, h, t, cls="mi", kind="pill"):
        s.o.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{h/2}" class="{kind}"/>')
        s.text(x + w / 2, y + h / 2 + 4, t, cls, "middle", maxw=w - 12)

    def wire(s, pts, arrow=True, assoc=False):
        d = "M " + " L ".join(f"{x} {y}" for x, y in pts)
        m = ' marker-end="url(#ar)"' if arrow else ""
        s.o.append(f'<path d="{d}" class="{"as" if assoc else "w"}"{m}/>')

    def eyebrow(s, x, y, t):
        s.text(x, y, t.upper(), "e")

    def legend(s, y, hub="cinder Worker"):
        x = 24
        items = [("hub", False, hub), ("box", False, "live today"), ("box", True, "planned (not yet live)")]
        for kind, plan, lab in items:
            if not lab:
                continue
            c = kind + (" plan" if plan else "")
            s.o.append(f'<rect x="{x}" y="{y}" width="26" height="16" rx="5" class="{c}"/>')
            s.text(x + 34, y + 12.5, lab, "l")
            x += 34 + est(lab, "l") + 28

    def render(s, variant):
        p = PAL[variant]
        head = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {s.w} {s.h}" width="{s.w}" height="{s.h}" '
                f'role="img" aria-labelledby="ttl dsc">\n<!--\n{SOURCE}\n-->\n'
                f'<title id="ttl">{escape(s.name)}</title><desc id="dsc">{escape(s.label)}</desc>\n'
                + style(p) +
                '<defs><marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" '
                'orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" class="ah"/></marker></defs>\n'
                f'<rect x="0.5" y="0.5" width="{s.w-1}" height="{s.h-1}" rx="16" class="card"/>\n')
        return head + "\n".join(s.o) + "\n</svg>\n"


# 1. System overview -----------------------------------------------------------
def overview():
    d = D("cinder system overview", 1000, 980,
          "Browsers, the cinder CLI and BYO runners reach cinder through Cloudflare Access. One cinder Worker serves "
          "the static React app and the API, and every resource behind it is a Cloudflare product: D1, Durable Objects, "
          "Artifacts, R2, Queues, Workflows, Cron, Containers, Workers AI, AI Gateway, Vectorize, Secrets Store, "
          "Workers Logs and Analytics Engine. Jobs run on an autoscaled Containers pool. Deploys go to Cloudflare targets "
          "through Workflows and to other clouds from the runner pool.")
    cw, cx = 220, [110, 390, 670]
    clients = [("Browser", ["React SPA"]), ("cinder CLI · git", ["HTTPS + git smart HTTP"]),
               ("BYO runner pools", ["self-hosted · clouds · GPU"])]
    for x, (t, ls) in zip(cx, clients):
        d.box(x, 32, cw, 62, t, ls)
        d.wire([(x + cw / 2, 94), (x + cw / 2, 136)])
    d.box(110, 140, 780, 62, "Cloudflare Access", ["app 'cinder' · owners policy · runner service token"], kind="edge")
    d.wire([(500, 202), (500, 238)])
    d.box(290, 242, 420, 96, "cinder Worker", ["static assets: the React SPA", "/api router · queue consumers · cron */10",
                                                "container egress · pool autoscale · merge signing"], kind="hub")
    cols = [50, 280, 510, 740]
    cwid = 210
    d.wire([(500, 338), (500, 368)], arrow=False)
    d.wire([(cols[0] + 18, 368), (cols[3] + 18, 368)], arrow=False)
    groups = [
        ("State", [("D1 'cinder'", ["index, jobs, issues,", "judgments, deploys"], False),
                   ("Durable Objects", ["RepoDO · ChangeDO", "DispatchDO (SQLite)"], False),
                   ("Artifacts 'cinder'", ["repos · change forks", "agents · org wiki"], False),
                   ("R2 cinder-ci-cache", ["flow toolchain cache", "checksummed releases"], False),
                   ("R2 cinder-logs", ["flow step logs", "masked before storage"], False)]),
        ("Execution", [("Queues", ["cinder-events", "cinder-webhooks"], False),
                       ("Workflows", ["cinder-pipeline · cinder-reset", "cinder-seed", "flow deploy steps"], False),
                       ("Cron Triggers", ["*/10: drift, scans, usage,", "leases, flows, autoscale"], False),
                       ("Rate limits", ["claims · changes", "previews"], False),
                       ("Containers runner pool", ["lite · basic · standard", "one job per instance"], False)]),
        ("AI", [("Workers AI", ["Clef judges · agent models", "embeddings · toMarkdown"], False),
                ("AI Gateway 'cinder'", ["stored keys (BYOK)", "logs · usage metadata"], False),
                ("Vectorize", ["VULN_INDEX", "advisory embeddings"], False)]),
        ("Secrets + logs", [("Secrets Store", ["one binding per secret", "via cinder-secrets"], False),
                                     ("Workers Logs + traces", ["Worker and containers"], False),
                                     ("Analytics Engine", ["insight time series", "SQL API"], False)]),
    ]
    by = 412
    for gx, (gname, boxes) in zip(cols, groups):
        d.wire([(gx + 18, 368), (gx + 18, by)])
        d.eyebrow(gx + 30, 392, gname)
        for i, (t, ls, plan) in enumerate(boxes):
            d.box(gx, by + i * 82, cwid, 72, t, ls, plan=plan)
    # AI Gateway -> model providers note
    d.text(cols[2], by + 3 * 82 + 22, "AI Gateway → Anthropic · OpenAI ·", "l")
    d.text(cols[2], by + 3 * 82 + 39, "Google · xAI · Workers AI", "l")
    # deploy targets
    ty = by + 5 * 82 + 34
    d.eyebrow(50, ty - 12, "Deploy targets (multi-cloud)")
    d.box(50, ty, 420, 62, "Other clouds", ["AWS · Google Cloud · Azure · SSH, from the runner pool"])
    d.box(530, ty, 420, 62, "Cloudflare targets", ["Workers versions · previews · rollouts · D1/KV/Queues/R2"])
    pool_b = by + 4 * 82 + 72
    d.wire([(cols[1] + 105, pool_b), (cols[1] + 105, ty)])
    wf_y = by + 82 + 36
    d.wire([(cols[1] + cwid, wf_y), (500, wf_y), (500, ty + 31), (530, ty + 31)])
    d.legend(ty + 92)
    return d


# 2. Job execution -------------------------------------------------------------
def jobs():
    d = D("cinder job execution", 1000, 760,
          "A change, push or Flow run queues a job row in D1. The Worker starts a container in the autoscaled Containers "
          "pool for each queued job, up to the pool's max; DispatchDO serialises claims, gate jobs first. One job per "
          "instance, scaling to zero with an optional warm buffer. Every outbound request passes the Worker's container "
          "egress: a per-job allowlist, web pages as Markdown, and model calls to AI Gateway, which adds the stored key. "
          "Flow secrets are read from Secrets Store for the job's lease and masked. Results return as git commits to "
          "Artifacts and masked logs to R2. Cloudflare targets deploy through Workflows; other clouds deploy from the instance.")
    d.box(30, 40, 220, 78, "Change or Flow run", ["push · change · cron · manual"])
    d.wire([(140, 118), (140, 156)])
    d.box(30, 160, 220, 78, "D1 jobs", ["one row per job", "gate jobs claimed first"])
    d.wire([(140, 238), (140, 276)])
    d.box(30, 280, 220, 96, "Worker · DispatchDO", ["queued jobs → pool size", "claims serialised, leased", "lease expiry returns a job"], kind="hub")
    # pool region
    px, py, pw, ph = 300, 40, 350, 420
    d.o.append(f'<rect x="{px}" y="{py}" width="{pw}" height="{ph}" rx="10" class="box"/>')
    d.text(px + 16, py + 26, "Runner pool · Containers", "t")
    d.text(px + 16, py + 46, "autoscaled from queue depth", "s")
    d.text(px + 16, py + 63, "same image, runs any job kind", "s")
    d.wire([(250, 328), (300, 328)])
    iw, ih = 150, 70
    inst = [("instance", ["job A · running"], False), ("instance", ["job B · running"], False),
            ("warm buffer", ["idle, accepts fast"], False), ("scale to zero", ["no work, no instances"], False)]
    for i, (t, ls, plan) in enumerate(inst):
        x = px + 18 + (i % 2) * (iw + 14)
        y = py + 88 + (i // 2) * (ih + 14)
        d.box(x, y, iw, ih, t, ls, plan=plan)
    d.text(px + 16, py + 290, "one job per instance", "s")
    d.text(px + 16, py + 307, "no state carried between jobs", "s")
    d.text(px + 16, py + 324, "destroyed when the job reports", "s")
    d.text(px + 16, py + 360, "git: scoped, expiring Artifacts tokens", "l")
    d.text(px + 16, py + 377, "egress: only through the container egress", "l")
    # right column
    rx, rw = 710, 260
    d.box(rx, 40, rw, 78, "Secrets Store", ["flow secrets, read for the", "job's lease, masked in logs"])
    d.wire([(rx + 130, 118), (rx + 130, 156)])
    d.box(rx, 160, rw, 96, "Container egress", ["per-job host allowlist", "web pages as Markdown", "no model key enters"])
    d.wire([(650, 208), (rx, 208)])
    d.text(656, 200, "egress", "l")
    d.wire([(rx + 130, 256), (rx + 130, 296)])
    d.box(rx, 300, rw, 78, "AI Gateway 'cinder'", ["adds the stored key (BYOK)", "→ Workers AI · Anthropic · OpenAI"])
    d.wire([(rx + rw, 208), (985, 208), (985, 449), (rx + rw, 449)])
    d.box(rx, 410, rw, 78, "Other clouds", ["AWS · Google Cloud · Azure · SSH", "deploy steps run from the job"])
    # results
    d.wire([(px + 90, py + ph), (px + 90, 536)])
    d.wire([(px + 260, py + ph), (px + 260, 536)])
    d.text(px + 98, 506, "commits", "l")
    d.text(px + 268, 506, "logs", "l")
    d.box(300, 540, 160, 78, "Artifacts", ["git commits on the", "change's fork"])
    d.box(480, 540, 170, 78, "R2 · Workers Logs", ["secrets masked", "before storage"])
    # Cloudflare deploys
    d.wire([(px, 440), (140, 440), (140, 536)])
    d.text(152, 432, "Cloudflare deploy step", "l")
    d.box(30, 540, 220, 78, "Workflows", ["cloudflare/workflow steps", "cinder-pipeline sync"])
    d.wire([(250, 579), (275, 579), (275, 660), (rx, 660)], arrow=True)
    d.box(rx, 630, rw, 62, "Cloudflare targets", ["Workers versions · previews · rollouts"])
    d.legend(712, hub="dispatcher")
    return d


# 3. Git and change lifecycle -------------------------------------------------
def git():
    d = D("cinder git and change lifecycle", 1000, 700,
          "A push lands in Artifacts, which emits cf.artifacts.repo.pushed and starts the cinder-pipeline Workflow; it "
          "hands the push to the cinder-events Queue, whose consumer queues guard and verify jobs on the runner pool. "
          "A change moves from leased through developing and verifying to in_queue and merged. The risk judge routes a "
          "verified change: an untrusted judge sends it to the reviewer agent, a trusted high answer to a person. RepoDO "
          "holds the symbol leases and settles a collision by stacking or a seam; ChangeDO holds the change and its merge "
          "queue entry. Clef judges on Workers AI answer at each step and are scored against outcomes. At merge the Worker "
          "signs the merge commit with a key bound from Secrets Store, and a history job writes the change's record.")
    y1 = 40
    d.box(20, y1, 160, 78, "git push", ["agents · runners", "people · CLI"])
    d.wire([(180, y1 + 39), (206, y1 + 39)])
    d.box(210, y1, 170, 78, "Artifacts 'cinder'", ["repo + one fork", "per change"])
    d.wire([(380, y1 + 39), (406, y1 + 39)])
    d.pill(410, y1 + 23, 200, 32, "cf.artifacts.repo.pushed")
    d.wire([(610, y1 + 39), (636, y1 + 39)])
    d.box(640, y1, 150, 78, "Workflow", ["cinder-pipeline"], mono=(0,))
    d.wire([(790, y1 + 39), (816, y1 + 39)])
    d.box(820, y1, 160, 78, "Queue", ["cinder-events", "→ guard + verify"], mono=(0,))
    d.text(416, y1 + 74, "event trigger, namespace-wide", "l")
    # states
    sy = 200
    d.eyebrow(40, sy - 16, "Change states")
    xs = [40, 230, 420, 610, 800]
    names = ["leased", "developing", "verifying", "in_queue", "merged"]
    for i, (x, n) in enumerate(zip(xs, names)):
        d.pill(x, sy, 160, 36, n, kind="hub" if n == "merged" else "pill")
        if i < 4:
            d.wire([(x + 160, sy + 18), (xs[i + 1] - 4, sy + 18)])
    d.wire([(900, y1 + 78), (900, 160), (500, 160), (500, sy - 4)])
    d.text(600, 154, "guard + verify results", "l")
    d.text(140, sy + 58, "also: needs_fix · conflict → resolving · waiting (stacked)", "l")
    d.text(140, sy + 76, "risk route: untrusted → reviewer agent · high → a person", "l")
    # DOs and judges
    dy = 310
    d.box(40, dy, 280, 96, "RepoDO · per repo", ["symbol leases while developing", "collision → stack or seam", "per-target merge queues"])
    d.box(360, dy, 280, 96, "ChangeDO · per change", ["state, events, acceptance", "its merge queue entry", "stacked: merges after its base"])
    d.box(680, dy, 280, 96, "Clef judges · Workers AI", ["lease · collision · seam · split", "guard · risk · flake", "scored against outcomes"])
    d.wire([(120, sy + 36), (120, dy)], arrow=False, assoc=True)
    d.wire([(620, sy + 36), (620, dy)], arrow=False, assoc=True)
    d.wire([(820, sy + 36), (820, dy)], arrow=False, assoc=True)
    # merge path
    my = 490
    d.eyebrow(40, my - 16, "Merge")
    d.box(40, my, 220, 86, "Secrets Store", ["merge-signing key", "bound to the Worker only"])
    d.wire([(260, my + 43), (296, my + 43)])
    d.box(300, my, 240, 86, "cinder Worker", ["signs the merge commit", "runners never see the key"], kind="hub")
    d.wire([(660, sy + 36), (660, 450), (420, 450), (420, my - 4)])
    d.wire([(540, my + 43), (576, my + 43)])
    d.box(580, my, 160, 86, "target branch", ["signed merge commit", "in Artifacts"])
    d.wire([(740, my + 43), (776, my + 43)])
    d.box(780, my, 180, 86, "History job", ["trailers on the merge", "refs/cinder/changes"])
    d.legend(640)
    return d


# 4. Secrets and model access -------------------------------------------------
def secrets():
    d = D("cinder secrets and model access", 1000, 660,
          "A person's provider key (My model access) and the org's deploy, signing and webhook secrets go into Secrets "
          "Store; org model keys go into AI Gateway stored keys. Cloudflare encrypts and holds every value; cinder keeps "
          "only references. A model key never enters a job: the container egress sends model calls to AI Gateway, which "
          "adds the stored key. A flow job reads its own secrets for its lease and its output is masked. Values never land "
          "in D1, logs, queue messages, job payloads or the browser.")
    d.box(40, 40, 300, 78, "You · My model access", ["your own provider key"])
    d.box(400, 40, 300, 78, "Org admins · Secrets", ["org model keys", "deploy, signing, webhook secrets"])
    d.box(40, 180, 300, 86, "Secrets Store", ["keystore, webhooks: cinder-secrets", "signing key: the cinder Worker", "personal keys for AI Gateway"])
    d.box(400, 180, 300, 86, "AI Gateway stored keys", ["BYOK per provider", "logs with person metadata"])
    d.box(760, 180, 210, 86, "Model providers", ["Anthropic · OpenAI", "Google · xAI · Workers AI"])
    d.wire([(190, 118), (190, 176)])
    d.wire([(550, 118), (550, 176)])
    d.wire([(440, 118), (440, 146), (300, 146), (300, 176)])
    d.wire([(700, 223), (756, 223)])
    # cinder refs
    d.box(40, 350, 300, 86, "cinder Worker + D1", ["references only: secret name,", "version, owner and audit trail"], kind="hub")
    d.wire([(110, 266), (110, 350)], arrow=False, assoc=True)
    d.text(120, 312, "reference, never the value", "l")
    # proxy and job
    d.box(400, 350, 300, 86, "Container egress", ["models.internal → AI Gateway", "per-job host allowlist", "the job's own flow secrets"])
    d.wire([(290, 266), (290, 316), (480, 316), (480, 346)])
    d.text(488, 336, "read for the lease", "l")
    d.wire([(620, 350), (620, 270)])
    d.text(628, 312, "model calls", "l")
    d.box(400, 510, 300, 78, "Ephemeral job instance", ["never holds a model key", "output masked as ***"])
    d.wire([(550, 510), (550, 440)])
    d.text(558, 480, "every outbound request", "l")
    # never
    d.o.append('<rect x="760" y="350" width="210" height="238" rx="10" class="edge"/>')
    d.text(774, 374, "Values never land in", "t")
    for i, t in enumerate(["D1 rows", "Workers Logs · R2 logs", "Queue messages", "job payloads · git", "the browser"]):
        d.text(774, 400 + i * 22, "×  " + t, "s")
    d.text(774, 520, "cinder encrypts nothing", "l")
    d.text(774, 537, "itself; Cloudflare holds", "l")
    d.text(774, 554, "and encrypts every value.", "l")
    d.legend(612, hub="cinder (references)")
    return d


# 5. Page -> resource map ------------------------------------------------------
def pages():
    d = D("cinder pages and their Cloudflare resources", 1000, 730,
          "Each sidebar page and the Cloudflare resource behind it. Repo pages: Code, with Releases on its toolbar, on "
          "Artifacts and D1; Changes, which holds the repo's issues, on D1, RepoDO, ChangeDO and guard and verify jobs on the "
          "runner pool; Watchtower on D1, scan jobs, Vectorize and Clef; Insights on Analytics Engine and AI Gateway logs; "
          "repo Settings on D1 and .cinder.yml in Artifacts. Automation: Agents on Artifacts cinder-agents, D1 and AI Gateway; "
          "Marketplace on D1 and release jobs; Judges on Clef through AI Gateway and D1; Flows on runner pool jobs, Workflows "
          "and R2 logs; Environments on Workflows and the Workers API; Workers on the Containers pool and DispatchDO. "
          "Organization: Repositories on D1 and Artifacts; Wiki on an org Artifacts repo and D1; Needs you on D1 and "
          "ChangeDO; Access and people on Cloudflare Access and D1; Keystore on Secrets Store; My model access on Secrets "
          "Store and AI Gateway.")
    repo = [("Code · Releases", ["Artifacts repo · RepoDO", "D1 index · tags · releases"], False),
            ("Changes · issues", ["D1 · RepoDO · ChangeDO", "guard + verify jobs"], False),
            ("Watchtower", ["D1 · scan jobs", "Vectorize · Clef"], False),
            ("Insights", ["Analytics Engine", "AI Gateway logs"], False),
            ("Repo settings", ["D1 · .cinder.yml", "webhooks: Queue"], False)]
    auto = [("Agents", ["Artifacts cinder-agents", "D1 · AI Gateway"], False),
            ("Marketplace", ["D1 listings", "release jobs"], False),
            ("Judges & calibration", ["Clef on Workers AI via", "AI Gateway · D1"], False),
            ("Flows", ["runner pool jobs", "Workflows · R2 logs"], False),
            ("Environments", ["Workflows", "Workers API deploys"], False),
            ("Workers", ["Containers pool", "DispatchDO claims"], False)]
    org = [("Repositories", ["D1 · Artifacts", "create and import"], False),
           ("Wiki", ["org Artifacts repo", "D1 index · search"], False),
           ("Needs you", ["D1 · ChangeDO"], False),
           ("Access & people", ["Cloudflare Access", "D1 roles"], False),
           ("Keystore", ["Secrets Store", "via cinder-secrets"], False),
           ("My model access", ["Secrets Store", "AI Gateway keys"], False)]
    w, h, g = 225, 74, 20
    def grid(items, y0):
        for i, (t, ls, plan) in enumerate(items):
            d.box(20 + (i % 4) * (w + g), y0 + (i // 4) * (h + 14), w, h, t, ls, plan=plan)
    d.eyebrow(22, 34, "Repo pages · Code ▸ repo")
    grid(repo, 46)
    d.eyebrow(22, 248, "Automation")
    grid(auto, 260)
    d.eyebrow(22, 462, "Organization")
    grid(org, 474)
    d.text(22, 666, "Folded into a host page: Issues (inside Changes) and Releases (from the Code toolbar).", "l")
    d.legend(690, hub="")
    return d


os.makedirs(OUT, exist_ok=True)
for fn, slug in [(overview, "system-overview"), (jobs, "job-execution"), (git, "git-lifecycle"),
                 (secrets, "secrets-model-access"), (pages, "page-resource-map")]:
    dg = fn()
    for v in PAL:
        with open(os.path.join(OUT, f"{slug}-{v}.svg"), "w") as f:
            f.write(dg.render(v))
for w in WARN:
    print("WARN", w)
