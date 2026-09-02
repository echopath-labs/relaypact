import { runLocalDelegation } from "../../core/src/local-delegation.mjs";
import { runExecutor } from "../../executor-cursor/src/executor.mjs";

function cursorSecurityEvidence() {
  return {
    sensitiveValues: [],
    credentialEvidenceTrusted: true
  };
}

export async function runDelegation(input, options = {}) {
  return runLocalDelegation(input, {
    ...options,
    securityEvidence: cursorSecurityEvidence,
    execute(envelope, runtime) {
      return runExecutor(envelope, {
        ...options,
        workingDirectory: runtime.workingDirectory,
        signal: runtime.signal
      });
    }
  });
}
