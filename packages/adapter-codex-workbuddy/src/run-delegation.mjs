import { filesystemEvidenceMaxBytes, validateTaskEnvelope } from "../../contracts/src/envelope.mjs";
import { DelegationError } from "../../contracts/src/errors.mjs";
import { assertRepositoryLinks } from "../../core/src/filesystem-evidence.mjs";
import { runLocalDelegation } from "../../core/src/local-delegation.mjs";
import { containsExactSensitiveValue } from "../../core/src/redact.mjs";
import { runExecutor, workBuddyModelId } from "../../executor-workbuddy/src/executor.mjs";

export async function runDelegation(input, options = {}) {
  options = { ...options, validationEnv: Object.freeze({ ...(options.validationEnv ?? {}) }) };
  const model = workBuddyModelId(options.model);
  if (containsExactSensitiveValue(model, Object.values(options.validationEnv))) {
    throw new DelegationError("workbuddy_model_sensitive_collision", "The selected WorkBuddy model overlaps a protected validation value and cannot be retained as exact evidence.");
  }
  if (options.stateRoot || options.hostInstanceId || options.resumeSessionId || options.correctionPrompt) {
    throw new DelegationError("workbuddy_fresh_task_required", "WorkBuddy currently supports fresh bounded tasks only; same-session correction is not admitted.");
  }
  const bounded = structuredClone(validateTaskEnvelope(input));
  const nativeScope = structuredClone(bounded.scope);
  options.readOnly = options.readOnly === true || bounded.scope.allowedPaths.length === 0;
  if (options.readOnly) {
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
          await assertRepositoryLinks(runtime.repository.gitRoot, undefined, { maxBytes: filesystemEvidenceMaxBytes(envelope) });
        }
      });
    }
  });
}
