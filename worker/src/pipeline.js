import { WorkflowEntrypoint } from "cloudflare:workers";
import { syncEnvironment } from "./deploy.js";

// Started by the cf.artifacts.repo.pushed trigger in wrangler.jsonc. Forwards the push to the cinder-events Queue
// (src/pushes.js); verification runs on the runners.
export class PipelineWorkflow extends WorkflowEntrypoint {
  // A manual sync (POST …/environments/:env/sync), a flow's deploy step or a self-heal (drift.js, actor cinder-drift)
  // starts an instance with params {sync, repo, env?, branch, sha, actor, override, all}; env names the environment when several share the branch.
  async run(event, step) {
    const { sync, repo, env, branch, sha, actor, override, all } = event.payload;
    if (sync) return syncEnvironment(this.env, repo, branch, sha, step, { manual: true, id: sync, actor, override, all, name: env });
    await step.do("enqueue push", () => this.env.EVENTS.send(event.payload));
  }
}
