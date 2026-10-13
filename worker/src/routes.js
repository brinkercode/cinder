// The route table. One import line and one route line per feature, nothing else: this file merges with git's
// union driver (.gitattributes), so parallel tasks that each add a route never conflict.
import { getAgent, listAgents } from "./agents.js";
import { moveChannel } from "./agents.js";
import { agentHistory } from "./agents.js";
import { agentVersions } from "./canary.js";
import { listFlakes } from "./flakes.js";
import { listQuarantine, releaseQuarantine } from "./flakes.js";
import { diffAgent, putDraft } from "./agents.js";
import { releaseAgent } from "./agents.js";
import { putTokenLimits } from "./agents.js";
import { discardDraft } from "./agents.js";
import { agentVersion } from "./agents.js";
import { releaseEgress } from "./agents.js";
import { installAgent, listCatalog, publishAgent } from "./agents.js";
import { listJudges } from "./judgments.js";
import { createChange } from "./changes.js";
import { patchChange } from "./changes.js";
import { closeChange, getChange, listChanges } from "./changes.js";
import { createRepo, getRepo, listRepos } from "./repos.js";
import { createRunner } from "./runners.js";
import { addAccountMember, createAccount } from "./accounts.js";
import { listAccounts } from "./accounts.js";
import { myAccounts, switchAccount } from "./accounts.js";
import { createLiveTicket, openLive } from "./live.js";
import { claimWork, heartbeatWork, reportWork } from "./work.js";
import { getSymbols, putSymbols } from "./symbols.js";
import { getQueue } from "./queue.js";
import { getPolicy, putPolicy } from "./policy.js";
import { getGlobalPolicy, putGlobalPolicy } from "./policy.js";
import { previewPolicy } from "./policy.js";
import { getMe } from "./access.js";
import { getFile, getTree } from "./code.js";
import { getRaw } from "./code.js";
import { getScorecard, promoteLeg } from "./races.js";
import { listRaces } from "./races.js";
import { listNeeds, resolveNeed } from "./needs.js";
import { getInsights } from "./insights.js";
import { previewChange } from "./preview.js";
import { createGitCredentials } from "./pushes.js";
import { messageAgent, releaseChange, takeOver } from "./takeover.js";
import { editChange } from "./edit.js";
import { getAuthorship, putAuthorship } from "./code.js";
import { listEnvironments, syncEnvironmentNow } from "./environments.js";
import { getLeaseMap } from "./lease-map.js";
import { getCollisions, resolveCollision } from "./collisions.js";
import { answerHandover, getHandover, requestHandover } from "./handover.js";
import { rollbackEnvironment } from "./deploy.js";
import { settleQuarantine } from "./quarantine.js";
import { putAirlock, putJudge } from "./judgments.js";
import { listRunners } from "./runners.js";
import { putSettings } from "./settings.js";
import { pruneEnvironment } from "./environments.js";
import { createWebhook } from "./webhooks.js";
import { getSigningKey } from "./signing.js";
import { signMerge } from "./signing.js";
import { getEgress } from "./egress.js";
import { uploadSarif } from "./sarif.js";
import { addComment, createThread, listThreads, reopenThread, resolveThread } from "./threads.js";
import { applySuggestion } from "./threads.js";
import { dismissFinding, reopenFinding } from "./findings.js";
import { getDependencies } from "./dependencies.js";
import { requestReviewer, suggestReviewers } from "./reviewers.js";
import { removeReviewer } from "./reviewers.js";
import { listScans } from "./scans.js";
import { getWatchtower } from "./scans.js";
import { startScan } from "./scans.js";
import { getSbom } from "./sbom.js";
import { reviewChange } from "./changes.js";
import { readyChange } from "./changes.js";
import { listChecks, listCommits } from "./change-checks.js";
import { listFiles } from "./change-checks.js";
import { fixFinding } from "./findings.js";
import { listBranches } from "./branches.js";
import { createBranch, deleteBranch } from "./branches.js";
import { getTool, putTool } from "./toolcache.js";
import { getCompare, putCompare } from "./compare.js";
import { addWikiComment, deleteWikiComment, editWikiComment, listWikiComments } from "./wiki.js";
import { getWikiPage, getWikiTree, searchWiki } from "./wiki.js";
import { createWikiPage, deleteWikiPage, editWikiPage, moveWikiPage } from "./wiki.js";
import { diffWikiPage, listWikiHistory, restoreWikiVersion } from "./wiki.js";
import { getWikiContext } from "./wiki.js";
import { createCommit } from "./commits.js";
import { createTag } from "./tags.js";
import { resolveCommit } from "./tags.js";
import { getLog, searchCode } from "./code.js";
import { getCommit } from "./code.js";
import { addPerson, putRepoRole, putRole, removePerson } from "./people.js";
import { seedCommits } from "./commits.js";
import { reimportRepo } from "./repos.js";
import { archiveRepo } from "./repos.js";
import { getOverview, putAccount } from "./overview.js";
import { getAccount } from "./overview.js";
import { createSecret, getKeystoreAudit, listKeystore, readJobSecret, rotateSecret } from "./keystore.js";
import { getKeystoreUsage, removeSecret } from "./keystore.js";
import { rebindSecrets } from "./keystore.js";
import { assignPool, createPool, drainPool, listPools, scalePool } from "./workers.js";
import { createByoPool, listByoPools, resizePool } from "./workers.js";
import { putByoPool, putPool } from "./workers.js";
import { undrainPool } from "./workers.js";
import { deleteByoPool } from "./workers.js";
import { revokeRunner } from "./workers.js";
import { getRun, reportStep, startRun } from "./flows.js";
import { listRuns } from "./flows.js";
import { driveStep } from "./flows.js";
import { addIssueComment, createIssue, editIssue, getIssue, linkIssue, listIssues } from "./issues.js";
import { createRelease, listReleases, listTags, promoteRelease, publishRelease } from "./releases.js";
import { queueChange, setAutoQueue } from "./change-view.js";
import { patchDependency } from "./dependencies.js";
import { deleteGroup, listGroups, putGroup } from "./people.js";
import { addInvites, listPeople, setPersonRole } from "./people.js";
import { deleteModelKey, getModelAccess, putModelKey, putModelSource, reportModelUsage } from "./model-access.js";
import { getCatalog, getFleet, putAgentRole, putFleet } from "./fleet.js";
import { environmentTree } from "./environments.js";
import { listBranchDeploys } from "./environments.js";
import { getSettings } from "./settings.js";
import { deleteRepo } from "./repos.js";
import { resetData } from "./admin.js";
import { getReset } from "./admin.js";
import { seedData, startDemo } from "./admin.js";
import { deleteRepoRole, listRepoRoles, listRoles } from "./people.js";
import { deleteServiceToken, listServiceTokens, putServiceToken } from "./access.js";
import { deleteWebhook, listWebhooks, patchWebhook, rotateWebhook } from "./webhooks.js";
import { getLogPage, getLogText, listAnnotations, postAnnotations, postStepLog, postStepStatus } from "./flow-logs.js";
import { getServices } from "./services.js";
import { retryChange } from "./changes.js";
import { listRepairs } from "./repairs.js";
import { checkEdit } from "./edit-check.js";
import { listPoolTokens, mintPoolToken, revokePoolToken } from "./runners.js";
import { cancelRun, getArtifact, listArtifacts, listTests, postTests, putArtifact, rerunRun } from "./flow-results.js";
import { putJudgeAirlock } from "./judgments.js";
import { releaseWorkspaceLease, steerAgent } from "./workspace.js";
import { getFlow, listFlows } from "./flows.js";
import { listWork } from "./work-board.js";
import { claimIssue, postActivity, suggestAgents, unclaimIssue } from "./work-claim.js";
import { getRouting, putRouting } from "./routing.js";

export const routes = {
  "GET /api/health": () => Response.json({ ok: true }),
  "POST /api/runners": createRunner,
  "POST /api/workers/byo-pools/:id/tokens": mintPoolToken,
  "GET /api/workers/byo-pools/:id/tokens": listPoolTokens, "DELETE /api/workers/byo-pools/:id/tokens/:prefix": revokePoolToken,
  "POST /api/repos": createRepo,
  "GET /api/repos": listRepos,
  "GET /api/repos/:name": getRepo,
  "GET /api/repos/:name/flakes": listFlakes,
  "GET /api/repos/:name/quarantine": listQuarantine, "DELETE /api/repos/:name/quarantine/:test": releaseQuarantine,
  "POST /api/repos/:name/flakes/:test/release": releaseQuarantine,
  "GET /api/repos/:name/judges": listJudges,
  "GET /api/agents": listAgents,
  "GET /api/agents/:name": getAgent,
  "PUT /api/agents/:name/channels/:channel": moveChannel,
  "GET /api/agents/:name/versions": agentVersions,
  "PUT /api/agents/:name/versions/:version/limits": putTokenLimits,
  "GET /api/agents/:name/versions/:version": agentVersion,
  "GET /api/agents/:name/history": agentHistory,
  "PUT /api/agents/:name/draft": putDraft,
  "DELETE /api/agents/:name/draft": discardDraft,
  "GET /api/agents/:name/diff": diffAgent,
  "POST /api/agents/:name/release": releaseAgent,
  "POST /api/agents/:name/egress": releaseEgress,
  "GET /api/marketplace": listCatalog, "POST /api/agents/:name/install": installAgent, "POST /api/agents/:name/publish": publishAgent,
  "POST /api/repos/:name/changes": createChange,
  "GET /api/repos/:name/changes": listChanges,
  "GET /api/changes/:id": getChange,
  "POST /api/changes/:id/close": closeChange,
  "POST /api/live-ticket": createLiveTicket,
  "GET /api/repos/:name/live": openLive,
  "POST /api/work/claim": claimWork,
  "POST /api/work/jobs/:job/heartbeat": heartbeatWork,
  "POST /api/work/jobs/:job/report": reportWork,
  "POST /api/work/jobs/:job/sign": signMerge,
  "GET /api/repos/:name/symbols": getSymbols,
  "PUT /api/work/repos/:name/symbols/:sha": putSymbols,
  "GET /api/repos/:name/queue": getQueue,
  "GET /api/repos/:name/policy": getPolicy, "PUT /api/repos/:name/policy": putPolicy,
  "GET /api/me": getMe,
  "GET /api/repos/:name/tree": getTree, "GET /api/repos/:name/file": getFile,
  "GET /api/repos/:name/raw": getRaw,
  "GET /api/races/:id": getScorecard, "POST /api/changes/:id/promote": promoteLeg,
  "GET /api/races": listRaces,
  "GET /api/needs": listNeeds, "POST /api/needs/:id/resolve": resolveNeed,
  "GET /api/repos/:name/insights": getInsights,
  "POST /api/repos/:name/changes/preview": previewChange,
  "POST /api/repos/:name/git-credentials": createGitCredentials,
  "POST /api/repos/:name/changes/edit": editChange,
  "POST /api/changes/:id/takeover": takeOver, "POST /api/changes/:id/messages": messageAgent, "POST /api/changes/:id/release": releaseChange,
  "GET /api/repos/:name/authorship": getAuthorship, "PUT /api/work/repos/:name/authorship/:sha": putAuthorship,
  "GET /api/repos/:name/environments": listEnvironments, "POST /api/repos/:name/environments/:environment/sync": syncEnvironmentNow,
  "GET /api/repos/:name/lease-map": getLeaseMap,
  "GET /api/repos/:name/collisions": getCollisions, "POST /api/changes/:id/collisions/resolve": resolveCollision,
  "POST /api/repos/:name/environments/:env/rollback": rollbackEnvironment,
  "POST /api/changes/:id/quarantine": settleQuarantine,
  "PUT /api/repos/:name/airlock": putAirlock, "PUT /api/repos/:name/judges/:kind": putJudge,
  "GET /api/people": listPeople,
  "PUT /api/repos/:name/settings": putSettings,
  "POST /api/repos/:name/environments/:env/prune": pruneEnvironment,
  "POST /api/repos/:name/webhooks": createWebhook,
  "GET /api/repos/:name/signing-key": getSigningKey,
  "GET /api/repos/:name/egress": getEgress,
  "POST /api/repos/:name/sarif": uploadSarif,
  "POST /api/changes/:id/threads": createThread, "GET /api/changes/:id/threads": listThreads, "POST /api/changes/:id/threads/:t/comments": addComment, "POST /api/changes/:id/threads/:t/resolve": resolveThread, "POST /api/changes/:id/threads/:t/reopen": reopenThread,
  "POST /api/findings/:id/dismiss": dismissFinding, "POST /api/findings/:id/reopen": reopenFinding,
  "GET /api/repos/:name/dependencies": getDependencies,
  "POST /api/changes/:id/reviewers": requestReviewer, "GET /api/changes/:id/reviewers/suggested": suggestReviewers,
  "DELETE /api/changes/:id/reviewers/:who": removeReviewer,
  "GET /api/repos/:name/sbom": getSbom,
  "POST /api/changes/:id/threads/:t/apply": applySuggestion,
  "POST /api/changes/:id/review": reviewChange,
  "POST /api/changes/:id/ready": readyChange,
  "GET /api/changes/:id/commits": listCommits, "GET /api/changes/:id/checks": listChecks,
  "POST /api/findings/:id/fix": fixFinding,
  "GET /api/repos/:name/branches": listBranches,
  "POST /api/repos/:name/branches": createBranch, "DELETE /api/repos/:name/branches/:branch": deleteBranch,
  "GET /api/repos/:name/compare": getCompare, "PUT /api/work/repos/:name/compare/:base/:head": putCompare,
  "GET /api/repos/:name/wiki/tree": getWikiTree, "GET /api/repos/:name/wiki/pages/:id": getWikiPage,
  "GET /api/repos/:name/wiki/search": searchWiki,
  "GET /api/repos/:name/wiki/context": getWikiContext,
  "GET /api/repos/:name/wiki/pages/:id/comments": listWikiComments, "POST /api/repos/:name/wiki/pages/:id/comments": addWikiComment, "PATCH /api/repos/:name/wiki/pages/:id/comments/:c": editWikiComment, "DELETE /api/repos/:name/wiki/pages/:id/comments/:c": deleteWikiComment,
  "POST /api/repos/:name/wiki/pages": createWikiPage, "PATCH /api/repos/:name/wiki/pages/:id": editWikiPage, "PATCH /api/repos/:name/wiki/pages/:id/move": moveWikiPage, "DELETE /api/repos/:name/wiki/pages/:id": deleteWikiPage,
  "GET /api/repos/:name/wiki/pages/:id/history": listWikiHistory, "GET /api/repos/:name/wiki/pages/:id/diff": diffWikiPage, "POST /api/repos/:name/wiki/pages/:id/restore/:v": restoreWikiVersion,
  "GET /api/repos/:name/watchtower": getWatchtower,
  "POST /api/repos/:name/commits": createCommit,
  "POST /api/repos/:name/tags": createTag,
  "GET /api/repos/:name/resolve": resolveCommit,
  "GET /api/repos/:name/watchtower/scans": listScans,
  "POST /api/repos/:name/watchtower/scans": startScan,
  "POST /api/workers": createRunner, "GET /api/workers": listRunners, "POST /api/workers/pools": createPool, "GET /api/workers/pools": listPools, "POST /api/workers/pools/:id/scale": scalePool, "PUT /api/workers/pools/:id/assign": assignPool, "POST /api/workers/pools/:id/drain": drainPool,
  "GET /api/repos/:name/log": getLog, "GET /api/repos/:name/code-search": searchCode,
  "POST /api/people": addPerson, "DELETE /api/people/:email": removePerson, "PUT /api/roles/:role": putRole, "PUT /api/repos/:name/people/:email": putRepoRole,
  "POST /api/repos/:name/seed": seedCommits,
  "POST /api/repos/:name/import": reimportRepo,
  "POST /api/repos/:name/flows/:flow/runs": startRun, "GET /api/repos/:name/flow-runs/:id": getRun, "POST /api/work/jobs/:job/steps": reportStep,
  "POST /api/keystore": createSecret, "GET /api/keystore": listKeystore, "POST /api/keystore/:id/rotate": rotateSecret, "GET /api/keystore/:id/audit": getKeystoreAudit, "GET /api/work/jobs/:job/secrets/:secret": readJobSecret,
  "GET /api/keystore/usage": getKeystoreUsage, "DELETE /api/keystore/:id": removeSecret,
  "POST /api/keystore/rebind": rebindSecrets,
  "GET /api/settings/policy": getGlobalPolicy, "PUT /api/settings/policy": putGlobalPolicy,
  "GET /api/repos/:name/flow-runs": listRuns,
  "GET /api/repos/:name/issues": listIssues, "POST /api/repos/:name/issues": createIssue, "GET /api/repos/:name/issues/:n": getIssue, "PATCH /api/repos/:name/issues/:n": editIssue, "POST /api/repos/:name/issues/:n/comments": addIssueComment, "PUT /api/repos/:name/issues/:n/changes/:id": linkIssue,
  "GET /api/repos/:name/commits/:sha": getCommit,
  "GET /api/repos/:name/tags": listTags, "GET /api/repos/:name/releases": listReleases, "POST /api/repos/:name/releases": createRelease, "POST /api/repos/:name/releases/:id/publish": publishRelease, "POST /api/repos/:name/environments/:env/promote": promoteRelease,
  "PATCH /api/changes/:id/auto_queue": setAutoQueue, "POST /api/changes/:id/queue": queueChange,
  "PUT /api/workers/pools/:id/size": resizePool, "POST /api/workers/byo-pools": createByoPool, "GET /api/workers/byo-pools": listByoPools,
  "PATCH /api/repos/:name/dependencies": patchDependency,
  "POST /api/workers/pools/:id/undrain": undrainPool,
  "DELETE /api/workers/byo-pools/:id": deleteByoPool,
  "PUT /api/workers/pools/:id": putPool, "PUT /api/workers/byo-pools/:id": putByoPool,
  "DELETE /api/workers/:id": revokeRunner,
  "GET /api/groups": listGroups, "PUT /api/groups/:group": putGroup, "DELETE /api/groups/:group": deleteGroup,
  "PATCH /api/people/:email": setPersonRole, "POST /api/groups": putGroup, "POST /api/invites": addInvites,
  "GET /api/account": getAccount,
  "GET /api/overview": getOverview, "PUT /api/account": putAccount, "POST /api/repos/:name/archive": archiveRepo, "DELETE /api/repos/:name/archive": archiveRepo,
  "GET /api/me/models": getModelAccess, "PUT /api/me/models": putModelSource, "PUT /api/me/models/:provider": putModelKey, "DELETE /api/me/models/:provider": deleteModelKey, "POST /api/work/model-usage": reportModelUsage,
  "GET /api/fleet": getFleet, "PUT /api/fleet": putFleet, "PUT /api/agents/:name/role": putAgentRole, "GET /api/models/catalog": getCatalog,
  "GET /api/repos/:name/environments/:env/tree": environmentTree,
  "POST /api/work/jobs/:job/steps/:step/start": driveStep,
  "POST /api/admin/reset": resetData,
  "GET /api/admin/reset/:id": getReset,
  "POST /api/admin/seed": seedData, "GET /api/admin/seed/:id": getReset, "POST /api/admin/demo": startDemo,
  "GET /api/repos/:name/settings": getSettings, "DELETE /api/repos/:name": deleteRepo, "GET /api/roles": listRoles,
  "GET /api/repos/:name/people": listRepoRoles, "DELETE /api/repos/:name/people/:email": deleteRepoRole,
  "GET /api/repos/:name/webhooks": listWebhooks, "PATCH /api/repos/:name/webhooks/:id": patchWebhook, "DELETE /api/repos/:name/webhooks/:id": deleteWebhook, "POST /api/repos/:name/webhooks/:id/rotate": rotateWebhook,
  "GET /api/changes/:id/files": listFiles,
  "GET /api/work/toolcache/:tool/:version": getTool, "PUT /api/work/toolcache/:tool/:version": putTool,
  "GET /api/service-tokens": listServiceTokens, "PUT /api/service-tokens/:client_id": putServiceToken, "DELETE /api/service-tokens/:client_id": deleteServiceToken,
  "POST /api/accounts": createAccount, "POST /api/accounts/:id/members": addAccountMember,
  "GET /api/accounts": listAccounts,
  "GET /api/me/accounts": myAccounts, "POST /api/me/accounts/:id/switch": switchAccount,
  "POST /api/work/jobs/:job/steps/:idx/status": postStepStatus, "POST /api/work/jobs/:job/steps/:idx/log": postStepLog, "POST /api/work/jobs/:job/annotations": postAnnotations, "GET /api/repos/:name/flow-runs/:id/jobs/:key/log": getLogPage, "GET /api/repos/:name/flow-runs/:id/jobs/:key/log.txt": getLogText, "GET /api/repos/:name/flow-runs/:id/annotations": listAnnotations,
  "GET /api/repos/:name/services": getServices,
  "POST /api/changes/:id/retry": retryChange,
  "GET /api/repos/:name/policy/preview": previewPolicy,
  "POST /api/work/edit-check": checkEdit,
  "GET /api/changes/:id/repairs": listRepairs,
  "GET /api/repos/:name/branch-deploys": listBranchDeploys,
  "POST /api/repos/:name/flow-runs/:id/cancel": cancelRun, "POST /api/repos/:name/flow-runs/:id/rerun": rerunRun, "POST /api/work/jobs/:job/tests": postTests, "GET /api/repos/:name/flow-runs/:id/tests": listTests, "PUT /api/work/jobs/:job/artifacts/:name": putArtifact, "GET /api/repos/:name/flow-runs/:id/artifacts": listArtifacts, "GET /api/repos/:name/flow-runs/:id/artifacts/:artifact": getArtifact,
  "PUT /api/repos/:name/judges/:kind/airlock": putJudgeAirlock,
  "DELETE /api/leases/:id": releaseWorkspaceLease, "POST /api/changes/:id/steer": steerAgent,
  "POST /api/leases/:id/handover-request": requestHandover, "GET /api/leases/:id/handover-request/:rid": getHandover, "POST /api/leases/:id/handover-request/:rid/answer": answerHandover,
  "GET /api/repos/:name/flows": listFlows, "GET /api/repos/:name/flows/:flow": getFlow,
  "GET /api/repos/:name/work": listWork,
  "PATCH /api/changes/:id": patchChange,
  "POST /api/repos/:name/issues/:n/claim": claimIssue, "DELETE /api/repos/:name/issues/:n/claim": unclaimIssue, "GET /api/repos/:name/agents/suggest": suggestAgents, "POST /api/work/jobs/:job/activity": postActivity,
  "GET /api/repos/:name/routing": getRouting, "PUT /api/repos/:name/routing": putRouting,
};
