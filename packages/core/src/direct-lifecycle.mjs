import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { validateTaskEnvelope } from "../../contracts/src/envelope.mjs";
import { DelegationError } from "../../contracts/src/errors.mjs";
import { evaluatePathScope } from "../../contracts/src/path-policy.mjs";
import {
  assertFilesystemSnapshot,
  changedFilesystemPaths,
  snapshotFilesystem,
  snapshotGitControls
} from "./filesystem-evidence.mjs";
import {
  collectGitState,
  enforceDirtyTreePolicy,
  resolveRepository,
  snapshotGitIndex
} from "./git.mjs";
import { canonicalize, createSignedStateStore } from "./signed-state.mjs";

const STATES = new Set([
  "prepared", "running", "awaiting_review", "correction_requested",
  "accepted", "rejected", "abandoned", "failed"
]);
const TERMINAL = new Set(["accepted", "rejected", "abandoned", "failed"]);
const STATE_KEYS = new Set([
  "schemaVersion", "taskId", "routeId", "executorHarness", "lifecycleState",
  "hostInstanceId", "taskRootDev", "taskRootIno", "repositoryRoot", "workingDirectory",
  "branch", "head", "envelopeFingerprint", "initialFilesystemFingerprint",
  "initialGitControlFingerprint", "initialGitIndexFingerprint", "resultIdentity",
  "sessionDigest", "sessionHandle", "reviewFingerprint", "reviewFilesystemFingerprint",
  "reviewGitControlFingerprint", "reviewGitIndexFingerprint", "correctionSequence",
  "stateRevision", "integrity"
]);
const REVIEW_KEYS = new Set([
  "schemaVersion", "taskId", "routeId", "executorHarness", "lifecycleState",
  "correctionSequence", "executionResult", "reviewIdentity"
]);
const MAX_CORRECTIONS = 1_000_000;

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function nonempty(value) {
  return typeof value === "string" && value.trim().length > 0 && !value.includes("\0");
}

function protectedHandle(value) {
  return nonempty(value) && Buffer.byteLength(value) <= 4096;
}

function nullableFingerprint(value) {
  return value === null || (typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value));
}

function nullableEvidenceFingerprint(value) {
  return value === null || (typeof value === "string" && /^[a-f0-9]{64}$/u.test(value));
}

function validateState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new DelegationError("task_state_unavailable", "Direct delegation lifecycle state is missing or malformed.");
  }
  const unknown = Object.keys(state).filter((key) => !STATE_KEYS.has(key));
  const required = [
    "taskId", "routeId", "executorHarness", "hostInstanceId", "repositoryRoot",
    "workingDirectory", "branch", "head", "envelopeFingerprint", "initialFilesystemFingerprint",
    "initialGitControlFingerprint", "initialGitIndexFingerprint"
  ];
  if (
    unknown.length > 0 || state.schemaVersion !== "1.0.0" || !STATES.has(state.lifecycleState) ||
    required.some((key) => !nonempty(state[key])) ||
    !Number.isSafeInteger(state.taskRootDev) || !Number.isSafeInteger(state.taskRootIno) ||
    state.taskRootDev < 0 || state.taskRootIno < 0 ||
    !Number.isSafeInteger(state.correctionSequence) || state.correctionSequence < 0 || state.correctionSequence > MAX_CORRECTIONS ||
    !Number.isSafeInteger(state.stateRevision) || state.stateRevision < 0 ||
    !nullableFingerprint(state.resultIdentity) || !nullableFingerprint(state.sessionDigest) ||
    !nullableFingerprint(state.reviewFingerprint) || !nullableEvidenceFingerprint(state.reviewFilesystemFingerprint) ||
    !nullableEvidenceFingerprint(state.reviewGitControlFingerprint) || !nullableEvidenceFingerprint(state.reviewGitIndexFingerprint) ||
    (state.sessionHandle !== null && !protectedHandle(state.sessionHandle)) ||
    typeof state.integrity !== "string" || !/^hmac-sha256:[a-f0-9]{64}$/u.test(state.integrity)
  ) {
    throw new DelegationError("task_state_unavailable", "Direct delegation lifecycle state failed schema validation.");
  }
  return state;
}

function store(statePath) {
  return createSignedStateStore(statePath, validateState);
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function requireRealDirectory(input, code, message) {
  if (!path.isAbsolute(input)) throw new DelegationError(code, message);
  let info;
  let resolved;
  try {
    [info, resolved] = await Promise.all([lstat(input), realpath(input)]);
  } catch {
    throw new DelegationError(code, message);
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new DelegationError(code, message);
  }
  return resolved;
}

async function writeJson(file, value) {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(file, content, { flag: "wx", mode: 0o600 });
  await chmod(file, 0o600);
  const [info, observed] = await Promise.all([lstat(file), readFile(file, "utf8")]);
  if (!info.isFile() || info.isSymbolicLink() || observed !== content) {
    throw new DelegationError("task_state_unavailable", "Private lifecycle control changed while it was persisted.");
  }
}

async function readJson(file) {
  let info;
  let value;
  try {
    info = await lstat(file);
    value = JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw new DelegationError("task_state_unavailable", "Private lifecycle control is missing or malformed.");
  }
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600) {
    throw new DelegationError("task_state_unavailable", "Private lifecycle control has an unsafe type or mode.");
  }
  return value;
}

async function writeReviewJson(file, value) {
  try {
    await writeJson(file, value);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = await readJson(file);
    if (canonicalize(existing) !== canonicalize(value)) {
      throw new DelegationError("review_identity_mismatch", "Existing direct-worktree review evidence does not match the current result.");
    }
  }
}

function reviewPath(taskRoot, sequence) {
  return path.join(taskRoot, "evidence", `review-${sequence}.json`);
}

function reviewIdentityInput(review) {
  const { reviewIdentity: ignored, ...unsigned } = review;
  void ignored;
  return unsigned;
}

function bindReview(state, executionResult) {
  const unsigned = {
    schemaVersion: "1.0.0",
    taskId: state.taskId,
    routeId: state.routeId,
    executorHarness: state.executorHarness,
    lifecycleState: state.lifecycleState,
    correctionSequence: state.correctionSequence,
    executionResult
  };
  return {
    ...unsigned,
    reviewIdentity: {
      schemaVersion: "1.0.0",
      stateRevision: state.stateRevision,
      resultIdentity: state.resultIdentity,
      fingerprint: sha256(canonicalize(unsigned))
    }
  };
}

function validateReview(review, state) {
  if (!review || typeof review !== "object" || Array.isArray(review) || Object.keys(review).some((key) => !REVIEW_KEYS.has(key))) {
    throw new DelegationError("review_identity_mismatch", "Persistent direct-worktree review is missing or malformed.");
  }
  const identity = review.reviewIdentity;
  const expected = sha256(canonicalize(reviewIdentityInput(review)));
  if (
    review.schemaVersion !== "1.0.0" || review.taskId !== state.taskId || review.routeId !== state.routeId ||
    review.executorHarness !== state.executorHarness || review.lifecycleState !== "awaiting_review" ||
    review.correctionSequence !== state.correctionSequence || !identity || identity.schemaVersion !== "1.0.0" ||
    identity.stateRevision !== state.stateRevision || identity.resultIdentity !== state.resultIdentity ||
    identity.fingerprint !== expected || state.reviewFingerprint !== expected
  ) {
    throw new DelegationError("review_identity_mismatch", "Persistent direct-worktree review does not match current lifecycle state.");
  }
  return review;
}

async function currentEvidence(repositoryRoot) {
  const [git, filesystem, gitControl, gitIndex] = await Promise.all([
    collectGitState(repositoryRoot),
    snapshotFilesystem(repositoryRoot, { exclude: [".git"] }),
    snapshotGitControls(repositoryRoot, { excludeIndexes: true }),
    snapshotGitIndex(repositoryRoot)
  ]);
  return { git, filesystem, gitControl, gitIndex };
}

async function assertReviewBasis(state) {
  const evidence = await currentEvidence(state.repositoryRoot);
  const mismatches = [];
  if (evidence.git.head !== state.head) mismatches.push("HEAD");
  if (evidence.git.branch !== state.branch) mismatches.push("branch");
  if (evidence.filesystem.fingerprint !== state.reviewFilesystemFingerprint) mismatches.push("filesystem");
  if (evidence.gitControl.fingerprint !== state.reviewGitControlFingerprint) mismatches.push("git-control");
  if (evidence.gitIndex.fingerprint !== state.reviewGitIndexFingerprint) mismatches.push("git-index");
  if (mismatches.length > 0) {
    throw new DelegationError("stale_review", `Candidate evidence changed after review: ${mismatches.join(", ")}.`);
  }
  return evidence;
}

async function transition(statePath, expected, next, updates = {}) {
  return store(statePath).withLock(async ({ read, persist }) => {
    const state = await read();
    if (state.lifecycleState !== expected) {
      throw new DelegationError("invalid_lifecycle_transition", `Cannot transition direct delegation from ${state.lifecycleState} to ${next}.`);
    }
    return persist({
      ...state,
      ...updates,
      lifecycleState: next,
      stateRevision: state.stateRevision + 1
    }, { expectedRevision: state.stateRevision });
  });
}

export async function prepareDirectDelegation({ envelope: input, stateRoot, hostInstanceId, routeId, executorHarness }) {
  const envelope = validateTaskEnvelope(input);
  if (!nonempty(hostInstanceId) || !nonempty(routeId) || !nonempty(executorHarness)) {
    throw new DelegationError("host_instance_required", "Host instance, route, and executor harness identities are required.");
  }
  const [resolvedStateRoot, repository] = await Promise.all([
    requireRealDirectory(stateRoot, "invalid_state_root", "Direct lifecycle state root must be an absolute pre-existing real directory."),
    resolveRepository(envelope.repository)
  ]);
  const baseline = await currentEvidence(repository.gitRoot);
  if (!nonempty(baseline.git.head)) {
    throw new DelegationError("repository_head_unavailable", "Persistent direct-worktree lifecycle requires an existing Git HEAD.");
  }
  enforceDirtyTreePolicy(baseline.git, envelope.repository.dirtyTree);
  const taskRoot = path.join(resolvedStateRoot, `task-${randomUUID()}`);
  await mkdir(taskRoot, { mode: 0o700 });
  const [taskInfo, resolvedTaskRoot] = await Promise.all([lstat(taskRoot), realpath(taskRoot)]);
  if (!taskInfo.isDirectory() || taskInfo.isSymbolicLink() || isInside(repository.gitRoot, resolvedTaskRoot)) {
    await rm(taskRoot, { recursive: true, force: true });
    throw new DelegationError("invalid_state_root", "Direct lifecycle task state must remain outside the delegated repository.");
  }
  const evidenceRoot = path.join(taskRoot, "evidence");
  await mkdir(evidenceRoot, { mode: 0o700 });
  await Promise.all([
    writeJson(path.join(taskRoot, "task-envelope.json"), envelope),
    writeJson(path.join(taskRoot, "initial-filesystem.json"), baseline.filesystem)
  ]);
  const statePath = path.join(taskRoot, "state.json");
  const state = await store(statePath).create({
    schemaVersion: "1.0.0",
    taskId: envelope.taskId,
    routeId,
    executorHarness,
    lifecycleState: "prepared",
    hostInstanceId,
    taskRootDev: taskInfo.dev,
    taskRootIno: taskInfo.ino,
    repositoryRoot: repository.gitRoot,
    workingDirectory: repository.workingDirectory,
    branch: baseline.git.branch,
    head: baseline.git.head,
    envelopeFingerprint: sha256(canonicalize(envelope)),
    initialFilesystemFingerprint: baseline.filesystem.fingerprint,
    initialGitControlFingerprint: baseline.gitControl.fingerprint,
    initialGitIndexFingerprint: baseline.gitIndex.fingerprint,
    resultIdentity: null,
    sessionDigest: null,
    sessionHandle: null,
    reviewFingerprint: null,
    reviewFilesystemFingerprint: null,
    reviewGitControlFingerprint: null,
    reviewGitIndexFingerprint: null,
    correctionSequence: 0,
    stateRevision: 0,
    integrity: "hmac-sha256:0000000000000000000000000000000000000000000000000000000000000000"
  });
  return { taskRoot, statePath, envelope, initialFilesystem: baseline.filesystem, repository, state };
}

export async function beginDirectDelegation(prepared) {
  const state = await transition(prepared.statePath, "prepared", "running");
  return { ...prepared, state };
}

export async function recordDirectDelegationResult(prepared, executionResult, session = {}) {
  if (executionResult?.taskId !== prepared.envelope.taskId || executionResult?.hostAcceptance?.status !== "pending") {
    throw new DelegationError("review_identity_mismatch", "Execution result is not attributable to the prepared direct delegation.");
  }
  if (
    Boolean(session.handle) !== Boolean(session.digest) ||
    (session.handle && (!protectedHandle(session.handle) || sha256(session.handle) !== session.digest))
  ) {
    throw new DelegationError("executor_session_mismatch", "Protected executor session handle and digest are inconsistent.");
  }
  const basis = await currentEvidence(prepared.repository.gitRoot);
  const cumulativePaths = [...new Set([
    ...basis.git.dirtyPaths,
    ...changedFilesystemPaths(prepared.initialFilesystem, basis.filesystem)
  ])].sort();
  const cumulativeBreaches = evaluatePathScope(cumulativePaths, prepared.envelope.scope);
  const lifecycleState = await store(prepared.statePath).read();
  if (basis.git.head !== lifecycleState.head) cumulativeBreaches.push("git:HEAD changed during delegated execution");
  if (basis.git.branch !== lifecycleState.branch) cumulativeBreaches.push("git:branch changed during delegated execution");
  if (
    basis.gitControl.fingerprint !== lifecycleState.initialGitControlFingerprint ||
    basis.gitIndex.fingerprint !== lifecycleState.initialGitIndexFingerprint
  ) cumulativeBreaches.push("git:metadata changed during delegated execution");
  const breaches = [...new Set([...(executionResult.scope?.breaches ?? []), ...cumulativeBreaches])].sort();
  const rejected = breaches.length > 0;
  const normalizedResult = {
    ...executionResult,
    status: rejected ? "rejected" : executionResult.status,
    summary: rejected ? "Execution was rejected by independent persistent postflight checks." : executionResult.summary,
    changedPaths: cumulativePaths,
    scope: { compliant: !rejected, breaches },
    hostAcceptance: {
      status: "pending",
      eligible: !rejected && executionResult.status === "completed" && executionResult.hostAcceptance.eligible === true,
      decidedBy: null
    },
    residualRisks: rejected
      ? [...new Set([...(executionResult.residualRisks ?? []), "Persistent lifecycle evidence found a scope or Git-control breach."])]
      : executionResult.residualRisks
  };
  const resultIdentity = sha256(canonicalize(normalizedResult));
  const evidencePath = reviewPath(prepared.taskRoot, lifecycleState.correctionSequence);
  const { state, review } = await store(prepared.statePath).withLock(async ({ read, persist }) => {
    const current = await read();
    if (current.lifecycleState !== "running") {
      throw new DelegationError("invalid_lifecycle_transition", `Cannot record a result while direct delegation is ${current.lifecycleState}.`);
    }
    const unsignedState = {
      ...current,
      lifecycleState: "awaiting_review",
      resultIdentity,
      sessionDigest: session.digest ?? null,
      sessionHandle: session.handle ?? null,
      reviewFilesystemFingerprint: basis.filesystem.fingerprint,
      reviewGitControlFingerprint: basis.gitControl.fingerprint,
      reviewGitIndexFingerprint: basis.gitIndex.fingerprint,
      stateRevision: current.stateRevision + 1
    };
    const candidateReview = bindReview(unsignedState, normalizedResult);
    await writeReviewJson(evidencePath, candidateReview);
    const persisted = await persist({
      ...unsignedState,
      reviewFingerprint: candidateReview.reviewIdentity.fingerprint
    }, { expectedRevision: current.stateRevision });
    return { state: persisted, review: bindReview(persisted, normalizedResult) };
  });
  return { state, review, evidence: { reviewPath: evidencePath } };
}

export async function failDirectDelegation(prepared) {
  return store(prepared.statePath).withLock(async ({ read, persist }) => {
    const state = await read();
    if (!new Set(["running", "correction_requested"]).has(state.lifecycleState)) return state;
    return persist({
      ...state,
      lifecycleState: "failed",
      stateRevision: state.stateRevision + 1
    }, { expectedRevision: state.stateRevision });
  });
}

export async function loadDirectDelegation(taskRootInput, { routeId, executorHarness } = {}) {
  const taskRoot = await requireRealDirectory(taskRootInput, "task_state_unavailable", "Direct lifecycle task root must be an absolute real directory.");
  const taskInfo = await lstat(taskRoot);
  const statePath = path.join(taskRoot, "state.json");
  const state = await store(statePath).read();
  if (
    state.taskRootDev !== taskInfo.dev || state.taskRootIno !== taskInfo.ino ||
    (routeId && state.routeId !== routeId) || (executorHarness && state.executorHarness !== executorHarness)
  ) {
    throw new DelegationError("task_state_mismatch", "Direct lifecycle task identity does not match the selected route.");
  }
  const envelope = validateTaskEnvelope(await readJson(path.join(taskRoot, "task-envelope.json")));
  const initialFilesystem = assertFilesystemSnapshot(await readJson(path.join(taskRoot, "initial-filesystem.json")));
  if (
    envelope.taskId !== state.taskId || sha256(canonicalize(envelope)) !== state.envelopeFingerprint ||
    initialFilesystem.fingerprint !== state.initialFilesystemFingerprint
  ) {
    throw new DelegationError("task_state_mismatch", "Direct lifecycle controls no longer match signed state.");
  }
  const repository = await resolveRepository(envelope.repository);
  if (repository.gitRoot !== state.repositoryRoot || repository.workingDirectory !== state.workingDirectory) {
    throw new DelegationError("task_state_mismatch", "Direct lifecycle repository identity changed.");
  }
  return { taskRoot, statePath, state, envelope, initialFilesystem, repository };
}

export async function authorizeDirectCorrection(prepared, prompt) {
  if (!nonempty(prompt) || Buffer.byteLength(prompt) > 64 * 1024) {
    throw new DelegationError("invalid_correction", "A bounded non-empty correction prompt is required.");
  }
  const review = validateReview(
    await readJson(reviewPath(prepared.taskRoot, prepared.state.correctionSequence)),
    prepared.state
  );
  const evidence = await assertReviewBasis(prepared.state);
  if (!prepared.state.sessionHandle || !prepared.state.sessionDigest) {
    throw new DelegationError("cursor_session_unavailable", "The selected executor did not yield a protected resumable session.");
  }
  const changedPaths = [...new Set([
    ...evidence.git.dirtyPaths,
    ...changedFilesystemPaths(prepared.initialFilesystem, evidence.filesystem)
  ])].sort();
  const breaches = evaluatePathScope(changedPaths, prepared.envelope.scope);
  if (breaches.length > 0) {
    throw new DelegationError("scope_breach", "Correction cannot resume while the current candidate exceeds its original scope.", { paths: breaches });
  }
  if (prepared.state.correctionSequence >= MAX_CORRECTIONS) {
    throw new DelegationError("correction_sequence_exhausted", "Correction sequence limit has been reached.");
  }
  const state = await store(prepared.statePath).withLock(async ({ read, persist }) => {
    const current = await read();
    if (
      current.lifecycleState !== "awaiting_review" ||
      current.stateRevision !== prepared.state.stateRevision ||
      current.reviewFingerprint !== prepared.state.reviewFingerprint
    ) {
      throw new DelegationError("invalid_lifecycle_transition", `Cannot authorize correction while direct delegation is ${current.lifecycleState}.`);
    }
    return persist({
      ...current,
      lifecycleState: "running",
      correctionSequence: current.correctionSequence + 1,
      reviewFingerprint: null,
      reviewFilesystemFingerprint: null,
      reviewGitControlFingerprint: null,
      reviewGitIndexFingerprint: null,
      stateRevision: current.stateRevision + 1
    }, { expectedRevision: current.stateRevision });
  });
  return {
    ...prepared,
    state,
    priorReview: review,
    correctionPrompt: prompt,
    resumeSessionId: state.sessionHandle,
    envelope: {
      ...prepared.envelope,
      repository: {
        ...prepared.envelope.repository,
        dirtyTree: { allow: true, acknowledgedPaths: evidence.git.dirtyPaths }
      }
    }
  };
}

export async function recordDirectTerminalDecision(prepared, action, actor) {
  const decisions = {
    accept: { lifecycleState: "accepted", acceptance: "accepted" },
    reject: { lifecycleState: "rejected", acceptance: "rejected" },
    abandon: { lifecycleState: "abandoned", acceptance: "abandoned" }
  };
  const decision = decisions[action];
  if (!decision) throw new DelegationError("invalid_host_action", "Host action must be accept, reject, or abandon.");
  if (!nonempty(actor)) throw new DelegationError("host_actor_required", "A host or human decision-maker identity is required.");
  const state = await store(prepared.statePath).read();
  const review = validateReview(await readJson(reviewPath(prepared.taskRoot, state.correctionSequence)), state);
  await assertReviewBasis(state);
  if (action === "accept" && review.executionResult.hostAcceptance.eligible !== true) {
    throw new DelegationError("acceptance_ineligible", "Host acceptance is refused because current evidence is not eligible.");
  }
  const terminal = await transition(prepared.statePath, "awaiting_review", decision.lifecycleState);
  const executionResult = {
    ...review.executionResult,
    hostAcceptance: {
      status: decision.acceptance,
      eligible: review.executionResult.hostAcceptance.eligible,
      decidedBy: actor
    }
  };
  const unsigned = {
    ...reviewIdentityInput(review),
    lifecycleState: terminal.lifecycleState,
    executionResult
  };
  return {
    state: terminal,
    review: {
      ...unsigned,
      reviewIdentity: {
        schemaVersion: "1.0.0",
        stateRevision: terminal.stateRevision,
        resultIdentity: terminal.resultIdentity,
        fingerprint: sha256(canonicalize(unsigned))
      }
    }
  };
}

export async function validateDirectArchiveRoot(prepared, archiveRootInput) {
  const archiveRoot = await requireRealDirectory(
    archiveRootInput,
    "invalid_archive_root",
    "Review archive root must be an absolute pre-existing real directory."
  );
  if (isInside(prepared.taskRoot, archiveRoot) || isInside(prepared.repository.gitRoot, archiveRoot)) {
    throw new DelegationError("invalid_archive_root", "Review evidence must be archived outside the task and delegated repository directories.");
  }
  return archiveRoot;
}

export async function archiveAndCleanupDirectTask(prepared, decided, archiveRootInput) {
  const archiveRoot = await validateDirectArchiveRoot(prepared, archiveRootInput);
  const state = await store(prepared.statePath).read();
  if (!TERMINAL.has(state.lifecycleState) || state.lifecycleState !== decided.state.lifecycleState) {
    throw new DelegationError("cleanup_refused", "Only the matching terminal direct delegation can be archived and cleaned.");
  }
  const identity = decided.review?.reviewIdentity;
  const expectedFingerprint = sha256(canonicalize(reviewIdentityInput(decided.review ?? {})));
  const expectedAcceptance = {
    accepted: "accepted",
    rejected: "rejected",
    abandoned: "abandoned"
  }[state.lifecycleState];
  if (
    decided.review?.lifecycleState !== state.lifecycleState || identity?.stateRevision !== state.stateRevision ||
    identity?.resultIdentity !== state.resultIdentity || identity?.fingerprint !== expectedFingerprint ||
    decided.review?.executionResult?.hostAcceptance?.status !== expectedAcceptance ||
    !nonempty(decided.review?.executionResult?.hostAcceptance?.decidedBy)
  ) {
    throw new DelegationError("stale_review", "Terminal direct-worktree review no longer matches lifecycle state.");
  }
  const archivePath = path.join(archiveRoot, `review-${randomUUID()}`);
  await mkdir(archivePath, { mode: 0o700 });
  const reviewFile = path.join(archivePath, "host-review.json");
  await writeJson(reviewFile, decided.review);
  const [archiveInfo, persisted] = await Promise.all([lstat(archivePath), readJson(reviewFile)]);
  if (!archiveInfo.isDirectory() || archiveInfo.isSymbolicLink() || canonicalize(persisted) !== canonicalize(decided.review)) {
    throw new DelegationError("archive_verification_failed", "Archived direct-worktree review changed before cleanup.");
  }
  const taskInfo = await lstat(prepared.taskRoot).catch(() => null);
  if (!taskInfo?.isDirectory() || taskInfo.isSymbolicLink() || taskInfo.dev !== state.taskRootDev || taskInfo.ino !== state.taskRootIno) {
    throw new DelegationError("cleanup_refused", "Direct lifecycle task root identity changed before cleanup.");
  }
  await rm(prepared.taskRoot, { recursive: true, force: true });
  await store(prepared.statePath).removeIntegrityAnchor();
  return { archivePath, reviewPath: reviewFile };
}
