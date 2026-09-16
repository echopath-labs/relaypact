import { createHash, createHmac } from "node:crypto";
import path from "node:path";
import { DelegationError } from "../../contracts/src/errors.mjs";
import { canonicalize, createSignedStateStore } from "../../core/src/signed-state.mjs";
import { resultIdentity } from "./result.mjs";

const TRANSITIONS = {
  prepared: new Set(["running", "failed", "abandoned"]),
  running: new Set(["awaiting_review", "failed"]),
  awaiting_review: new Set(["correction_requested", "accepted", "rejected", "abandoned"]),
  correction_requested: new Set(["running", "abandoned"]),
  accepted: new Set(),
  rejected: new Set(),
  abandoned: new Set(),
  failed: new Set()
};
const STATE_KEYS = new Set([
  "schemaVersion", "taskId", "lifecycleState", "hostInstanceId", "executorThreadId",
  "profileName", "profileFingerprint", "capsuleBaseline", "contextManifestFingerprint",
  "privateControlFingerprint", "resultIdentity", "workerSensitiveGrantFingerprint",
  "validationSensitiveGrantFingerprint", "relaypactInput", "correctionSequence", "stateRevision", "integrity"
]);
const SENSITIVE_GRANT_FIELDS = {
  worker: "workerSensitiveGrantFingerprint",
  validation: "validationSensitiveGrantFingerprint"
};
const MAX_CORRECTION_SEQUENCE = 1_000_000;

function nonemptyString(value) {
  return typeof value === "string" && value.trim().length > 0 && !value.includes("\0");
}

function validRelaypactInput(value) {
  if (value === null) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const fields = ["relaypactPromptBytes", "relaypactResultSchemaBytes", "relaypactDeclaredInputBytes"];
  if (Object.keys(value).some((key) => !fields.includes(key)) || fields.some((key) => !Number.isSafeInteger(value[key]) || value[key] < 0)) {
    return false;
  }
  return value.relaypactDeclaredInputBytes === value.relaypactPromptBytes + value.relaypactResultSchemaBytes;
}

function sensitiveGrantFingerprint(channel, values, key) {
  if (!Object.hasOwn(SENSITIVE_GRANT_FIELDS, channel) || !Array.isArray(values)) {
    throw new DelegationError("sensitive_grant_invalid", "Sensitive grant evidence is missing or malformed.");
  }
  const normalized = [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))].sort();
  return `hmac-sha256:${createHmac("sha256", key).update(canonicalize({ channel, values: normalized })).digest("hex")}`;
}

export function validateTaskState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new DelegationError("task_state_unavailable", "Task lifecycle state is missing or malformed.");
  }
  const unknown = Object.keys(state).filter((key) => !STATE_KEYS.has(key));
  const requiredStrings = ["taskId", "hostInstanceId", "profileName", "profileFingerprint", "capsuleBaseline", "privateControlFingerprint"];
  const optionalStrings = [
    "executorThreadId", "contextManifestFingerprint", "resultIdentity",
    "workerSensitiveGrantFingerprint", "validationSensitiveGrantFingerprint"
  ];
  if (
    unknown.length > 0 ||
    state.schemaVersion !== "1.0.0" ||
    !Object.hasOwn(TRANSITIONS, state.lifecycleState) ||
    requiredStrings.some((key) => !nonemptyString(state[key])) ||
    optionalStrings.some((key) => state[key] !== null && !nonemptyString(state[key])) ||
    !validRelaypactInput(state.relaypactInput ?? null) ||
    [state.workerSensitiveGrantFingerprint, state.validationSensitiveGrantFingerprint]
      .some((value) => value !== null && !/^hmac-sha256:[a-f0-9]{64}$/u.test(value)) ||
    !Number.isSafeInteger(state.correctionSequence) ||
    state.correctionSequence < 0 ||
    state.correctionSequence > MAX_CORRECTION_SEQUENCE ||
    !Number.isSafeInteger(state.stateRevision) ||
    state.stateRevision < 0 ||
    typeof state.integrity !== "string" ||
    !/^hmac-sha256:[a-f0-9]{64}$/u.test(state.integrity)
  ) {
    throw new DelegationError("task_state_unavailable", "Task lifecycle state failed schema validation.");
  }
  return state;
}

function taskStateStore(statePath) {
  return createSignedStateStore(statePath, validateTaskState);
}

async function transitionUnlocked(statePath, state, next, updates = {}) {
  if (!TRANSITIONS[state.lifecycleState]?.has(next)) {
    throw new DelegationError("invalid_lifecycle_transition", `Cannot transition task from ${state.lifecycleState} to ${next}.`);
  }
  const updated = { ...state, ...updates, lifecycleState: next, stateRevision: state.stateRevision + 1 };
  return taskStateStore(statePath).persist(updated, { expectedRevision: state.stateRevision });
}

function assertCorrectionIdentityValue(state, identity) {
  const dimensions = [
    ["taskId", identity.taskId],
    ["profileFingerprint", identity.profileFingerprint],
    ["capsuleBaseline", identity.capsuleBaseline],
    ["resultIdentity", identity.priorResultIdentity]
  ];
  if (state.contextManifestFingerprint !== null && state.contextManifestFingerprint !== undefined) {
    dimensions.push(["contextManifestFingerprint", identity.contextManifestFingerprint]);
  }
  const mismatches = dimensions.filter(([field, value]) => state[field] !== value).map(([field]) => field);
  if (mismatches.length > 0 || !state.executorThreadId) {
    throw new DelegationError("resume_identity_mismatch", `Correction resume identity mismatch: ${mismatches.join(", ") || "executorThreadId"}.`);
  }
  return state;
}

export async function createTaskState({ capsule, profile, hostInstanceId }) {
  if (typeof hostInstanceId !== "string" || hostInstanceId.trim().length === 0) {
    throw new DelegationError("host_instance_required", "A distinct coordinating-host instance identity is required.");
  }
  if (!nonemptyString(capsule.privateControlBaseline?.fingerprint)) {
    throw new DelegationError("task_state_unavailable", "Private control baseline identity is required before task lifecycle creation.");
  }
  const statePath = path.join(capsule.taskRoot, "state.json");
  const state = {
    schemaVersion: "1.0.0",
    taskId: capsule.taskId,
    lifecycleState: "prepared",
    hostInstanceId,
    executorThreadId: null,
    profileName: profile.name,
    profileFingerprint: profile.fingerprint,
    capsuleBaseline: capsule.baseline,
    contextManifestFingerprint: capsule.contextManifestFingerprint ?? null,
    privateControlFingerprint: capsule.privateControlBaseline.fingerprint,
    resultIdentity: null,
    workerSensitiveGrantFingerprint: null,
    validationSensitiveGrantFingerprint: null,
    relaypactInput: null,
    correctionSequence: 0,
    stateRevision: 0,
    integrity: "hmac-sha256:0000000000000000000000000000000000000000000000000000000000000000"
  };
  const persistedState = await taskStateStore(statePath).create(state);
  return { statePath, state: persistedState };
}

export async function readTaskState(statePath) {
  return taskStateStore(statePath).read();
}

export async function transitionTaskState(statePath, next, updates = {}) {
  return taskStateStore(statePath).withLock(async ({ read }) => {
    const state = await read();
    return transitionUnlocked(statePath, state, next, updates);
  });
}

export async function bindTaskSensitiveGrant(statePath, channel, values) {
  const field = SENSITIVE_GRANT_FIELDS[channel];
  if (!field) throw new DelegationError("sensitive_grant_invalid", "Sensitive grant channel is unsupported.");
  return taskStateStore(statePath).withLock(async ({ read, persist, key: readKey }) => {
    const state = await read();
    const key = await readKey();
    const fingerprint = sensitiveGrantFingerprint(channel, values, key);
    if (state[field] !== null) {
      return { consistent: state[field] === fingerprint, fingerprint: state[field], state };
    }
    const updated = await persist({
      ...state,
      [field]: fingerprint,
      stateRevision: state.stateRevision + 1
    }, { expectedRevision: state.stateRevision });
    return { consistent: true, fingerprint, state: updated };
  });
}

export async function taskSensitiveGrantMatches(statePath, channel, values) {
  const field = SENSITIVE_GRANT_FIELDS[channel];
  if (!field) throw new DelegationError("sensitive_grant_invalid", "Sensitive grant channel is unsupported.");
  const state = await taskStateStore(statePath).read();
  if (state[field] === null) return false;
  const key = await taskStateStore(statePath).key();
  return state[field] === sensitiveGrantFingerprint(channel, values, key);
}

export async function transitionTaskStateMatching(statePath, next, expected, updates = {}) {
  const allowed = new Set([
    "taskId", "lifecycleState", "stateRevision", "correctionSequence",
    "resultIdentity", "privateControlFingerprint"
  ]);
  if (!expected || typeof expected !== "object" || Array.isArray(expected) || Object.keys(expected).some((key) => !allowed.has(key))) {
    throw new DelegationError("review_identity_mismatch", "Terminal state expectations are missing or malformed.");
  }
  return taskStateStore(statePath).withLock(async ({ read }) => {
    const state = await read();
    const mismatches = Object.entries(expected)
      .filter(([key, value]) => state[key] !== value)
      .map(([key]) => key);
    if (mismatches.length > 0) {
      throw new DelegationError("stale_review", `Review no longer matches current task state: ${mismatches.join(", ")}.`);
    }
    return transitionUnlocked(statePath, state, next, updates);
  });
}

export async function recordWorkerResult(statePath, { threadId, result, relaypactInput = null }) {
  return taskStateStore(statePath).withLock(async ({ read }) => {
    const state = await read();
    if (typeof threadId !== "string" || threadId.trim().length === 0 || threadId === state.hostInstanceId) {
      throw new DelegationError("executor_identity_unavailable", "A distinct delegated Codex thread identity was not evidenced.");
    }
    if (state.executorThreadId !== null && state.executorThreadId !== threadId) {
      throw new DelegationError("executor_identity_mismatch", "The delegated Codex thread changed during the task lifecycle.");
    }
    if (!validRelaypactInput(relaypactInput)) {
      throw new DelegationError("relaypact_input_unavailable", "RelayPact declared-input evidence is missing or malformed.");
    }
    return transitionUnlocked(statePath, state, "awaiting_review", {
      executorThreadId: threadId,
      resultIdentity: resultIdentity(result),
      relaypactInput
    });
  });
}

export async function assertCorrectionIdentity(statePath, identity) {
  return assertCorrectionIdentityValue(await taskStateStore(statePath).read(), identity);
}

export async function authorizeCorrection(statePath, identity) {
  return taskStateStore(statePath).withLock(async ({ read }) => {
    const state = assertCorrectionIdentityValue(await read(), identity);
    if (state.correctionSequence >= MAX_CORRECTION_SEQUENCE) {
      throw new DelegationError("correction_sequence_exhausted", "Correction sequence limit has been reached.");
    }
    return transitionUnlocked(statePath, state, "correction_requested", {
      correctionSequence: state.correctionSequence + 1
    });
  });
}

export function opaqueTaskMetricId(taskId) {
  return createHash("sha256").update(taskId).digest("hex").slice(0, 16);
}

export async function removeTaskIntegrityAnchor(statePath) {
  await taskStateStore(statePath).removeIntegrityAnchor();
}
