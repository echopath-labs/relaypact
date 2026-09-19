import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_FILESYSTEM_EVIDENCE_MAX_BYTES, filesystemEvidenceMaxBytes, validateTaskEnvelope } from "../../contracts/src/envelope.mjs";
import { assertGitIndexSnapshot, collectGitState, enforceDirtyTreePolicy, resolveRepository } from "../../core/src/git.mjs";
import { DelegationError } from "../../contracts/src/errors.mjs";
import { assertFilesystemSnapshot } from "../../core/src/filesystem-evidence.mjs";
import { cleanupCapsule, getPrivateControlChanges, prepareCapsule, verifyContextManifestIdentity, verifySourceUnchanged } from "../../executor-codex/src/capsule.mjs";
import { checkCodexCompatibility } from "../../executor-codex/src/compatibility.mjs";
import { requireProviderCredential, resolveWorkerProfile } from "../../executor-codex/src/profile.mjs";
import { checkRouterHealth } from "../../executor-codex/src/router.mjs";
import { loadReadinessEvidence, persistReadinessEvidence, runCapsuleReadiness } from "../../executor-codex/src/readiness.mjs";
import {
  assertCorrectionIdentity,
  authorizeCorrection,
  createTaskState,
  readTaskState,
  recordWorkerResult,
  transitionTaskState
} from "../../executor-codex/src/state.mjs";
import { runCodexWorker } from "../../executor-codex/src/worker.mjs";

const DEFAULT_WORKER_SCHEMA = fileURLToPath(new URL("../../contracts/schemas/codex-worker-result.schema.json", import.meta.url));

export async function prepareCodexDelegation(input, options = {}) {
  const envelope = validateTaskEnvelope(input.envelope);
  if (typeof input.hostInstanceId !== "string" || input.hostInstanceId.trim().length === 0) {
    throw new DelegationError("host_instance_required", "A distinct coordinating-host instance identity is required.");
  }
  if (typeof envelope.executionProfile !== "string") {
    throw new DelegationError("worker_profile_required", "Codex delegation requires a named worker profile.");
  }
  const profile = resolveWorkerProfile(input.profileRegistry, envelope.executionProfile);
  const environment = options.environment ?? process.env;
  const repository = await resolveRepository(envelope.repository);
  const sourceState = await collectGitState(repository.gitRoot);
  enforceDirtyTreePolicy(sourceState, envelope.repository.dirtyTree);
  const capsule = await prepareCapsule({
    envelope,
    repository,
    profile,
    stateRoot: input.stateRoot,
    workerResultSchemaPath: input.workerResultSchemaPath ?? DEFAULT_WORKER_SCHEMA
  });
  let lifecycle;
  let readiness;
  let readinessPath;
  let providerCredential;
  let compatibility;
  let router;
  try {
    readiness = await runCapsuleReadiness({ envelope, capsule }, {
      runProcess: options.readinessProcess,
      environment
    });
    const sourceAfterReadiness = await verifySourceUnchanged(repository, capsule);
    if (!sourceAfterReadiness.unchanged) {
      throw new DelegationError(
        "context_readiness_source_mutation",
        "Source workspace changed during context readiness.",
        { readiness, workerRequestCount: 0 }
      );
    }
    readinessPath = await persistReadinessEvidence(capsule, readiness);
    providerCredential = requireProviderCredential(profile, environment);
    compatibility = await checkCodexCompatibility(profile, {
      runProcess: options.compatibilityProcess,
      environment
    });
    router = await checkRouterHealth(profile, { fetch: options.fetch });
    lifecycle = await createTaskState({ capsule, profile, hostInstanceId: input.hostInstanceId });
  } catch (error) {
    await cleanupCapsule(capsule, repository);
    throw error;
  }
  return {
    envelope,
    profile,
    compatibility,
    router,
    providerCredential,
    repository,
    sourceState,
    capsule: { ...capsule, readinessPath },
    readiness,
    statePath: lifecycle.statePath
  };
}

export async function executeCodexDelegation(prepared, options = {}) {
  await transitionTaskState(prepared.statePath, "running");
  const execution = await runCodexWorker(prepared, options);
  try {
    const state = await recordWorkerResult(prepared.statePath, {
      threadId: execution.threadId,
      result: execution.workerResult,
      relaypactInput: execution.relaypactInput ?? null
    });
    return { ...execution, state };
  } catch (error) {
    const current = await readTaskState(prepared.statePath);
    const state = current.lifecycleState === "running"
      ? await transitionTaskState(prepared.statePath, "failed")
      : current;
    return { ...execution, state, lifecycleError: { code: error.code ?? "lifecycle_error", message: error.message } };
  }
}

export async function correctCodexDelegation(prepared, correction, options = {}) {
  if (typeof correction?.prompt !== "string" || correction.prompt.trim().length === 0) {
    throw new DelegationError("invalid_correction", "A non-empty correction prompt is required.");
  }
  await verifyContextManifestIdentity(prepared.capsule);
  const correctionIdentity = {
    taskId: correction.taskId,
    profileFingerprint: correction.profileFingerprint,
    capsuleBaseline: correction.capsuleBaseline,
    contextManifestFingerprint: correction.contextManifestFingerprint,
    priorResultIdentity: correction.priorResultIdentity
  };
  await assertCorrectionIdentity(prepared.statePath, correctionIdentity);
  const environment = options.environment ?? process.env;
  requireProviderCredential(prepared.profile, environment);
  await checkCodexCompatibility(prepared.profile, { runProcess: options.compatibilityProcess, environment });
  await checkRouterHealth(prepared.profile, { fetch: options.fetch });
  const authorized = await authorizeCorrection(prepared.statePath, correctionIdentity);
  await transitionTaskState(prepared.statePath, "running");
  const execution = await runCodexWorker({
    ...prepared,
    correction: {
      threadId: authorized.executorThreadId,
      sequence: authorized.correctionSequence,
      prompt: correction.prompt
    }
  }, options);
  const state = await recordWorkerResult(prepared.statePath, {
    threadId: execution.threadId,
    result: execution.workerResult,
    relaypactInput: execution.relaypactInput ?? null
  });
  return { ...execution, state };
}

export async function loadCodexDelegation(taskRootInput, profileRegistry) {
  const taskRoot = await realpath(taskRootInput);
  let marker;
  try {
    marker = JSON.parse(await readFile(path.join(taskRoot, "capsule.json"), "utf8"));
  } catch {
    throw new DelegationError("task_state_unavailable", "Task capsule marker is missing or malformed.");
  }
  const statePath = path.join(taskRoot, "state.json");
  const taskRootInfo = await lstat(taskRoot);
  if (
    !taskRootInfo.isDirectory() || taskRootInfo.isSymbolicLink() ||
    marker.taskRootIdentity?.dev !== taskRootInfo.dev || marker.taskRootIdentity?.ino !== taskRootInfo.ino
  ) {
    throw new DelegationError("task_state_mismatch", "Task root identity no longer matches its marker.");
  }
  const state = await readTaskState(statePath);
  const envelope = validateTaskEnvelope(JSON.parse(await readFile(path.join(taskRoot, "control", "task-envelope.json"), "utf8")));
  const privateControlBaselinePath = path.join(taskRoot, "control", "private-control-baseline.json");
  const privateControlBaseline = assertFilesystemSnapshot(JSON.parse(await readFile(privateControlBaselinePath, "utf8")));
  const sourceGitControlBaselinePath = path.join(taskRoot, "control", "source-git-control-baseline.json");
  const sourceGitControlBaseline = assertFilesystemSnapshot(JSON.parse(await readFile(sourceGitControlBaselinePath, "utf8")));
  if (privateControlBaseline.fingerprint !== state.privateControlFingerprint) {
    throw new DelegationError("task_state_mismatch", "Stored private control evidence no longer matches lifecycle state.");
  }
  if (marker.taskId !== state.taskId || state.taskId !== envelope.taskId) {
    throw new DelegationError("task_state_mismatch", "Task marker, lifecycle state, and envelope identities do not match.");
  }
  const profile = resolveWorkerProfile(profileRegistry, state.profileName);
  if (profile.fingerprint !== state.profileFingerprint) {
    throw new DelegationError("resume_identity_mismatch", "The current named profile does not match the stored profile fingerprint.");
  }
  const repository = await resolveRepository(envelope.repository);
  if (repository.gitRoot !== marker.sourceRoot) {
    throw new DelegationError("task_state_mismatch", "The stored source repository no longer matches the task marker.");
  }
  const capsuleRoot = await realpath(marker.capsuleRoot);
  const relativeCapsule = path.relative(taskRoot, capsuleRoot);
  if (relativeCapsule.startsWith("..") || path.isAbsolute(relativeCapsule)) {
    throw new DelegationError("task_state_mismatch", "The stored capsule is outside its task directory.");
  }
  const controlRoot = path.join(taskRoot, "control");
  const gitDir = await realpath(marker.gitDir);
  const expectedGitParent = marker.mode === "trusted-worktree" ? repository.gitRoot : controlRoot;
  const relativeGitDir = path.relative(expectedGitParent, gitDir);
  if (relativeGitDir.startsWith("..") || path.isAbsolute(relativeGitDir) || gitDir === capsuleRoot) {
    throw new DelegationError("task_state_mismatch", "The stored Git control directory is outside private task control.");
  }
  if (typeof marker.gitLinkSha256 !== "string" || !/^[a-f0-9]{64}$/.test(marker.gitLinkSha256)) {
    throw new DelegationError("task_state_mismatch", "The stored Git control identity is missing or malformed.");
  }
  const contextManifestFingerprint = marker.contextManifestFingerprint ?? null;
  if ((state.contextManifestFingerprint ?? null) !== contextManifestFingerprint) {
    throw new DelegationError("task_state_mismatch", "Task marker and lifecycle context identities do not match.");
  }
  if ((marker.filesystemEvidenceMaxBytes ?? DEFAULT_FILESYSTEM_EVIDENCE_MAX_BYTES) !== filesystemEvidenceMaxBytes(envelope)) {
    throw new DelegationError("task_state_mismatch", "Stored filesystem evidence budget does not match the task envelope.");
  }
  const capsule = {
    filesystemEvidenceMaxBytes: filesystemEvidenceMaxBytes(envelope),
    taskId: state.taskId,
    taskRoot,
    taskRootIdentity: marker.taskRootIdentity,
    markerPath: path.join(taskRoot, "capsule.json"),
    capsuleRoot,
    controlRoot,
    envelopePath: path.join(controlRoot, "task-envelope.json"),
    resultSchemaPath: path.join(controlRoot, "codex-worker-result.schema.json"),
    contextManifestPath: contextManifestFingerprint ? path.join(controlRoot, "context-manifest.json") : null,
    executorContextManifestPath: contextManifestFingerprint
      ? path.join(capsuleRoot, ".relaypact", "context-manifest.json")
      : null,
    contextManifestFingerprint,
    mode: marker.mode,
    baseline: state.capsuleBaseline,
    gitControl: { gitDir, workTree: capsuleRoot },
    gitLinkSha256: marker.gitLinkSha256,
    capsuleFilesystemBaselinePath: path.join(controlRoot, "capsule-filesystem-baseline.json"),
    sourceFilesystemBaselinePath: path.join(controlRoot, "source-filesystem-baseline.json"),
    sourceGitControlBaselinePath,
    capsuleGitIndexBaselinePath: path.join(controlRoot, "git-index-baseline.json"),
    sourceGitIndexBaselinePath: path.join(controlRoot, "source-git-index-baseline.json"),
    privateControlBaselinePath,
    sourceHead: marker.sourceHead,
    sourceStatus: marker.sourceStatus,
    sourceStateFingerprint: marker.sourceStateFingerprint,
    inputMetadata: Array.isArray(marker.inputMetadata) ? marker.inputMetadata : []
  };
  capsule.capsuleFilesystemBaseline = assertFilesystemSnapshot(JSON.parse(await readFile(capsule.capsuleFilesystemBaselinePath, "utf8")));
  capsule.sourceFilesystemBaseline = assertFilesystemSnapshot(JSON.parse(await readFile(capsule.sourceFilesystemBaselinePath, "utf8")));
  capsule.sourceGitControlBaseline = sourceGitControlBaseline;
  try {
    capsule.capsuleGitIndexBaseline = assertGitIndexSnapshot(JSON.parse(await readFile(capsule.capsuleGitIndexBaselinePath, "utf8")));
    capsule.sourceGitIndexBaseline = assertGitIndexSnapshot(JSON.parse(await readFile(capsule.sourceGitIndexBaselinePath, "utf8")));
  } catch {
    throw new DelegationError("task_state_mismatch", "Stored semantic Git index evidence is missing or malformed.");
  }
  capsule.privateControlBaseline = privateControlBaseline;
  if (
    capsule.capsuleFilesystemBaseline.fingerprint !== marker.capsuleFilesystemFingerprint ||
    capsule.sourceFilesystemBaseline.fingerprint !== marker.sourceFilesystemFingerprint ||
    capsule.sourceGitControlBaseline.fingerprint !== marker.sourceGitControlFingerprint ||
    capsule.capsuleGitIndexBaseline.fingerprint !== marker.capsuleGitIndexFingerprint ||
    capsule.sourceGitIndexBaseline.fingerprint !== marker.sourceGitIndexFingerprint
  ) {
    throw new DelegationError("task_state_mismatch", "Stored filesystem evidence no longer matches the task marker.");
  }
  if ((await getPrivateControlChanges(capsule)).length > 0) {
    throw new DelegationError("task_state_mismatch", "Stored immutable private controls changed after task preparation.");
  }
  await verifyContextManifestIdentity(capsule, contextManifestFingerprint);
  const contextManifest = contextManifestFingerprint
    ? JSON.parse(await readFile(capsule.contextManifestPath, "utf8"))
    : null;
  capsule.contextManifest = contextManifest;
  const readiness = await loadReadinessEvidence(capsule, { allowMissing: envelope.contextPlanning === undefined });
  capsule.readinessPath = path.join(controlRoot, "readiness-evidence.json");
  return { envelope, profile, repository, capsule, readiness, statePath };
}
