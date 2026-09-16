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
const RISKS = [
  "Native WorkBuddy configuration, plugins and startup services remain harness-owned; startup can write caches and contact services.",
  "Tool selection and task instructions are not OS containment. Host must review repository changes independently; external side effects are not inventoried.",
  "This route is single-shot. Correction requires a fresh bounded delegation; host acceptance and publication are separate decisions."
];

function fail(code) { throw new DelegationError(code, "The selected WorkBuddy installation or configuration could not be verified."); }
function selectedEdition(edition) {
  if (!Object.hasOwn(EDITIONS, edition)) fail("workbuddy_edition_required");
  return EDITIONS[edition];
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
    return { state: "available", edition: identity.edition, version: identity.version,
      authentication: "unverified", model: "native configuration; current desktop conversation selection is not asserted",
      capabilities: ["single-shot", "read-only", "file-edit"], resumable: false };
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
  return { status: payload.status, summary: payload.summary };
}

function outcome(reportedStatus, summary, processResult = {}, failureCode) {
  return { reportedStatus, summary, residualRisks: [...RISKS], exitCode: processResult.exitCode ?? null,
    signal: processResult.signal ?? null, ...(failureCode ? { failureCode } : {}),
    modelObservation: { state: "unavailable", value: null, source: "unavailable", assurance: "unknown", observedAt: new Date().toISOString() } };
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
  if (envelope.execution?.exposureMode === "sanitized" || envelope.contextPlanning) {
    return outcome("blocked", "WorkBuddy uses a native trusted worktree; sanitized capsules and context planning are not supported.", {}, "workbuddy_exposure_unsupported");
  }
  if (options.resumeSessionId || options.correctionPrompt || envelope.executionProfile) {
    return outcome("blocked", "WorkBuddy requires a fresh task using the selected native desktop configuration.", {}, "workbuddy_fresh_task_required");
  }
  let temporaryRoot;
  try {
    options.signal?.throwIfAborted();
    const identity = await inspectWorkBuddy(options);
    const workingDirectory = await realpath(options.workingDirectory);
    const nativeEnvelope = { ...envelope, repository: { ...envelope.repository, root: await realpath(envelope.repository.root) } };
    const settings = await permissionSettings(nativeEnvelope, options.readOnly === true);
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "relaypact-workbuddy-runtime-"));
    const env = {
      HOME: identity.home, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
      TMPDIR: temporaryRoot, LANG: "en_US.UTF-8", CODEBUDDY_DISABLE_COMPILE_CACHE: "1", DO_NOT_TRACK: "1",
      CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS: "1",
      CODEBUDDY_CONFIG_DIR: identity.configDir, WORKBUDDY_CONFIG_DIR: identity.configDir,
      WORKBUDDY_DATA_FOLDER_NAME: identity.dataFolderName
    };
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
      "--permission-mode", "dontAsk", "--settings", JSON.stringify(settings),
      "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--no-session-persistence"];
    await options.beforeVerifiedLaunch?.();
    const current = await inspectWorkBuddy({ ...options, appPath: identity.appPath, home: identity.home });
    if (current.fingerprint !== identity.fingerprint || current.configDir !== identity.configDir) fail("workbuddy_identity_changed");
    options.signal?.throwIfAborted();
    const result = await (options.runProcess ?? runProcess)(process.execPath, args, {
      cwd: workingDirectory, env, timeoutMs: envelope.execution?.timeoutMs ?? 120_000,
      maxCaptureBytes: 2 * 1024 * 1024, signal: options.signal
    });
    if (result.timedOut || result.cancelled || result.signal || result.stdoutTruncated || result.stderrTruncated) {
      return outcome("failed", "WorkBuddy did not complete within the process and evidence bounds.", result, "workbuddy_process_failed");
    }
    if (/Authentication (?:required|failed)\. Please use \/login/u.test(result.stderr ?? "")) {
      return outcome("blocked", "The selected WorkBuddy native login is unavailable.", result, "workbuddy_authentication_unavailable");
    }
    if (result.exitCode !== 0) {
      return outcome("failed", "WorkBuddy exited unsuccessfully.", result, "workbuddy_process_failed");
    }
    const parsed = parseWorkBuddyResult(result.stdout);
    if (!parsed) return outcome("malformed", "WorkBuddy did not return the required terminal task result.", result, "workbuddy_result_invalid");
    return outcome(parsed.status, parsed.summary ? conciseOutput(parsed.summary, 4000, options.redactionValues) : `WorkBuddy reported ${parsed.status}; Host checks and acceptance remain independent.`, result);
  } catch (error) {
    return outcome(options.signal?.aborted ? "failed" : "blocked", "WorkBuddy execution could not start with the selected identity and authority.", {}, error instanceof DelegationError ? error.code : "workbuddy_launch_failed");
  } finally {
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true }).catch(() => {});
  }
}
