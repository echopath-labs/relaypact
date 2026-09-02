import { runLocalDelegation } from "../../core/src/local-delegation.mjs";
import { DelegationError } from "../../contracts/src/errors.mjs";
import {
  archiveAndCleanupDirectTask,
  authorizeDirectCorrection,
  beginDirectDelegation,
  failDirectDelegation,
  loadDirectDelegation,
  prepareDirectDelegation,
  recordDirectDelegationResult,
  recordDirectTerminalDecision,
  validateDirectArchiveRoot
} from "../../core/src/direct-lifecycle.mjs";
import { cursorPrivateSession, runExecutor } from "../../executor-cursor/src/executor.mjs";

const ROUTE = Object.freeze({ routeId: "codex-cursor", executorHarness: "cursor" });

function cursorSecurityEvidence() {
  return {
    sensitiveValues: [],
    credentialEvidenceTrusted: true
  };
}

export async function runDelegation(input, options = {}) {
  if ((options.stateRoot || options.hostInstanceId) && !(options.stateRoot && options.hostInstanceId)) {
    throw new TypeError("Persistent Cursor execution requires both stateRoot and hostInstanceId.");
  }
  if (!options.stateRoot) return runCursorAttempt(input, options).then(({ result }) => result);

  let prepared = await prepareDirectDelegation({
    envelope: input,
    stateRoot: options.stateRoot,
    hostInstanceId: options.hostInstanceId,
    ...ROUTE
  });
  prepared = await beginDirectDelegation(prepared);
  try {
    const attempt = await runCursorAttempt(prepared.envelope, options);
    const recorded = await recordDirectDelegationResult(prepared, attempt.result, cursorPrivateSession(attempt.executor));
    return {
      taskRoot: prepared.taskRoot,
      statePath: prepared.statePath,
      evidence: recorded.evidence,
      review: recorded.review
    };
  } catch (error) {
    await failDirectDelegation(prepared).catch(() => {});
    throw error;
  }
}

async function runCursorAttempt(input, options = {}) {
  let executor;
  const result = await runLocalDelegation(input, {
    ...options,
    securityEvidence: cursorSecurityEvidence,
    execute(envelope, runtime) {
      return runExecutor(envelope, {
        ...options,
        workingDirectory: runtime.workingDirectory,
        signal: runtime.signal
      }).then((value) => {
        executor = value;
        return value;
      });
    }
  });
  return { result, executor };
}

export async function correctDelegation(taskRoot, prompt, options = {}) {
  let prepared = await loadDirectDelegation(taskRoot, ROUTE);
  if (options.executorCommand && options.executorCommand !== prepared.state.executorCommand) {
    throw new DelegationError("cursor_executor_mismatch", "Cursor correction must reuse the executor command bound to the original session.");
  }
  prepared = await authorizeDirectCorrection(prepared, prompt);
  try {
    const attempt = await runCursorAttempt(prepared.envelope, {
      ...options,
      executorCommand: prepared.executorCommand,
      resumeSessionId: prepared.resumeSessionId,
      correctionPrompt: prepared.correctionPrompt
    });
    const nextSession = cursorPrivateSession(attempt.executor);
    if (
      (nextSession.handle && nextSession.handle !== prepared.resumeSessionId) ||
      (nextSession.executorCommand && nextSession.executorCommand !== prepared.executorCommand)
    ) {
      throw new DelegationError("cursor_session_mismatch", "Cursor correction returned a different session identity.");
    }
    const recorded = await recordDirectDelegationResult(prepared, attempt.result, {
      handle: nextSession.handle ?? prepared.resumeSessionId,
      digest: nextSession.digest ?? prepared.state.sessionDigest,
      executorCommand: nextSession.executorCommand ?? prepared.executorCommand
    });
    return {
      taskRoot: prepared.taskRoot,
      statePath: prepared.statePath,
      evidence: recorded.evidence,
      review: recorded.review
    };
  } catch (error) {
    await failDirectDelegation(prepared).catch(() => {});
    throw error;
  }
}

export async function decideDelegation(taskRoot, action, actor, archiveRoot) {
  const prepared = await loadDirectDelegation(taskRoot, ROUTE);
  await validateDirectArchiveRoot(prepared, archiveRoot);
  const decided = await recordDirectTerminalDecision(prepared, action, actor);
  const archive = await archiveAndCleanupDirectTask(prepared, decided, archiveRoot);
  return {
    action,
    lifecycleState: decided.state.lifecycleState,
    acceptance: decided.review.executionResult.hostAcceptance,
    archive
  };
}
