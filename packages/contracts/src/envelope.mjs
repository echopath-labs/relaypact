import path from "node:path";
import { DelegationError } from "./errors.mjs";
import { isReservedPath, normalizeRelativePath } from "./path-policy.mjs";

export const DEFAULT_FILESYSTEM_EVIDENCE_MAX_BYTES = 512 * 1024 * 1024;
export const MAX_FILESYSTEM_EVIDENCE_BYTES = 8 * 1024 * 1024 * 1024;

export function filesystemEvidenceMaxBytes(envelope) {
  const value = envelope?.execution?.filesystemEvidenceMaxBytes;
  if (value === undefined) return DEFAULT_FILESYSTEM_EVIDENCE_MAX_BYTES;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_FILESYSTEM_EVIDENCE_BYTES) {
    throw new DelegationError("invalid_envelope", "execution.filesystemEvidenceMaxBytes must be an integer from 1 to 8589934592 bytes.");
  }
  return value;
}

const TOP_LEVEL_KEYS = new Set([
  "schemaVersion",
  "taskId",
  "objective",
  "expectedOutcome",
  "repository",
  "scope",
  "contextPlanning",
  "instructions",
  "constraints",
  "validation",
  "requiredEvidence",
  "stopConditions",
  "resultFormat",
  "executionProfile",
  "execution"
]);
const REQUIRED_EVIDENCE = new Set([
  "git_preflight",
  "changed_paths",
  "validation_results",
  "executor_report"
]);
const REASONING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const CREDENTIAL_KEY = /(api.?key|access.?token|auth.?token|password|secret|credential)/i;
const CREDENTIAL_ARGUMENT = /^(?:--?)?(?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|access[_-]?token|auth(?:entication)?[_-]?token|token|password|secret|credential)(?:[_-][A-Za-z0-9]+)*(?:=|$)/i;
const CREDENTIAL_VALUE = /(?:^|\s)(?:authorization|proxy-authorization)\s*:\s*(?:bearer|basic)\s+\S+|^\s*(?:bearer|basic)\s+\S+|https?:\/\/[^/\s:@]+:[^/\s@]+@|\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{12,})\b/i;
const SHELL_EXECUTABLES = new Set([
  "sh", "bash", "zsh", "dash", "ksh", "fish", "csh", "tcsh",
  "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe"
]);
const GLOB_CHARACTER = /[*?\[\]{}]/;
const MAX_PLANNED_FILES = 10_000;
const MAX_PLANNED_BYTES = 67_108_864;
const MAX_PLANNED_DEPTH = 256;
const MAX_TEXT_LENGTH = 16_384;
const MAX_TASK_ID_LENGTH = 128;
const MAX_ARRAY_ITEMS = 10_000;
const MAX_COMMANDS = 256;
const MAX_COMMAND_ARGS = 256;

function containsCredentialArgument(value) {
  return CREDENTIAL_ARGUMENT.test(value) || CREDENTIAL_VALUE.test(value);
}

function rejectUnknown(value, allowed, field) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new DelegationError("invalid_envelope", `Unknown ${field} field(s): ${unknown.join(", ")}.`);
  }
}

function requireObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DelegationError("invalid_envelope", `${field} must be an object.`);
  }
  return value;
}

function requireString(value, field, { maxLength = MAX_TEXT_LENGTH } = {}) {
  if (typeof value !== "string" || value.trim().length === 0 || [...value].length > maxLength || value.includes("\0")) {
    throw new DelegationError("invalid_envelope", `${field} must be a non-empty string.`);
  }
  return value;
}

function requireStringArray(value, field, { min = 0, max = MAX_ARRAY_ITEMS, itemMaxLength = MAX_TEXT_LENGTH } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new DelegationError("invalid_envelope", `${field} must contain at least ${min} item(s).`);
  }
  value.forEach((item, index) => requireString(item, `${field}[${index}]`, { maxLength: itemMaxLength }));
  if (new Set(value).size !== value.length) {
    throw new DelegationError("invalid_envelope", `${field} must not contain duplicates.`);
  }
  return value;
}

function requireNormalizedPathArray(value, field, { min = 0, allowGlobs = true, allowRoot = true } = {}) {
  requireStringArray(value, field, { min });
  const normalized = value.map((item, index) => {
    const candidate = normalizeRelativePath(item, `${field}[${index}]`);
    if (candidate !== item || (candidate !== "." && (candidate.includes("//") || candidate.includes("/./") || candidate.endsWith("/")))) {
      throw new DelegationError("invalid_envelope", `${field}[${index}] must be normalized.`);
    }
    if (!allowRoot && candidate === ".") {
      throw new DelegationError("invalid_envelope", `${field}[${index}] must identify a file path, not the repository root.`);
    }
    if (!allowGlobs && GLOB_CHARACTER.test(item)) {
      throw new DelegationError("invalid_envelope", `${field}[${index}] must be a literal path without glob characters.`);
    }
    return candidate;
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new DelegationError("invalid_envelope", `${field} must not contain duplicate normalized paths.`);
  }
  return value;
}

function requireBoundedPositiveInteger(value, field, maximum) {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new DelegationError("invalid_envelope", `${field} must be a bounded positive integer.`);
  }
}

function validateReadiness(readiness, field = "contextPlanning.readiness") {
  if (!Array.isArray(readiness) || readiness.length > MAX_COMMANDS) {
    throw new DelegationError("invalid_envelope", `${field} must be an array.`);
  }
  const ids = new Set();
  readiness.forEach((entry, index) => {
    const entryField = `${field}[${index}]`;
    requireObject(entry, entryField);
    rejectUnknown(entry, new Set(["id", "argv", "timeoutMs", "acceptableExitCodes"]), entryField);
    requireString(entry.id, `${entryField}.id`);
    if (ids.has(entry.id)) {
      throw new DelegationError("invalid_envelope", `${field} must not contain duplicate ids.`);
    }
    ids.add(entry.id);
    requireStringArray(entry.argv, `${entryField}.argv`, { min: 1, max: MAX_COMMAND_ARGS });
    const executable = path.posix.basename(entry.argv[0].replaceAll("\\", "/")).toLowerCase();
    if (SHELL_EXECUTABLES.has(executable)) {
      throw new DelegationError("invalid_envelope", `${entryField}.argv must invoke a non-shell executable.`);
    }
    if (entry.argv.some(containsCredentialArgument)) {
      throw new DelegationError("credential_in_envelope", `${entryField}.argv contains a credential-like argument.`);
    }
    if (!Number.isInteger(entry.timeoutMs) || entry.timeoutMs < 1 || entry.timeoutMs > 3_600_000) {
      throw new DelegationError("invalid_envelope", `${entryField}.timeoutMs is invalid.`);
    }
    if (!Array.isArray(entry.acceptableExitCodes) || entry.acceptableExitCodes.length < 1) {
      throw new DelegationError("invalid_envelope", `${entryField}.acceptableExitCodes must contain at least one code.`);
    }
    if (entry.acceptableExitCodes.some((code) => !Number.isInteger(code) || code < 0 || code > 255)) {
      throw new DelegationError("invalid_envelope", `${entryField}.acceptableExitCodes must contain integer exit codes from 0 through 255.`);
    }
    if (new Set(entry.acceptableExitCodes).size !== entry.acceptableExitCodes.length) {
      throw new DelegationError("invalid_envelope", `${entryField}.acceptableExitCodes must not contain duplicates.`);
    }
  });
}

function validateContextPlanning(contextPlanning, scope, execution) {
  requireObject(contextPlanning, "contextPlanning");
  rejectUnknown(contextPlanning, new Set(["strategy", "seeds", "analyzers", "budget", "readiness"]), "contextPlanning");
  if (contextPlanning.strategy !== "dependency-closure") {
    throw new DelegationError("invalid_envelope", "contextPlanning.strategy must be dependency-closure.");
  }
  if (!Array.isArray(scope.discoverablePaths) || scope.discoverablePaths.length < 1) {
    throw new DelegationError("invalid_envelope", "Planned mode requires non-empty scope.discoverablePaths.");
  }
  requireNormalizedPathArray(scope.discoverablePaths, "scope.discoverablePaths", { min: 1 });
  requireNormalizedPathArray(contextPlanning.seeds, "contextPlanning.seeds", { min: 1, allowGlobs: false, allowRoot: false });
  requireStringArray(contextPlanning.analyzers, "contextPlanning.analyzers", { min: 1 });
  if (contextPlanning.analyzers.some((analyzer) => analyzer !== "node-esm")) {
    throw new DelegationError("invalid_envelope", "contextPlanning.analyzers only supports node-esm.");
  }
  if (!contextPlanning.budget || typeof contextPlanning.budget !== "object" || Array.isArray(contextPlanning.budget)) {
    throw new DelegationError("invalid_envelope", "contextPlanning.budget must be an object.");
  }
  rejectUnknown(contextPlanning.budget, new Set(["maxFiles", "maxBytes", "maxDepth"]), "contextPlanning.budget");
  requireBoundedPositiveInteger(contextPlanning.budget.maxFiles, "contextPlanning.budget.maxFiles", MAX_PLANNED_FILES);
  requireBoundedPositiveInteger(contextPlanning.budget.maxBytes, "contextPlanning.budget.maxBytes", MAX_PLANNED_BYTES);
  requireBoundedPositiveInteger(contextPlanning.budget.maxDepth, "contextPlanning.budget.maxDepth", MAX_PLANNED_DEPTH);
  validateReadiness(contextPlanning.readiness);
  if (execution?.exposureMode === "trusted-worktree") {
    throw new DelegationError("invalid_envelope", "contextPlanning cannot be used with trusted-worktree exposure.");
  }
}

function rejectCredentials(value, trail = []) {
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (CREDENTIAL_KEY.test(key)) {
      throw new DelegationError(
        "credential_in_envelope",
        `Credential-like field is not allowed in the task envelope: ${[...trail, key].join(".")}.`
      );
    }
    rejectCredentials(nested, [...trail, key]);
  }
}

export function validateTaskEnvelope(input) {
  const envelope = requireObject(input, "envelope");
  const unknown = Object.keys(envelope).filter((key) => !TOP_LEVEL_KEYS.has(key));
  if (unknown.length > 0) {
    throw new DelegationError("invalid_envelope", `Unknown envelope field(s): ${unknown.join(", ")}.`);
  }
  if (envelope.schemaVersion !== "1.0.0") {
    throw new DelegationError("invalid_envelope", "schemaVersion must be 1.0.0.");
  }
  requireString(envelope.taskId, "taskId", { maxLength: MAX_TASK_ID_LENGTH });
  requireString(envelope.objective, "objective");
  requireString(envelope.expectedOutcome, "expectedOutcome");

  const repository = requireObject(envelope.repository, "repository");
  rejectUnknown(repository, new Set(["root", "workingDirectory", "dirtyTree"]), "repository");
  const root = requireString(repository.root, "repository.root");
  if (!path.isAbsolute(root) && !path.win32.isAbsolute(root)) {
    throw new DelegationError("invalid_envelope", "repository.root must be absolute.");
  }
  normalizeRelativePath(requireString(repository.workingDirectory, "repository.workingDirectory"), "repository.workingDirectory");
  const dirtyTree = requireObject(repository.dirtyTree, "repository.dirtyTree");
  rejectUnknown(dirtyTree, new Set(["allow", "acknowledgedPaths"]), "repository.dirtyTree");
  if (typeof dirtyTree.allow !== "boolean") {
    throw new DelegationError("invalid_envelope", "repository.dirtyTree.allow must be boolean.");
  }
  requireStringArray(dirtyTree.acknowledgedPaths, "repository.dirtyTree.acknowledgedPaths");
  dirtyTree.acknowledgedPaths.forEach((item) => normalizeRelativePath(item, "acknowledged dirty path"));

  const scope = requireObject(envelope.scope, "scope");
  rejectUnknown(scope, new Set(["allowedPaths", "forbiddenPaths", "readablePaths", "discoverablePaths"]), "scope");
  requireStringArray(scope.allowedPaths, "scope.allowedPaths", { min: 1 });
  requireStringArray(scope.forbiddenPaths, "scope.forbiddenPaths");
  if (scope.readablePaths !== undefined) requireStringArray(scope.readablePaths, "scope.readablePaths");
  [...scope.allowedPaths, ...scope.forbiddenPaths, ...(scope.readablePaths ?? [])].forEach((item) => normalizeRelativePath(item, "scope pattern"));
  if (scope.discoverablePaths !== undefined) requireNormalizedPathArray(scope.discoverablePaths, "scope.discoverablePaths");

  requireStringArray(envelope.instructions, "instructions", { min: 1 });
  requireStringArray(envelope.constraints, "constraints");
  requireStringArray(envelope.stopConditions, "stopConditions", { min: 1 });
  requireStringArray(envelope.requiredEvidence, "requiredEvidence", { min: 1 });
  for (const item of envelope.requiredEvidence) {
    if (!REQUIRED_EVIDENCE.has(item)) {
      throw new DelegationError("invalid_envelope", `Unsupported requiredEvidence value: ${item}.`);
    }
  }

  if (!Array.isArray(envelope.validation) || envelope.validation.length > MAX_COMMANDS) {
    throw new DelegationError("invalid_envelope", "validation must be an array.");
  }
  envelope.validation.forEach((entry, index) => {
    requireObject(entry, `validation[${index}]`);
    rejectUnknown(entry, new Set(["id", "argv", "timeoutMs"]), `validation[${index}]`);
    requireString(entry.id, `validation[${index}].id`);
    requireStringArray(entry.argv, `validation[${index}].argv`, { min: 1, max: MAX_COMMAND_ARGS });
    if (entry.argv.some(containsCredentialArgument)) {
      throw new DelegationError("credential_in_envelope", `validation[${index}].argv contains a credential-like argument.`);
    }
    if (entry.timeoutMs !== undefined && (!Number.isInteger(entry.timeoutMs) || entry.timeoutMs < 1 || entry.timeoutMs > 3_600_000)) {
      throw new DelegationError("invalid_envelope", `validation[${index}].timeoutMs is invalid.`);
    }
  });

  const resultFormat = requireObject(envelope.resultFormat, "resultFormat");
  rejectUnknown(resultFormat, new Set(["schemaVersion"]), "resultFormat");
  if (resultFormat.schemaVersion !== "1.0.0") {
    throw new DelegationError("invalid_envelope", "resultFormat.schemaVersion must be 1.0.0.");
  }

  if (typeof envelope.executionProfile === "string") {
    requireString(envelope.executionProfile, "executionProfile");
  } else if (envelope.executionProfile !== undefined) {
    const profile = requireObject(envelope.executionProfile, "executionProfile");
    for (const key of Object.keys(profile)) {
      if (!["provider", "model", "reasoning"].includes(key)) {
        throw new DelegationError("invalid_envelope", `Unknown executionProfile field: ${key}.`);
      }
    }
    if (profile.provider !== undefined) requireString(profile.provider, "executionProfile.provider");
    if (profile.model !== undefined) requireString(profile.model, "executionProfile.model");
    if (profile.reasoning !== undefined && !REASONING_LEVELS.has(profile.reasoning)) {
      throw new DelegationError("invalid_envelope", "executionProfile.reasoning is invalid.");
    }
  }

  if (envelope.execution !== undefined) {
    const execution = requireObject(envelope.execution, "execution");
    for (const key of Object.keys(execution)) {
      if (!["timeoutMs", "exposureMode", "trustedWorktreeAcknowledged", "filesystemEvidenceMaxBytes"].includes(key)) {
        throw new DelegationError("invalid_envelope", `Unknown execution field: ${key}.`);
      }
    }
    filesystemEvidenceMaxBytes(envelope);
    if (execution.timeoutMs !== undefined && (!Number.isInteger(execution.timeoutMs) || execution.timeoutMs < 1 || execution.timeoutMs > 3_600_000)) {
      throw new DelegationError("invalid_envelope", "execution.timeoutMs is invalid.");
    }
    if (execution.exposureMode !== undefined && !["sanitized", "trusted-worktree"].includes(execution.exposureMode)) {
      throw new DelegationError("invalid_envelope", "execution.exposureMode is invalid.");
    }
    if (execution.trustedWorktreeAcknowledged !== undefined && typeof execution.trustedWorktreeAcknowledged !== "boolean") {
      throw new DelegationError("invalid_envelope", "execution.trustedWorktreeAcknowledged must be boolean.");
    }
  }

  if (envelope.contextPlanning !== undefined) {
    validateContextPlanning(envelope.contextPlanning, scope, envelope.execution);
  }

  const authorityPaths = [
    ...scope.allowedPaths,
    ...(scope.readablePaths ?? []),
    ...(scope.discoverablePaths ?? []),
    ...(input.contextPlanning?.seeds ?? [])
  ];
  if (authorityPaths.some(isReservedPath)) {
    throw new DelegationError("invalid_envelope", "Reserved .git and .relaypact paths cannot be granted as task authority.");
  }

  rejectCredentials(envelope);
  return envelope;
}
