import { filesystemEvidenceMaxBytes } from "../../contracts/src/envelope.mjs";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { minimalEnvironment } from "../../core/src/environment.mjs";
import { DelegationError } from "../../contracts/src/errors.mjs";
import { changedFilesystemPaths, snapshotFilesystem } from "../../core/src/filesystem-evidence.mjs";
import { conciseOutput } from "../../core/src/redact.mjs";
import { runProcess } from "../../core/src/process.mjs";
import { IMMUTABLE_PRIVATE_CONTROL_PATHS, collectCandidateEvidence, verifySourceUnchanged } from "../../executor-codex/src/capsule.mjs";
import { resultIdentity } from "../../executor-codex/src/result.mjs";
import {
  bindTaskSensitiveGrant,
  opaqueTaskMetricId,
  readTaskState,
  taskSensitiveGrantMatches
} from "../../executor-codex/src/state.mjs";
import { taskSensitiveValues } from "../../executor-codex/src/worker.mjs";

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function reviewIdentityInput(packet, candidatePatch) {
  const { reviewIdentity: ignored, ...packetWithoutIdentity } = packet;
  void ignored;
  return {
    packet: packetWithoutIdentity,
    candidatePatchSha256: sha256(candidatePatch ?? "")
  };
}

export function verifyReviewIdentity(review) {
  const identity = review?.packet?.reviewIdentity;
  if (!identity || identity.schemaVersion !== "1.0.0") {
    throw new DelegationError("review_identity_mismatch", "Review identity is missing or malformed.");
  }
  const input = reviewIdentityInput(review.packet, review.candidatePatch);
  if (identity.candidatePatchSha256 !== input.candidatePatchSha256 || identity.fingerprint !== sha256(canonicalize(input))) {
    throw new DelegationError("review_identity_mismatch", "Review packet or candidate patch changed after host review.");
  }
  return identity;
}

export function bindReviewIdentity(packetInput, candidatePatch, state) {
  const { reviewIdentity: ignored, ...packet } = packetInput;
  void ignored;
  const identityInput = reviewIdentityInput(packet, candidatePatch);
  return {
    ...packet,
    reviewIdentity: {
      schemaVersion: "1.0.0",
      stateRevision: state.stateRevision,
      correctionSequence: state.correctionSequence,
      resultIdentity: state.resultIdentity,
      privateControlFingerprint: state.privateControlFingerprint,
      candidatePatchSha256: identityInput.candidatePatchSha256,
      fingerprint: sha256(canonicalize(identityInput))
    }
  };
}

function unavailable(value) {
  return Number.isFinite(value) && value >= 0 ? value : "unavailable";
}

function boundedInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : "unavailable";
}

function usageValue(usage, ...keys) {
  for (const key of keys) {
    if (Number.isFinite(usage?.[key])) return usage[key];
  }
  return undefined;
}

function boundedRatio(value, maximum) {
  return Number.isFinite(value) && Number.isFinite(maximum) && maximum > 0
    ? Math.min(1, Math.max(0, value / maximum))
    : "unavailable";
}

function contextPlanEvidence(capsule) {
  const manifest = capsule.contextManifest;
  if (!manifest) {
    return {
      mode: "explicit",
      strategy: null,
      fingerprint: null,
      selectedFileCount: capsule.inputMetadata?.length ?? 0,
      selectedBytes: (capsule.inputMetadata ?? []).reduce((sum, item) => sum + (item.bytes ?? 0), 0),
      unresolvedReferenceCount: 0,
      budgetUtilization: null
    };
  }
  return {
    mode: "planned",
    strategy: manifest.strategy,
    fingerprint: manifest.fingerprint,
    selectedFileCount: manifest.totals.selectedFiles,
    selectedBytes: manifest.totals.selectedBytes,
    unresolvedReferenceCount: manifest.totals.unresolvedReferences,
    budgetUtilization: {
      files: boundedRatio(manifest.totals.selectedFiles, manifest.budget.maxFiles),
      bytes: boundedRatio(manifest.totals.selectedBytes, manifest.budget.maxBytes),
      maxDepth: manifest.budget.maxDepth
    }
  };
}

function executorContextGap(workerResult) {
  if (workerResult.status !== "blocked" || workerResult.blocking?.code !== "context_gap") return null;
  return {
    code: "context_gap",
    message: conciseOutput(workerResult.blocking.message, 1000)
  };
}

function contextEvidenceFor(prepared, execution) {
  return {
    plan: contextPlanEvidence(prepared.capsule),
    readiness: prepared.readiness ?? {
      outcome: "not_configured",
      commandCount: 0,
      passedCount: 0,
      failedCount: 0,
      mutationDetected: false,
      commands: []
    },
    executorContextGap: executorContextGap(execution.workerResult)
  };
}

export function extractAggregateMetrics({ taskId, profile, execution, durationMs, contextEvidence = undefined }) {
  const usage = execution.usage;
  const relaypactInput = execution.relaypactInput;
  const plan = contextEvidence?.plan;
  const readiness = contextEvidence?.readiness;
  return {
    task: opaqueTaskMetricId(taskId),
    profile: profile.fingerprint.slice("sha256:".length, "sha256:".length + 16),
    requestCount: 1,
    eventCount: Number.isInteger(execution.eventCount) ? execution.eventCount : 0,
    durationMs: unavailable(durationMs),
    inputTokens: unavailable(usageValue(usage, "input_tokens", "inputTokens")),
    outputTokens: unavailable(usageValue(usage, "output_tokens", "outputTokens")),
    cachedInputTokens: unavailable(usageValue(usage, "cached_input_tokens", "cachedInputTokens")),
    reasoningTokens: unavailable(usageValue(usage, "reasoning_tokens", "reasoningTokens")),
    relaypactPromptBytes: boundedInteger(relaypactInput?.relaypactPromptBytes),
    relaypactResultSchemaBytes: boundedInteger(relaypactInput?.relaypactResultSchemaBytes),
    relaypactDeclaredInputBytes: boundedInteger(relaypactInput?.relaypactDeclaredInputBytes),
    cost: "unavailable",
    contextMode: plan?.mode === "planned" ? "planned" : "explicit",
    contextStrategy: plan?.strategy === "dependency-closure" ? "dependency-closure" : plan?.mode === "planned" ? "unavailable" : "explicit",
    selectedFileCount: unavailable(plan?.selectedFileCount),
    selectedBytes: unavailable(plan?.selectedBytes),
    unresolvedReferenceCount: unavailable(plan?.unresolvedReferenceCount),
    fileBudgetUtilization: unavailable(plan?.budgetUtilization?.files),
    byteBudgetUtilization: unavailable(plan?.budgetUtilization?.bytes),
    readinessOutcome: new Set(["not_configured", "passed", "failed"]).has(readiness?.outcome)
      ? readiness.outcome
      : "unavailable",
    contextBlockCategory: contextEvidence?.executorContextGap ? "executor_context_gap" : "none",
    newTaskRequired: Boolean(contextEvidence?.executorContextGap)
  };
}

export async function runHostValidations(envelope, capsule, options = {}) {
  const runner = options.runProcess ?? runProcess;
  const sensitiveValues = [...new Set([
    ...(options.redactionValues ?? []),
    ...Object.values(options.validationEnv ?? {})
  ].filter((value) => typeof value === "string" && value.length > 0))];
  const home = await mkdtemp(path.join(capsule.taskRoot, "validation-home-"));
  let temporary;
  try {
    temporary = await mkdtemp(path.join(capsule.taskRoot, "validation-tmp-"));
  } catch (error) {
    await rm(home, { recursive: true, force: true });
    throw error;
  }
  await chmod(home, 0o700);
  await chmod(temporary, 0o700);
  const env = minimalEnvironment(options.environment ?? process.env, {
    grants: options.validationEnv ?? {},
    home,
    temporary
  });
  const results = [];
  try {
    for (const command of envelope.validation) {
      const safeArgv = command.argv.map((argument) => conciseOutput(argument, 1000, sensitiveValues));
      const started = performance.now();
      let processResult;
      try {
        processResult = await runner(command.argv[0], command.argv.slice(1), {
          cwd: capsule.capsuleRoot,
          env,
          timeoutMs: command.timeoutMs ?? 120_000
        });
      } catch (error) {
        results.push({
          id: command.id,
          argv: safeArgv,
          status: "not_run",
          exitCode: null,
          durationMs: Math.round(performance.now() - started),
          summary: conciseOutput(error.message, 4000, sensitiveValues),
          reason: "spawn_error"
        });
        continue;
      }
      const truncated = processResult.stdoutTruncated || processResult.stderrTruncated;
      const passed = processResult.exitCode === 0 && !processResult.signal && !processResult.timedOut && !truncated;
      results.push({
        id: command.id,
        argv: safeArgv,
        status: passed ? "passed" : "failed",
        exitCode: processResult.exitCode,
        durationMs: Math.round(performance.now() - started),
        summary: conciseOutput(`${processResult.stdout}\n${processResult.stderr}`, 4000, sensitiveValues),
        reason: truncated ? "output_truncated" : processResult.timedOut ? "timeout" : processResult.signal ? `signal:${processResult.signal}` : null
      });
    }
    return results;
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(temporary, { recursive: true, force: true });
  }
}

function sanitizeValidationEvidence(results, sensitiveValues, suppressNarratives = false) {
  return results.map((item) => ({
    ...item,
    id: conciseOutput(item.id, 200, sensitiveValues),
    argv: suppressNarratives
      ? []
      : item.argv.map((argument) => conciseOutput(argument, 1000, sensitiveValues)),
    summary: suppressNarratives
      ? "Validation narrative was omitted because sensitive-grant evidence changed."
      : conciseOutput(item.summary, 4000, sensitiveValues),
    reason: item.reason === null ? null : conciseOutput(item.reason, 200, sensitiveValues)
  }));
}

export async function buildHostReviewPacket(prepared, execution, options = {}) {
  let contextEvidence = contextEvidenceFor(prepared, execution);
  const validationEnv = Object.freeze(Object.fromEntries(Object.entries(options.validationEnv ?? {})));
  const validationSensitiveValues = Object.values(validationEnv)
    .filter((value) => typeof value === "string" && value.length > 0);
  let workerSensitiveValues = [];
  let credentialEvidenceTrusted = true;
  try {
    workerSensitiveValues = await taskSensitiveValues(
      prepared.capsule,
      prepared.profile,
      options.environment ?? process.env
    );
    const workerGrantMatches = await taskSensitiveGrantMatches(
      prepared.statePath,
      "worker",
      workerSensitiveValues
    );
    const validationGrant = await bindTaskSensitiveGrant(
      prepared.statePath,
      "validation",
      validationSensitiveValues
    );
    credentialEvidenceTrusted = workerGrantMatches && validationGrant.consistent;
  } catch {
    credentialEvidenceTrusted = false;
  }
  const sensitiveValues = [...new Set([...workerSensitiveValues, ...validationSensitiveValues])];
  const candidateOptions = { sensitiveValues, credentialEvidenceTrusted };
  let [state, evidence, source] = await Promise.all([
    readTaskState(prepared.statePath),
    collectCandidateEvidence(prepared.capsule, prepared.envelope.scope, candidateOptions),
    verifySourceUnchanged(prepared.repository, prepared.capsule)
  ]);
  const relaypactInput = state.relaypactInput ?? execution.relaypactInput ?? null;
  execution = { ...execution, relaypactInput };
  contextEvidence = contextEvidenceFor(prepared, execution);
  const canValidate = execution.workerResult.status === "completed" &&
    evidence.baselineConsistent && evidence.scopeBreaches.length === 0 && source.unchanged;
  const privateControlBefore = canValidate
    ? await snapshotFilesystem(prepared.capsule.taskRoot, { selectedPaths: IMMUTABLE_PRIVATE_CONTROL_PATHS })
    : null;
  let validations = canValidate
    ? await runHostValidations(prepared.envelope, prepared.capsule, {
      ...options,
      validationEnv,
      redactionValues: sensitiveValues
    })
    : prepared.envelope.validation.map((command) => ({
      id: conciseOutput(command.id, 200, sensitiveValues),
      argv: command.argv.map((argument) => conciseOutput(
        argument,
        1000,
        sensitiveValues
      )),
      status: "not_run",
      exitCode: null,
      durationMs: 0,
      summary: "Validation was skipped because required postflight evidence was not eligible.",
      reason: "postflight_ineligible"
    }));
  if (canValidate) {
    let finalSensitiveValues = sensitiveValues;
    let finalCredentialEvidenceTrusted = credentialEvidenceTrusted;
    try {
      const currentWorkerSensitiveValues = await taskSensitiveValues(
        prepared.capsule,
        prepared.profile,
        options.environment ?? process.env
      );
      const [workerGrantMatches, validationGrantMatches] = await Promise.all([
        taskSensitiveGrantMatches(prepared.statePath, "worker", currentWorkerSensitiveValues),
        taskSensitiveGrantMatches(prepared.statePath, "validation", validationSensitiveValues)
      ]);
      finalSensitiveValues = [...new Set([
        ...sensitiveValues,
        ...currentWorkerSensitiveValues,
        ...validationSensitiveValues
      ])];
      finalCredentialEvidenceTrusted = finalCredentialEvidenceTrusted && workerGrantMatches && validationGrantMatches;
    } catch {
      finalCredentialEvidenceTrusted = false;
    }
    validations = sanitizeValidationEvidence(
      validations,
      finalSensitiveValues,
      !finalCredentialEvidenceTrusted
    );
    [state, evidence, source] = await Promise.all([
      readTaskState(prepared.statePath),
      collectCandidateEvidence(prepared.capsule, prepared.envelope.scope, {
        sensitiveValues: finalSensitiveValues,
        credentialEvidenceTrusted: finalCredentialEvidenceTrusted
      }),
      verifySourceUnchanged(prepared.repository, prepared.capsule)
    ]);
  }
  const validationControlChanged = privateControlBefore
    ? changedFilesystemPaths(
      privateControlBefore,
      await snapshotFilesystem(prepared.capsule.taskRoot, { selectedPaths: IMMUTABLE_PRIVATE_CONTROL_PATHS })
    ).length > 0
    : false;
  const privateControlChanged = evidence.privateControlChanged || validationControlChanged;
  const validationPassed = validations.every((item) => item.status === "passed");
  const unresolvedRisks = [...execution.workerResult.residualRisks];
  const workerResultMatchesState = state.resultIdentity === resultIdentity(execution.workerResult);
  const lifecycleReady = state.lifecycleState === "awaiting_review" && !execution.lifecycleError;
  if (!evidence.baselineConsistent) unresolvedRisks.push("The task capsule HEAD changed from its host-recorded baseline.");
  if (!source.unchanged) unresolvedRisks.push("The source workspace changed during delegated execution.");
  if (evidence.scopeBreaches.length > 0) unresolvedRisks.push("One or more host-observed scope breaches require recovery review.");
  if (!validationPassed) unresolvedRisks.push("One or more host-controlled validations failed or did not run.");
  if (privateControlChanged) unresolvedRisks.push("Private task controls changed during host validation.");
  if (!evidence.credentialEvidenceSafe) unresolvedRisks.push("Candidate evidence contained or could not exclude an exact granted credential value.");
  if (!workerResultMatchesState) unresolvedRisks.push("Executor result identity does not match current lifecycle state.");
  if (!lifecycleReady) unresolvedRisks.push("Task lifecycle is not ready for host review acceptance.");
  const evidenceAvailable = evidence.credentialEvidenceSafe && typeof evidence.candidatePatch === "string" && source.unchanged;
  const eligible = execution.workerResult.status === "completed" && evidenceAvailable &&
    evidence.baselineConsistent && evidence.scopeBreaches.length === 0 && validationPassed && !privateControlChanged &&
    workerResultMatchesState && lifecycleReady;
  const packetWithoutIdentity = {
    schemaVersion: "1.0.0",
    taskId: prepared.envelope.taskId,
    lifecycleState: state.lifecycleState,
    profile: {
      name: prepared.profile.name,
      fingerprint: prepared.profile.fingerprint,
      effectiveModel: prepared.profile.model ?? null
    },
    contextEvidence,
    executorSelfReport: execution.workerResult,
    hostObserved: {
      filesystemEvidenceMaxBytes: filesystemEvidenceMaxBytes(prepared.envelope),
      baseline: prepared.capsule.baseline,
      changedPaths: evidence.changedPaths,
      scopeBreaches: evidence.scopeBreaches,
      candidatePatchSha256: evidence.candidatePatchSha256,
      evidenceAvailable,
      privateControlChanged,
      credentialEvidenceSafe: evidence.credentialEvidenceSafe
    },
    validations,
    unresolvedRisks: [...new Set(unresolvedRisks)],
    metrics: extractAggregateMetrics({
      taskId: prepared.envelope.taskId,
      profile: prepared.profile,
      execution,
      durationMs: options.durationMs,
      contextEvidence
    }),
    acceptance: { status: "pending", eligible, decidedBy: null }
  };
  const packet = bindReviewIdentity(packetWithoutIdentity, evidence.candidatePatch, state);
  return { packet, candidatePatch: evidence.candidatePatch, sourceUnchanged: source.unchanged };
}

export async function persistPendingReview(prepared, review) {
  const state = await readTaskState(prepared.statePath);
  const evidenceRoot = path.join(prepared.capsule.taskRoot, "evidence");
  try {
    await mkdir(evidenceRoot, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const [taskRoot, evidenceInfo, resolvedEvidenceRoot] = await Promise.all([
    realpath(prepared.capsule.taskRoot),
    lstat(evidenceRoot).catch(() => null),
    realpath(evidenceRoot).catch(() => null)
  ]);
  const relativeEvidence = resolvedEvidenceRoot ? path.relative(taskRoot, resolvedEvidenceRoot) : "..";
  if (
    !evidenceInfo?.isDirectory() || evidenceInfo.isSymbolicLink() ||
    !resolvedEvidenceRoot || relativeEvidence === "" ||
    relativeEvidence.startsWith("..") || path.isAbsolute(relativeEvidence)
  ) {
    throw new DelegationError("evidence_path_invalid", "Pending review evidence root must be a real directory inside the task root.");
  }
  const suffix = String(state.correctionSequence);
  const packetPath = path.join(evidenceRoot, `host-review-packet-${suffix}.json`);
  const patchPath = path.join(evidenceRoot, `candidate-${suffix}.patch`);
  if (path.dirname(packetPath) !== evidenceRoot || path.dirname(patchPath) !== evidenceRoot) {
    throw new Error("Review evidence path escaped its private task directory.");
  }
  await writeFile(packetPath, `${JSON.stringify(review.packet, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await writeFile(patchPath, review.candidatePatch ?? "", { flag: "wx", mode: 0o600 });
  await chmod(packetPath, 0o600);
  await chmod(patchPath, 0o600);
  const [rootAfter, resolvedAfter, packetAfter, patchAfter, packetContent, patchContent] = await Promise.all([
    lstat(evidenceRoot),
    realpath(evidenceRoot),
    lstat(packetPath),
    lstat(patchPath),
    readFile(packetPath, "utf8"),
    readFile(patchPath, "utf8")
  ]);
  if (
    rootAfter.dev !== evidenceInfo.dev || rootAfter.ino !== evidenceInfo.ino || resolvedAfter !== resolvedEvidenceRoot ||
    !packetAfter.isFile() || packetAfter.isSymbolicLink() ||
    !patchAfter.isFile() || patchAfter.isSymbolicLink() ||
    packetContent !== `${JSON.stringify(review.packet, null, 2)}\n` || patchContent !== (review.candidatePatch ?? "")
  ) {
    throw new DelegationError("evidence_path_invalid", "Pending review evidence changed while it was persisted.");
  }
  return { packetPath, patchPath };
}
