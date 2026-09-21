import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { filesystemEvidenceMaxBytes, validateTaskEnvelope } from "../../contracts/src/envelope.mjs";
import { evaluatePathScope } from "../../contracts/src/path-policy.mjs";
import { createIsolatedEnvironment } from "./environment.mjs";
import { assertRepositoryLinks, assertFilesystemSnapshot, changedFilesystemPaths, snapshotFilesystem, snapshotGitControls } from "./filesystem-evidence.mjs";
import {
  collectGitState,
  enforceDirtyTreePolicy,
  getCommittedDiffPaths,
  resolveRepository,
  snapshotGitIndex
} from "./git.mjs";
import { runProcess } from "./process.mjs";
import { conciseOutput, containsExactSensitiveValue } from "./redact.mjs";

const MAX_SENSITIVE_EVIDENCE_BYTES = 64 * 1024 * 1024;

function skippedValidations(commands, reason, sensitiveValues = []) {
  return commands.map((command) => ({
    id: conciseOutput(command.id, 200, sensitiveValues),
    argv: command.argv.map((argument) => conciseOutput(argument, 1000, sensitiveValues)),
    status: "not_run",
    exitCode: null,
    output: "",
    reason
  }));
}

async function runValidations(commands, workingDirectory, options = {}) {
  const results = [];
  const sensitiveValues = [...new Set([
    ...(options.redactionValues ?? []),
    ...Object.values(options.validationEnv ?? {})
  ].filter((value) => typeof value === "string" && value.length > 0))];
  const isolated = await createIsolatedEnvironment(options.validationEnvironment ?? process.env, {
    prefix: "relaypact-validation-",
    grants: options.validationEnv ?? {}
  });
  const runner = options.validationProcess ?? runProcess;
  try {
    for (let index = 0; index < commands.length; index += 1) {
      const command = commands[index];
      if (options.signal?.aborted) {
        results.push(...skippedValidations(commands.slice(index), "cancelled", sensitiveValues));
        break;
      }
      let processResult;
      try {
        await assertRepositoryLinks(options.repositoryRoot ?? workingDirectory, undefined, { maxBytes: options.filesystemEvidenceMaxBytes });
        options.onValidationStarted?.();
        processResult = await runner(command.argv[0], command.argv.slice(1), {
          cwd: workingDirectory,
          env: isolated.env,
          timeoutMs: command.timeoutMs ?? 120_000,
          signal: options.signal
        });
        options.onValidationSettled?.();
      } catch (error) {
        if (error?.code === "repository_link_unsafe") throw error;
        results.push({
          id: conciseOutput(command.id, 200, sensitiveValues),
          argv: command.argv.map((argument) => conciseOutput(argument, 1000, sensitiveValues)),
          status: "not_run",
          exitCode: null,
          output: conciseOutput(error.message, 4000, sensitiveValues),
          reason: "spawn_error"
        });
        continue;
      }
      const truncated = processResult.stdoutTruncated || processResult.stderrTruncated;
      const passed = processResult.exitCode === 0 && !processResult.signal &&
        !processResult.timedOut && !processResult.cancelled && !truncated;
      results.push({
        id: conciseOutput(command.id, 200, sensitiveValues),
        argv: command.argv.map((argument) => conciseOutput(argument, 1000, sensitiveValues)),
        status: passed ? "passed" : "failed",
        exitCode: processResult.exitCode,
        output: conciseOutput(`${processResult.stdout}\n${processResult.stderr}`, 4000, sensitiveValues),
        reason: truncated
          ? "output_truncated"
          : processResult.timedOut
            ? "timeout"
            : processResult.cancelled
              ? "cancelled"
              : processResult.signal ? `signal:${processResult.signal}` : null
      });
    }
  } finally {
    await isolated.cleanup();
  }
  return results;
}

function mergePaths(...collections) {
  return [...new Set(collections.flat())].sort();
}

function sanitizeChangedPathEvidence(changedPaths, security, additionalValues = []) {
  if (security.credentialEvidenceTrusted !== true) {
    return { paths: [], breach: "evidence:credential inventory changed" };
  }
  const values = [...new Set([...(security.sensitiveValues ?? []), ...additionalValues]
    .filter((value) => typeof value === "string" && value.length > 0))];
  const paths = changedPaths.filter((relative) => !containsExactSensitiveValue(relative, values));
  return {
    paths,
    breach: paths.length === changedPaths.length ? null : "evidence:credential value detected"
  };
}

async function inspectChangedFilesForSensitiveValues(repositoryRoot, changedPaths, security, additionalValues = []) {
  if (security.credentialEvidenceTrusted !== true) return "evidence:credential inventory changed";
  const values = [...new Set([...(security.sensitiveValues ?? []), ...additionalValues]
    .filter((value) => typeof value === "string" && value.length > 0))];
  if (values.length === 0) return null;
  const needles = values.map((value) => Buffer.from(value));
  let totalBytes = 0;
  for (const relative of changedPaths) {
    const absolute = path.join(repositoryRoot, ...relative.split("/"));
    let handle;
    try {
      handle = await open(absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
      const before = await handle.stat();
      if (!before.isFile()) continue;
      totalBytes += before.size;
      if (!Number.isSafeInteger(before.size) || before.size < 0 || totalBytes > MAX_SENSITIVE_EVIDENCE_BYTES) {
        return "evidence:credential scan exceeded";
      }
      const content = await handle.readFile();
      const after = await handle.stat();
      if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
        return "evidence:credential scan unstable";
      }
      if (needles.some((needle) => content.includes(needle))) return "evidence:credential value detected";
    } catch (error) {
      if (error?.code !== "ENOENT") return "evidence:credential scan unavailable";
    } finally {
      await handle?.close().catch(() => {});
    }
  }
  return null;
}

async function collectPostflight(repository, before, pathBaseline, gitControlsBefore, gitIndexBefore, maxBytes) {
  const [after, filesystemAfter, gitControlsAfter, gitIndexAfter] = await Promise.all([
    collectGitState(repository.gitRoot),
    snapshotFilesystem(repository.gitRoot, { exclude: [".git"], maxBytes }),
    snapshotGitControls(repository.gitRoot, { excludeIndexes: true }),
    snapshotGitIndex(repository.gitRoot)
  ]);
  let unsafeLinks = false;
  try { await assertRepositoryLinks(repository.gitRoot, filesystemAfter); }
  catch (error) { if (error?.code !== "repository_link_unsafe") throw error; unsafeLinks = true; }
  const committedPaths = await getCommittedDiffPaths(repository.gitRoot, before.head, after.head);
  return {
    after,
    unsafeLinks,
    committedPaths,
    filesystemPaths: changedFilesystemPaths(pathBaseline, filesystemAfter),
    gitControlsChanged: gitControlsBefore.fingerprint !== gitControlsAfter.fingerprint ||
      gitIndexBefore.fingerprint !== gitIndexAfter.fingerprint
  };
}

export async function runLocalDelegation(input, options = {}) {
  if (typeof options.execute !== "function") throw new TypeError("A local executor callback is required.");
  const envelope = validateTaskEnvelope(input);
  const maxBytes = filesystemEvidenceMaxBytes(envelope);
  const validationEnv = Object.freeze(Object.fromEntries(Object.entries(options.validationEnv ?? {})));
  const validationSensitiveValues = Object.values(validationEnv)
    .filter((value) => typeof value === "string" && value.length > 0);
  const repository = await resolveRepository(envelope.repository);
  const before = await collectGitState(repository.gitRoot);
  enforceDirtyTreePolicy(before, envelope.repository.dirtyTree);
  const [filesystemBefore, gitControlsBefore, gitIndexBefore] = await Promise.all([
    snapshotFilesystem(repository.gitRoot, { exclude: [".git"], maxBytes }),
    snapshotGitControls(repository.gitRoot, { excludeIndexes: true }),
    snapshotGitIndex(repository.gitRoot)
  ]);

  const pathBaseline = options.initialFilesystem
    ? assertFilesystemSnapshot(options.initialFilesystem)
    : filesystemBefore;

  try {
    await assertRepositoryLinks(repository.gitRoot, filesystemBefore);
    await options.assertExecutionBasis?.();
  } catch (error) {
    await options.onExecutionSettled?.();
    throw error;
  }
  const executor = await options.execute(envelope, {
    workingDirectory: repository.workingDirectory,
    repository,
    signal: options.signal
  });
  let executionSettled = true;
  try {
    const security = options.securityEvidence?.(executor) ?? {
      sensitiveValues: [],
      credentialEvidenceTrusted: true
    };
    const evidenceSensitiveValues = [...new Set([
      ...(security.sensitiveValues ?? []),
      ...validationSensitiveValues
    ])];
    const modelBindingCollision = executor.modelBinding &&
      containsExactSensitiveValue(executor.modelBinding.value, evidenceSensitiveValues);
    const modelObservationCollision = typeof executor.modelObservation?.value === "string" &&
      containsExactSensitiveValue(executor.modelObservation.value, evidenceSensitiveValues);

    let postflight = await collectPostflight(repository, before, pathBaseline, gitControlsBefore, gitIndexBefore, maxBytes);
    let after = postflight.after;
    let changedPaths = mergePaths(after.dirtyPaths, postflight.committedPaths, postflight.filesystemPaths);
    const baselinePathEvidence = sanitizeChangedPathEvidence(before.dirtyPaths, security, validationSensitiveValues);
    let pathEvidence = sanitizeChangedPathEvidence(changedPaths, security, validationSensitiveValues);
    changedPaths = pathEvidence.paths;
    let breaches = evaluatePathScope(changedPaths, envelope.scope);
    if (baselinePathEvidence.breach) breaches.push(baselinePathEvidence.breach);
    if (pathEvidence.breach) breaches.push(pathEvidence.breach);
    if (modelBindingCollision) breaches.push("evidence:model binding overlaps a protected value");
    const initialCredentialBreach = await inspectChangedFilesForSensitiveValues(
      repository.gitRoot, changedPaths, security, validationSensitiveValues
    );
    if (initialCredentialBreach) breaches.push(initialCredentialBreach);
    if (postflight.unsafeLinks) breaches.push("evidence:repository link escapes or cannot be verified");
    if (postflight.gitControlsChanged) breaches.push("git:metadata changed during delegated execution");
    if (before.head !== after.head) breaches.push("git:HEAD changed during delegated execution");
    if (before.branch !== after.branch) breaches.push("git:branch changed during delegated execution");
    breaches = [...new Set(breaches)].sort();

    let validations;
    if (breaches.length > 0) {
      validations = skippedValidations(envelope.validation, "scope_breach", evidenceSensitiveValues);
    } else if (executor.reportedStatus !== "completed") {
      validations = skippedValidations(envelope.validation, `executor_${executor.reportedStatus}`, evidenceSensitiveValues);
    } else {
      validations = await runValidations(envelope.validation, repository.workingDirectory, {
        ...options,
        validationEnv,
        filesystemEvidenceMaxBytes: maxBytes,
        repositoryRoot: repository.gitRoot,
        redactionValues: evidenceSensitiveValues,
        onValidationStarted() { executionSettled = false; },
        onValidationSettled() { executionSettled = true; }
      });
      executionSettled = true;
      postflight = await collectPostflight(repository, before, pathBaseline, gitControlsBefore, gitIndexBefore, maxBytes);
      after = postflight.after;
      changedPaths = mergePaths(after.dirtyPaths, postflight.committedPaths, postflight.filesystemPaths);
      pathEvidence = sanitizeChangedPathEvidence(changedPaths, security, validationSensitiveValues);
      changedPaths = pathEvidence.paths;
      breaches = evaluatePathScope(changedPaths, envelope.scope);
      if (baselinePathEvidence.breach) breaches.push(baselinePathEvidence.breach);
      if (pathEvidence.breach) breaches.push(pathEvidence.breach);
      const finalCredentialBreach = await inspectChangedFilesForSensitiveValues(
        repository.gitRoot, changedPaths, security, validationSensitiveValues
      );
      if (finalCredentialBreach) breaches.push(finalCredentialBreach);
      if (postflight.unsafeLinks) breaches.push("evidence:repository link escapes or cannot be verified");
      if (postflight.gitControlsChanged) breaches.push("git:metadata changed during delegated execution");
      if (before.head !== after.head) breaches.push("git:HEAD changed during delegated execution");
      if (before.branch !== after.branch) breaches.push("git:branch changed during delegated execution");
      breaches = [...new Set(breaches)].sort();
    }

    const validationFailed = validations.some((item) => item.status !== "passed");
    let status;
    if (breaches.length > 0) status = "rejected";
    else if (executor.reportedStatus === "blocked") status = "blocked";
    else if (executor.reportedStatus !== "completed" || validationFailed) status = "failed";
    else status = "completed";

    const safeText = (value) => conciseOutput(value, 4000, evidenceSensitiveValues);
    const residualRisks = executor.residualRisks.map(safeText);
    if (before.dirtyPaths.length > 0) residualRisks.push("Target repository began with explicitly acknowledged uncommitted changes.");
    if (breaches.length > 0) residualRisks.push("Scope breach requires host review and explicit recovery instructions.");
    if (validationFailed) residualRisks.push("One or more required validations did not pass or were not run.");

    return {
      schemaVersion: "1.0.0",
      taskId: envelope.taskId,
      filesystemEvidenceMaxBytes: maxBytes,
      status,
      summary: status === "completed"
        ? "Executor completed the bounded task; host acceptance is still pending."
        : status === "rejected"
          ? "Execution was rejected by independent postflight checks."
          : safeText(executor.summary),
      baseline: {
        gitRoot: repository.gitRoot,
        branch: before.branch,
        headBefore: before.head,
        headAfter: after.head,
        dirtyPathsBefore: baselinePathEvidence.paths
      },
      changedPaths,
      scope: { compliant: breaches.length === 0, breaches },
      validations,
      executor: {
        reportedStatus: executor.reportedStatus,
        exitCode: executor.exitCode,
        signal: executor.signal,
        summary: safeText(executor.summary),
        ...(executor.failureCode ? { failureCode: executor.failureCode } : {}),
        ...(executor.modelBinding && !modelBindingCollision ? { modelBinding: { ...executor.modelBinding, value: executor.modelBinding.value } } : {}),
        ...(executor.modelObservation ? { modelObservation: modelObservationCollision
          ? { state: "unavailable", value: null, source: "unavailable", assurance: "unknown", observedAt: executor.modelObservation.observedAt }
          : { ...executor.modelObservation, value: executor.modelObservation.value } } : {})
      },
      hostAcceptance: { status: "pending", eligible: status === "completed", decidedBy: null },
      residualRisks
    };
  } finally {
    // No process is pending here only after both executor and validation phases returned.
    if (executionSettled) await options.onExecutionSettled?.();
  }
}
