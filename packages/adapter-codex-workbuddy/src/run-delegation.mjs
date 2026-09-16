import { validateTaskEnvelope } from "../../contracts/src/envelope.mjs";
import { DelegationError } from "../../contracts/src/errors.mjs";
import { assertRepositoryLinks } from "../../core/src/filesystem-evidence.mjs";
import { runLocalDelegation } from "../../core/src/local-delegation.mjs";
import { runExecutor } from "../../executor-workbuddy/src/executor.mjs";

export async function runDelegation(input, options = {}) {
  options = { ...options, validationEnv: Object.freeze({ ...(options.validationEnv ?? {}) }) };
  if (options.stateRoot || options.hostInstanceId || options.resumeSessionId || options.correctionPrompt) {
    throw new DelegationError("workbuddy_fresh_task_required", "WorkBuddy currently supports fresh bounded tasks only; same-session correction is not admitted.");
  }
  const bounded = structuredClone(validateTaskEnvelope(input));
  const nativeScope = structuredClone(bounded.scope);
  if (options.readOnly === true) {
    bounded.scope.forbiddenPaths = [...new Set([...bounded.scope.forbiddenPaths, "**"])];
    bounded.repository.dirtyTree = { allow: false, acknowledgedPaths: [] };
  }
  return runLocalDelegation(bounded, {
    ...options,
    async execute(envelope, runtime) {
      return runExecutor({ ...envelope, scope: nativeScope }, {
        ...options, redactionValues: Object.values(options.validationEnv ?? {}), workingDirectory: runtime.workingDirectory, signal: runtime.signal,
        async beforeVerifiedLaunch() {
          await options.beforeVerifiedLaunch?.();
          await assertRepositoryLinks(runtime.repository.gitRoot);
        }
      });
    }
  });
}
