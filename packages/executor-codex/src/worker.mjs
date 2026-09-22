import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { minimalEnvironment } from "../../core/src/environment.mjs";
import { DelegationError } from "../../contracts/src/errors.mjs";
import { runProcess } from "../../core/src/process.mjs";
import {
  conciseOutput,
  SensitiveUrlDecodeBudgetError,
  SensitiveUrlEncodingError,
  sensitiveUrlValues
} from "../../core/src/redact.mjs";
import { failedWorkerResult, validateCodexWorkerResult } from "./result.mjs";
import { bindTaskSensitiveGrant, taskSensitiveGrantMatches } from "./state.mjs";
import { workerEnvironment } from "./profile.mjs";

function tomlString(value) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")}"`;
}

const AUTH_KEYS = new Set(["OPENAI_API_KEY", "tokens", "last_refresh", "auth_mode"]);
const CREDENTIAL_ASSIGNMENT = /^\s*(?:api[_-]?key|.*(?:access|auth|bearer)[_-]?token|password|secret|credential)\s*=/imu;
const CONFIG_TABLE = /^\s*\[+\s*([^\]]+)\s*\]+\s*$/gmu;
const CONFIG_ASSIGNMENT = /^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*=/u;
const SAFE_TOP_LEVEL_CONFIG = new Set(["model", "model_provider", "model_reasoning_effort", "disable_response_storage"]);
const SAFE_PROFILE_CONFIG = new Set(["model", "model_provider", "model_reasoning_effort", "disable_response_storage"]);
const SAFE_PROVIDER_CONFIG = new Set(["name", "base_url", "env_key", "wire_api", "request_max_retries", "stream_max_retries", "stream_idle_timeout_ms", "websocket_connect_timeout_ms"]);
const MAX_WORKER_RESULT_BYTES = 4 * 1024 * 1024;
const MAX_RELAYPACT_PROMPT_BYTES = 4 * 1024 * 1024;
const MAX_RELAYPACT_RESULT_SCHEMA_BYTES = 4 * 1024 * 1024;

function parseSnapshotString(line, key, profileName) {
  const match = line.match(new RegExp(`^\\s*${key}\\s*=\\s*(\"(?:[^\"\\\\]|\\\\.)*\"|'[^']*')\\s*(?:#.*)?$`, "u"));
  if (!match) {
    throw new DelegationError("codex_profile_projection_unsupported", `The selected Codex profile snapshot has an unsupported ${key} value: ${profileName}.`);
  }
  if (match[1].startsWith("'")) return match[1].slice(1, -1);
  try {
    return JSON.parse(match[1]);
  } catch {
    throw new DelegationError("codex_profile_projection_unsupported", `The selected Codex profile snapshot has a malformed ${key} value: ${profileName}.`);
  }
}

function providerNameFromTable(table, profileName) {
  const raw = table.slice("model_providers.".length);
  if (/^[A-Za-z0-9_-]+$/u.test(raw)) return raw;
  if (/^"(?:[^"\\]|\\.)*"$/u.test(raw)) {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === "string" && parsed.length > 0) return parsed;
    } catch {
      // Fall through to the normalized projection error.
    }
  }
  throw new DelegationError("codex_profile_projection_unsupported", `The selected Codex profile snapshot has an unsupported provider table name: ${profileName}.`);
}

function validateSnapshotBaseUrl(line, profileName) {
  const value = parseSnapshotString(line, "base_url", profileName);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new DelegationError("codex_profile_projection_unsupported", `The selected Codex profile snapshot has an invalid base_url: ${profileName}.`);
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
  if ((parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new DelegationError("codex_profile_projection_unsupported", `The selected Codex profile snapshot base_url must use HTTPS or loopback HTTP without credentials, query parameters, or fragments: ${profileName}.`);
  }
}

function stringLeaves(value, output = []) {
  if (typeof value === "string") output.push(value);
  else if (Array.isArray(value)) value.forEach((item) => stringLeaves(item, output));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => stringLeaves(item, output));
  return output;
}

function providerUrlSensitiveValues(value) {
  try {
    return sensitiveUrlValues(value);
  } catch (error) {
    if (error instanceof SensitiveUrlDecodeBudgetError) {
      throw new DelegationError(
        "provider_url_decode_budget_exceeded",
        "Selected provider URL exceeds the supported path decoding bound."
      );
    }
    if (error instanceof SensitiveUrlEncodingError) {
      throw new DelegationError(
        "provider_url_encoding_unsupported",
        "Selected provider URL contains unsupported path encoding."
      );
    }
    throw error;
  }
}

export async function taskSensitiveValues(capsule, profile, environmentSource = process.env, providedGrants = undefined) {
  const codexHome = path.join(capsule.taskRoot, "codex-home");
  const environmentGrants = providedGrants ?? workerEnvironment(profile, environmentSource);
  const values = Object.values(environmentGrants ?? {});
  try {
    const auth = JSON.parse(await readFile(path.join(codexHome, "auth.json"), "utf8"));
    stringLeaves(auth, values);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (profile.provider?.baseUrl) values.push(...providerUrlSensitiveValues(profile.provider.baseUrl));
  try {
    const config = await readFile(path.join(codexHome, "config.toml"), "utf8");
    for (const line of config.split(/\r?\n/u)) {
      if (!/^\s*base_url\s*=/u.test(line)) continue;
      values.push(...providerUrlSensitiveValues(parseSnapshotString(line, "base_url", "task configuration")));
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

function minimalNativeConfig(profile, capsuleRoot) {
  const lines = ['sandbox_mode = "workspace-write"'];
  if (profile.model && !profile.codexProfile) lines.push(`model = ${tomlString(profile.model)}`);
  if (profile.codexProfile) {
    lines.push("", `[profiles.${tomlString(profile.codexProfile)}]`);
    if (profile.model) lines.push(`model = ${tomlString(profile.model)}`);
  }
  lines.push("", `[projects.${tomlString(path.resolve(capsuleRoot))}]`, 'trust_level = "trusted"', "");
  return lines.join("\n");
}

async function readSafeConfigSnapshot(source, profileName) {
  let info;
  try {
    info = await lstat(source);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024) {
    throw new DelegationError("codex_profile_projection_unsupported", `The selected Codex profile snapshot is not a safe regular file: ${profileName}.`);
  }
  const content = await readFile(source, "utf8");
  if (CREDENTIAL_ASSIGNMENT.test(content)) {
    throw new DelegationError("codex_profile_projection_unsupported", `The selected Codex profile snapshot contains a credential-like assignment: ${profileName}.`);
  }
  let currentTable = null;
  const referencedProviders = new Set();
  const providerTables = new Set();
  const expectedProfileTables = new Set([`profiles.${profileName}`, `profiles.${JSON.stringify(profileName)}`]);
  for (const line of content.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const table = trimmed.match(/^\[+\s*([^\]]+)\s*\]+$/u);
    if (table) {
      currentTable = table[1].trim();
      if (!expectedProfileTables.has(currentTable) && !currentTable.startsWith("model_providers.")) {
        throw new DelegationError("codex_profile_projection_unsupported", `The selected Codex profile snapshot contains an unrelated configuration table: ${profileName}.`);
      }
      if (currentTable.startsWith("model_providers.")) providerTables.add(providerNameFromTable(currentTable, profileName));
      continue;
    }
    const assignment = line.match(CONFIG_ASSIGNMENT);
    if (!assignment) {
      throw new DelegationError("codex_profile_projection_unsupported", `The selected Codex profile snapshot contains unsupported syntax: ${profileName}.`);
    }
    const allowed = currentTable === null
      ? SAFE_TOP_LEVEL_CONFIG
      : currentTable.startsWith("profiles.")
        ? SAFE_PROFILE_CONFIG
        : SAFE_PROVIDER_CONFIG;
    if (!allowed.has(assignment[1])) {
      throw new DelegationError("codex_profile_projection_unsupported", `The selected Codex profile snapshot contains an unrelated setting: ${profileName}.`);
    }
    if (currentTable?.startsWith("model_providers.") && assignment[1] === "base_url") {
      validateSnapshotBaseUrl(line, profileName);
    }
    if ((currentTable === null || currentTable.startsWith("profiles.")) && assignment[1] === "model_provider") {
      referencedProviders.add(parseSnapshotString(line, "model_provider", profileName));
    }
  }
  for (const match of content.matchAll(CONFIG_TABLE)) {
    const table = match[1].trim();
    if (!table.startsWith("profiles.") && !table.startsWith("model_providers.")) {
      throw new DelegationError("codex_profile_projection_unsupported", `The selected Codex profile snapshot contains an unrelated configuration table: ${profileName}.`);
    }
  }
  const unrelatedProviders = [...providerTables].filter((provider) => !referencedProviders.has(provider));
  if (unrelatedProviders.length > 0) {
    throw new DelegationError("codex_profile_projection_unsupported", `The selected Codex profile snapshot contains an unreferenced provider table: ${profileName}.`);
  }
  return content.endsWith("\n") ? content : `${content}\n`;
}

async function projectNativeAuth(sourceHome, codexHome) {
  const source = path.join(sourceHome, "auth.json");
  const destination = path.join(codexHome, "auth.json");
  let existing = null;
  try {
    existing = await lstat(destination);
    if (!existing.isFile() || existing.isSymbolicLink() || (existing.mode & 0o777) !== 0o600) {
      throw new DelegationError("codex_auth_projection_unsupported", "Task-scoped Codex authentication has an unsafe file type or permissions.");
    }
  } catch (error) {
    if (error instanceof DelegationError) throw error;
    if (error?.code !== "ENOENT") throw error;
  }
  let info;
  try {
    info = await lstat(source);
  } catch (error) {
    if (error?.code === "ENOENT") {
      if (existing) {
        throw new DelegationError("codex_auth_projection_unsupported", "Host Codex authentication disappeared before task execution could be refreshed.");
      }
      return false;
    }
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) {
    throw new DelegationError("codex_auth_projection_unsupported", "Codex authentication cannot be projected from an unsafe file.");
  }
  let parsed;
  try {
    parsed = JSON.parse(await readFile(source, "utf8"));
  } catch {
    throw new DelegationError("codex_auth_projection_unsupported", "Codex authentication cannot be projected from malformed JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new DelegationError("codex_auth_projection_unsupported", "Codex authentication has an unsupported shape.");
  }
  const projected = Object.fromEntries(Object.entries(parsed).filter(([key]) => AUTH_KEYS.has(key)));
  if (Object.keys(projected).length === 0) {
    throw new DelegationError("codex_auth_projection_unsupported", "Codex authentication has no supported projected fields.");
  }
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(projected, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, destination);
    await chmod(destination, 0o600);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  return true;
}

export function directProviderConfig(profile, capsuleRoot = undefined) {
  if (!profile.provider) return null;
  const lines = [
    `model = ${tomlString(profile.model)}`,
    `model_provider = ${tomlString(profile.provider.name)}`,
    'sandbox_mode = "workspace-write"',
    "",
    `[model_providers.${profile.provider.name}]`,
    `name = ${tomlString(profile.provider.name)}`,
    `base_url = ${tomlString(profile.provider.baseUrl)}`,
    `env_key = ${tomlString(profile.provider.credentialEnv)}`,
    `wire_api = ${tomlString(profile.provider.wireApi)}`,
    ""
  ];
  if (capsuleRoot !== undefined) {
    if (!path.isAbsolute(capsuleRoot)) {
      throw new DelegationError("invalid_capsule_root", "Direct provider project trust requires an absolute task capsule path.");
    }
    lines.push(
      `[projects.${tomlString(path.resolve(capsuleRoot))}]`,
      'trust_level = "trusted"',
      ""
    );
  }
  return lines.join("\n");
}

async function materializeDirectConfig(destination, expected, requireExisting = false) {
  let info;
  try {
    info = await lstat(destination);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (!info) {
    if (requireExisting) {
      throw new DelegationError("provider_config_drift", "The task-scoped direct provider configuration is missing.");
    }
    await writeFile(destination, expected, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await chmod(destination, 0o600);
    return;
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new DelegationError("provider_config_drift", "The task-scoped direct provider configuration has an unsafe file type.");
  }
  const actual = await readFile(destination, "utf8");
  if (actual !== expected) {
    throw new DelegationError("provider_config_drift", "The task-scoped direct provider configuration no longer matches the selected profile.");
  }
  if ((info.mode & 0o777) !== 0o600) {
    throw new DelegationError("provider_config_drift", "The task-scoped direct provider configuration permissions have drifted.");
  }
}

export async function prepareTaskCodexHome(capsule, profile, options = {}) {
  const codexHome = path.join(capsule.taskRoot, "codex-home");
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  if (profile.provider) {
    await materializeDirectConfig(
      path.join(codexHome, "config.toml"),
      directProviderConfig(profile, capsule.capsuleRoot),
      options.requireDirectConfig === true
    );
    return codexHome;
  }
  const sourceHome = path.resolve(options.sourceCodexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"));
  const snapshot = profile.codexProfile
    ? await readSafeConfigSnapshot(path.join(sourceHome, `${profile.codexProfile}.config.toml`), profile.codexProfile)
    : null;
  if (profile.router && snapshot === null) {
    throw new DelegationError("codex_profile_projection_unsupported", "Router-backed Codex execution requires a credential-free selected profile snapshot.");
  }
  let config = snapshot ?? minimalNativeConfig(profile, capsule.capsuleRoot);
  if (snapshot) {
    config = `${snapshot}\n[projects.${tomlString(path.resolve(capsule.capsuleRoot))}]\ntrust_level = "trusted"\n`;
  }
  await materializeDirectConfig(path.join(codexHome, "config.toml"), config, false);
  await projectNativeAuth(sourceHome, codexHome);
  return codexHome;
}

function promptFor(envelope, correction) {
  const readOnly = envelope.scope.allowedPaths.length === 0;
  const authority = [
    `Task ID: ${envelope.taskId}`,
    `Objective: ${envelope.objective}`,
    `Expected outcome: ${envelope.expectedOutcome}`,
    `Allowed output paths: ${envelope.scope.allowedPaths.join(", ") || "none"}`,
    `Forbidden paths: ${envelope.scope.forbiddenPaths.join(", ") || "none"}`,
    `Instructions: ${envelope.instructions.join(" | ")}`,
    `Constraints: ${envelope.constraints.join(" | ") || "none"}`,
    `Stop conditions: ${envelope.stopConditions.join(" | ")}`,
    "You are the delegated executor, not the coordinating host. Do not accept, integrate, commit, push, tag, publish, or deploy this work.",
    "First inspect the declared capsule context, use available tools to perform the engineering task, and run useful checks. The structured JSON is the final report, not a substitute for doing the task.",
    "The executor-visible task envelope uses a stable virtual repository root for deterministic, privacy-safe identity. Your actual current working directory is the capsule; resolve task paths relative to it.",
    "When .relaypact/context-manifest.json is present, use it only to understand selected context and provenance; never edit task controls under .relaypact.",
    readOnly
      ? "This task has zero write authority. Do not modify the capsule. Report completed when the expected outcome is fully provided in the structured result, with changedFiles set to the empty array."
      : "Do not report completed unless the expected outcome is actually present in the capsule.",
    "If required context or tool execution is unavailable, report blocked with non-empty blocking.code and blocking.message.",
    "When concrete missing task context is the blocker, use blocking.code context_gap and identify only the missing repository-relative dependency or information in blocking.message; do not request self-expansion.",
    "Return only the structured result required by the supplied output schema. Execution completion remains pending host review.",
    "Use exactly these top-level result keys: schemaVersion, taskId, status, summary, changedFiles, validations, residualRisks, blocking.",
    "Do not add reason, message, acceptance, evidence, metadata, or any other top-level field. Put failure details only in blocking.",
    `schemaVersion must be the exact string \"1.0.0\" and taskId must be the exact string ${JSON.stringify(envelope.taskId)}.`,
    "When status is completed, blocking must be the JSON literal null, not a string or object.",
    `Completed-result shape: ${JSON.stringify({
      schemaVersion: "1.0.0",
      taskId: envelope.taskId,
      status: "completed",
      summary: "brief summary",
      changedFiles: readOnly ? [] : ["relative/path"],
      validations: [{ id: "validation-id", status: "passed", summary: "brief summary" }],
      residualRisks: [],
      blocking: null
    })}`
  ];
  if (correction) authority.push(`Correction request ${correction.sequence}: ${correction.prompt}`);
  return `${authority.join("\n")}\n`;
}

function profileArgs(profile) {
  const args = [];
  if (profile.codexProfile) args.push("--profile", profile.codexProfile);
  if (profile.model) args.push("--model", profile.model);
  if (profile.reasoning) args.push("--config", `model_reasoning_effort=\"${profile.reasoning}\"`);
  return args;
}

export function buildCodexExecInvocation({ envelope, profile, capsule, resultPath, correction }) {
  const readOnly = envelope.scope.allowedPaths.length === 0;
  const sandbox = readOnly ? "read-only" : "workspace-write";
  const common = [
    "--json",
    "--output-schema", capsule.resultSchemaPath,
    "--output-last-message", resultPath,
    ...profileArgs(profile)
  ];
  const resumeCommon = common.filter((item, index) => item !== "--profile" && common[index - 1] !== "--profile");
  if (readOnly) resumeCommon.push("--config", 'sandbox_mode="read-only"');
  const args = correction
    ? ["exec", "resume", ...resumeCommon, correction.threadId, "-"]
    : ["exec", ...common, "--sandbox", sandbox, "--cd", capsule.capsuleRoot, "-"];
  return { command: profile.codexCommand, args, input: promptFor(envelope, correction) };
}

async function measureRelaypactDeclaredInput(invocation, resultSchemaPath) {
  const relaypactPromptBytes = Buffer.byteLength(invocation.input, "utf8");
  if (!Number.isSafeInteger(relaypactPromptBytes) || relaypactPromptBytes > MAX_RELAYPACT_PROMPT_BYTES) {
    throw new DelegationError("relaypact_input_too_large", "The RelayPact worker prompt exceeds the declared-input byte bound.");
  }

  let handle;
  try {
    handle = await open(resultSchemaPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || !Number.isSafeInteger(info.size) || info.size < 0) {
      throw new DelegationError("relaypact_input_unavailable", "The RelayPact result schema is not a measurable regular file.");
    }
    if (info.size > MAX_RELAYPACT_RESULT_SCHEMA_BYTES) {
      throw new DelegationError("relaypact_input_too_large", "The RelayPact result schema exceeds the declared-input byte bound.");
    }
    return {
      relaypactPromptBytes,
      relaypactResultSchemaBytes: info.size,
      relaypactDeclaredInputBytes: relaypactPromptBytes + info.size
    };
  } catch (error) {
    if (error instanceof DelegationError) throw error;
    throw new DelegationError("relaypact_input_unavailable", "The RelayPact result schema could not be measured safely.");
  } finally {
    await handle?.close().catch(() => {});
  }
}

export function parseCodexEventStream(stdout, options = {}) {
  const sensitiveValues = Array.isArray(options.sensitiveValues) ? options.sensitiveValues : [];
  let threadId = null;
  let terminalState = null;
  let usage = null;
  let failure = null;
  let eventCount = 0;
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      throw new DelegationError("malformed_codex_event", "Codex emitted a non-JSON event line.");
    }
    eventCount += 1;
    if (event.type === "thread.started" && typeof event.thread_id === "string") threadId = event.thread_id;
    if (event.type === "turn.completed") {
      terminalState = "completed";
      usage = event.usage && typeof event.usage === "object" ? event.usage : null;
    }
    if (event.type === "turn.failed") {
      terminalState = "failed";
      failure = {
        code: typeof event.error?.code === "string"
          ? conciseOutput(event.error.code, 200, sensitiveValues)
          : "codex_turn_failed",
        message: conciseOutput(event.error?.message ?? "The delegated Codex turn failed.", 1000, sensitiveValues)
      };
    }
  }
  return { threadId, terminalState, usage, eventCount, failure };
}

export async function runCodexWorker({ envelope, profile, capsule, statePath = null, correction = null }, options = {}) {
  const runner = options.runProcess ?? runProcess;
  let codexHome;
  try {
    codexHome = profile.provider
      ? await prepareTaskCodexHome(capsule, profile, { ...options, requireDirectConfig: correction !== null })
      : options.codexHome ?? await prepareTaskCodexHome(capsule, profile, options);
  } catch (error) {
    const code = error instanceof DelegationError ? error.code : "codex_home_unavailable";
    const message = error instanceof DelegationError ? error.message : "The task-scoped Codex home could not be prepared.";
    return { threadId: correction?.threadId ?? null, terminalState: "failed", usage: null, eventCount: 0, workerResult: failedWorkerResult(envelope.taskId, code, message) };
  }
  const sequence = correction?.sequence ?? 0;
  const resultPath = path.join(capsule.controlRoot, `worker-result-${sequence}.json`);
  const invocation = buildCodexExecInvocation({ envelope, profile, capsule, resultPath, correction });
  const environmentSource = options.environment ?? process.env;
  let sensitiveValues;
  let environmentGrants;
  let env;
  try {
    const home = path.join(capsule.taskRoot, "worker-home");
    const temporary = path.join(capsule.taskRoot, "worker-tmp");
    await mkdir(home, { recursive: true, mode: 0o700 });
    await mkdir(temporary, { recursive: true, mode: 0o700 });
    environmentGrants = workerEnvironment(profile, environmentSource);
    env = minimalEnvironment(environmentSource, {
      grants: environmentGrants,
      home,
      temporary
    });
    env.CODEX_HOME = codexHome;
    sensitiveValues = await taskSensitiveValues(capsule, profile, environmentSource, environmentGrants);
    if (statePath) {
      const grant = await bindTaskSensitiveGrant(statePath, "worker", sensitiveValues);
      if (!grant.consistent) {
        throw new DelegationError("sensitive_grant_changed", "The worker sensitive-value set changed during the task lifecycle; start a new task.");
      }
    }
  } catch (error) {
    const code = error instanceof DelegationError ? error.code : "worker_environment_unavailable";
    const message = error instanceof DelegationError ? error.message : "The delegated worker environment could not be prepared.";
    return { threadId: correction?.threadId ?? null, terminalState: "failed", usage: null, eventCount: 0, workerResult: failedWorkerResult(envelope.taskId, code, message) };
  }
  let relaypactInput;
  try {
    relaypactInput = await measureRelaypactDeclaredInput(invocation, capsule.resultSchemaPath);
  } catch (error) {
    const code = error instanceof DelegationError ? error.code : "relaypact_input_unavailable";
    const message = error instanceof DelegationError ? error.message : "RelayPact declared input could not be measured safely.";
    return { threadId: correction?.threadId ?? null, terminalState: "failed", usage: null, eventCount: 0, workerResult: failedWorkerResult(envelope.taskId, code, message) };
  }
  let processResult;
  try {
    processResult = await runner(invocation.command, invocation.args, {
      cwd: capsule.capsuleRoot,
      env,
      timeoutMs: envelope.execution?.timeoutMs ?? 30 * 60_000,
      maxCaptureBytes: 8 * 1024 * 1024,
      input: invocation.input
    });
  } catch {
    return { threadId: correction?.threadId ?? null, terminalState: "failed", usage: null, eventCount: 0, relaypactInput, workerResult: failedWorkerResult(envelope.taskId, "codex_start_failed", "The configured Codex executable could not be started.") };
  }

  if (statePath) {
    let grantMatches = false;
    try {
      const currentSensitiveValues = await taskSensitiveValues(capsule, profile, environmentSource, environmentGrants);
      grantMatches = await taskSensitiveGrantMatches(statePath, "worker", currentSensitiveValues);
    } catch {
      grantMatches = false;
    }
    if (!grantMatches) {
      let cleanupVerified = true;
      if (!options.readResultFile) {
        await rm(resultPath, { force: true }).catch(() => { cleanupVerified = false; });
        if (await lstat(resultPath).catch(() => null)) cleanupVerified = false;
      }
      return {
        threadId: correction?.threadId ?? null,
        terminalState: "failed",
        usage: null,
        eventCount: 0,
        relaypactInput,
        workerResult: failedWorkerResult(
          envelope.taskId,
          cleanupVerified ? "sensitive_grant_changed" : "sensitive_evidence_cleanup_failed",
          cleanupVerified
            ? "The worker sensitive-value set changed during execution; start a new task."
            : "Untrusted worker evidence could not be removed safely."
        )
      };
    }
  }

  if (processResult.stdoutTruncated || processResult.stderrTruncated) {
    return {
      threadId: correction?.threadId ?? null,
      terminalState: "failed",
      usage: null,
      eventCount: 0,
      relaypactInput,
      workerResult: failedWorkerResult(envelope.taskId, "codex_output_truncated", "Codex output exceeded the evidence capture bound.")
    };
  }

  let events;
  try {
    events = parseCodexEventStream(processResult.stdout, { sensitiveValues });
  } catch (error) {
    return { threadId: correction?.threadId ?? null, terminalState: "failed", usage: null, eventCount: 0, relaypactInput, workerResult: failedWorkerResult(envelope.taskId, error.code, error.message) };
  }
  const threadId = events.threadId ?? correction?.threadId ?? null;
  if (!threadId) return { ...events, relaypactInput, workerResult: failedWorkerResult(envelope.taskId, "executor_identity_unavailable", "Codex did not emit a delegated thread identity.") };
  if (correction && events.threadId && events.threadId !== correction.threadId) {
    return { ...events, threadId: events.threadId, relaypactInput, workerResult: failedWorkerResult(envelope.taskId, "executor_identity_mismatch", "Codex resumed a different delegated thread.") };
  }
  if (processResult.timedOut) return { ...events, threadId, relaypactInput, workerResult: failedWorkerResult(envelope.taskId, "codex_timeout", "The delegated Codex turn timed out.") };
  if (processResult.signal) return { ...events, threadId, relaypactInput, workerResult: failedWorkerResult(envelope.taskId, "codex_interrupted", "The delegated Codex turn was interrupted.") };
  if (processResult.exitCode !== 0 || events.terminalState !== "completed") {
    return {
      ...events,
      threadId,
      relaypactInput,
      workerResult: failedWorkerResult(
        envelope.taskId,
        events.failure?.code ?? "codex_process_failed",
        events.failure?.message || "The delegated Codex turn did not complete successfully."
      )
    };
  }
  let parsed;
  try {
    if (!options.readResultFile) {
      const resultInfo = await lstat(resultPath);
      if (!resultInfo.isFile() || resultInfo.isSymbolicLink() || resultInfo.size > MAX_WORKER_RESULT_BYTES) {
        throw new DelegationError("malformed_worker_result", "Codex structured output is not a bounded regular file.");
      }
    }
    parsed = JSON.parse(await (options.readResultFile ?? readFile)(resultPath, "utf8"));
    parsed = validateCodexWorkerResult(parsed, envelope.taskId, { sensitiveValues });
    if (!options.readResultFile) {
      await writeFile(resultPath, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await chmod(resultPath, 0o600);
    }
  } catch (error) {
    if (!options.readResultFile) await rm(resultPath, { force: true }).catch(() => {});
    const code = error instanceof DelegationError ? error.code : "malformed_worker_result";
    const message = error instanceof DelegationError ? error.message : "Codex produced malformed structured output.";
    return { ...events, threadId, relaypactInput, workerResult: failedWorkerResult(envelope.taskId, code, message) };
  }
  return { ...events, threadId, relaypactInput, workerResult: parsed, resultPath };
}
