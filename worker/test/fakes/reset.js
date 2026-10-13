import { ResetWorkflow } from "../../src/index.js";

// The RESET Workflow binding over env: create() starts the run in the background, as the platform does, with one step
// per step.do. steps lists the step names run; runs holds each run's promise, for a test to await.
export function fakeReset(env) {
  const steps = [];
  const runs = [];
  const step = { do: async (name, fn) => { steps.push(name); return fn(); } };
  return {
    steps, runs,
    create: async ({ id }) => {
      runs.push(ResetWorkflow.prototype.run.call({ env }, { instanceId: id, payload: {} }, step));
      return { id };
    },
  };
}
