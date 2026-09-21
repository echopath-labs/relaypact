import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DelegationError } from "../../contracts/src/errors.mjs";
import { conciseOutput } from "../../core/src/redact.mjs";
import { runProcess } from "../../core/src/process.mjs";

const EDITIONS = Object.freeze({
  mainland: Object.freeze({ app: "WorkBuddy", bundleId: "com.tencent.workbuddy.mac", productName: "WorkBuddy", applicationName: "WorkBuddy", dataFolderName: ".workbuddy", authId: "workbuddy-desktop" }),
  international: Object.freeze({ app: "WorkBuddy AI", bundleId: "com.workbuddy.workbuddy-ai", productName: "WorkBuddy AI", applicationName: "workbuddy-ai", dataFolderName: ".workbuddy-ai", authId: "workbuddy-desktop-ai" })
});
const ADMITTED_CLI_VERSION = "2.137.1";
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MODEL_HELP_TIMEOUT_MS = 30_000;
const MODEL_HELP_CAPTURE_BYTES = 256 * 1024;
const RISKS = [
  "Native WorkBuddy configuration, plugins and startup services remain harness-owned; startup can write caches and contact services.",
  "The Host-bound model argument and help preflight do not prove provider use, account entitlement, price or free status; model observation remains separate.",
  "Tool selection and task instructions are not OS containment. Host must review repository changes independently; external side effects are not inventoried.",
  "This route is single-shot. Correction requires a fresh bounded delegation; host acceptance and publication are separate decisions."
];

function fail(code) { throw new DelegationError(code, "The selected WorkBuddy installation or configuration could not be verified."); }
export function workBuddyModelId(value) {
  if (typeof value !== "string" || value.length === 0) fail("workbuddy_model_required");
  if (!MODEL_ID.test(value)) fail("workbuddy_model_invalid");
  return value;
}
function selectedEdition(edition) {
  if (!Object.hasOwn(EDITIONS, edition)) fail("workbuddy_edition_required");
  return EDITIONS[edition];
}

export function parseWorkBuddySupportedModels(stdout) {
  if (typeof stdout !== "string" || Buffer.byteLength(stdout, "utf8") > MODEL_HELP_CAPTURE_BYTES) return null;
  const matches = [...stdout.matchAll(/--model <model>[^\r\n]*Currently supported:\s*\(([^\r\n()]*)\)/gu)];
  if (matches.length !== 1) return null;
  const models = matches[0][1].split(",").map((value) => value.trim()).filter(Boolean);
  if (models.length === 0 || models.some((value) => !MODEL_ID.test(value))) return null;
  return [...new Set(models)];
}

function nativeEnvironment(identity, temporaryRoot) {
  return {
    HOME: identity.home, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    TMPDIR: temporaryRoot, LANG: "en_US.UTF-8", CODEBUDDY_DISABLE_COMPILE_CACHE: "1", DO_NOT_TRACK: "1",
    CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS: "1",
    CODEBUDDY_CONFIG_DIR: identity.configDir, WORKBUDDY_CONFIG_DIR: identity.configDir,
    WORKBUDDY_DATA_FOLDER_NAME: identity.dataFolderName
  };
}

export async function inspectWorkBuddyModel(identity, value, options = {}) {
  const model = workBuddyModelId(value);
  let temporaryRoot;
  try {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "relaypact-workbuddy-model-"));
    const result = await (options.runModelProbe ?? runProcess)(process.execPath, [identity.cliPath, "--help"], {
      cwd: temporaryRoot,
      env: nativeEnvironment(identity, temporaryRoot),
      timeoutMs: MODEL_HELP_TIMEOUT_MS,
      maxCaptureBytes: MODEL_HELP_CAPTURE_BYTES,
      signal: options.signal
    });
    if (result.exitCode !== 0 || result.signal || result.timedOut || result.cancelled || result.stdoutTruncated || result.stderrTruncated) {
      fail("workbuddy_model_probe_unavailable");
    }
    const supported = parseWorkBuddySupportedModels(result.stdout);
    if (!supported) fail("workbuddy_model_probe_unavailable");
    if (!supported.includes(model)) fail("workbuddy_model_unsupported");
    return { model, source: "native_help", supported: true };
  } finally {
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true }).catch(() => {});
  }
}
async function boundedFile(file, limit) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit) fail("workbuddy_identity_invalid");
  const content = await readFile(file);
  if (content.length > limit) fail("workbuddy_identity_invalid");
  return content;
}

// Only distribution metadata is inspected. Authentication/settings files are loaded by WorkBuddy itself.
export async function inspectWorkBuddy(options = {}) {
  const expected = selectedEdition(options.edition);
  if ((options.platform ?? process.platform) !== "darwin") fail("workbuddy_platform_unsupported");
  try {
    const app = await realpath(options.appPath ?? `/Applications/${expected.app}.app`);
    const cli = path.join(app, "Contents/Resources/app.asar.unpacked/cli");
    const parts = ["Contents/Info.plist", "Contents/Resources/app.asar.unpacked/cli/product.json", "Contents/Resources/app.asar.unpacked/cli/package.json", "Contents/Resources/app.asar.unpacked/cli/bin/codebuddy", "Contents/Resources/app.asar.unpacked/cli/dist/codebuddy-headless.js"];
    const contents = [];
    for (const relative of parts) {
      const file = path.join(app, relative);
      if (await realpath(file) !== file) fail("workbuddy_identity_invalid");
      contents.push(await boundedFile(file, relative.endsWith("codebuddy-headless.js") ? 64 * 1024 * 1024 : 1024 * 1024));
    }
    const plist = contents[0].toString("utf8");
    const bundleId = plist.match(/<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/u)?.[1];
    const product = JSON.parse(contents[1]);
    const pkg = JSON.parse(contents[2]);
    if (bundleId !== expected.bundleId || ["productName", "applicationName", "dataFolderName"].some((key) => product[key] !== expected[key]) ||
        product.authentication?.id !== expected.authId || product.authentication?.type !== "cli-external-link" ||
        (options.edition === "international" ? product.isOversea !== true : product.isOversea === true)) fail("workbuddy_edition_mismatch");
    const version = pkg.publishConfig?.customPackage?.version;
    if (version !== ADMITTED_CLI_VERSION) fail("workbuddy_version_unverified");
    const home = await realpath(options.home ?? os.homedir());
    const configDir = path.join(home, expected.dataFolderName);
    const configInfo = await lstat(configDir).catch(() => fail("workbuddy_configuration_unavailable"));
    if (!configInfo.isDirectory() || configInfo.isSymbolicLink() || await realpath(configDir) !== configDir) fail("workbuddy_configuration_unavailable");
    const hash = createHash("sha256");
    for (const content of contents) { hash.update(String(content.length)); hash.update(":"); hash.update(content); }
    return { edition: options.edition, appPath: app, cliPath: path.join(cli, "bin/codebuddy"), home, configDir, dataFolderName: expected.dataFolderName, version, fingerprint: hash.digest("hex") };
  } catch (error) {
    if (error instanceof DelegationError) throw error;
    fail("workbuddy_installation_unavailable");
  }
}

export async function discoverWorkBuddy(options = {}) {
  try {
    const identity = await inspectWorkBuddy(options);
    const model = options.model === undefined ? null : await inspectWorkBuddyModel(identity, options.model, options);
    return { state: "available", edition: identity.edition, version: identity.version,
      authentication: "unverified",
      model: model ? model.model : "native configuration; current desktop conversation selection is not asserted",
      modelPreflight: model ? "supported_by_native_help" : "not_requested",
      capabilities: ["single-shot", "read-only", "file-edit"], resumable: false,
      limitations: model
        ? ["The native help probe sends no task prompt but can contact native services or update caches.", "Model support does not prove login, account entitlement, provider use, price or free status."]
        : ["Authentication and the model used by a future fresh task remain unverified."] };
  } catch (error) {
    return { state: "blocked", reason: error instanceof DelegationError ? error.code : "workbuddy_installation_unavailable", authentication: "unverified" };
  }
}

export function parseWorkBuddyResult(stdout) {
  let records;
  try { records = JSON.parse(stdout); } catch { return null; }
  if (!Array.isArray(records) || records.length === 0 || records.some((item) => !item || typeof item !== "object" || Array.isArray(item))) return null;
  const terminals = records.filter((item) => item.type === "result");
  if (terminals.length !== 1 || records.at(-1) !== terminals[0]) return null;
  const terminal = terminals[0];
  if (terminal.subtype !== "success" || terminal.is_error !== false) return { status: "failed" };
  if (!Array.isArray(terminal.permission_denials)) return null;
  if (terminal.permission_denials.length > 0) return { status: "blocked" };
  if (typeof terminal.result !== "string") return null;
  let payload;
  try { payload = JSON.parse(terminal.result.trim().split("\n").at(-1)); } catch { return null; }
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || !["completed", "blocked", "failed"].includes(payload.status) || typeof payload.summary !== "string" || !payload.summary.trim()) return null;
  // Only the explicit task delivery is eligible for redaction and bounded display; never forward the transcript or provider metadata.
  const reportedModelFields = ["model", "model_name"].filter((key) => Object.hasOwn(terminal, key));
  if (reportedModelFields.some((key) => typeof terminal[key] !== "string" || !MODEL_ID.test(terminal[key]))) return null;
  const reportedModels = [...new Set(reportedModelFields.map((key) => terminal[key]))];
  if (reportedModels.length > 1) return null;
  const reportedModel = reportedModels[0];
  return { status: payload.status, summary: payload.summary, ...(reportedModel ? { model: reportedModel } : {}) };
}

function unavailableModelObservation() {
  return { state: "unavailable", value: null, source: "unavailable", assurance: "unknown", observedAt: new Date().toISOString() };
}

function reportedModelObservation(value) {
  return { state: "observed", value, source: "executor_event", assurance: "reported", observedAt: new Date().toISOString() };
}

function outcome(reportedStatus, summary, processResult = {}, failureCode, modelBinding, modelObservation = unavailableModelObservation()) {
  return { reportedStatus, summary, residualRisks: [...RISKS], exitCode: processResult.exitCode ?? null,
    signal: processResult.signal ?? null, ...(failureCode ? { failureCode } : {}),
    ...(modelBinding ? { modelBinding } : {}), modelObservation };
}

async function permissionSettings(envelope, readOnly) {
  const root = await realpath(envelope.repository.root);
  if (/[\[\]{}()!*?\\\r\n]/u.test(root)) fail("workbuddy_scope_unsupported");
  const readPatterns = envelope.scope.readablePaths ?? envelope.scope.allowedPaths;
  const writePatterns = readOnly ? [] : envelope.scope.allowedPaths;
  const denyPatterns = [...new Set([...envelope.scope.forbiddenPaths, ".git/**", ".relaypact/**"])];
  function rule(tool, pattern) {
    // Native gitignore patterns have more syntax than the neutral matcher. Do not broaden it silently.
    if (/[\[\]{}()!\\\r\n]/u.test(pattern)) fail("workbuddy_scope_unsupported");
    return `${tool}(/${path.join(root, pattern)})`;
  }
  return { permissions: {
    allow: [...readPatterns.map((p) => rule("Read", p)), ...writePatterns.map((p) => rule("Write", p))],
    // Native dontAsk otherwise auto-allows reads in the working directory.
    // Ask follows explicit allow rules and is denied by the noninteractive harness.
    ask: [rule("Read", "**")],
    deny: [...denyPatterns.flatMap((p) => [rule("Read", p), rule("Write", p)]), ...(readOnly ? [rule("Write", "**")] : [])]
  } };
}

export async function runExecutor(envelope, options = {}) {
  options = { ...options };
  let model;
  try { model = workBuddyModelId(options.model); }
  catch (error) {
    return outcome("blocked", "WorkBuddy requires one exact Host-selected model.", {}, error instanceof DelegationError ? error.code : "workbuddy_model_invalid");
  }
  if (envelope.execution?.exposureMode === "sanitized" || envelope.contextPlanning) {
    return outcome("blocked", "WorkBuddy uses a native trusted worktree; sanitized capsules and context planning are not supported.", {}, "workbuddy_exposure_unsupported");
  }
  if (options.resumeSessionId || options.correctionPrompt || envelope.executionProfile) {
    return outcome("blocked", "WorkBuddy requires a fresh task using the selected native desktop configuration.", {}, "workbuddy_fresh_task_required");
  }
  let temporaryRoot;
  let modelBinding;
  try {
    options.signal?.throwIfAborted();
    const identity = await inspectWorkBuddy(options);
    await inspectWorkBuddyModel(identity, model, options);
    const workingDirectory = await realpath(options.workingDirectory);
    const nativeEnvelope = { ...envelope, repository: { ...envelope.repository, root: await realpath(envelope.repository.root) } };
    const settings = await permissionSettings(nativeEnvelope, options.readOnly === true);
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "relaypact-workbuddy-runtime-"));
    const env = nativeEnvironment(identity, temporaryRoot);
    const tools = options.readOnly === true ? "Read" : "Read,Write";
    const prompt = [
      "You are a bounded delegated executor using WorkBuddy's native harness. Follow this Host agreement.",
      "Read only context needed for the objective; change only allowed paths. Do not access credentials, publish, commit, delegate, or widen authority.",
      "Commands and external tools are unavailable. Host runs validation independently. If required authority/context is absent, report blocked.",
      options.readOnly === true ? "This invocation is read-only. Do not change files." : "Only Read and Write are available for this bounded file task.",
      "End with exactly one compact JSON object on the last line: {\"status\":\"completed|blocked|failed\",\"summary\":\"brief result\"}. No markdown fence.",
      JSON.stringify(nativeEnvelope)
    ].join("\n\n");
    const args = [identity.cliPath, "--print", prompt, "--output-format", "json", "--tools", tools,
      "--model", model,
      "--permission-mode", "dontAsk", "--settings", JSON.stringify(settings),
      "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--no-session-persistence"];
    await options.beforeVerifiedLaunch?.();
    const current = await inspectWorkBuddy({ ...options, appPath: identity.appPath, home: identity.home });
    if (current.fingerprint !== identity.fingerprint || current.configDir !== identity.configDir) fail("workbuddy_identity_changed");
    options.signal?.throwIfAborted();
    const bindModel = () => {
      modelBinding ??= {
        value: model, source: "host_argument", mechanism: "process_argument",
        assurance: "preflight_supported", fallbackAllowed: false, boundAt: new Date().toISOString()
      };
    };
    const taskRun = (options.runProcess ?? runProcess)(process.execPath, args, {
      cwd: workingDirectory, env, timeoutMs: envelope.execution?.timeoutMs ?? 120_000,
      maxCaptureBytes: 2 * 1024 * 1024, signal: options.signal, onSpawn: bindModel
    });
    const result = await taskRun;
    bindModel();
    if (result.timedOut || result.cancelled || result.signal || result.stdoutTruncated || result.stderrTruncated) {
      return outcome("failed", "WorkBuddy did not complete within the process and evidence bounds.", result, "workbuddy_process_failed", modelBinding);
    }
    if (/Authentication (?:required|failed)\. Please use \/login/u.test(result.stderr ?? "")) {
      return outcome("blocked", "The selected WorkBuddy native login is unavailable.", result, "workbuddy_authentication_unavailable", modelBinding);
    }
    if (result.exitCode !== 0) {
      return outcome("failed", "WorkBuddy exited unsuccessfully.", result, "workbuddy_process_failed", modelBinding);
    }
    const parsed = parseWorkBuddyResult(result.stdout);
    if (!parsed) return outcome("malformed", "WorkBuddy did not return the required terminal task result.", result, "workbuddy_result_invalid", modelBinding);
    const observation = parsed.model ? reportedModelObservation(parsed.model) : unavailableModelObservation();
    if (parsed.model && parsed.model !== model) {
      return outcome("failed", "WorkBuddy reported a model different from the Host-bound model.", result, "workbuddy_model_mismatch", modelBinding, observation);
    }
    return outcome(parsed.status, parsed.summary ? conciseOutput(parsed.summary, 4000, options.redactionValues) : `WorkBuddy reported ${parsed.status}; Host checks and acceptance remain independent.`, result, undefined, modelBinding, observation);
  } catch (error) {
    return outcome(options.signal?.aborted ? "failed" : "blocked", "WorkBuddy execution could not start with the selected identity and authority.", {}, error instanceof DelegationError ? error.code : "workbuddy_launch_failed", modelBinding);
  } finally {
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true }).catch(() => {});
  }
}
