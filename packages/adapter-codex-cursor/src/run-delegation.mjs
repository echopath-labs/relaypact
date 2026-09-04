import { runLocalDelegation } from "../../core/src/local-delegation.mjs";
import { DelegationError } from "../../contracts/src/errors.mjs";
import {
  authorizeDirectCorrection,
  executeDirectDelegation,
  loadDirectDelegation,
  prepareDirectDelegation,
  requireDirectExecutorSession
} from "../../core/src/direct-lifecycle.mjs";
import { decideDirectDelegation } from "../../host-codex/src/direct-actions.mjs";
import {
  cursorPrivateSession,
  discoverCursorCli,
  resolveCursorExecutable,
  runExecutor
} from "../../executor-cursor/src/executor.mjs";

const ROUTE = Object.freeze({ routeId: "codex-cursor", executorHarness: "cursor" });

function cursorSecurityEvidence() {
  return {
    sensitiveValues: [],
    credentialEvidenceTrusted: true
  };
}

function cursorLifecycleError(error) {
  if (error instanceof DelegationError && error.code === "executor_session_unavailable") {
    return new DelegationError("cursor_session_unavailable", error.message, error.details);
  }
  return error;
}

export async function runDelegation(input, options = {}) {
  if ((options.stateRoot || options.hostInstanceId) && !(options.stateRoot && options.hostInstanceId)) {
    throw new TypeError("Persistent Cursor execution requires both stateRoot and hostInstanceId.");
  }
  if (!options.stateRoot) return runCursorAttempt(input, options).then(({ result }) => result);

  const prepared = await prepareDirectDelegation({
    envelope: input,
    stateRoot: options.stateRoot,
    hostInstanceId: options.hostInstanceId,
    executionMode: options.readOnly === true ? "read_only" : "write",
    ...ROUTE
  });
  const recorded = await executeDirectDelegation(prepared, async (active) => {
    const attempt = await runCursorAttempt(active.envelope, options);
    return {
      executionResult: attempt.result,
      session: cursorPrivateSession(attempt.executor)
    };
  });
  return {
    taskRoot: prepared.taskRoot,
    statePath: prepared.statePath,
    evidence: recorded.evidence,
    review: recorded.review
  };
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
  const executorContextOverride = options.executorCommand !== undefined ||
    options.environment !== undefined || options.commandBaseDirectory !== undefined;
  if (!prepared.state.sessionHandle && !executorContextOverride) {
    try {
      requireDirectExecutorSession(prepared.state);
    } catch (error) {
      throw cursorLifecycleError(error);
    }
  }
  const identity = await resolveCursorExecutable(
    options.executorCommand ?? prepared.state.executorCommand,
    {
      environment: options.environment,
      commandBaseDirectory: options.commandBaseDirectory
    }
  );
  if (
    !identity || identity.command !== prepared.state.executorCommand ||
    identity.fingerprint !== prepared.state.executorFingerprint
  ) {
    throw new DelegationError("cursor_executor_mismatch", "Cursor correction must reuse the executor command bound to the original session.");
  }
  try {
    requireDirectExecutorSession(prepared.state);
  } catch (error) {
    throw cursorLifecycleError(error);
  }
  const readiness = await discoverCursorCli({
    ...options,
    executorIdentity: identity
  });
  try {
    prepared = await authorizeDirectCorrection(prepared, prompt);
  } catch (error) {
    throw cursorLifecycleError(error);
  }
  const recorded = await executeDirectDelegation(prepared, async (active) => {
    const attempt = await runCursorAttempt(active.envelope, {
      ...options,
      executorCommand: active.executorCommand,
      readiness,
      readOnly: active.executionMode === "read_only",
      resumeSessionId: active.resumeSessionId,
      correctionPrompt: active.correctionPrompt
    });
    const nextSession = cursorPrivateSession(attempt.executor);
    if (
      (nextSession.handle && nextSession.handle !== active.resumeSessionId) ||
      (nextSession.executorCommand && nextSession.executorCommand !== active.executorCommand) ||
      (nextSession.executorFingerprint && nextSession.executorFingerprint !== active.executorFingerprint)
    ) {
      throw new DelegationError("cursor_session_mismatch", "Cursor correction returned a different session identity.");
    }
    return {
      executionResult: attempt.result,
      session: {
        handle: nextSession.handle ?? active.resumeSessionId,
        digest: nextSession.digest ?? active.state.sessionDigest,
        executorCommand: nextSession.executorCommand ?? active.executorCommand,
        executorFingerprint: nextSession.executorFingerprint ?? active.executorFingerprint
      }
    };
  });
  return {
    taskRoot: prepared.taskRoot,
    statePath: prepared.statePath,
    evidence: recorded.evidence,
    review: recorded.review
  };
}

export async function decideDelegation(taskRoot, action, actor, archiveRoot) {
  const prepared = await loadDirectDelegation(taskRoot, ROUTE);
  return decideDirectDelegation(prepared, action, actor, archiveRoot);
}
