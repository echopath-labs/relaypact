import os from "node:os";
import path from "node:path";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, realpath, writeFile } from "node:fs/promises";
import { createIsolatedEnvironment } from "../../core/src/environment.mjs";
import { DelegationError } from "../../contracts/src/errors.mjs";
import {
  conciseOutput,
  SensitiveUrlDecodeBudgetError,
  SensitiveUrlEncodingError,
  sensitiveUrlValues
} from "../../core/src/redact.mjs";
import { runProcess } from "../../core/src/process.mjs";

const EXECUTOR_STATUSES = new Set(["completed", "blocked", "failed"]);
const EXECUTOR_SECURITY = Symbol("executorSecurity");
const MAX_PI_CONFIG_BYTES = 1024 * 1024;
const ENVIRONMENT_REFERENCE = /^[A-Z_][A-Z0-9_]*$/u;
const AUTH_ENVIRONMENT_REFERENCE = /^\$(?:\{([A-Z_][A-Z0-9_]*)\}|([A-Z_][A-Z0-9_]*))$/u;

function attachExecutorSecurity(result, evidence) {
  Object.defineProperty(result, EXECUTOR_SECURITY, { value: evidence, enumerable: false });
  return result;
}

export function executorSecurityEvidence(result) {
  return result?.[EXECUTOR_SECURITY] ?? { sensitiveValues: [], credentialEvidenceTrusted: false };
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function addSensitiveLiteral(value, output) {
  output.push(value);
  if (/^https?:\/\//iu.test(value)) {
    try {
      output.push(...sensitiveUrlValues(value));
    } catch (error) {
      if (error instanceof SensitiveUrlDecodeBudgetError) {
        throw new DelegationError(
          "pi_config_projection_unsupported",
          "Pi selected sensitive value exceeds the supported URL path decoding bound."
        );
      }
      if (error instanceof SensitiveUrlEncodingError) {
        throw new DelegationError(
          "pi_config_projection_unsupported",
          "Pi selected sensitive value contains unsupported URL path encoding."
        );
      }
      // Non-URL credential text remains covered by its exact literal value.
    }
  }
}

function projectPiAuthCredential(value, explicitGrants, sensitiveValues) {
  if (!plainObject(value) || value.type !== "api_key" || typeof value.key !== "string") {
    throw new DelegationError(
      "pi_config_projection_unsupported",
      "Pi delegated execution supports only selected api_key authentication with an inventoriable key."
    );
  }
  const unknown = Object.keys(value).filter((key) => !["type", "key"].includes(key));
  if (unknown.length > 0 || value.key.length === 0 || value.key.includes("\0") || value.key.startsWith("!")) {
    throw new DelegationError(
      "pi_config_projection_unsupported",
      "Pi selected authentication uses unsupported resolver or provider-specific semantics."
    );
  }
  const reference = value.key.match(AUTH_ENVIRONMENT_REFERENCE);
  if (reference) {
    const name = reference[1] ?? reference[2];
    const resolved = explicitGrants[name];
    if (typeof resolved !== "string" || resolved.length === 0 || resolved.includes("\0")) {
      throw new DelegationError(
        "pi_config_projection_unsupported",
        "Pi authentication environment references must be explicit executor grants."
      );
    }
    addSensitiveLiteral(resolved, sensitiveValues);
  } else {
    if (value.key.includes("$")) {
      throw new DelegationError(
        "pi_config_projection_unsupported",
        "Pi authentication interpolation and escape syntax is not supported by delegated execution."
      );
    }
    addSensitiveLiteral(value.key, sensitiveValues);
  }
  return { type: "api_key", key: value.key };
}

function snapshotEnvironmentGrants(value) {
  if (!plainObject(value)) {
    throw new DelegationError("invalid_environment_grant", "Executor environment grants must be a name-value object.");
  }
  return Object.freeze(Object.fromEntries(Object.entries(value)));
}

function validateProjectedProviderUrls(value, sensitiveValues) {
  if (Array.isArray(value)) {
    value.forEach((item) => validateProjectedProviderUrls(item, sensitiveValues));
    return;
  }
  if (!plainObject(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (key.toLowerCase() === "baseurl" && typeof item === "string") {
      let parsed;
      try {
        parsed = new URL(item);
      } catch {
        throw new DelegationError("pi_config_projection_unsupported", "Pi provider baseUrl must be a valid URL.");
      }
      if (parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new DelegationError(
          "pi_config_projection_unsupported",
          "Pi provider baseUrl must not contain credentials, query parameters, or fragments."
        );
      }
      try {
        sensitiveValues.push(...sensitiveUrlValues(item));
      } catch (error) {
        if (error instanceof SensitiveUrlDecodeBudgetError) {
          throw new DelegationError(
            "pi_config_projection_unsupported",
            "Pi provider baseUrl exceeds the supported URL path decoding bound."
          );
        }
        if (error instanceof SensitiveUrlEncodingError) {
          throw new DelegationError(
            "pi_config_projection_unsupported",
            "Pi provider baseUrl contains unsupported URL path encoding."
          );
        }
        throw error;
      }
    }
    validateProjectedProviderUrls(item, sensitiveValues);
  }
}

async function readBoundedJson(file, label, { optional = false } = {}) {
  let before;
  try {
    before = await lstat(file);
  } catch (error) {
    if (optional && error?.code === "ENOENT") return null;
    throw new DelegationError("pi_config_projection_unsupported", `${label} is unavailable.`);
  }
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_PI_CONFIG_BYTES) {
    throw new DelegationError("pi_config_projection_unsupported", `${label} has an unsafe type or size.`);
  }
  let handle;
  try {
    handle = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs) {
      throw new DelegationError("pi_config_projection_unsupported", `${label} changed while it was projected.`);
    }
    const content = await handle.readFile({ encoding: "utf8" });
    const after = await handle.stat();
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new DelegationError("pi_config_projection_unsupported", `${label} changed while it was projected.`);
    }
    const parsed = JSON.parse(content);
    if (!plainObject(parsed)) throw new Error("expected object");
    return parsed;
  } catch (error) {
    if (error instanceof DelegationError) throw error;
    throw new DelegationError("pi_config_projection_unsupported", `${label} is not safe JSON.`);
  } finally {
    await handle?.close().catch(() => {});
  }
}

function collectModelCredentialValues(value, explicitGrants, output, credentialContext = false) {
  if (typeof value === "string") {
    if (!credentialContext) return;
    if (value.startsWith("!")) {
      throw new DelegationError("pi_config_projection_unsupported", "Pi shell-based credential resolvers are not supported by delegated execution.");
    }
    if (ENVIRONMENT_REFERENCE.test(value)) {
      if (typeof explicitGrants[value] !== "string") {
        throw new DelegationError("pi_config_projection_unsupported", "Pi credential environment references must be explicit executor grants.");
      }
      addSensitiveLiteral(explicitGrants[value], output);
    } else {
      addSensitiveLiteral(value, output);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectModelCredentialValues(item, explicitGrants, output, credentialContext));
    return;
  }
  if (!plainObject(value)) return;
  for (const [key, item] of Object.entries(value)) {
    const sensitive = credentialContext || /api.?key|token|secret|password|credential|authorization|headers?/iu.test(key);
    collectModelCredentialValues(item, explicitGrants, output, sensitive);
  }
}

async function materializePiProjection({ sourceDirectory, destination, envelope, explicitGrants }) {
  let source = null;
  try {
    const sourceInfo = await lstat(sourceDirectory);
    if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) {
      throw new DelegationError("pi_config_projection_unsupported", "Pi configuration root must be a real directory.");
    }
    source = await realpath(sourceDirectory);
  } catch (error) {
    if (error instanceof DelegationError) throw error;
    if (error?.code !== "ENOENT") throw error;
  }
  const settings = source
    ? await readBoundedJson(path.join(source, "settings.json"), "Pi settings", { optional: true }) ?? {}
    : {};
  const auth = source
    ? await readBoundedJson(path.join(source, "auth.json"), "Pi authentication", { optional: true }) ?? {}
    : {};
  const models = source
    ? await readBoundedJson(path.join(source, "models.json"), "Pi model registry", { optional: true }) ?? {}
    : {};
  const profile = plainObject(envelope.executionProfile) ? envelope.executionProfile : {};
  const authProviders = Object.keys(auth);
  const provider = profile.provider ?? settings.defaultProvider ?? (authProviders.length === 1 ? authProviders[0] : null);
  if (provider !== null && (typeof provider !== "string" || provider.trim().length === 0)) {
    throw new DelegationError("pi_config_projection_unsupported", "Pi provider selection is invalid.");
  }
  if (!provider && (authProviders.length > 0 || Object.keys(models.providers ?? {}).length > 0)) {
    throw new DelegationError("pi_config_projection_unsupported", "Pi delegated execution requires one explicit or configured default provider.");
  }
  const sensitiveValues = [];
  const projectedAuth = provider && Object.hasOwn(auth, provider)
    ? Object.fromEntries([[provider, projectPiAuthCredential(auth[provider], explicitGrants, sensitiveValues)]])
    : {};
  const selectedProvider = provider && plainObject(models.providers) && Object.hasOwn(models.providers, provider)
    ? models.providers[provider]
    : null;
  const projectedModels = selectedProvider === null
    ? null
    : { providers: Object.fromEntries([[provider, selectedProvider]]) };
  const projectedSettings = {};
  const resolvedModel = profile.model ?? settings.defaultModel;
  const resolvedReasoning = profile.reasoning ?? settings.defaultThinkingLevel;
  if (!provider || typeof resolvedModel !== "string" || resolvedModel.length === 0) {
    throw new DelegationError(
      "pi_config_projection_unsupported",
      "Pi delegated execution requires a resolved provider and model before launch."
    );
  }
  for (const [key, value] of [
    ["defaultProvider", provider],
    ["defaultModel", resolvedModel],
    ["defaultThinkingLevel", resolvedReasoning]
  ]) {
    if (typeof value === "string" && value.length > 0) projectedSettings[key] = value;
  }
  if (selectedProvider !== null) {
    validateProjectedProviderUrls(selectedProvider, sensitiveValues);
    collectModelCredentialValues(selectedProvider, explicitGrants, sensitiveValues);
  }
  await mkdir(destination, { mode: 0o700 });
  const expected = new Map();
  for (const [name, value] of [
    ["auth.json", projectedAuth],
    ["settings.json", projectedSettings],
    ...(projectedModels === null ? [] : [["models.json", projectedModels]])
  ]) {
    const content = `${JSON.stringify(value, null, 2)}\n`;
    const file = path.join(destination, name);
    await writeFile(file, content, { flag: "wx", mode: 0o600 });
    await chmod(file, 0o600);
    expected.set(name, content);
  }
  return {
    directory: destination,
    expected,
    route: { provider, model: resolvedModel, reasoning: typeof resolvedReasoning === "string" ? resolvedReasoning : null },
    sensitiveValues: [...new Set(sensitiveValues.filter((value) => typeof value === "string" && value.length > 0))]
  };
}

async function verifyPiProjection(projection) {
  for (const [name, expected] of projection.expected) {
    const file = path.join(projection.directory, name);
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_PI_CONFIG_BYTES) return false;
      if (await readFile(file, "utf8") !== expected) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function parseExecutorPayload(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  // Text mode returns the final answer, not an event stream. Consume the whole
  // answer so conflicting objects or trailing partial output cannot be ignored.
  const fence = /^```(?:json)?[\t ]*\r?\n([\s\S]*?)\r?\n```$/u.exec(trimmed);
  try {
    const payload = JSON.parse(fence ? fence[1] : trimmed);
    return payload && typeof payload === "object" && !Array.isArray(payload) &&
      EXECUTOR_STATUSES.has(payload.status) && typeof payload.summary === "string"
      ? payload : null;
  } catch {
    return null;
  }
}

function buildPrompt(envelope) {
  return [
    "You are the Delegated Executor. Execute only within the following envelope.",
    "Stop with status blocked if information or authority is missing.",
    "Do not commit, push, widen scope, or expose credentials.",
    envelope.scope.allowedPaths.length === 0
      ? "This task has zero write authority. Do not change files; write-capable tools are unavailable."
      : "Change only the explicitly allowed output paths.",
    "Your final response must be exactly one JSON object with status (completed|blocked|failed), a string summary, and optional residualRisks.",
    "Do not add prose, Markdown fences, or additional JSON objects. Put any explanation inside summary or residualRisks.",
    JSON.stringify(envelope, null, 2)
  ].join("\n\n");
}

function buildPiArgs(envelope, route) {
  const tools = envelope.scope.allowedPaths.length === 0
    ? "read,grep,find,ls"
    : "read,bash,edit,write,grep,find,ls";
  const args = [
    "--print",
    // Pi text mode emits only the final assistant response. JSON mode emits
    // the whole event stream, which can exhaust the bounded evidence capture.
    "--mode", "text",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--no-approve",
    "--tools", tools
  ];
  args.push("--provider", route.provider, "--model", route.model);
  if (route.reasoning) args.push("--thinking", route.reasoning);
  args.push(buildPrompt(envelope));
  return args;
}

function processMetadata(result = {}) {
  return {
    exitCode: result.exitCode ?? null,
    signal: result.signal ?? null,
    timedOut: result.timedOut === true,
    hardKilled: result.hardKilled === true,
    groupCleanupAttempted: result.groupCleanupAttempted === true,
    stdoutTruncated: result.stdoutTruncated === true,
    stderrTruncated: result.stderrTruncated === true
  };
}

export async function runExecutor(envelope, options) {
  const command = options.executorCommand ?? "pi";
  const environmentSource = options.environment ?? process.env;
  const explicitGrants = snapshotEnvironmentGrants(options.executorEnv ?? {});
  let sensitiveValues = Object.values(explicitGrants)
    .filter((value) => typeof value === "string" && value.length > 0);
  const piConfigDirectory = explicitGrants.PI_CODING_AGENT_DIR
    ?? environmentSource.PI_CODING_AGENT_DIR
    ?? path.join(os.homedir(), ".pi", "agent");
  let isolated;
  let processResult;
  let projection;
  let credentialEvidenceTrusted = false;
  const finish = (result) => attachExecutorSecurity(result, { sensitiveValues, credentialEvidenceTrusted });
  try {
    isolated = await createIsolatedEnvironment(environmentSource, {
      prefix: "relaypact-pi-",
      grants: { ...explicitGrants, GIT_OPTIONAL_LOCKS: "0" }
    });
    projection = await materializePiProjection({
      sourceDirectory: piConfigDirectory,
      destination: path.join(isolated.root, "agent"),
      envelope,
      explicitGrants
    });
    sensitiveValues = [...new Set([...sensitiveValues, ...projection.sensitiveValues])];
    isolated.env.PI_CODING_AGENT_DIR = projection.directory;
    isolated.env.PI_CODING_AGENT_SESSION_DIR = isolated.temporary;
    credentialEvidenceTrusted = await verifyPiProjection(projection);
    if (!credentialEvidenceTrusted) {
      throw new DelegationError("pi_config_projection_unsupported", "Pi task configuration changed before executor launch.");
    }
    processResult = await runProcess(command, buildPiArgs(envelope, projection.route), {
      cwd: options.workingDirectory,
      env: isolated.env,
      timeoutMs: envelope.execution?.timeoutMs ?? 900_000
    });
    credentialEvidenceTrusted = await verifyPiProjection(projection);
  } catch (error) {
    return finish({
      reportedStatus: "failed",
      summary: conciseOutput(`Executor could not start: ${error.message}`, 4000, sensitiveValues),
      residualRisks: [],
      exitCode: null,
      signal: null,
      timedOut: false,
      output: ""
    });
  } finally {
    await isolated?.cleanup();
  }

  if (!credentialEvidenceTrusted) {
    return finish({
      reportedStatus: "failed",
      summary: "Executor authentication changed during delegated execution.",
      residualRisks: [],
      ...processMetadata(processResult),
      output: ""
    });
  }

  const combinedOutput = conciseOutput(`${processResult.stdout}\n${processResult.stderr}`, 4000, sensitiveValues);
  const metadata = processMetadata(processResult);
  if (processResult.stdoutTruncated || processResult.stderrTruncated) {
    return finish({ reportedStatus: "failed", summary: "Executor output exceeded the evidence capture bound.", residualRisks: [], ...metadata, output: combinedOutput });
  }
  if (processResult.timedOut) {
    return finish({ reportedStatus: "failed", summary: "Executor timed out.", residualRisks: [], ...metadata, output: combinedOutput });
  }
  if (processResult.exitCode !== 0 || processResult.signal) {
    return finish({ reportedStatus: "failed", summary: combinedOutput || "Executor process failed.", residualRisks: [], ...metadata, output: combinedOutput });
  }

  const payload = parseExecutorPayload(processResult.stdout);
  if (!payload) {
    return finish({ reportedStatus: "malformed", summary: "Executor final output must be one JSON result object, bare or in a single JSON fence, without surrounding prose.", residualRisks: [], ...metadata, output: combinedOutput });
  }
  return finish({
    reportedStatus: payload.status,
    summary: conciseOutput(payload.summary, 4000, sensitiveValues),
    residualRisks: Array.isArray(payload.residualRisks) ? payload.residualRisks.map((item) => conciseOutput(item, 4000, sensitiveValues)) : [],
    ...metadata,
    output: combinedOutput
  });
}
