import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, chmod, copyFile, cp, lstat, mkdir, open, opendir, readFile, readlink, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
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
const PI_SNAPSHOT_ROOT_ENV = "RELAYPACT_PI_EXECUTABLE_SNAPSHOT_ROOT";
export const MINIMUM_PI_VERSION = "0.84.0";
const REQUIRED_PI_FLAGS = Object.freeze([
  "--print", "--mode", "--no-session", "--no-extensions", "--no-skills",
  "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve",
  "--tools", "--provider", "--model", "--thinking"
]);
const SETTINGS_WRITE_FAILURE = /(?:(?:EPERM|EACCES|EROFS|permission denied|operation not permitted)[^\r\n]*(?:settings\.json\.lock|global settings)|(?:settings\.json\.lock|global settings)[^\r\n]*(?:EPERM|EACCES|EROFS|permission denied|operation not permitted))/iu;
const ENVIRONMENT_REFERENCE = /^[A-Z_][A-Z0-9_]*$/u;
const AUTH_ENVIRONMENT_REFERENCE = /^\$(?:\{([A-Z_][A-Z0-9_]*)\}|([A-Z_][A-Z0-9_]*))$/u;
const SEMANTIC_VERSION_PATTERN = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?`;

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

function parseSemanticVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.exec(value);
  if (!match) return null;
  const core = match.slice(1, 4);
  const prerelease = match[4]?.split(".") ?? [];
  if (core.some((part) => part.length > 1 && part.startsWith("0"))) return null;
  if (prerelease.some((part) => /^\d+$/u.test(part) && part.length > 1 && part.startsWith("0"))) return null;
  return {
    core,
    prerelease
  };
}

function compareVersions(left, right) {
  const a = parseSemanticVersion(left);
  const b = parseSemanticVersion(right);
  if (!a || !b) return Number.NaN;
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return BigInt(a.core[index]) < BigInt(b.core[index]) ? -1 : 1;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    if (a.prerelease.length === b.prerelease.length) return 0;
    return a.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    if (a.prerelease[index] === undefined) return -1;
    if (b.prerelease[index] === undefined) return 1;
    if (a.prerelease[index] === b.prerelease[index]) continue;
    const aNumeric = /^\d+$/u.test(a.prerelease[index]);
    const bNumeric = /^\d+$/u.test(b.prerelease[index]);
    if (aNumeric && bNumeric) return BigInt(a.prerelease[index]) < BigInt(b.prerelease[index]) ? -1 : 1;
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a.prerelease[index] < b.prerelease[index] ? -1 : 1;
  }
  return 0;
}

function parsePiVersion(output) {
  const lines = String(output).split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const labeledPattern = new RegExp(
    `^pi(?:\\s+coding\\s+agent)?(?:\\s+version)?\\s*(?::|=)?\\s*v?(${SEMANTIC_VERSION_PATTERN})$`,
    "iu"
  );
  const labeled = lines.flatMap((line) => labeledPattern.exec(line)?.[1] ?? []);
  if (labeled.length === 1) return parseSemanticVersion(labeled[0]) ? labeled[0] : null;
  if (labeled.length > 1) return null;

  const tokenPattern = new RegExp(`(?:^|\\s)(${SEMANTIC_VERSION_PATTERN})(?=\\s|$)`, "gu");
  const tokens = [...String(output).matchAll(tokenPattern)].map((match) => match[1]);
  if (tokens.length !== 1) return null;
  const barePattern = new RegExp(`^(${SEMANTIC_VERSION_PATTERN})$`, "u");
  const bare = lines.flatMap((line) => barePattern.exec(line)?.[1] ?? []);
  return bare.length === 1 && bare[0] === tokens[0] && parseSemanticVersion(bare[0]) ? bare[0] : null;
}

function helpHasOption(output, flag) {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?:^|[^A-Za-z0-9_-])${escaped}(?=$|[^A-Za-z0-9_-])`, "u").test(output);
}

function helpOptionLine(output, flag) {
  return output.split(/\r?\n/u).find((line) => helpHasOption(line, flag)) ?? "";
}

async function cleanupPiResources(...resources) {
  const results = await Promise.allSettled(
    resources.filter(Boolean).map((resource) => Promise.resolve().then(() => resource.cleanup()))
  );
  return results.some((result) => result.status === "rejected");
}

function piSnapshotRootUnavailable(message = "Pi executable snapshot root is unavailable.") {
  const error = new Error(message);
  error.code = "pi_snapshot_root_unavailable";
  return error;
}

function piSnapshotBaseDirectories(environment, explicitRoot) {
  const configured = explicitRoot ?? environment[PI_SNAPSHOT_ROOT_ENV];
  const candidates = [];
  if (configured !== undefined) {
    if (typeof configured !== "string" || !path.isAbsolute(configured) || configured.includes("\0")) {
      throw piSnapshotRootUnavailable("Pi executable snapshot root must be an absolute directory.");
    }
    candidates.push(configured);
  } else {
    if (typeof environment.XDG_RUNTIME_DIR === "string" && path.isAbsolute(environment.XDG_RUNTIME_DIR)) {
      candidates.push(path.join(environment.XDG_RUNTIME_DIR, "relaypact", "pi-executable-snapshots"));
    }
    const home = typeof environment.HOME === "string" && path.isAbsolute(environment.HOME)
      ? environment.HOME
      : os.homedir();
    candidates.push(path.join(home, ".cache", "relaypact", "pi-executable-snapshots"));
    candidates.push(path.join(os.tmpdir(), "relaypact", "pi-executable-snapshots"));
  }
  return [...new Set(candidates)];
}

async function preparePiSnapshotBaseDirectory(base) {
  await mkdir(base, { recursive: true, mode: 0o700 });
  const info = await lstat(base);
  if (!info.isDirectory() || info.isSymbolicLink()) throw piSnapshotRootUnavailable();
  await chmod(base, 0o700);
  return realpath(base);
}

async function assertPiSnapshotRootExecutable(isolated, environment, run) {
  if (process.platform === "win32") return;
  const probe = path.join(isolated.root, ".relaypact-exec-probe");
  await writeFile(probe, "#!/bin/sh\nexit 0\n", { mode: 0o500, flag: "wx" });
  let result;
  try {
    result = await run(probe, [], {
      cwd: isolated.root,
      env: minimalEnvironment(isolated.env ?? environment),
      timeoutMs: PI_PROBE_TIMEOUT_MS,
      maxCaptureBytes: 1024
    });
  } catch {
    result = null;
  } finally {
    await rm(probe, { force: true }).catch(() => {});
  }
  if (!result || result.exitCode !== 0 || result.signal || result.timedOut || result.cancelled) {
    const error = new Error("Pi executable snapshot root is not executable.");
    error.code = "pi_snapshot_root_unavailable";
    throw error;
  }
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

export async function collectPiBundle(root, relative = "", depth = 0, state = null, options = {}) {
  if (!state) state = { entries: [], bytes: 0, canonicalRoot: await realpath(root) };
  if (depth > MAX_PI_BUNDLE_DEPTH) throw new Error("Pi package exceeds the supported directory depth.");
  const directory = path.join(root, relative);
  const maxFiles = Number.isSafeInteger(options.maxFiles) && options.maxFiles >= 0
    ? Math.min(options.maxFiles, MAX_PI_BUNDLE_FILES)
    : MAX_PI_BUNDLE_FILES;
  const remaining = maxFiles - state.entries.length;
  if (remaining < 0) throw new Error("Pi package exceeds the supported file-count bound.");
  const names = [];
  const openDirectory = options.openDirectory ?? opendir;
  const handle = await openDirectory(directory);
  try {
    for await (const entry of handle) {
      if (options.excludeNodeModules === true && relative === "" && entry.name === "node_modules") continue;
      if (names.length >= remaining) throw new Error("Pi package exceeds the supported file-count bound.");
      names.push(entry.name);
    }
  } finally {
    await handle.close?.().catch(() => {});
  }
  names.sort();
  for (const name of names) {
    if (state.entries.length >= maxFiles) throw new Error("Pi package exceeds the supported file-count bound.");
    const nextRelative = relative ? path.join(relative, name) : name;
    const absolute = path.join(root, nextRelative);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) {
      const target = await readlink(absolute);
      if (path.isAbsolute(target)) throw new Error("Pi package contains an unsupported absolute symbolic link.");
      const resolved = await realpath(absolute);
      const prefix = `${state.canonicalRoot}${path.sep}`;
      if (resolved !== state.canonicalRoot && !resolved.startsWith(prefix)) throw new Error("Pi package contains an escaping symbolic link.");
      const excluded = `${path.join(state.canonicalRoot, "node_modules")}${path.sep}`;
      if (options.excludeNodeModules === true && (resolved === path.join(state.canonicalRoot, "node_modules") || resolved.startsWith(excluded))) {
        throw new Error("Pi package contains a symbolic link into dependency storage.");
      }
      state.entries.push({ path: nextRelative, type: "symlink", target });
    } else if (info.isDirectory()) {
      state.entries.push({ path: nextRelative, type: "directory" });
      await collectPiBundle(root, nextRelative, depth + 1, state, options);
    } else if (info.isFile()) {
      state.bytes += info.size;
      if (state.bytes > MAX_PI_BUNDLE_BYTES) throw new Error("Pi package exceeds the supported byte bound.");
      const fingerprint = await executableFingerprint(absolute);
      if (!fingerprint) throw new Error("Pi package contains an unsupported file.");
      state.entries.push({ path: nextRelative, type: "file", size: info.size, executable: (info.mode & 0o111) !== 0, fingerprint });
    } else {
      throw new Error("Pi package contains an unsupported filesystem entry.");
    }
  }
  return state;
}

function piBundleFingerprint(entries) {
  return `sha256:${createHash("sha256").update(JSON.stringify(entries)).digest("hex")}`;
}

async function readPiPackageManifest(root) {
  const manifestPath = path.join(root, "package.json");
  let handle;
  try {
    handle = await open(
      manifestPath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0)
    );
    const before = await handle.stat();
    if (!before.isFile() || before.size > MAX_PI_CONFIG_BYTES) throw new Error("Pi package manifest is unsafe.");
    const buffer = Buffer.alloc(MAX_PI_CONFIG_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > MAX_PI_CONFIG_BYTES) throw new Error("Pi package manifest is unsafe.");
    const after = await handle.stat();
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new Error("Pi package manifest changed while it was read.");
    }
    const manifest = JSON.parse(buffer.subarray(0, total).toString("utf8"));
    if (!plainObject(manifest)) throw new Error("Pi package manifest is invalid.");
    return manifest;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function packageNameParts(name) {
  if (typeof name !== "string") return null;
  const parts = name.split("/");
  if (parts.length === 1 && /^[A-Za-z0-9._~-]+$/u.test(parts[0]) && parts[0] !== "." && parts[0] !== "..") return parts;
  if (parts.length === 2 && /^@[A-Za-z0-9._~-]+$/u.test(parts[0]) && /^[A-Za-z0-9._~-]+$/u.test(parts[1]) && parts[1] !== "." && parts[1] !== "..") return parts;
  return null;
}

function packageDependencyRequirements(manifest) {
  const requirements = new Map();
  for (const name of Object.keys(plainObject(manifest.dependencies) ? manifest.dependencies : {}).sort()) {
    requirements.set(name, true);
  }
  for (const name of Object.keys(plainObject(manifest.optionalDependencies) ? manifest.optionalDependencies : {}).sort()) {
    requirements.set(name, false);
  }
  for (const name of Object.keys(plainObject(manifest.peerDependencies) ? manifest.peerDependencies : {}).sort()) {
    const optional = manifest.peerDependenciesMeta?.[name]?.optional === true;
    if (!requirements.has(name)) requirements.set(name, !optional);
  }
  return [...requirements.entries()].sort(([left], [right]) => left.localeCompare(right, "en"));
}

async function resolveDependencyPackage(root, name) {
  const parts = packageNameParts(name);
  if (!parts) throw new Error("Pi package declares an unsupported dependency name.");
  let directory = root;
  while (true) {
    let candidate;
    try {
      candidate = await realpath(path.join(directory, "node_modules", ...parts));
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
    }
    if (candidate) {
      await readPiPackageManifest(candidate);
      return candidate;
    }
    // Continue through the same ancestor locations used by Node package resolution.
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

function piPackageGraphFingerprint(graph) {
  const portable = {
    rootId: graph.rootId,
    nodes: graph.nodes.map(({ id, entries, dependencies }) => ({ id, entries, dependencies }))
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(portable)).digest("hex")}`;
}

async function collectPiPackageGraph(root) {
  const canonicalRoot = await realpath(root);
  const roots = new Map([[canonicalRoot, 0]]);
  const nodes = [{ id: 0, root: canonicalRoot, depth: 0, entries: [], dependencies: [] }];
  let totalBytes = 0;
  let totalEntries = 0;
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    const manifest = await readPiPackageManifest(node.root);
    const bundle = await collectPiBundle(node.root, "", 0, null, {
      excludeNodeModules: true,
      maxFiles: MAX_PI_BUNDLE_FILES - totalEntries
    });
    node.entries = bundle.entries;
    totalBytes += bundle.bytes;
    totalEntries += bundle.entries.length;
    if (totalBytes > MAX_PI_BUNDLE_BYTES) throw new Error("Pi dependency closure exceeds the supported byte bound.");
    if (totalEntries > MAX_PI_BUNDLE_FILES) throw new Error("Pi dependency closure exceeds the supported file-count bound.");

    for (const [name, required] of packageDependencyRequirements(manifest)) {
      const dependencyRoot = await resolveDependencyPackage(node.root, name);
      if (!dependencyRoot) {
        if (required) throw new Error("Pi package has an unresolved runtime dependency.");
        continue;
      }
      let target = roots.get(dependencyRoot);
      if (target === undefined) {
        const dependencyDepth = node.depth + 1;
        if (dependencyDepth > MAX_PI_BUNDLE_DEPTH) throw new Error("Pi dependency closure exceeds the supported depth.");
        target = nodes.length;
        roots.set(dependencyRoot, target);
        nodes.push({ id: target, root: dependencyRoot, depth: dependencyDepth, entries: [], dependencies: [] });
      }
      node.dependencies.push({ name, target });
      totalEntries += 1;
      if (totalEntries > MAX_PI_BUNDLE_FILES) throw new Error("Pi dependency closure exceeds the supported file-count bound.");
    }
  }
  return { rootId: 0, nodes };
}

async function findPiPackage(entry) {
  let directory = path.dirname(entry);
  while (true) {
    try {
      const manifest = await readPiPackageManifest(directory);
      const declared = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.pi;
      if (typeof declared === "string" && await realpath(path.resolve(directory, declared)) === entry) {
        const packageEntry = path.relative(directory, entry);
        if (packageEntry === "" || packageEntry === ".." || packageEntry.startsWith(`..${path.sep}`) || path.isAbsolute(packageEntry)) {
          throw new Error("Pi package entry escapes its package root.");
        }
        const graph = await collectPiPackageGraph(directory);
        return { root: directory, entry: packageEntry, graph, fingerprint: piPackageGraphFingerprint(graph) };
      }
    } catch {
      // Continue toward the filesystem root without retaining package diagnostics.
    }
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

async function resolveVoltaTarget(candidate, environment, run, tool = "pi", cwd) {
  const volta = path.join(path.dirname(candidate), process.platform === "win32" ? "volta.exe" : "volta");
  try {
    const result = await run(volta, ["which", tool], {
      cwd,
      env: environment,
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

function nodeCommandFromShebang(shebang) {
  if (!shebang.startsWith("#!")) return null;
  const tokens = shebang.slice(2).trim().split(/\s+/u);
  if (tokens.length === 1 && path.isAbsolute(tokens[0]) && /^node(?:\.exe)?$/iu.test(path.basename(tokens[0]))) {
    return tokens[0];
  }
  if (tokens.length === 2 && path.isAbsolute(tokens[0]) && path.basename(tokens[0]) === "env" && tokens[1] === "node") {
    return "node";
  }
  return null;
}

async function resolveNodeRuntime(shebang, environment, run, cwd) {
  const command = nodeCommandFromShebang(shebang);
  if (!command) return null;
  for (const candidate of commandCandidates(command, environment)) {
    try {
      await access(candidate, fsConstants.X_OK);
    } catch {
      continue;
    }
    try {
      const resolvedCommand = await realpath(candidate);
      if (!/^node(?:\.exe)?$/iu.test(path.basename(resolvedCommand))) return null;
      if ((await firstLine(resolvedCommand)).startsWith("#!")) return null;
      const launcherFingerprint = await executableFingerprint(resolvedCommand);
      if (!launcherFingerprint) return null;
      const probe = await run(resolvedCommand, ["-p", "process.execPath"], {
        cwd,
        env: environment,
        timeoutMs: PI_PROBE_TIMEOUT_MS,
        maxCaptureBytes: 16 * 1024
      });
      if (probe.exitCode !== 0 || probe.signal || probe.timedOut || probe.stdoutTruncated || probe.stderrTruncated) return null;
      const selected = String(probe.stdout ?? "").trim();
      if (!path.isAbsolute(selected) || selected.includes("\n") || selected.includes("\r")) return null;
      const target = await realpath(selected);
      await access(target, fsConstants.X_OK);
      const targetFingerprint = await executableFingerprint(target);
      if (!targetFingerprint) return null;
      // A wrapper or toolchain shim can add opaque environment or argv semantics.
      // Execute only a directly resolved Node runtime that can be snapshotted exactly.
      if (target !== resolvedCommand || targetFingerprint !== launcherFingerprint) return null;
      return {
        command: path.resolve(candidate),
        resolvedCommand,
        launcherFingerprint,
        target,
        targetFingerprint
      };
    } catch {
      // The first executable PATH candidate is the shebang-selected runtime.
      // Reject it if its semantics cannot be reproduced; never fall through to a different Node.
      return null;
    }
  }
  return null;
}

function piLaunchFingerprint(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

export async function resolvePiExecutable(command, options = {}) {
  if (typeof command !== "string" || command.trim().length === 0 || command.includes("\0")) return null;
  const environment = options.environment ?? process.env;
  const run = options.runProcess ?? runProcess;
  const createEnvironment = options.createEnvironment ?? createIsolatedEnvironment;
  let discovery;
  try {
    try {
      discovery = await createEnvironment(environment, { prefix: "relaypact-pi-resolve-" });
    } catch {
      const error = new Error("Pi executable discovery state is unavailable.");
      error.code = "pi_resolution_isolation_unavailable";
      throw error;
    }
    for (const candidate of commandCandidates(command, environment)) {
      try {
        await access(candidate, fsConstants.X_OK);
      } catch {
        continue;
      }
      let resolvedCommand;
      let info;
      try {
        resolvedCommand = await realpath(candidate);
        info = await stat(resolvedCommand);
      } catch {
        return null;
      }
      if (!info.isFile()) continue;
      try {
        if (info.size > MAX_PI_EXECUTABLE_BYTES) return null;
        await access(resolvedCommand, fsConstants.X_OK);
        const launcherFingerprint = await executableFingerprint(resolvedCommand);
        if (!launcherFingerprint) return null;
        const target = path.basename(resolvedCommand) === "volta-shim"
          ? await resolveVoltaTarget(candidate, discovery.env, run, "pi", discovery.root)
          : resolvedCommand;
        if (!target) return null;
        const targetInfo = await stat(target);
        if (!targetInfo.isFile() || targetInfo.size > MAX_PI_EXECUTABLE_BYTES) return null;
        const targetFingerprint = await executableFingerprint(target);
        if (!targetFingerprint) return null;
        const shebang = await firstLine(target);
        const nodeRuntime = await resolveNodeRuntime(shebang, discovery.env, run, discovery.root);
        const nodePackage = nodeRuntime ? await findPiPackage(target) : null;
        if (shebang.startsWith("#!") && (!nodeRuntime || !nodePackage)) return null;
        const identity = {
          command: path.resolve(candidate),
          resolvedCommand,
          launcherFingerprint,
          target,
          targetFingerprint,
          kind: nodePackage ? "node-package" : "native",
          packageRoot: nodePackage?.root ?? null,
          packageEntry: nodePackage?.entry ?? null,
          packageGraph: nodePackage?.graph ?? null,
          packageFingerprint: nodePackage?.fingerprint ?? null,
          runtimeCommand: nodeRuntime?.target ?? null,
          runtimeFingerprint: nodeRuntime?.targetFingerprint ?? null,
          runtimeLaunchCommand: nodeRuntime?.command ?? null,
          runtimeResolvedCommand: nodeRuntime?.resolvedCommand ?? null,
          runtimeLauncherFingerprint: nodeRuntime?.launcherFingerprint ?? null
        };
        return { ...identity, executableFingerprint: piLaunchFingerprint(identity) };
      } catch {
        // The first executable regular-file PATH candidate is selected by command lookup.
        // Reject it if its launch identity cannot be reproduced; never fall through.
        return null;
      }
    }
    return null;
  } finally {
    if (await cleanupPiResources(discovery)) {
      const error = new Error("Pi executable discovery cleanup failed.");
      error.code = "pi_resolution_cleanup_failed";
      throw error;
    }
  }
}

function samePiExecutableIdentity(left, right) {
  return Boolean(left && right &&
    left.command === right.command &&
    left.executableFingerprint === right.executableFingerprint);
}

export async function materializePiExecutable(identity, options = {}) {
  if (!identity || !path.isAbsolute(identity.command) || !/^sha256:[a-f0-9]{64}$/u.test(identity.executableFingerprint)) {
    throw new Error("Pi executable identity is incomplete.");
  }
  const createEnvironment = options.createEnvironment ?? createIsolatedEnvironment;
  const environment = options.environment ?? process.env;
  let isolated;
  try {
    const snapshotBases = piSnapshotBaseDirectories(environment, options.snapshotBaseDirectory);
    for (const candidate of snapshotBases) {
      let candidateEnvironment;
      try {
        const snapshotBase = await preparePiSnapshotBaseDirectory(candidate);
        candidateEnvironment = await createEnvironment(environment, {
          prefix: "relaypact-pi-exec-",
          baseDirectory: snapshotBase
        });
        await assertPiSnapshotRootExecutable(candidateEnvironment, environment, options.runProcess ?? runProcess);
        isolated = candidateEnvironment;
        break;
      } catch {
        const cleanupFailed = await cleanupPiResources(candidateEnvironment);
        if (cleanupFailed) {
          const error = new Error("Pi launch snapshot cleanup failed.");
          error.code = "pi_snapshot_cleanup_failed";
          throw error;
        }
        if (options.snapshotBaseDirectory !== undefined || environment[PI_SNAPSHOT_ROOT_ENV] !== undefined) break;
      }
    }
    if (!isolated) throw piSnapshotRootUnavailable();
    if (identity.kind === "native") {
      const executable = path.join(isolated.root, "pi");
      await copyFile(identity.target, executable, fsConstants.COPYFILE_EXCL | (fsConstants.COPYFILE_FICLONE ?? 0));
      await chmod(executable, 0o500);
      if (await executableFingerprint(executable) !== identity.targetFingerprint) throw new Error("Pi executable changed during snapshot.");
      return { identity: { ...identity, launchCommand: executable, launchPrefix: [] }, cleanup: isolated.cleanup };
    }
    if (identity.kind !== "node-package" || !plainObject(identity.packageGraph) ||
        !path.isAbsolute(identity.runtimeCommand) || !path.isAbsolute(identity.runtimeLaunchCommand) ||
        identity.runtimeResolvedCommand !== identity.runtimeCommand ||
        identity.runtimeLauncherFingerprint !== identity.runtimeFingerprint) {
      throw new Error("Pi package identity is incomplete.");
    }
    const store = path.join(isolated.root, "packages");
    await mkdir(store, { mode: 0o700 });
    const destinations = new Map();
    for (const node of identity.packageGraph.nodes) {
      const destination = path.join(store, String(node.id));
      destinations.set(node.id, destination);
      await cp(node.root, destination, {
        recursive: true,
        verbatimSymlinks: true,
        filter(source) {
          const relative = path.relative(node.root, source);
          return relative === "" || relative.split(path.sep)[0] !== "node_modules";
        }
      });
      await chmod(destination, 0o700);
      const copiedBundle = await collectPiBundle(destination, "", 0, null, { excludeNodeModules: true });
      if (piBundleFingerprint(copiedBundle.entries) !== piBundleFingerprint(node.entries)) {
        throw new Error("Pi package changed during snapshot.");
      }
    }
    for (const node of identity.packageGraph.nodes) {
      const destination = destinations.get(node.id);
      for (const dependency of node.dependencies) {
        const parts = packageNameParts(dependency.name);
        const target = destinations.get(dependency.target);
        if (!parts || !target) throw new Error("Pi dependency closure is incomplete.");
        const link = path.join(destination, "node_modules", ...parts);
        await mkdir(path.dirname(link), { recursive: true, mode: 0o700 });
        await symlink(path.relative(path.dirname(link), target), link, process.platform === "win32" ? "junction" : "dir");
      }
    }
    if (piPackageGraphFingerprint(identity.packageGraph) !== identity.packageFingerprint) {
      throw new Error("Pi dependency closure identity changed during snapshot.");
    }
    const runtime = path.join(isolated.root, "node");
    await copyFile(identity.runtimeCommand, runtime, fsConstants.COPYFILE_EXCL | (fsConstants.COPYFILE_FICLONE ?? 0));
    await chmod(runtime, 0o500);
    if (await executableFingerprint(runtime) !== identity.runtimeFingerprint) throw new Error("Pi runtime changed during snapshot.");
    return {
      identity: {
        ...identity,
        launchCommand: runtime,
        launchPrefix: [path.join(destinations.get(identity.packageGraph.rootId), identity.packageEntry)]
      },
      cleanup: isolated.cleanup
    };
  } catch (cause) {
    const cleanupFailed = await cleanupPiResources(isolated);
    const rootUnavailable = cause?.code === "pi_snapshot_root_unavailable";
    const priorCleanupFailed = cause?.code === "pi_snapshot_cleanup_failed";
    const error = new Error(cleanupFailed
      ? "Pi launch snapshot cleanup failed."
      : priorCleanupFailed
        ? "Pi launch snapshot cleanup failed."
      : rootUnavailable
        ? "Pi executable snapshot root is not executable."
        : "Pi launch identity could not be snapshotted.");
    error.code = cleanupFailed
      ? "pi_snapshot_cleanup_failed"
      : priorCleanupFailed
        ? "pi_snapshot_cleanup_failed"
        : rootUnavailable ? "pi_snapshot_root_unavailable" : "pi_snapshot_failed";
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

async function probePiSnapshot(run, materializeExecutable, identity, args, environment, cwd) {
  const outcome = { probe: null, snapshotFailed: false, snapshotUnavailable: false, cleanupFailed: false };
  let materialized;
  try {
    materialized = await materializeExecutable(identity);
    outcome.probe = await probePi(run, materialized.identity, args, environment, cwd);
  } catch (error) {
    outcome.snapshotFailed = true;
    if (error?.code === "pi_snapshot_cleanup_failed") outcome.cleanupFailed = true;
    if (error?.code === "pi_snapshot_root_unavailable") outcome.snapshotUnavailable = true;
  } finally {
    outcome.cleanupFailed = await cleanupPiResources(materialized) || outcome.cleanupFailed;
  }
  return outcome;
}

export async function discoverPiCli(options = {}) {
  const run = options.runProcess ?? runProcess;
  const resolveExecutable = options.resolveExecutable ?? resolvePiExecutable;
  const environment = options.environment ?? process.env;
  const createEnvironment = options.createEnvironment ?? createIsolatedEnvironment;
  const materializeExecutable = options.materializeExecutable ?? ((identity) => materializePiExecutable(identity, {
    environment,
    snapshotBaseDirectory: options.snapshotBaseDirectory
  }));
  const selectedCommand = options.executorCommand ?? "pi";
  let identity;
  try {
    identity = await resolveExecutable(selectedCommand, {
      environment,
      commandBaseDirectory: options.commandBaseDirectory,
      runProcess: run
    });
  } catch (error) {
    const reason = error?.code === "pi_resolution_cleanup_failed"
      ? "cleanup_failed"
      : error?.code === "pi_resolution_isolation_unavailable"
        ? "isolation_unavailable"
        : "missing";
    return unavailablePiReadiness(reason);
  }
  if (!identity) return unavailablePiReadiness("missing");

  let isolated;
  let version = null;
  let versionCompatible = false;
  let settingsIsolated = false;
  let capabilities = {};
  let reason = null;
  const snapshotProbes = run === runProcess || options.materializeExecutable;
  let readiness;
  let cleanupFailed = false;
  try {
    isolated = await createEnvironment(environment, {
      prefix: "relaypact-pi-doctor-",
      grants: { GIT_OPTIONAL_LOCKS: "0" }
    });
  } catch {
    return unavailablePiReadiness("isolation_unavailable", { command: identity.command });
  }
  const configuration = path.join(isolated.root, "agent");
  try {
    await mkdir(configuration, { mode: 0o700 });
  } catch {
    const setupCleanupFailed = await cleanupPiResources(isolated);
    return unavailablePiReadiness(setupCleanupFailed ? "cleanup_failed" : "isolation_unavailable", {
      command: identity.command
    });
  }
  try {
    const probeEnvironment = {
      ...isolated.env,
      PI_CODING_AGENT_DIR: configuration,
      PI_CODING_AGENT_SESSION_DIR: isolated.temporary
    };

    const runProbe = async (args) => snapshotProbes
      ? probePiSnapshot(run, materializeExecutable, identity, args, probeEnvironment, isolated.root)
      : { probe: await probePi(run, identity, args, probeEnvironment, isolated.root), snapshotFailed: false, cleanupFailed: false };

    const versionOutcome = await runProbe(["--version"]);
    if (versionOutcome.cleanupFailed) reason = "cleanup_failed";
    else if (versionOutcome.snapshotUnavailable) reason = "snapshot_unavailable";
    else if (versionOutcome.snapshotFailed) reason = "mutated";
    else {
      const versionProbe = versionOutcome.probe;
      const settingsWriteDetected = SETTINGS_WRITE_FAILURE.test(versionProbe.output);
      if (settingsWriteDetected) reason = "settings_write_attempt";
      else if (versionProbe.state !== "complete") reason = versionProbe.state;
      else if (versionProbe.exitCode !== 0 || versionProbe.signal) reason = "unsupported";
      else {
        settingsIsolated = true;
        version = parsePiVersion(versionProbe.output);
        versionCompatible = version !== null && compareVersions(version, MINIMUM_PI_VERSION) >= 0;
        if (!versionCompatible) reason = "unsupported_version";
      }
    }

    if (!reason) {
      settingsIsolated = false;
      const helpOutcome = await runProbe(["--help"]);
      if (helpOutcome.cleanupFailed) reason = "cleanup_failed";
      else if (helpOutcome.snapshotUnavailable) reason = "snapshot_unavailable";
      else if (helpOutcome.snapshotFailed) reason = "mutated";
      else {
        const helpProbe = helpOutcome.probe;
        const settingsWriteDetected = SETTINGS_WRITE_FAILURE.test(helpProbe.output);
        if (settingsWriteDetected) reason = "settings_write_attempt";
        else if (helpProbe.state !== "complete") reason = helpProbe.state;
        else if (helpProbe.exitCode !== 0 || helpProbe.signal) reason = "unsupported";
        else {
          settingsIsolated = true;
          const supported = Object.fromEntries(REQUIRED_PI_FLAGS.map((flag) => [flag, helpHasOption(helpProbe.output, flag)]));
          const modeLine = helpOptionLine(helpProbe.output, "--mode");
          capabilities = {
            nonInteractive: supported["--print"] === true,
            structuredOutput: supported["--mode"] === true && /\btext\b/u.test(modeLine) && /\bjson\b/u.test(modeLine),
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
    }

    let verifiedIdentity;
    try {
      verifiedIdentity = await resolveExecutable(selectedCommand, {
        environment,
        commandBaseDirectory: options.commandBaseDirectory,
        runProcess: run
      });
    } catch (error) {
      if (error?.code === "pi_resolution_cleanup_failed") reason = "cleanup_failed";
      else if (error?.code === "pi_resolution_isolation_unavailable") reason = "isolation_unavailable";
    }
    const executableStable = samePiExecutableIdentity(identity, verifiedIdentity);
    if (!executableStable && reason !== "cleanup_failed" && reason !== "isolation_unavailable") reason = "mutated";
    if (reason) {
      readiness = unavailablePiReadiness(reason, {
        command: identity.command,
        version,
        versionCompatible,
        executableStable,
        settingsIsolated,
        executableFingerprint: executableStable ? identity.executableFingerprint : null,
        capabilities
      });
    } else {
      readiness = {
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
    }
  } finally {
    cleanupFailed = await cleanupPiResources(isolated);
  }
  return cleanupFailed
    ? unavailablePiReadiness("cleanup_failed", { command: identity.command })
    : readiness;
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
  let executionFailure;
  let cleanupFailed = false;
  let credentialEvidenceTrusted = false;
  const finish = (result) => attachExecutorSecurity(result, { sensitiveValues, credentialEvidenceTrusted });
  try {
    const readiness = await discoverPiCli({
      executorCommand: selectedCommand,
      environment: environmentSource,
      commandBaseDirectory: options.commandBaseDirectory ?? process.cwd(),
      snapshotBaseDirectory: options.snapshotBaseDirectory
    });
    if (readiness.state !== "ready") {
      throw new DelegationError("pi_readiness_blocked", `Pi readiness is blocked: ${readiness.reason ?? "unavailable"}.`);
    }
    const executableIdentity = await resolvePiExecutable(selectedCommand, {
      environment: environmentSource,
      commandBaseDirectory: options.commandBaseDirectory ?? process.cwd(),
      runProcess
    });
    if (!executableIdentity) throw new DelegationError("pi_executor_unavailable", "The selected Pi executable could not be resolved to a supported absolute launch identity.");
    if (readiness.command !== executableIdentity.command || readiness.executableFingerprint !== executableIdentity.executableFingerprint) {
      throw new DelegationError("pi_executor_unavailable", "The selected Pi executable changed after readiness verification.");
    }
    executableSnapshot = options.materializeExecutable
      ? await options.materializeExecutable(executableIdentity)
      : await materializePiExecutable(executableIdentity, {
        environment: environmentSource,
        snapshotBaseDirectory: options.snapshotBaseDirectory
      });
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
    if (error?.code === "pi_snapshot_cleanup_failed" || error?.code === "pi_resolution_cleanup_failed") {
      cleanupFailed = true;
    }
    if (!processResult && !projection) credentialEvidenceTrusted = true;
    const readinessBlocked = error?.code === "pi_readiness_blocked";
    executionFailure = {
      reportedStatus: readinessBlocked ? "blocked" : "failed",
      summary: conciseOutput(`Executor could not start: ${error.message}`, 4000, sensitiveValues),
      residualRisks: [],
      exitCode: null,
      signal: null,
      timedOut: false,
      output: ""
    };
    if (readinessBlocked) executionFailure.failureCode = "pi_readiness_blocked";
    if (error?.code === "pi_snapshot_root_unavailable") executionFailure.failureCode = "pi_snapshot_unavailable";
  } finally {
    cleanupFailed = await cleanupPiResources(isolated, executableSnapshot) || cleanupFailed;
  }

  if (cleanupFailed) {
    return finish({
      reportedStatus: "failed",
      summary: "Pi temporary state cleanup failed.",
      residualRisks: ["Executor temporary state cleanup requires Host review."],
      failureCode: "pi_cleanup_failed",
      ...processMetadata(processResult),
      output: ""
    });
  }
  if (executionFailure) return finish(executionFailure);

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
