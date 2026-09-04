import { createHash } from "node:crypto";
import { constants as fsConstants, createWriteStream } from "node:fs";
import { access, chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { DelegationError } from "../../contracts/src/errors.mjs";
import { runProcess } from "../../core/src/process.mjs";
import { conciseOutput } from "../../core/src/redact.mjs";

const CURSOR_SESSION = Symbol("cursorSession");
const EXECUTOR_STATUSES = new Set(["completed", "blocked", "failed"]);
const PROBE_TIMEOUT_MS = 5_000;
const PROBE_CAPTURE_BYTES = 256 * 1024;
const EXECUTION_CAPTURE_BYTES = 8 * 1024 * 1024;
const MAX_CURSOR_BUNDLE_FILES = 1_024;
const MAX_CURSOR_BUNDLE_BYTES = 512 * 1024 * 1024;
const MAX_CURSOR_BUNDLE_DEPTH = 16;
const SUPPORTED_SHELL_INTERPRETERS = new Set(["bash", "dash", "ksh", "sh", "zsh"]);
const CURSOR_BUNDLE_RUNTIME_COMMAND = "node";
const CURSOR_BUNDLE_RUNTIME_ENTRY = "index.js";
const CURSOR_DIRECT_BOOTSTRAP_ID = "cursor-private-bundle-runtime-v1";
const CURSOR_DIRECT_BOOTSTRAP_FINGERPRINT = `sha256:${createHash("sha256").update(CURSOR_DIRECT_BOOTSTRAP_ID).digest("hex")}`;
const CURSOR_RUNTIME_ARGUMENT_CACHE = new Map();
const HARNESS_OWNED_AUTH_RISK = "Cursor authentication and model configuration remain harness-owned; RelayPact cannot inventory their credential values for exact-value evidence scanning.";
const SAFE_ENVIRONMENT_NAMES = [
  "PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "SHELL",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "XDG_CONFIG_HOME", "PATHEXT"
];

function safeEnvironment(source) {
  return Object.fromEntries(SAFE_ENVIRONMENT_NAMES.flatMap((name) => (
    source[name] === undefined ? [] : [[name, source[name]]]
  )));
}

function cursorEnvironment(source, command) {
  return {
    ...safeEnvironment(source),
    CURSOR_INVOKED_AS: path.basename(command)
  };
}

function processMetadata(result = {}) {
  return {
    exitCode: result.exitCode ?? null,
    signal: result.signal ?? null,
    timedOut: result.timedOut === true,
    cancelled: result.cancelled === true,
    hardKilled: result.hardKilled === true,
    groupCleanupAttempted: result.groupCleanupAttempted === true,
    stdoutTruncated: result.stdoutTruncated === true,
    stderrTruncated: result.stderrTruncated === true
  };
}

function residualRisks(values = []) {
  return [...new Set([
    ...values.filter((value) => typeof value === "string" && value.length > 0),
    HARNESS_OWNED_AUTH_RISK
  ])];
}

async function probe(run, identity, args, environment, signal) {
  if (signal?.aborted) return { state: "interrupted" };
  try {
    const result = await run(identity.launchCommand, [...identity.launchPrefix, ...args], {
      env: environment,
      argv0: identity.argv0,
      timeoutMs: PROBE_TIMEOUT_MS,
      maxCaptureBytes: PROBE_CAPTURE_BYTES,
      signal
    });
    if (result.timedOut || result.cancelled) return { state: "interrupted" };
    if (result.stdoutTruncated || result.stderrTruncated) return { state: "truncated" };
    return {
      state: "complete",
      exitCode: result.exitCode,
      signal: result.signal,
      output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`
    };
  } catch {
    return { state: signal?.aborted ? "interrupted" : "unavailable" };
  }
}

function unavailableReadiness(state = "blocked") {
  return {
    state,
    command: null,
    version: null,
    authenticated: false,
    structuredOutput: false,
    capabilities: {
      boundedWorkspace: false,
      sandbox: false,
      force: false,
      resume: false
    }
  };
}

function parseVersion(output) {
  const match = output.match(/(?:cursor-agent|agent|cursor)\s+(\d{4}\.\d{2}\.\d{2}(?:-[A-Za-z0-9._-]+)?)/iu)
    ?? output.match(/\b(\d+\.\d+\.\d+(?:-[A-Za-z0-9._-]+)?)\b/u);
  return match?.[1] ?? null;
}

function supportsRequiredFlags(output) {
  return ["--print", "--output-format", "--workspace", "--sandbox", "--resume", "--force", "--mode", "--trust"]
    .every((flag) => output.includes(flag));
}

function commandCandidates(command, environment, baseDirectory) {
  if (path.isAbsolute(command)) return [command];
  if (command.includes("/") || command.includes("\\")) return [path.resolve(baseDirectory, command)];
  const directories = String(environment.PATH ?? "").split(path.delimiter).filter(Boolean);
  const extensions = process.platform === "win32"
    ? String(environment.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
    : [""];
  return directories.flatMap((directory) => extensions.map((extension) => path.join(directory, `${command}${extension}`)));
}

async function fileFingerprint(file) {
  const handle = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    return `sha256:${hash.digest("hex")}`;
  } finally {
    await handle.close().catch(() => {});
  }
}

async function shebangTokens(file) {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/u, 1)[0];
    if (!firstLine.startsWith("#!")) return [];
    const tokens = firstLine.slice(2).trim().split(/\s+/u).filter(Boolean);
    return tokens.length > 0 ? tokens : null;
  } finally {
    await handle.close();
  }
}

async function resolveExecutableFile(candidate) {
  await access(candidate, fsConstants.X_OK);
  const resolved = await realpath(candidate);
  const info = await stat(resolved);
  if (!info.isFile()) return null;
  await access(resolved, fsConstants.X_OK);
  return { command: resolved, fingerprint: await fileFingerprint(resolved) };
}

async function isPermissionPinnedSystemExecutable(file) {
  let current = file;
  while (true) {
    const info = await stat(current);
    if (info.uid !== 0 || (info.mode & 0o022) !== 0) return false;
    if (current === path.parse(current).root) return true;
    current = path.dirname(current);
  }
}

async function collectCursorBundleFiles(root, relative = "", depth = 0, files = []) {
  if (depth > MAX_CURSOR_BUNDLE_DEPTH) {
    throw new DelegationError("cursor_executor_mismatch", "Cursor installation bundle exceeds the supported directory depth.");
  }
  const directory = path.join(root, relative);
  const names = (await readdir(directory)).sort();
  for (const name of names) {
    const nextRelative = relative ? path.join(relative, name) : name;
    if (nextRelative === ".running") continue;
    const source = path.join(root, nextRelative);
    const info = await lstat(source);
    if (info.isSymbolicLink()) {
      throw new DelegationError("cursor_executor_mismatch", "Cursor installation bundle contains an unsupported symbolic link.");
    }
    if (info.isDirectory()) {
      await collectCursorBundleFiles(root, nextRelative, depth + 1, files);
      continue;
    }
    if (!info.isFile()) {
      throw new DelegationError("cursor_executor_mismatch", "Cursor installation bundle contains an unsupported filesystem entry.");
    }
    files.push({
      relativePath: nextRelative,
      source,
      size: info.size,
      executable: (info.mode & 0o111) !== 0
    });
    if (files.length > MAX_CURSOR_BUNDLE_FILES) {
      throw new DelegationError("cursor_executor_mismatch", "Cursor installation bundle exceeds the supported file-count bound.");
    }
    const totalBytes = files.reduce((sum, entry) => sum + entry.size, 0);
    if (totalBytes > MAX_CURSOR_BUNDLE_BYTES) {
      throw new DelegationError("cursor_executor_mismatch", "Cursor installation bundle exceeds the supported byte bound.");
    }
  }
  return files;
}

function cursorBundleFingerprint(entries) {
  const value = entries.map(({ relativePath, size, executable, fingerprint }) => ({
    relativePath,
    size,
    executable,
    fingerprint
  }));
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

async function assertCursorBundleIdentity(root) {
  const packagePath = path.join(root, "package.json");
  const info = await lstat(packagePath);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) {
    throw new DelegationError("cursor_executor_mismatch", "Cursor shell launcher must belong to a bounded Agent CLI installation bundle.");
  }
  const metadata = JSON.parse(await readFile(packagePath, "utf8"));
  if (metadata?.name !== "@anysphere/agent-cli-runtime" || metadata.private !== true) {
    throw new DelegationError("cursor_executor_mismatch", "Cursor shell launcher is not part of a recognized Agent CLI installation bundle.");
  }
}

async function inspectCursorBundle(root) {
  await assertCursorBundleIdentity(root);
  const files = await collectCursorBundleFiles(root);
  const entries = [];
  for (const file of files) {
    entries.push({ ...file, fingerprint: await fileFingerprint(file.source) });
  }
  const runtimeCommand = entries.find((entry) => entry.relativePath === CURSOR_BUNDLE_RUNTIME_COMMAND);
  const runtimeEntry = entries.find((entry) => entry.relativePath === CURSOR_BUNDLE_RUNTIME_ENTRY);
  if (
    !runtimeCommand?.executable || !runtimeEntry ||
    (await shebangTokens(runtimeCommand.source))?.length !== 0
  ) {
    throw new DelegationError("cursor_executor_mismatch", "Cursor installation bundle does not contain the supported native runtime and entrypoint.");
  }
  return {
    files,
    entries,
    fingerprint: cursorBundleFingerprint(entries),
    runtime: {
      command: runtimeCommand.source,
      commandFingerprint: runtimeCommand.fingerprint,
      entry: runtimeEntry.source,
      entryFingerprint: runtimeEntry.fingerprint
    }
  };
}

async function fingerprintMatchedContent(file, expectedFingerprint, maxBytes) {
  const handle = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) {
      throw new DelegationError("cursor_executor_mismatch", "Cursor launcher is not a bounded regular file.");
    }
    const content = await handle.readFile();
    const fingerprint = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    if (fingerprint !== expectedFingerprint) {
      throw new DelegationError("cursor_executor_mismatch", "Cursor launcher changed while its runtime policy was resolved.");
    }
    return content.toString("utf8");
  } finally {
    await handle.close().catch(() => {});
  }
}

async function cursorRuntimeArguments(launcher, launcherFingerprint, runtime, environment) {
  const content = await fingerprintMatchedContent(launcher, launcherFingerprint, 64 * 1024);
  const cacheKey = `${launcherFingerprint}:${runtime.commandFingerprint}`;
  const cached = CURSOR_RUNTIME_ARGUMENT_CACHE.get(cacheKey);
  if (cached) return [...cached];
  if (!content.includes('"$NODE_BIN" --use-system-ca --version')) {
    CURSOR_RUNTIME_ARGUMENT_CACHE.set(cacheKey, []);
    return [];
  }

  const probeRoot = await mkdtemp(path.join(os.tmpdir(), "relaypact-cursor-runtime-probe-"));
  await chmod(probeRoot, 0o700);
  try {
    const probeRuntime = path.join(probeRoot, CURSOR_BUNDLE_RUNTIME_COMMAND);
    await copyVerifiedExecutable(runtime.command, probeRuntime, runtime.commandFingerprint);
    const result = await runProcess(probeRuntime, ["--use-system-ca", "--version"], {
      env: safeEnvironment(environment),
      timeoutMs: PROBE_TIMEOUT_MS,
      maxCaptureBytes: PROBE_CAPTURE_BYTES
    });
    const selected = result.exitCode === 0 && !result.signal && !result.timedOut &&
      !result.cancelled && !result.stdoutTruncated && !result.stderrTruncated
      ? ["--use-system-ca"]
      : [];
    CURSOR_RUNTIME_ARGUMENT_CACHE.set(cacheKey, selected);
    return [...selected];
  } finally {
    await rm(probeRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function copyCursorBundle(root, targetRoot, expectedFingerprint) {
  await assertCursorBundleIdentity(root);
  const files = await collectCursorBundleFiles(root);
  const entries = [];
  for (const file of files) {
    const target = path.join(targetRoot, file.relativePath);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const fingerprint = await copyVerifiedFile(
      file.source,
      target,
      file.executable ? 0o500 : 0o400
    );
    entries.push({ ...file, fingerprint });
  }
  const observedFingerprint = cursorBundleFingerprint(entries);
  if (observedFingerprint !== expectedFingerprint) {
    throw new DelegationError("cursor_executor_mismatch", "Cursor installation bundle changed before its private launch snapshot was created.");
  }
  return entries;
}

async function resolveInterpreter(tokens, environment, baseDirectory) {
  if (!Array.isArray(tokens) || tokens.length === 0) return null;
  const [interpreter, ...arguments_] = tokens;
  if (!path.isAbsolute(interpreter)) return null;
  if (path.basename(interpreter) === "env") {
    if (arguments_.length !== 1 || arguments_[0].startsWith("-")) return null;
    for (const candidate of commandCandidates(arguments_[0], environment, baseDirectory)) {
      try {
        const resolved = await resolveExecutableFile(candidate);
        if (
          resolved && (await shebangTokens(resolved.command))?.length === 0 &&
          SUPPORTED_SHELL_INTERPRETERS.has(path.basename(resolved.command)) &&
          await isPermissionPinnedSystemExecutable(resolved.command)
        ) return resolved;
      } catch {
        // Try the next explicit PATH candidate.
      }
    }
    return null;
  }
  if (arguments_.length > 1) return null;
  const resolved = await resolveExecutableFile(interpreter).catch(() => null);
  if (
    !resolved || (await shebangTokens(resolved.command))?.length !== 0 ||
    !SUPPORTED_SHELL_INTERPRETERS.has(path.basename(resolved.command)) ||
    !await isPermissionPinnedSystemExecutable(resolved.command)
  ) return null;
  return { ...resolved, arguments: arguments_ };
}

function launchFingerprint(launcher, launchCommand, launchCommandFingerprint, launchPrefix, bundleFingerprint = null, runtime = null) {
  const value = JSON.stringify({
    launcher: { command: launcher.command, fingerprint: launcher.fingerprint },
    invocation: { command: launchCommand, fingerprint: launchCommandFingerprint, prefix: launchPrefix },
    bundleFingerprint,
    runtime,
    bootstrapFingerprint: runtime ? CURSOR_DIRECT_BOOTSTRAP_FINGERPRINT : null
  });
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function sameExecutableIdentity(left, right) {
  return Boolean(left && right &&
    left.command === right.command &&
    left.fingerprint === right.fingerprint &&
    left.launchCommand === right.launchCommand &&
    left.launcherFingerprint === right.launcherFingerprint &&
    left.launchCommandFingerprint === right.launchCommandFingerprint &&
    left.bundleRoot === right.bundleRoot &&
    left.bundleFingerprint === right.bundleFingerprint &&
    left.runtimeCommand === right.runtimeCommand &&
    left.runtimeCommandFingerprint === right.runtimeCommandFingerprint &&
    left.runtimeEntry === right.runtimeEntry &&
    left.runtimeEntryFingerprint === right.runtimeEntryFingerprint &&
    JSON.stringify(left.runtimeArguments) === JSON.stringify(right.runtimeArguments) &&
    left.bootstrapFingerprint === right.bootstrapFingerprint &&
    JSON.stringify(left.launchPrefix) === JSON.stringify(right.launchPrefix));
}

async function copyVerifiedFile(source, target, mode) {
  const handle = await open(source, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("Snapshot source is not a regular file.");
    if (process.platform === "darwin" || process.platform === "linux") {
      const descriptorPath = process.platform === "darwin" ? `/dev/fd/${handle.fd}` : `/proc/self/fd/${handle.fd}`;
      await copyFile(descriptorPath, target, fsConstants.COPYFILE_EXCL | (fsConstants.COPYFILE_FICLONE ?? 0));
    } else {
      await pipeline(
        handle.createReadStream({ autoClose: false }),
        createWriteStream(target, { flags: "wx", mode })
      );
    }
    await chmod(target, mode);
    return fileFingerprint(target);
  } catch (error) {
    await rm(target, { force: true }).catch(() => {});
    throw error;
  } finally {
    await handle.close().catch(() => {});
  }
}

async function copyVerifiedExecutable(source, target, expectedFingerprint) {
  const observed = await copyVerifiedFile(source, target, 0o500);
  if (observed !== expectedFingerprint) {
    await rm(target, { force: true }).catch(() => {});
    throw new DelegationError("cursor_executor_mismatch", "Cursor executable identity changed before its private launch snapshot was created.");
  }
}

export async function materializeCursorExecutable(identity) {
  if (
    !identity || !path.isAbsolute(identity.command) || !path.isAbsolute(identity.launchCommand) ||
    !/^sha256:[a-f0-9]{64}$/u.test(identity.launcherFingerprint) ||
    !/^sha256:[a-f0-9]{64}$/u.test(identity.launchCommandFingerprint)
  ) {
    throw new DelegationError("cursor_executor_mismatch", "Cursor executable identity is incomplete for verified launch materialization.");
  }
  const snapshotRoot = await mkdtemp(path.join(os.tmpdir(), "relaypact-cursor-exec-"));
  await chmod(snapshotRoot, 0o700);
  try {
    const launcher = path.join(snapshotRoot, "launcher");
    if (identity.command === identity.launchCommand) {
      await copyVerifiedExecutable(identity.command, launcher, identity.launcherFingerprint);
      return {
        identity: { ...identity, launchCommand: launcher, launchPrefix: [] },
        cleanup: () => rm(snapshotRoot, { recursive: true, force: true })
      };
    }
    if (
      identity.launchPrefix.at(-1) !== identity.command ||
      !path.isAbsolute(identity.bundleRoot) || !/^sha256:[a-f0-9]{64}$/u.test(identity.bundleFingerprint) ||
      identity.runtimeCommand !== path.join(identity.bundleRoot, CURSOR_BUNDLE_RUNTIME_COMMAND) ||
      identity.runtimeEntry !== path.join(identity.bundleRoot, CURSOR_BUNDLE_RUNTIME_ENTRY) ||
      !/^sha256:[a-f0-9]{64}$/u.test(identity.runtimeCommandFingerprint) ||
      !/^sha256:[a-f0-9]{64}$/u.test(identity.runtimeEntryFingerprint) ||
      !Array.isArray(identity.runtimeArguments) ||
      !["[]", '["--use-system-ca"]'].includes(JSON.stringify(identity.runtimeArguments)) ||
      identity.bootstrapFingerprint !== CURSOR_DIRECT_BOOTSTRAP_FINGERPRINT
    ) {
      throw new DelegationError("cursor_executor_mismatch", "Cursor interpreter invocation is not bound to the verified launcher.");
    }
    const verifiedInterpreter = await resolveExecutableFile(identity.launchCommand);
    if (
      !verifiedInterpreter || verifiedInterpreter.command !== identity.launchCommand ||
      verifiedInterpreter.fingerprint !== identity.launchCommandFingerprint ||
      path.basename(identity.launchCommand) !== "bash" ||
      !await isPermissionPinnedSystemExecutable(identity.launchCommand)
    ) {
      throw new DelegationError("cursor_executor_mismatch", "Cursor shell interpreter is not identity-matched and permission-pinned for launch.");
    }
    const copiedEntries = await copyCursorBundle(identity.bundleRoot, snapshotRoot, identity.bundleFingerprint);
    const copiedRuntimeCommand = copiedEntries.find((entry) => entry.relativePath === CURSOR_BUNDLE_RUNTIME_COMMAND);
    const copiedRuntimeEntry = copiedEntries.find((entry) => entry.relativePath === CURSOR_BUNDLE_RUNTIME_ENTRY);
    if (
      copiedRuntimeCommand?.fingerprint !== identity.runtimeCommandFingerprint ||
      copiedRuntimeEntry?.fingerprint !== identity.runtimeEntryFingerprint
    ) {
      throw new DelegationError("cursor_executor_mismatch", "Cursor bundle runtime identity changed before its private launch snapshot was created.");
    }
    const bundledLauncher = path.join(snapshotRoot, path.relative(identity.bundleRoot, identity.command));
    const bundledRuntimeCommand = path.join(snapshotRoot, CURSOR_BUNDLE_RUNTIME_COMMAND);
    const bundledRuntimeEntry = path.join(snapshotRoot, CURSOR_BUNDLE_RUNTIME_ENTRY);
    return {
      identity: {
        ...identity,
        launchCommand: bundledRuntimeCommand,
        launchPrefix: [...identity.runtimeArguments, bundledRuntimeEntry],
        argv0: bundledLauncher
      },
      cleanup: () => rm(snapshotRoot, { recursive: true, force: true })
    };
  } catch (error) {
    await rm(snapshotRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function resolveCursorExecutable(command, options = {}) {
  if (typeof command !== "string" || command.trim().length === 0 || command.includes("\0")) return null;
  const environment = safeEnvironment(options.environment ?? process.env);
  const baseDirectory = path.resolve(options.commandBaseDirectory ?? process.cwd());
  for (const candidate of commandCandidates(command, environment, baseDirectory)) {
    try {
      const launcher = await resolveExecutableFile(candidate);
      if (!launcher) continue;
      const shebang = await shebangTokens(launcher.command);
      if (shebang === null) continue;
      if (shebang.length === 0) {
        return {
          command: launcher.command,
          launchCommand: launcher.command,
          launchPrefix: [],
          launcherFingerprint: launcher.fingerprint,
          launchCommandFingerprint: launcher.fingerprint,
          bundleRoot: null,
          bundleFingerprint: null,
          fingerprint: launchFingerprint(launcher, launcher.command, launcher.fingerprint, [])
        };
      }
      const interpreter = await resolveInterpreter(shebang, environment, baseDirectory);
      if (!interpreter || path.basename(interpreter.command) !== "bash" || (interpreter.arguments?.length ?? 0) !== 0) continue;
      const bundleRoot = path.dirname(launcher.command);
      const bundle = await inspectCursorBundle(bundleRoot);
      const launchPrefix = [...(interpreter.arguments ?? []), launcher.command];
      const runtime = {
        ...bundle.runtime,
        arguments: await cursorRuntimeArguments(
          launcher.command,
          launcher.fingerprint,
          bundle.runtime,
          environment
        )
      };
      return {
        command: launcher.command,
        launchCommand: interpreter.command,
        launchPrefix,
        launcherFingerprint: launcher.fingerprint,
        launchCommandFingerprint: interpreter.fingerprint,
        bundleRoot,
        bundleFingerprint: bundle.fingerprint,
        runtimeCommand: runtime.command,
        runtimeCommandFingerprint: runtime.commandFingerprint,
        runtimeEntry: runtime.entry,
        runtimeEntryFingerprint: runtime.entryFingerprint,
        runtimeArguments: runtime.arguments,
        bootstrapFingerprint: CURSOR_DIRECT_BOOTSTRAP_FINGERPRINT,
        fingerprint: launchFingerprint(
          launcher,
          interpreter.command,
          interpreter.fingerprint,
          launchPrefix,
          bundle.fingerprint,
          runtime
        )
      };
    } catch {
      // Try the next explicit PATH candidate without exposing filesystem details.
    }
  }
  return null;
}

export async function discoverCursorCli(options = {}) {
  const run = options.runProcess ?? runProcess;
  const resolveExecutable = options.resolveExecutable ?? resolveCursorExecutable;
  const environment = safeEnvironment(options.environment ?? process.env);
  const candidates = options.executorIdentity
    ? [options.executorIdentity]
    : (options.executorCommand
    ? [options.executorCommand]
    : ["cursor-agent", "agent"]);

  for (const candidate of candidates) {
    if (options.signal?.aborted) return unavailableReadiness("interrupted");
    const resolvedIdentity = await resolveExecutable(
      typeof candidate === "string" ? candidate : candidate?.command,
      { environment, commandBaseDirectory: options.commandBaseDirectory }
    );
    if (options.signal?.aborted) return unavailableReadiness("interrupted");
    const identity = typeof candidate === "string" || sameExecutableIdentity(candidate, resolvedIdentity)
      ? resolvedIdentity
      : null;
    if (
      !identity || typeof identity.command !== "string" || !path.isAbsolute(identity.command) ||
      typeof identity.launchCommand !== "string" || !path.isAbsolute(identity.launchCommand) ||
      !Array.isArray(identity.launchPrefix) || identity.launchPrefix.some((item) => typeof item !== "string") ||
      !/^sha256:[a-f0-9]{64}$/u.test(identity.launcherFingerprint) ||
      !/^sha256:[a-f0-9]{64}$/u.test(identity.launchCommandFingerprint) ||
      (identity.command === identity.launchCommand
        ? identity.bundleRoot !== null || identity.bundleFingerprint !== null
        : !path.isAbsolute(identity.bundleRoot) || !/^sha256:[a-f0-9]{64}$/u.test(identity.bundleFingerprint) ||
          typeof identity.runtimeCommand !== "string" || !path.isAbsolute(identity.runtimeCommand) ||
          !/^sha256:[a-f0-9]{64}$/u.test(identity.runtimeCommandFingerprint) ||
          typeof identity.runtimeEntry !== "string" || !path.isAbsolute(identity.runtimeEntry) ||
          !/^sha256:[a-f0-9]{64}$/u.test(identity.runtimeEntryFingerprint) ||
          !Array.isArray(identity.runtimeArguments) ||
          !["[]", '["--use-system-ca"]'].includes(JSON.stringify(identity.runtimeArguments)) ||
          identity.bootstrapFingerprint !== CURSOR_DIRECT_BOOTSTRAP_FINGERPRINT) ||
      !/^sha256:[a-f0-9]{64}$/u.test(identity.fingerprint)
    ) continue;
    const command = identity.command;
    let materialized;
    try {
      materialized = run === runProcess ? await materializeCursorExecutable(identity) : null;
      const probeIdentity = materialized?.identity ?? identity;
      const launchEnvironment = cursorEnvironment(environment, command);
      const versionProbe = await probe(run, probeIdentity, ["--version"], launchEnvironment, options.signal);
      if (versionProbe.state === "interrupted") return unavailableReadiness("interrupted");
      if (versionProbe.state !== "complete" || versionProbe.exitCode !== 0 || versionProbe.signal) continue;
      const version = parseVersion(versionProbe.output);
      if (!version) continue;

      const helpProbe = await probe(run, probeIdentity, ["--help"], launchEnvironment, options.signal);
      if (helpProbe.state === "interrupted") return unavailableReadiness("interrupted");
      if (
        helpProbe.state !== "complete" || helpProbe.exitCode !== 0 || helpProbe.signal ||
        !supportsRequiredFlags(helpProbe.output)
      ) continue;

      const authProbe = await probe(run, probeIdentity, ["status"], launchEnvironment, options.signal);
      if (authProbe.state === "interrupted") return unavailableReadiness("interrupted");
      const authenticated = authProbe.state === "complete" && authProbe.exitCode === 0 && !authProbe.signal;
      if (options.signal?.aborted) return unavailableReadiness("interrupted");
      const verifiedIdentity = await resolveExecutable(command, {
        environment,
        commandBaseDirectory: options.commandBaseDirectory
      });
      if (options.signal?.aborted) return unavailableReadiness("interrupted");
      if (!sameExecutableIdentity(verifiedIdentity, identity)) continue;
      return {
        state: authenticated ? "ready" : "blocked",
        command,
        launchCommand: verifiedIdentity.launchCommand,
        launchPrefix: verifiedIdentity.launchPrefix,
        launcherFingerprint: verifiedIdentity.launcherFingerprint,
        launchCommandFingerprint: verifiedIdentity.launchCommandFingerprint,
        bundleRoot: verifiedIdentity.bundleRoot,
        bundleFingerprint: verifiedIdentity.bundleFingerprint,
        runtimeCommand: verifiedIdentity.runtimeCommand,
        runtimeCommandFingerprint: verifiedIdentity.runtimeCommandFingerprint,
        runtimeEntry: verifiedIdentity.runtimeEntry,
        runtimeEntryFingerprint: verifiedIdentity.runtimeEntryFingerprint,
        runtimeArguments: verifiedIdentity.runtimeArguments,
        bootstrapFingerprint: verifiedIdentity.bootstrapFingerprint,
        executableFingerprint: verifiedIdentity.fingerprint,
        version,
        authenticated,
        structuredOutput: true,
        capabilities: {
          boundedWorkspace: true,
          sandbox: true,
          force: true,
          resume: true
        }
      };
    } finally {
      await materialized?.cleanup().catch(() => {});
    }
  }

  return unavailableReadiness();
}

function findPayload(value, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return null;
  if (typeof value === "string") {
    try {
      return findPayload(JSON.parse(value), depth + 1);
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const found = findPayload(value[index], depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === "object") {
    if (EXECUTOR_STATUSES.has(value.status) && typeof value.summary === "string") return value;
    for (const key of ["result", "message", "content", "text", "data"]) {
      const found = findPayload(value[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function parseTerminalPayload(value) {
  const direct = findPayload(value);
  if (direct || typeof value !== "string") return direct;
  const candidates = new Map();
  const addCandidate = (text) => {
    try {
      const payload = findPayload(JSON.parse(text.trim()));
      if (payload) candidates.set(JSON.stringify(payload), payload);
    } catch {
      // Only complete JSON values with a supported payload are eligible.
    }
  };
  for (const line of value.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;
    addCandidate(trimmed);
  }
  for (const match of value.matchAll(/```(?:json)?[ \t]*\r?\n([\s\S]*?)```/giu)) {
    addCandidate(match[1]);
  }
  let cursor = value.length;
  for (let attempts = 0; attempts < 64; attempts += 1) {
    const start = value.lastIndexOf("{", cursor - 1);
    if (start < 0) break;
    addCandidate(value.slice(start));
    cursor = start;
  }
  return candidates.size === 1 ? candidates.values().next().value : null;
}

function parseCursorEvents(stdout) {
  const lines = stdout.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  const events = [];
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (!event || typeof event !== "object" || Array.isArray(event)) return null;
      events.push(event);
    } catch {
      return null;
    }
  }
  const terminals = events.filter((event) => event.type === "result");
  if (terminals.length !== 1) return null;
  return { events, terminal: terminals[0] };
}

function modelObservation(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const value = typeof event.model === "string" && event.model.trim()
      ? event.model.trim()
      : typeof event.model_name === "string" && event.model_name.trim()
        ? event.model_name.trim()
        : null;
    if (value) {
      if (value.toLowerCase() === "auto") {
        return {
          state: "harness_managed",
          value: conciseOutput(value, 200),
          source: "executor_event",
          assurance: "selector_alias",
          observedAt: new Date().toISOString()
        };
      }
      return {
        state: "observed",
        value: conciseOutput(value, 200),
        source: "executor_event",
        assurance: "reported",
        observedAt: new Date().toISOString()
      };
    }
  }
  return {
    state: "unavailable",
    value: null,
    source: "unavailable",
    assurance: "unknown",
    observedAt: new Date().toISOString()
  };
}

function buildPrompt(envelope, correctionPrompt = null) {
  const sections = [
    "You are a bounded Delegated Executor operating through Cursor CLI.",
    "Execute only within the following task envelope.",
    "Stop with status blocked if information or authority is missing.",
    "Do not commit, push, widen scope, change Git control state, or expose credentials.",
    "The final line of your response must be exactly one compact JSON object with status (completed|blocked|failed), summary, and optional residualRisks. Do not put other JSON objects on separate lines.",
    JSON.stringify(envelope, null, 2)
  ];
  if (correctionPrompt) {
    sections.push(
      "This is an authorized correction on the same bounded task and session. Preserve the original envelope and address only this correction request:",
      correctionPrompt
    );
  }
  return sections.join("\n\n");
}

function buildCursorArgs(envelope, workingDirectory, options) {
  const args = [
    "-p",
    "--output-format", "stream-json",
    "--trust",
    "--sandbox", "enabled",
    "--workspace", workingDirectory
  ];
  if (options.readOnly === true) args.push("--mode", "plan");
  else args.push("--force");
  if (options.resumeSessionId) args.push(`--resume=${options.resumeSessionId}`);
  args.push(buildPrompt(envelope, options.correctionPrompt));
  return args;
}

function sessionIdFrom(events, terminal) {
  const direct = [terminal.session_id, terminal.sessionId].find((value) => typeof value === "string" && value.length > 0);
  if (direct) return direct;
  for (const event of events) {
    const value = [event.session_id, event.sessionId].find((item) => typeof item === "string" && item.length > 0);
    if (value) return value;
  }
  return null;
}

function attachSession(result, sessionId, executorCommand, executorFingerprint) {
  if (!sessionId) return result;
  Object.defineProperty(result, CURSOR_SESSION, {
    enumerable: false,
    value: {
      sessionId,
      digest: `sha256:${createHash("sha256").update(sessionId).digest("hex")}`,
      executorCommand,
      executorFingerprint
    }
  });
  return result;
}

export function cursorSessionEvidence(result) {
  const evidence = result?.[CURSOR_SESSION];
  return evidence ? { digest: evidence.digest, resumable: true } : { digest: null, resumable: false };
}

export async function runExecutor(envelope, options = {}) {
  const readiness = options.readiness ?? await discoverCursorCli(options);
  if (readiness.state !== "ready") {
    const cancelled = readiness.state === "interrupted";
    return {
      reportedStatus: cancelled ? "failed" : "blocked",
      summary: cancelled
        ? "Cursor readiness was cancelled."
        : readiness.command
          ? "Cursor CLI authentication is unavailable or could not be verified."
          : "A compatible Cursor CLI installation could not be verified.",
      residualRisks: residualRisks(),
      exitCode: null,
      signal: null,
      ...(cancelled ? { cancelled: true } : {}),
      modelObservation: modelObservation([])
    };
  }

  const run = options.runProcess ?? runProcess;
  let processResult;
  let materialized;
  try {
    materialized = run === runProcess ? await materializeCursorExecutable({
      command: readiness.command,
      launchCommand: readiness.launchCommand ?? readiness.command,
      launchPrefix: readiness.launchPrefix ?? [],
      launcherFingerprint: readiness.launcherFingerprint,
      launchCommandFingerprint: readiness.launchCommandFingerprint,
      bundleRoot: readiness.bundleRoot,
      bundleFingerprint: readiness.bundleFingerprint,
      runtimeCommand: readiness.runtimeCommand,
      runtimeCommandFingerprint: readiness.runtimeCommandFingerprint,
      runtimeEntry: readiness.runtimeEntry,
      runtimeEntryFingerprint: readiness.runtimeEntryFingerprint,
      runtimeArguments: readiness.runtimeArguments,
      bootstrapFingerprint: readiness.bootstrapFingerprint,
      fingerprint: readiness.executableFingerprint
    }) : null;
    const launchIdentity = materialized?.identity ?? readiness;
    await options.beforeVerifiedLaunch?.();
    processResult = await run(
      launchIdentity.launchCommand ?? launchIdentity.command,
      [...(launchIdentity.launchPrefix ?? []), ...buildCursorArgs(envelope, options.workingDirectory, options)],
      {
        cwd: options.workingDirectory,
        env: cursorEnvironment(options.environment ?? process.env, readiness.command),
        argv0: launchIdentity.argv0,
        timeoutMs: envelope.execution?.timeoutMs ?? 900_000,
        maxCaptureBytes: options.maxCaptureBytes ?? EXECUTION_CAPTURE_BYTES,
        signal: options.signal
      }
    );
  } catch (error) {
    const identityMismatch = error instanceof DelegationError && error.code === "cursor_executor_mismatch";
    return {
      reportedStatus: "failed",
      summary: identityMismatch
        ? "Cursor executor identity changed before launch."
        : "Cursor executor could not start.",
      failureCode: identityMismatch ? "cursor_executor_mismatch" : "cursor_launch_failed",
      residualRisks: residualRisks(),
      exitCode: null,
      signal: null,
      modelObservation: modelObservation([])
    };
  } finally {
    await materialized?.cleanup().catch(() => {});
  }

  const metadata = processMetadata(processResult);
  if (processResult.stdoutTruncated || processResult.stderrTruncated) {
    return { reportedStatus: "failed", summary: "Cursor executor output exceeded the evidence capture bound.", residualRisks: residualRisks(), ...metadata, modelObservation: modelObservation([]) };
  }
  if (processResult.cancelled) {
    return { reportedStatus: "failed", summary: "Cursor executor was cancelled.", residualRisks: residualRisks(), ...metadata, modelObservation: modelObservation([]) };
  }
  if (processResult.timedOut) {
    return { reportedStatus: "failed", summary: "Cursor executor timed out.", residualRisks: residualRisks(), ...metadata, modelObservation: modelObservation([]) };
  }
  if (processResult.exitCode !== 0 || processResult.signal) {
    return { reportedStatus: "failed", summary: "Cursor executor process failed.", residualRisks: residualRisks(), ...metadata, modelObservation: modelObservation([]) };
  }

  const parsed = parseCursorEvents(processResult.stdout);
  if (!parsed) {
    return { reportedStatus: "malformed", summary: "Cursor output did not contain exactly one supported terminal result event.", residualRisks: residualRisks(), ...metadata, modelObservation: modelObservation([]) };
  }

  const observation = modelObservation(parsed.events);
  const terminalSucceeded = parsed.terminal.subtype === "success" && parsed.terminal.is_error !== true;
  if (!terminalSucceeded) {
    return attachSession({
      reportedStatus: "failed",
      summary: "Cursor reported an unsuccessful terminal result.",
      residualRisks: residualRisks(),
      ...metadata,
      modelObservation: observation
    }, sessionIdFrom(parsed.events, parsed.terminal), readiness.command, readiness.executableFingerprint);
  }

  const payload = parseTerminalPayload(parsed.terminal.result);
  if (!payload) {
    return attachSession({
      reportedStatus: "malformed",
      summary: "Cursor terminal output did not contain the required structured executor result.",
      residualRisks: residualRisks(),
      ...metadata,
      modelObservation: observation
    }, sessionIdFrom(parsed.events, parsed.terminal), readiness.command, readiness.executableFingerprint);
  }

  return attachSession({
    reportedStatus: payload.status,
    summary: conciseOutput(payload.summary, 4000),
    residualRisks: residualRisks(Array.isArray(payload.residualRisks)
      ? payload.residualRisks.map((item) => conciseOutput(item, 4000))
      : []),
    ...metadata,
    modelObservation: observation
  }, sessionIdFrom(parsed.events, parsed.terminal), readiness.command, readiness.executableFingerprint);
}

export function assertCursorResumeSession(result) {
  const evidence = result?.[CURSOR_SESSION];
  if (!evidence) throw new DelegationError("cursor_session_unavailable", "Cursor execution did not yield a resumable session.");
  return evidence.sessionId;
}

export function cursorPrivateSession(result) {
  const evidence = result?.[CURSOR_SESSION];
  return evidence
    ? {
      handle: evidence.sessionId,
      digest: evidence.digest,
      executorCommand: evidence.executorCommand,
      executorFingerprint: evidence.executorFingerprint
    }
    : { handle: null, digest: null, executorCommand: null, executorFingerprint: null };
}
