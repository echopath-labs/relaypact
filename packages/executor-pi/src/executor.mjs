import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, chmod, copyFile, cp, lstat, mkdir, open, readFile, readlink, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { createIsolatedEnvironment, minimalEnvironment } from "../../core/src/environment.mjs";
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
const MAX_PI_EXECUTABLE_BYTES = 256 * 1024 * 1024;
const MAX_PI_BUNDLE_BYTES = 512 * 1024 * 1024;
const MAX_PI_BUNDLE_FILES = 30_000;
const MAX_PI_BUNDLE_DEPTH = 32;
const PI_PROBE_TIMEOUT_MS = 5_000;
const PI_PROBE_CAPTURE_BYTES = 256 * 1024;
export const MINIMUM_PI_VERSION = "0.84.0";
const REQUIRED_PI_FLAGS = Object.freeze([
  "--print", "--mode", "--no-session", "--no-extensions", "--no-skills",
  "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve",
  "--tools", "--provider", "--model", "--thinking"
]);
const SETTINGS_WRITE_FAILURE = /(?:(?:EPERM|EACCES|EROFS|permission denied|operation not permitted)[^\r\n]*(?:settings\.json\.lock|global settings)|(?:settings\.json\.lock|global settings)[^\r\n]*(?:EPERM|EACCES|EROFS|permission denied|operation not permitted))/iu;
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

function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function parsePiVersion(output) {
  return output.match(/(?:^|\s)(\d+\.\d+\.\d+)(?:[-+][A-Za-z0-9._-]+)?(?:\s|$)/u)?.[1] ?? null;
}

function commandCandidates(command, environment) {
  if (path.isAbsolute(command)) return [command];
  if (command.includes("/") || command.includes("\\")) return [];
  const directories = String(environment.PATH ?? "").split(path.delimiter).filter(Boolean);
  const extensions = process.platform === "win32"
    ? String(environment.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
    : [""];
  return directories.filter(path.isAbsolute)
    .flatMap((directory) => extensions.map((extension) => path.join(directory, `${command}${extension}`)));
}

async function executableFingerprint(file) {
  const handle = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_PI_EXECUTABLE_BYTES) return null;
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    return `sha256:${hash.digest("hex")}`;
  } finally {
    await handle.close().catch(() => {});
  }
}

async function firstLine(file) {
  const handle = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/u, 1)[0];
  } finally {
    await handle.close().catch(() => {});
  }
}

async function collectPiBundle(root, relative = "", depth = 0, state = null) {
  if (!state) state = { entries: [], bytes: 0, canonicalRoot: await realpath(root) };
  if (depth > MAX_PI_BUNDLE_DEPTH) throw new Error("Pi package exceeds the supported directory depth.");
  const directory = path.join(root, relative);
  for (const name of (await readdir(directory)).sort()) {
    const nextRelative = relative ? path.join(relative, name) : name;
    const absolute = path.join(root, nextRelative);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) {
      const target = await readlink(absolute);
      const resolved = await realpath(absolute);
      const prefix = `${state.canonicalRoot}${path.sep}`;
      if (resolved !== state.canonicalRoot && !resolved.startsWith(prefix)) throw new Error("Pi package contains an escaping symbolic link.");
      state.entries.push({ path: nextRelative, type: "symlink", target });
    } else if (info.isDirectory()) {
      state.entries.push({ path: nextRelative, type: "directory" });
      await collectPiBundle(root, nextRelative, depth + 1, state);
    } else if (info.isFile()) {
      state.bytes += info.size;
      if (state.bytes > MAX_PI_BUNDLE_BYTES) throw new Error("Pi package exceeds the supported byte bound.");
      const fingerprint = await executableFingerprint(absolute);
      if (!fingerprint) throw new Error("Pi package contains an unsupported file.");
      state.entries.push({ path: nextRelative, type: "file", size: info.size, executable: (info.mode & 0o111) !== 0, fingerprint });
    } else {
      throw new Error("Pi package contains an unsupported filesystem entry.");
    }
    if (state.entries.length > MAX_PI_BUNDLE_FILES) throw new Error("Pi package exceeds the supported file-count bound.");
  }
  return state;
}

function piBundleFingerprint(entries) {
  return `sha256:${createHash("sha256").update(JSON.stringify(entries)).digest("hex")}`;
}

async function findPiPackage(entry) {
  let directory = path.dirname(entry);
  while (true) {
    const manifestPath = path.join(directory, "package.json");
    try {
      const info = await lstat(manifestPath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error("unsafe manifest");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      const declared = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.pi;
      if (typeof declared === "string" && await realpath(path.resolve(directory, declared)) === entry) {
        const bundle = await collectPiBundle(directory);
        return { root: directory, entry: path.relative(directory, entry), fingerprint: piBundleFingerprint(bundle.entries) };
      }
    } catch {
      // Continue toward the filesystem root without retaining package diagnostics.
    }
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

async function resolveVoltaTarget(candidate, environment, run) {
  const volta = path.join(path.dirname(candidate), process.platform === "win32" ? "volta.exe" : "volta");
  try {
    const result = await run(volta, ["which", "pi"], {
      env: minimalEnvironment(environment),
      timeoutMs: PI_PROBE_TIMEOUT_MS,
      maxCaptureBytes: 16 * 1024
    });
    if (result.exitCode !== 0 || result.signal || result.timedOut || result.stdoutTruncated || result.stderrTruncated) return null;
    const selected = String(result.stdout ?? "").trim();
    if (!path.isAbsolute(selected) || selected.includes("\n") || selected.includes("\r")) return null;
    return realpath(selected);
  } catch {
    return null;
  }
}

function piLaunchFingerprint(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

export async function resolvePiExecutable(command, options = {}) {
  if (typeof command !== "string" || command.trim().length === 0 || command.includes("\0")) return null;
  const environment = options.environment ?? process.env;
  const run = options.runProcess ?? runProcess;
  for (const candidate of commandCandidates(command, environment)) {
    try {
      await access(candidate, fsConstants.X_OK);
      const resolvedCommand = await realpath(candidate);
      const info = await stat(resolvedCommand);
      if (!info.isFile() || info.size > MAX_PI_EXECUTABLE_BYTES) continue;
      await access(resolvedCommand, fsConstants.X_OK);
      const launcherFingerprint = await executableFingerprint(resolvedCommand);
      if (!launcherFingerprint) continue;
      const target = path.basename(resolvedCommand) === "volta-shim"
        ? await resolveVoltaTarget(candidate, environment, run)
        : resolvedCommand;
      if (!target) continue;
      const targetInfo = await stat(target);
      if (!targetInfo.isFile() || targetInfo.size > MAX_PI_EXECUTABLE_BYTES) continue;
      const targetFingerprint = await executableFingerprint(target);
      if (!targetFingerprint) continue;
      const shebang = await firstLine(target);
      const nodePackage = /^#!.*(?:^|[\s/])(?:env\s+)?node(?:\s|$)/u.test(shebang)
        ? await findPiPackage(target)
        : null;
      if (shebang.startsWith("#!") && !nodePackage) continue;
      const runtimeFingerprint = nodePackage ? await executableFingerprint(process.execPath) : null;
      if (nodePackage && !runtimeFingerprint) continue;
      const identity = {
        command: path.resolve(candidate),
        resolvedCommand,
        launcherFingerprint,
        target,
        targetFingerprint,
        kind: nodePackage ? "node-package" : "native",
        packageRoot: nodePackage?.root ?? null,
        packageEntry: nodePackage?.entry ?? null,
        packageFingerprint: nodePackage?.fingerprint ?? null,
        runtimeCommand: nodePackage ? process.execPath : null,
        runtimeFingerprint
      };
      return { ...identity, executableFingerprint: piLaunchFingerprint(identity) };
    } catch {
      // Try the next explicit PATH candidate without retaining private path diagnostics.
    }
  }
  return null;
}

function samePiExecutableIdentity(left, right) {
  return Boolean(left && right &&
    left.command === right.command &&
    left.executableFingerprint === right.executableFingerprint);
}

export async function materializePiExecutable(identity) {
  if (!identity || !path.isAbsolute(identity.command) || !/^sha256:[a-f0-9]{64}$/u.test(identity.executableFingerprint)) {
    throw new Error("Pi executable identity is incomplete.");
  }
  const isolated = await createIsolatedEnvironment(process.env, { prefix: "relaypact-pi-exec-" });
  try {
    if (identity.kind === "native") {
      const executable = path.join(isolated.root, "pi");
      await copyFile(identity.target, executable, fsConstants.COPYFILE_EXCL | (fsConstants.COPYFILE_FICLONE ?? 0));
      await chmod(executable, 0o500);
      if (await executableFingerprint(executable) !== identity.targetFingerprint) throw new Error("Pi executable changed during snapshot.");
      return { identity: { ...identity, launchCommand: executable, launchPrefix: [] }, cleanup: isolated.cleanup };
    }
    if (identity.kind !== "node-package" || !path.isAbsolute(identity.packageRoot) || !path.isAbsolute(identity.runtimeCommand)) {
      throw new Error("Pi package identity is incomplete.");
    }
    const bundle = path.join(isolated.root, "bundle");
    await cp(identity.packageRoot, bundle, { recursive: true, verbatimSymlinks: true });
    const copiedBundle = await collectPiBundle(bundle);
    if (piBundleFingerprint(copiedBundle.entries) !== identity.packageFingerprint) throw new Error("Pi package changed during snapshot.");
    const runtime = path.join(isolated.root, "node");
    await copyFile(identity.runtimeCommand, runtime, fsConstants.COPYFILE_EXCL | (fsConstants.COPYFILE_FICLONE ?? 0));
    await chmod(runtime, 0o500);
    if (await executableFingerprint(runtime) !== identity.runtimeFingerprint) throw new Error("Pi runtime changed during snapshot.");
    return {
      identity: { ...identity, launchCommand: runtime, launchPrefix: [path.join(bundle, identity.packageEntry)] },
      cleanup: isolated.cleanup
    };
  } catch (error) {
    await isolated.cleanup().catch(() => {});
    throw error;
  }
}

function unavailablePiReadiness(reason, overrides = {}) {
  return {
    state: "blocked",
    reason,
    command: overrides.command ?? null,
    version: overrides.version ?? null,
    versionCompatible: overrides.versionCompatible ?? false,
    executableStable: overrides.executableStable ?? false,
    settingsIsolated: overrides.settingsIsolated ?? false,
    executableFingerprint: overrides.executableFingerprint ?? null,
    capabilities: {
      nonInteractive: false,
      structuredOutput: false,
      toolSelection: false,
      timeout: true,
      noSession: false,
      projectIsolation: false,
      ...(overrides.capabilities ?? {})
    }
  };
}

async function probePi(run, identity, args, environment, cwd) {
  try {
    const result = await run(identity.launchCommand ?? identity.command, [...(identity.launchPrefix ?? []), ...args], {
      cwd,
      env: environment,
      timeoutMs: PI_PROBE_TIMEOUT_MS,
      maxCaptureBytes: PI_PROBE_CAPTURE_BYTES
    });
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    if (result.timedOut || result.cancelled) return { state: "timed_out", output };
    if (result.stdoutTruncated || result.stderrTruncated) return { state: "truncated", output };
    return { state: "complete", exitCode: result.exitCode, signal: result.signal, output };
  } catch {
    return { state: "missing", output: "" };
  }
}

export async function discoverPiCli(options = {}) {
  const run = options.runProcess ?? runProcess;
  const resolveExecutable = options.resolveExecutable ?? resolvePiExecutable;
  const environment = options.environment ?? process.env;
  const selectedCommand = options.executorCommand ?? "pi";
  const identity = await resolveExecutable(selectedCommand, {
    environment,
    commandBaseDirectory: options.commandBaseDirectory,
    runProcess: run
  });
  if (!identity) return unavailablePiReadiness("missing");

  let isolated;
  let version = null;
  let versionCompatible = false;
  let settingsIsolated = true;
  let capabilities = {};
  let reason = null;
  let materialized;
  try {
    materialized = run === runProcess ? await materializePiExecutable(identity) : null;
    const probeIdentity = materialized?.identity ?? identity;
    isolated = await createIsolatedEnvironment(environment, {
      prefix: "relaypact-pi-doctor-",
      grants: { GIT_OPTIONAL_LOCKS: "0" }
    });
    const configuration = path.join(isolated.root, "agent");
    await mkdir(configuration, { mode: 0o700 });
    const probeEnvironment = {
      ...isolated.env,
      PI_CODING_AGENT_DIR: configuration,
      PI_CODING_AGENT_SESSION_DIR: isolated.temporary
    };

    const versionProbe = await probePi(run, probeIdentity, ["--version"], probeEnvironment, isolated.root);
    settingsIsolated = !SETTINGS_WRITE_FAILURE.test(versionProbe.output);
    if (!settingsIsolated) reason = "settings_write_attempt";
    else if (versionProbe.state !== "complete") reason = versionProbe.state;
    else if (versionProbe.exitCode !== 0 || versionProbe.signal) reason = "unsupported";
    else {
      version = parsePiVersion(versionProbe.output);
      versionCompatible = version !== null && compareVersions(version, MINIMUM_PI_VERSION) >= 0;
      if (!versionCompatible) reason = "unsupported_version";
    }

    if (!reason) {
      const helpProbe = await probePi(run, probeIdentity, ["--help"], probeEnvironment, isolated.root);
      settingsIsolated = !SETTINGS_WRITE_FAILURE.test(helpProbe.output);
      if (!settingsIsolated) reason = "settings_write_attempt";
      else if (helpProbe.state !== "complete") reason = helpProbe.state;
      else if (helpProbe.exitCode !== 0 || helpProbe.signal) reason = "unsupported";
      else {
        const supported = Object.fromEntries(REQUIRED_PI_FLAGS.map((flag) => [flag, helpProbe.output.includes(flag)]));
        capabilities = {
          nonInteractive: supported["--print"] === true,
          structuredOutput: supported["--mode"] === true && /\btext\b/u.test(helpProbe.output) && /\bjson\b/u.test(helpProbe.output),
          toolSelection: supported["--tools"] === true,
          timeout: true,
          noSession: supported["--no-session"] === true,
          projectIsolation: [
            "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes",
            "--no-context-files", "--no-approve", "--provider", "--model", "--thinking"
          ].every((flag) => supported[flag] === true)
        };
        if (!Object.values(capabilities).every(Boolean)) reason = "unsupported_capabilities";
      }
    }

    const verifiedIdentity = await resolveExecutable(selectedCommand, {
      environment,
      commandBaseDirectory: options.commandBaseDirectory,
      runProcess: run
    });
    const executableStable = samePiExecutableIdentity(identity, verifiedIdentity);
    if (!executableStable) reason = "mutated";
    if (reason) {
      return unavailablePiReadiness(reason, {
        command: identity.command,
        version,
        versionCompatible,
        executableStable,
        settingsIsolated,
        executableFingerprint: executableStable ? identity.executableFingerprint : null,
        capabilities
      });
    }
    return {
      state: "ready",
      reason: null,
      command: identity.command,
      version,
      versionCompatible: true,
      executableStable: true,
      settingsIsolated: true,
      executableFingerprint: identity.executableFingerprint,
      capabilities
    };
  } finally {
    await isolated?.cleanup().catch(() => {});
    await materialized?.cleanup().catch(() => {});
  }
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
  const selectedCommand = options.executorCommand ?? "pi";
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
  let executableSnapshot;
  let credentialEvidenceTrusted = false;
  const finish = (result) => attachExecutorSecurity(result, { sensitiveValues, credentialEvidenceTrusted });
  try {
    const executableIdentity = await resolvePiExecutable(selectedCommand, {
      environment: environmentSource,
      commandBaseDirectory: options.commandBaseDirectory ?? process.cwd(),
      runProcess
    });
    if (!executableIdentity) throw new DelegationError("pi_executor_unavailable", "The selected Pi executable could not be resolved to a supported absolute launch identity.");
    executableSnapshot = await materializePiExecutable(executableIdentity);
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
    processResult = await runProcess(
      executableSnapshot.identity.launchCommand,
      [...executableSnapshot.identity.launchPrefix, ...buildPiArgs(envelope, projection.route)],
      {
      cwd: options.workingDirectory,
      env: isolated.env,
      timeoutMs: envelope.execution?.timeoutMs ?? 900_000
      }
    );
    credentialEvidenceTrusted = await verifyPiProjection(projection);
  } catch (error) {
    if (!processResult && !projection) credentialEvidenceTrusted = true;
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
    const [isolationCleanup] = await Promise.allSettled([
      isolated?.cleanup(),
      executableSnapshot?.cleanup()
    ]);
    if (isolationCleanup.status === "rejected") throw isolationCleanup.reason;
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
