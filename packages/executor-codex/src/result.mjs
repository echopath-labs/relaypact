import { createHash } from "node:crypto";
import { DelegationError } from "../../contracts/src/errors.mjs";
import { normalizeRelativePath } from "../../contracts/src/path-policy.mjs";
import { conciseOutput } from "../../core/src/redact.mjs";

const RESULT_KEYS = new Set([
  "schemaVersion", "taskId", "status", "summary", "changedFiles", "validations", "residualRisks", "blocking"
]);
const VALIDATION_KEYS = new Set(["id", "status", "summary"]);

function requireString(value, field, { empty = false, maxLength = 2000, codePoints = false } = {}) {
  if (typeof value !== "string" || (!empty && value.trim().length === 0)) {
    throw new DelegationError("malformed_worker_result", `${field} must be a ${empty ? "string" : "non-empty string"}.`);
  }
  if ((codePoints ? [...value].length : value.length) > maxLength) {
    throw new DelegationError("malformed_worker_result", `${field} exceeds its maximum length.`);
  }
  return value;
}

function exactKeys(value, allowed, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DelegationError("malformed_worker_result", `${field} must be an object.`);
  }
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new DelegationError("malformed_worker_result", `${field} has unknown field(s): ${unknown.join(", ")}.`);
}

function stringArray(value, field, { paths = false, maxItems = 1000, sensitiveValues = [] } = {}) {
  if (!Array.isArray(value)) throw new DelegationError("malformed_worker_result", `${field} must be an array.`);
  if (value.length > maxItems) throw new DelegationError("malformed_worker_result", `${field} exceeds its maximum item count.`);
  const normalized = value.map((item, index) => {
    requireString(item, `${field}[${index}]`, { empty: paths === false, maxLength: paths ? 4096 : 2000 });
    if (paths && sensitiveValues.some((secret) => typeof secret === "string" && secret.length > 0 && item.includes(secret))) {
      throw new DelegationError("credential_in_worker_result", `${field}[${index}] contains a host-provided sensitive value.`);
    }
    return paths ? normalizeRelativePath(item, `${field}[${index}]`) : conciseOutput(item, 2000, sensitiveValues);
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new DelegationError("malformed_worker_result", `${field} must not contain duplicates.`);
  }
  return normalized;
}

export function validateCodexWorkerResult(input, expectedTaskId, options = {}) {
  const sensitiveValues = Array.isArray(options.sensitiveValues) ? options.sensitiveValues : [];
  exactKeys(input, RESULT_KEYS, "worker result");
  if (input.schemaVersion !== "1.0.0") throw new DelegationError("malformed_worker_result", "Worker result schemaVersion must be 1.0.0.");
  requireString(input.taskId, "worker result taskId", { maxLength: 128, codePoints: true });
  if (input.taskId !== expectedTaskId) throw new DelegationError("worker_task_mismatch", "Worker result taskId does not match the delegated task.");
  if (!["completed", "blocked", "failed"].includes(input.status)) throw new DelegationError("malformed_worker_result", "Worker result status is invalid.");
  requireString(input.summary, "worker result summary", { empty: true, maxLength: 4000 });
  const changedFiles = stringArray(input.changedFiles, "worker result changedFiles", { paths: true, maxItems: 10_000, sensitiveValues });
  if (!Array.isArray(input.validations)) throw new DelegationError("malformed_worker_result", "worker result validations must be an array.");
  if (input.validations.length > 1000) throw new DelegationError("malformed_worker_result", "worker result validations exceeds its maximum item count.");
  const validations = input.validations.map((entry, index) => {
    exactKeys(entry, VALIDATION_KEYS, `worker result validations[${index}]`);
    requireString(entry.id, `worker result validations[${index}].id`, { maxLength: 200 });
    if (!["passed", "failed", "not_run"].includes(entry.status)) throw new DelegationError("malformed_worker_result", `worker result validations[${index}].status is invalid.`);
    requireString(entry.summary, `worker result validations[${index}].summary`, { empty: true, maxLength: 2000 });
    return {
      id: conciseOutput(entry.id, 200, sensitiveValues),
      status: entry.status,
      summary: conciseOutput(entry.summary, 2000, sensitiveValues)
    };
  });
  const residualRisks = stringArray(input.residualRisks, "worker result residualRisks", { sensitiveValues });
  if (input.blocking !== null) {
    exactKeys(input.blocking, new Set(["code", "message"]), "worker result blocking");
    requireString(input.blocking.code, "worker result blocking.code", { maxLength: 200 });
    requireString(input.blocking.message, "worker result blocking.message", { maxLength: 2000 });
  }
  if (input.status === "completed" && input.blocking !== null) throw new DelegationError("malformed_worker_result", "A completed worker result cannot contain blocking details.");
  if (input.status !== "completed" && input.blocking === null) throw new DelegationError("malformed_worker_result", "A blocked or failed worker result requires blocking details.");
  return {
    schemaVersion: input.schemaVersion,
    taskId: input.taskId,
    status: input.status,
    summary: conciseOutput(input.summary, 4000, sensitiveValues),
    changedFiles,
    validations,
    residualRisks,
    blocking: input.blocking === null ? null : {
      code: conciseOutput(input.blocking.code, 200, sensitiveValues),
      message: conciseOutput(input.blocking.message, 2000, sensitiveValues)
    }
  };
}

export function failedWorkerResult(taskId, code, message) {
  return {
    schemaVersion: "1.0.0",
    taskId,
    status: "failed",
    summary: "The delegated Codex turn did not produce an acceptable structured result.",
    changedFiles: [],
    validations: [],
    residualRisks: ["Host-observed postflight evidence is still required."],
    blocking: { code, message }
  };
}

export function resultIdentity(result) {
  return `sha256:${createHash("sha256").update(JSON.stringify(result)).digest("hex")}`;
}
