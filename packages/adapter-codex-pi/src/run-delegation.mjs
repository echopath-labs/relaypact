import { runLocalDelegation } from "../../core/src/local-delegation.mjs";
import { executorSecurityEvidence, runExecutor } from "../../executor-pi/src/executor.mjs";

export async function runDelegation(input, options = {}) {
  return runLocalDelegation(input, {
    ...options,
    securityEvidence: executorSecurityEvidence,
    execute(envelope, runtime) {
      return runExecutor(envelope, {
        ...options,
        workingDirectory: runtime.workingDirectory,
        signal: runtime.signal
      });
    }
  });
}
