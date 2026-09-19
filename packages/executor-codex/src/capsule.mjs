import { filesystemEvidenceMaxBytes } from "../../contracts/src/envelope.mjs";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertContextManifestIdentity, planDelegationContext } from "../../core/src/context/planner.mjs";
import { minimalEnvironment } from "../../core/src/environment.mjs";
import { DelegationError } from "../../contracts/src/errors.mjs";
import { assertFilesystemSnapshot, changedFilesystemPaths, snapshotFilesystem, snapshotGitControls } from "../../core/src/filesystem-evidence.mjs";
import { assertGitIndexSnapshot, getCommittedDiffPaths, getHead, getStatusPaths, snapshotGitIndex } from "../../core/src/git.mjs";
import { evaluatePathScope, globToRegExp, normalizeRelativePath } from "../../contracts/src/path-policy.mjs";
import { runProcess } from "../../core/src/process.mjs";
import { containsExactSensitiveValue } from "../../core/src/redact.mjs";

const PRIVATE_SEGMENTS = new Set([".git", ".relaypact", ".pi", ".codex", ".ssh", "node_modules"]);
const PRIVATE_FILES = /^(?:\.env(?:\..*)?|auth\.json|credentials?(?:\..*)?|secrets?(?:\..*)?)$/i;
const GLOB_CHARACTER = /[*?[\]]/;
const MAX_CONTEXT_FILE_BYTES = 16 * 1024 * 1024;
const MAX_EXPLICIT_CONTEXT_BYTES = 64 * 1024 * 1024;
const MAX_CREDENTIAL_EVIDENCE_BYTES = 64 * 1024 * 1024;
const MAX_GIT_LINK_BYTES = 256 * 1024;
const CAPSULE_FILESYSTEM_BASELINE = "capsule-filesystem-baseline.json";
const SOURCE_FILESYSTEM_BASELINE = "source-filesystem-baseline.json";
const SOURCE_GIT_CONTROL_BASELINE = "source-git-control-baseline.json";
const SOURCE_GIT_INDEX_BASELINE = "source-git-index-baseline.json";
const PRIVATE_GIT_INDEX_BASELINE = "git-index-baseline.json";
const PRIVATE_CONTROL_BASELINE = "private-control-baseline.json";
export const IMMUTABLE_PRIVATE_CONTROL_PATHS = [
  "capsule.json",
  "control/task-envelope.json",
  "control/codex-worker-result.schema.json",
  "control/context-manifest.json",
  "control/capsule-filesystem-baseline.json",
  "control/source-filesystem-baseline.json",
  "control/source-git-control-baseline.json",
  "control/source-git-index-baseline.json",
  "control/git-index-baseline.json",
  "control/git/HEAD",
  "control/git/config",
  "control/git/packed-refs",
  "control/git/refs",
  "control/git/info",
  "control/git/hooks",
  "control/git/objects/info",
  "control/git/objects/pack",
  "control/git/shallow",
  "control/git/commondir"
];
const EXECUTOR_CAPSULE_ROOT = process.platform === "win32"
  ? "C:\\relaypact\\capsule"
  : "/relaypact/capsule";

async function updateFileHash(hash, absolute, before) {
  await new Promise((resolve, reject) => {
    const stream = createReadStream(absolute);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  const after = await lstat(absolute);
  if (
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs ||
    after.ino !== before.ino ||
    !after.isFile()
  ) {
    throw new DelegationError("source_state_unstable", "Source workspace changed while its private state fingerprint was collected.");
  }
}

async function sourceStateFingerprint(root, statusPaths) {
  const hash = createHash("sha256");
  for (const relative of [...statusPaths].sort()) {
    const absolute = path.resolve(root, relative);
    hash.update(`path:${relative}\0`);
    let info;
    try {
      info = await lstat(absolute);
    } catch (error) {
      if (error?.code === "ENOENT") {
        hash.update("missing\0");
        continue;
      }
      throw new DelegationError("source_state_unreadable", "Source workspace state cannot be fingerprinted safely.");
    }
    hash.update(`mode:${info.mode & 0o7777}\0size:${info.size}\0`);
    try {
      if (info.isSymbolicLink()) {
        hash.update(`symlink:${await readlink(absolute)}\0`);
      } else if (info.isFile()) {
        hash.update("file:\0");
        await updateFileHash(hash, absolute, info);
        hash.update("\0");
      } else {
        hash.update("other\0");
      }
    } catch (error) {
      if (error instanceof DelegationError) throw error;
      throw new DelegationError("source_state_unreadable", "Source workspace state cannot be fingerprinted safely.");
    }
  }
  return `sha256:${hash.digest("hex")}`;
}

function safeTaskName(taskId) {
  return taskId.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 48) || "task";
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isPrivate(relative) {
  const parts = relative.split("/");
  return parts.some((part) => PRIVATE_SEGMENTS.has(part.toLowerCase()) || PRIVATE_FILES.test(part));
}

async function rejectSymlinkComponents(root, relative) {
  let current = root;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) {
      throw new DelegationError("unsafe_capsule_input", `Readable input contains a symlink component: ${relative}.`);
    }
  }
}

async function fileMetadata(root, relative, forbiddenPatterns, maximumBytes) {
  if (GLOB_CHARACTER.test(relative)) {
    throw new DelegationError("unsafe_capsule_input", `Readable inputs must be literal paths: ${relative}.`);
  }
  if (isPrivate(relative)) {
    throw new DelegationError("unsafe_capsule_input", `Readable input is private: ${relative}.`);
  }
  if (forbiddenPatterns.some((pattern) => pattern.test(relative))) {
    throw new DelegationError(
      "unsafe_capsule_input",
      `Readable input is also forbidden: ${relative}. Express read-only access by keeping the path in readablePaths, omitting it from allowedPaths, and removing it from forbiddenPaths.`
    );
  }
  const absolute = path.resolve(root, relative);
  let resolved;
  try {
    await rejectSymlinkComponents(root, relative);
    resolved = await realpath(absolute);
  } catch (error) {
    if (error instanceof DelegationError) throw error;
    throw new DelegationError("capsule_input_missing", `Readable input does not exist: ${relative}.`);
  }
  if (!isInside(root, resolved)) throw new DelegationError("unsafe_capsule_input", `Readable input escapes the repository: ${relative}.`);
  const info = await lstat(resolved);
  if (!info.isFile()) throw new DelegationError("unsafe_capsule_input", `Readable input must be a regular file: ${relative}.`);
  if (!Number.isSafeInteger(info.size) || info.size < 0 || info.size > Math.min(MAX_CONTEXT_FILE_BYTES, maximumBytes)) {
    throw new DelegationError("context_budget_exceeded", `Readable input exceeds the capsule byte budget: ${relative}.`);
  }
  const content = await readFile(resolved);
  const after = await lstat(resolved);
  if (
    content.byteLength !== info.size ||
    after.size !== info.size ||
    after.dev !== info.dev ||
    after.ino !== info.ino ||
    after.mtimeMs !== info.mtimeMs ||
    !after.isFile()
  ) {
    throw new DelegationError("context_source_changed", `Readable input changed while it was collected: ${relative}.`);
  }
  return {
    relative,
    absolute: resolved,
    mode: info.mode & 0o777,
    sha256: createHash("sha256").update(content).digest("hex"),
    bytes: content.byteLength,
    content,
    identity: { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs }
  };
}

function exposureFor(envelope, profile) {
  const mode = envelope.execution?.exposureMode ?? "sanitized";
  if (mode === "trusted-worktree" && envelope.execution?.trustedWorktreeAcknowledged !== true) {
    throw new DelegationError(
      "trusted_worktree_not_acknowledged",
      "trusted-worktree requires explicit acknowledgement that it exposes the broader checkout and is not an operating-system sandbox."
    );
  }
  if (profile.external && envelope.execution?.exposureMode === undefined) return "sanitized";
  return mode;
}

async function checkedGit(args, cwd, options = {}) {
  const gitControl = options.gitControl;
  const invocation = [
    ...(gitControl ? [`--git-dir=${gitControl.gitDir}`, `--work-tree=${gitControl.workTree}`] : []),
    "-c", "core.fsmonitor=false",
    "-c", `core.hooksPath=${os.devNull}`,
    ...args
  ];
  const env = minimalEnvironment(process.env, {
    grants: {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
      ...(options.env ?? {})
    }
  });
  const result = await runProcess("git", invocation, { cwd, env, timeoutMs: 30_000 });
  if (result.stdoutTruncated || result.stderrTruncated) {
    throw new DelegationError("git_output_truncated", `Capsule Git output exceeded the evidence capture bound: git ${args.join(" ")}.`);
  }
  if (result.exitCode !== 0) throw new DelegationError("capsule_git_error", `Capsule Git command failed: git ${args.join(" ")}.`);
  return result;
}

export async function preflightCapsule({ envelope, repository, profile, stateRoot, workerResultSchemaPath }) {
  const mode = exposureFor(envelope, profile);
  const requestedStateRoot = stateRoot ?? os.tmpdir();
  if (!path.isAbsolute(requestedStateRoot)) throw new DelegationError("invalid_state_root", "State root must be absolute.");
  let stateRootInfo;
  let resolvedStateRoot;
  try {
    stateRootInfo = await lstat(requestedStateRoot);
    resolvedStateRoot = await realpath(requestedStateRoot);
  } catch {
    throw new DelegationError("invalid_state_root", "State root must be a pre-existing real directory.");
  }
  if (!stateRootInfo.isDirectory() || stateRootInfo.isSymbolicLink()) {
    throw new DelegationError("invalid_state_root", "State root must be a pre-existing real directory, not a symlink.");
  }
  if (isInside(repository.gitRoot, resolvedStateRoot)) {
    throw new DelegationError("invalid_state_root", "State root must be outside the source repository.");
  }

  let schemaPath;
  try {
    schemaPath = await realpath(workerResultSchemaPath);
    if (!(await stat(schemaPath)).isFile()) throw new Error("not a file");
  } catch {
    throw new DelegationError("worker_schema_missing", "Codex worker result schema is unavailable.");
  }

  const contextManifest = envelope.contextPlanning
    ? await planDelegationContext(envelope, repository.gitRoot)
    : null;
  const readablePaths = contextManifest
    ? contextManifest.selectedFiles.map((item) => item.relativePath)
    : (envelope.scope.readablePaths ?? []).map((item) => normalizeRelativePath(item, "readable path"));
  const forbiddenPatterns = envelope.scope.forbiddenPaths.map((pattern) => globToRegExp(pattern, { caseInsensitive: true }));
  const inputs = [];
  const maximumBytes = contextManifest?.budget.maxBytes ?? MAX_EXPLICIT_CONTEXT_BYTES;
  let selectedBytes = 0;
  for (const relative of readablePaths) {
    const input = await fileMetadata(repository.gitRoot, relative, forbiddenPatterns, maximumBytes - selectedBytes);
    selectedBytes += input.bytes;
    if (selectedBytes > maximumBytes) {
      throw new DelegationError("context_budget_exceeded", "Readable inputs exceed the capsule aggregate byte budget.");
    }
    inputs.push(input);
  }
  if (contextManifest) {
    for (const input of inputs) {
      const planned = contextManifest.selectedFiles.find((item) => item.relativePath === input.relative);
      if (!planned || planned.sha256 !== input.sha256 || planned.bytes !== input.bytes) {
        throw new DelegationError("context_source_changed", "Selected context changed while the capsule was being preflighted.");
      }
    }
  }

  const head = await getHead(repository.gitRoot);
  if (mode === "trusted-worktree" && !head) {
    throw new DelegationError("trusted_worktree_requires_head", "trusted-worktree requires a committed Git HEAD.");
  }

  const sourceStatus = await getStatusPaths(repository.gitRoot);
  const sourceStateFingerprintValue = await sourceStateFingerprint(repository.gitRoot, sourceStatus);
  const [headAfterFingerprint, statusAfterFingerprint] = await Promise.all([
    getHead(repository.gitRoot),
    getStatusPaths(repository.gitRoot)
  ]);
  if (headAfterFingerprint !== head || JSON.stringify(statusAfterFingerprint) !== JSON.stringify(sourceStatus)) {
    throw new DelegationError("source_state_unstable", "Source workspace changed during capsule preflight.");
  }

  return {
    mode,
    stateRoot: resolvedStateRoot,
    schemaPath,
    inputs,
    contextManifest,
    sourceHead: head,
    sourceStatus,
    sourceStateFingerprint: sourceStateFingerprintValue
  };
}

async function writeControlFiles(taskRoot, envelope, schemaPath, contextManifest) {
  const controlRoot = path.join(taskRoot, "control");
  await mkdir(controlRoot, { recursive: true, mode: 0o700 });
  const envelopePath = path.join(controlRoot, "task-envelope.json");
  const resultSchemaPath = path.join(controlRoot, "codex-worker-result.schema.json");
  const contextManifestPath = contextManifest ? path.join(controlRoot, "context-manifest.json") : null;
  await writeFile(envelopePath, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 });
  await copyFile(schemaPath, resultSchemaPath);
  await chmod(resultSchemaPath, 0o600);
  if (contextManifestPath) {
    await writeFile(contextManifestPath, `${JSON.stringify(contextManifest, null, 2)}\n`, { mode: 0o600 });
    await chmod(contextManifestPath, 0o600);
  }
  return { controlRoot, envelopePath, resultSchemaPath, contextManifestPath };
}

function containsSourceRoot(value, sourceRoots) {
  if (typeof value === "string") {
    const candidate = value.toLowerCase();
    return sourceRoots.some((sourceRoot) => candidate.includes(sourceRoot.toLowerCase()));
  }
  if (Array.isArray(value)) return value.some((item) => containsSourceRoot(item, sourceRoots));
  if (value && typeof value === "object") {
    return Object.values(value).some((item) => containsSourceRoot(item, sourceRoots));
  }
  return false;
}

export function projectExecutorEnvelope(envelope, sourceRoot) {
  const projection = {
    ...envelope,
    repository: {
      root: EXECUTOR_CAPSULE_ROOT,
      workingDirectory: ".",
      dirtyTree: { allow: false, acknowledgedPaths: [] }
    }
  };
  const sourceRoots = [...new Set([sourceRoot, envelope.repository.root].filter(Boolean))];
  if (containsSourceRoot(projection, sourceRoots)) {
    throw new DelegationError(
      "unsafe_executor_envelope",
      "The sanitized executor envelope still contains the host source root."
    );
  }
  return projection;
}

async function copyCapsuleControls(capsuleRoot, control, envelope, sourceRoot) {
  const destinationRoot = path.join(capsuleRoot, ".relaypact");
  await mkdir(destinationRoot, { recursive: true, mode: 0o700 });
  const envelopeDestination = path.join(destinationRoot, "task-envelope.json");
  const schemaDestination = path.join(destinationRoot, "codex-worker-result.schema.json");
  const contextManifestDestination = control.contextManifestPath
    ? path.join(destinationRoot, "context-manifest.json")
    : null;
  const executorEnvelope = projectExecutorEnvelope(envelope, sourceRoot);
  await writeFile(envelopeDestination, `${JSON.stringify(executorEnvelope, null, 2)}\n`, { mode: 0o600 });
  await copyFile(control.resultSchemaPath, schemaDestination);
  await chmod(envelopeDestination, 0o600);
  await chmod(schemaDestination, 0o600);
  if (contextManifestDestination) {
    await copyFile(control.contextManifestPath, contextManifestDestination);
    await chmod(contextManifestDestination, 0o600);
  }
  return { contextManifestDestination };
}

export async function copyVerifiedInput(input, destination) {
  const current = await lstat(input.absolute);
  if (
    current.dev !== input.identity.dev ||
    current.ino !== input.identity.ino ||
    current.size !== input.identity.size ||
    current.mtimeMs !== input.identity.mtimeMs ||
    !current.isFile()
  ) {
    throw new DelegationError("context_source_changed", `Readable input changed before capsule copy: ${input.relative}.`);
  }
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await writeFile(destination, input.content, { flag: "wx", mode: input.mode });
  const copied = await readFile(destination);
  if (copied.byteLength !== input.bytes || createHash("sha256").update(copied).digest("hex") !== input.sha256) {
    throw new DelegationError("context_copy_mismatch", `Capsule copy does not match the authorized source bytes: ${input.relative}.`);
  }
  await chmod(destination, input.mode);
}

async function prepareSanitized(preflight, taskRoot, control, envelope, sourceRoot) {
  const capsuleRoot = path.join(taskRoot, "capsule");
  await mkdir(capsuleRoot, { recursive: true, mode: 0o700 });
  for (const input of preflight.inputs) {
    const destination = path.join(capsuleRoot, input.relative);
    await copyVerifiedInput(input, destination);
  }
  const copiedControls = await copyCapsuleControls(capsuleRoot, control, envelope, sourceRoot);
  const gitDir = path.join(control.controlRoot, "git");
  await checkedGit(["init", "-b", "delegated-task", `--separate-git-dir=${gitDir}`, capsuleRoot], taskRoot);
  const gitControl = { gitDir, workTree: capsuleRoot };
  await checkedGit(["add", "--", "."], capsuleRoot, { gitControl });
  const deterministicGitEnv = {
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z"
  };
  await checkedGit([
    "-c", "user.name=RelayPact",
    "-c", "user.email=relaypact@example.invalid",
    "commit", "--allow-empty", "-m", "delegation: capsule baseline"
  ], capsuleRoot, { env: deterministicGitEnv, gitControl });
  const baseline = (await checkedGit(["rev-parse", "HEAD"], capsuleRoot, { gitControl })).stdout.trim();
  const gitLinkSha256 = createHash("sha256").update(await readFile(path.join(capsuleRoot, ".git"))).digest("hex");
  return { capsuleRoot, baseline, gitControl, gitLinkSha256, executorContextManifestPath: copiedControls.contextManifestDestination };
}

async function prepareTrusted(preflight, repository, taskRoot) {
  const capsuleRoot = path.join(taskRoot, "worktree");
  await checkedGit(["worktree", "add", "--detach", capsuleRoot, preflight.sourceHead], repository.gitRoot);
  const gitDir = (await checkedGit(["rev-parse", "--absolute-git-dir"], capsuleRoot)).stdout.trim();
  const gitControl = { gitDir: await realpath(gitDir), workTree: capsuleRoot };
  const gitLinkSha256 = createHash("sha256").update(await readFile(path.join(capsuleRoot, ".git"))).digest("hex");
  return { capsuleRoot, baseline: preflight.sourceHead, gitControl, gitLinkSha256 };
}

export async function prepareCapsule(options) {
  const preflight = await preflightCapsule(options);
  await mkdir(preflight.stateRoot, { recursive: true, mode: 0o700 });
  const taskRoot = path.join(preflight.stateRoot, `relaypact-${safeTaskName(options.envelope.taskId)}-${randomUUID()}`);
  await mkdir(taskRoot, { mode: 0o700 });
  const taskRootInfo = await lstat(taskRoot);
  const control = await writeControlFiles(taskRoot, options.envelope, preflight.schemaPath, preflight.contextManifest);
  let prepared;
  try {
    prepared = preflight.mode === "trusted-worktree"
      ? await prepareTrusted(preflight, options.repository, taskRoot)
      : await prepareSanitized(
        preflight,
        taskRoot,
        control,
        options.envelope,
        options.repository.gitRoot
      );
  } catch (error) {
    await rm(taskRoot, { recursive: true, force: true });
    throw error;
  }
  const [
    capsuleFilesystemBaseline,
    sourceFilesystemBaseline,
    sourceGitControlBaseline,
    capsuleGitIndexBaseline,
    sourceGitIndexBaseline
  ] = await Promise.all([
    snapshotFilesystem(prepared.capsuleRoot, { exclude: [".git"], maxBytes: filesystemEvidenceMaxBytes(options.envelope) }),
    snapshotFilesystem(options.repository.gitRoot, { exclude: [".git"], maxBytes: filesystemEvidenceMaxBytes(options.envelope) }),
    snapshotGitControls(options.repository.gitRoot, { excludeIndexes: true }),
    snapshotGitIndex(prepared.capsuleRoot, prepared.gitControl),
    snapshotGitIndex(options.repository.gitRoot)
  ]);
  const capsuleFilesystemBaselinePath = path.join(control.controlRoot, CAPSULE_FILESYSTEM_BASELINE);
  const sourceFilesystemBaselinePath = path.join(control.controlRoot, SOURCE_FILESYSTEM_BASELINE);
  const sourceGitControlBaselinePath = path.join(control.controlRoot, SOURCE_GIT_CONTROL_BASELINE);
  const capsuleGitIndexBaselinePath = path.join(control.controlRoot, PRIVATE_GIT_INDEX_BASELINE);
  const sourceGitIndexBaselinePath = path.join(control.controlRoot, SOURCE_GIT_INDEX_BASELINE);
  await writeFile(capsuleFilesystemBaselinePath, `${JSON.stringify(capsuleFilesystemBaseline)}\n`, { flag: "wx", mode: 0o600 });
  await writeFile(sourceFilesystemBaselinePath, `${JSON.stringify(sourceFilesystemBaseline)}\n`, { flag: "wx", mode: 0o600 });
  await writeFile(sourceGitControlBaselinePath, `${JSON.stringify(sourceGitControlBaseline)}\n`, { flag: "wx", mode: 0o600 });
  await writeFile(capsuleGitIndexBaselinePath, `${JSON.stringify(capsuleGitIndexBaseline)}\n`, { flag: "wx", mode: 0o600 });
  await writeFile(sourceGitIndexBaselinePath, `${JSON.stringify(sourceGitIndexBaseline)}\n`, { flag: "wx", mode: 0o600 });
  const inputMetadata = preflight.inputs.map(({ relative, mode, sha256, bytes }) => ({ path: relative, mode, sha256, bytes }));
  const marker = {
    schemaVersion: "1.0.0",
    taskId: options.envelope.taskId,
    filesystemEvidenceMaxBytes: filesystemEvidenceMaxBytes(options.envelope),
    taskRootIdentity: { dev: taskRootInfo.dev, ino: taskRootInfo.ino },
    mode: preflight.mode,
    capsuleRoot: prepared.capsuleRoot,
    sourceRoot: options.repository.gitRoot,
    sourceHead: preflight.sourceHead,
    sourceStatus: preflight.sourceStatus,
    sourceStateFingerprint: preflight.sourceStateFingerprint,
    inputMetadata,
    contextManifestFingerprint: preflight.contextManifest?.fingerprint ?? null,
    gitDir: prepared.gitControl?.gitDir ?? null,
    gitLinkSha256: prepared.gitLinkSha256 ?? null,
    capsuleFilesystemFingerprint: capsuleFilesystemBaseline.fingerprint,
    sourceFilesystemFingerprint: sourceFilesystemBaseline.fingerprint,
    sourceGitControlFingerprint: sourceGitControlBaseline.fingerprint,
    capsuleGitIndexFingerprint: capsuleGitIndexBaseline.fingerprint,
    sourceGitIndexFingerprint: sourceGitIndexBaseline.fingerprint
  };
  const markerPath = path.join(taskRoot, "capsule.json");
  await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
  const privateControlBaseline = await snapshotFilesystem(taskRoot, {
    selectedPaths: IMMUTABLE_PRIVATE_CONTROL_PATHS
  });
  const privateControlBaselinePath = path.join(control.controlRoot, PRIVATE_CONTROL_BASELINE);
  await writeFile(privateControlBaselinePath, `${JSON.stringify(privateControlBaseline)}\n`, { flag: "wx", mode: 0o600 });
  return {
    ...prepared,
    ...control,
    taskId: options.envelope.taskId,
    filesystemEvidenceMaxBytes: filesystemEvidenceMaxBytes(options.envelope),
    taskRoot,
    taskRootIdentity: marker.taskRootIdentity,
    markerPath,
    mode: preflight.mode,
    sourceHead: preflight.sourceHead,
    sourceStatus: preflight.sourceStatus,
    sourceStateFingerprint: preflight.sourceStateFingerprint,
    contextManifest: preflight.contextManifest,
    contextManifestFingerprint: preflight.contextManifest?.fingerprint ?? null,
    capsuleFilesystemBaseline,
    capsuleFilesystemBaselinePath,
    sourceFilesystemBaseline,
    sourceFilesystemBaselinePath,
    sourceGitControlBaseline,
    sourceGitControlBaselinePath,
    capsuleGitIndexBaseline,
    capsuleGitIndexBaselinePath,
    sourceGitIndexBaseline,
    sourceGitIndexBaselinePath,
    privateControlBaseline,
    privateControlBaselinePath,
    inputMetadata
  };
}

async function loadFilesystemBaseline(capsule, kind) {
  const objectKey = kind === "capsule" ? "capsuleFilesystemBaseline" : "sourceFilesystemBaseline";
  const pathKey = kind === "capsule" ? "capsuleFilesystemBaselinePath" : "sourceFilesystemBaselinePath";
  if (capsule[objectKey]) return assertFilesystemSnapshot(capsule[objectKey]);
  try {
    return assertFilesystemSnapshot(JSON.parse(await readFile(capsule[pathKey], "utf8")));
  } catch (error) {
    if (error instanceof DelegationError) throw error;
    throw new DelegationError("filesystem_evidence_invalid", `${kind} filesystem baseline is missing or malformed.`);
  }
}

export async function getCapsuleFilesystemChanges(capsule) {
  const baseline = await loadFilesystemBaseline(capsule, "capsule");
  const current = await snapshotFilesystem(capsule.capsuleRoot, { exclude: [".git"], maxBytes: capsule.filesystemEvidenceMaxBytes });
  return changedFilesystemPaths(baseline, current);
}

export async function getPrivateControlChanges(capsule) {
  let persisted;
  try {
    persisted = assertFilesystemSnapshot(JSON.parse(await readFile(capsule.privateControlBaselinePath, "utf8")));
  } catch (error) {
    if (error instanceof DelegationError) throw error;
    throw new DelegationError("filesystem_evidence_invalid", "Private control baseline is missing or malformed.");
  }
  const baseline = capsule.privateControlBaseline
    ? assertFilesystemSnapshot(capsule.privateControlBaseline)
    : persisted;
  const changes = [];
  if (baseline.fingerprint !== persisted.fingerprint) changes.push("control/private-control-baseline.json");
  const current = await snapshotFilesystem(capsule.taskRoot, {
    selectedPaths: IMMUTABLE_PRIVATE_CONTROL_PATHS
  });
  let gitIndexBaseline;
  try {
    const persistedIndex = assertGitIndexSnapshot(JSON.parse(await readFile(capsule.capsuleGitIndexBaselinePath, "utf8")));
    gitIndexBaseline = capsule.capsuleGitIndexBaseline
      ? assertGitIndexSnapshot(capsule.capsuleGitIndexBaseline)
      : persistedIndex;
    if (gitIndexBaseline.fingerprint !== persistedIndex.fingerprint) changes.push("control/git-index-baseline.json");
  } catch (error) {
    if (error instanceof DelegationError) throw error;
    throw new DelegationError("git_index_evidence_invalid", "Private Git index baseline is missing or malformed.");
  }
  const currentIndex = await snapshotGitIndex(capsule.capsuleRoot, capsule.gitControl);
  if (currentIndex.fingerprint !== gitIndexBaseline.fingerprint) changes.push("control/git/index");
  return [...new Set([...changes, ...changedFilesystemPaths(baseline, current)])].sort();
}

async function readContextManifestFile(file) {
  let info;
  let parsed;
  try {
    info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("unsafe file type");
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw new DelegationError("context_manifest_missing", "Stored context manifest is missing or malformed.");
  }
  return assertContextManifestIdentity(parsed);
}

export async function verifyContextManifestIdentity(capsule, expectedFingerprint = capsule.contextManifestFingerprint) {
  if (expectedFingerprint === null || expectedFingerprint === undefined) return { verified: false, fingerprint: null };
  if (!capsule.contextManifestPath) {
    throw new DelegationError("context_manifest_missing", "Private context manifest is unavailable.");
  }
  const visiblePath = capsule.executorContextManifestPath
    ?? path.join(capsule.capsuleRoot, ".relaypact", "context-manifest.json");
  const [privateManifest, visibleManifest] = await Promise.all([
    readContextManifestFile(capsule.contextManifestPath),
    readContextManifestFile(visiblePath)
  ]);
  if (
    privateManifest.fingerprint !== expectedFingerprint ||
    visibleManifest.fingerprint !== expectedFingerprint
  ) {
    throw new DelegationError("context_manifest_mismatch", "Stored context manifest identity no longer matches the task.");
  }
  return { verified: true, fingerprint: expectedFingerprint };
}

async function candidatePatchFromCleanIndex(capsule) {
  const reviewIndex = path.join(capsule.controlRoot, `review-index-${randomUUID()}`);
  const env = { GIT_INDEX_FILE: reviewIndex };
  try {
    await checkedGit(["read-tree", capsule.baseline], capsule.capsuleRoot, { gitControl: capsule.gitControl, env });
    await checkedGit(["add", "-N", "-f", "--", "."], capsule.capsuleRoot, { gitControl: capsule.gitControl, env });
    const [patchResult, pathsResult] = await Promise.all([
      checkedGit(["diff", "--binary", "--no-ext-diff", "--no-renames", capsule.baseline], capsule.capsuleRoot, { gitControl: capsule.gitControl, env }),
      checkedGit(["diff", "--name-only", "-z", "--no-renames", capsule.baseline], capsule.capsuleRoot, { gitControl: capsule.gitControl, env })
    ]);
    const patchPaths = pathsResult.stdout
      .split("\0")
      .filter(Boolean)
      .map((item) => normalizeRelativePath(item, "candidate patch path"))
      .sort();
    return { candidatePatch: patchResult.stdout, patchPaths: [...new Set(patchPaths)] };
  } finally {
    await rm(reviewIndex, { force: true });
    await rm(`${reviewIndex}.lock`, { force: true });
  }
}

async function inspectCandidateCredentials(capsule, changedPaths, candidatePatch, sensitiveValues) {
  const values = [...new Set((sensitiveValues ?? []).filter((value) => typeof value === "string" && value.length > 0))];
  if (values.length === 0) return { safe: true, reason: null, changedPaths };
  const sanitizedPaths = changedPaths.filter((relative) => !containsExactSensitiveValue(relative, values));
  if (sanitizedPaths.length !== changedPaths.length) {
    return { safe: false, reason: "evidence:credential value detected", changedPaths: sanitizedPaths };
  }
  if (values.some((value) => candidatePatch.includes(value))) {
    return { safe: false, reason: "evidence:credential value detected", changedPaths: sanitizedPaths };
  }
  const needles = values.map((value) => Buffer.from(value));
  let totalBytes = 0;
  for (const relative of changedPaths) {
    const absolute = path.join(capsule.capsuleRoot, ...relative.split("/"));
    let handle;
    try {
      handle = await open(absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      const before = await handle.stat();
      if (!before.isFile()) continue;
      totalBytes += before.size;
      if (!Number.isSafeInteger(before.size) || before.size < 0 || totalBytes > MAX_CREDENTIAL_EVIDENCE_BYTES) {
        return { safe: false, reason: "evidence:credential scan exceeded", changedPaths: sanitizedPaths };
      }
      const content = await handle.readFile();
      const after = await handle.stat();
      if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
        return { safe: false, reason: "evidence:credential scan unstable", changedPaths: sanitizedPaths };
      }
      if (needles.some((needle) => content.includes(needle))) {
        return { safe: false, reason: "evidence:credential value detected", changedPaths: sanitizedPaths };
      }
    } catch (error) {
      if (error?.code !== "ENOENT") return { safe: false, reason: "evidence:credential scan unavailable", changedPaths: sanitizedPaths };
    } finally {
      await handle?.close().catch(() => {});
    }
  }
  return { safe: true, reason: null, changedPaths: sanitizedPaths };
}

async function readBoundedCapsuleGitLink(file) {
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_GIT_LINK_BYTES) {
    throw new DelegationError("git_control_unavailable", "Executor-visible Git metadata has an unsafe type or size.");
  }
  let handle;
  try {
    handle = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
    const opened = await handle.stat();
    if (
      !opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino ||
      opened.size !== before.size || opened.mtimeMs !== before.mtimeMs
    ) {
      throw new DelegationError("filesystem_evidence_unstable", "Executor-visible Git metadata changed while it was inspected.");
    }
    const content = await handle.readFile();
    const after = await handle.stat();
    if (
      !after.isFile() || after.dev !== before.dev || after.ino !== before.ino ||
      after.size !== before.size || after.mtimeMs !== before.mtimeMs
    ) {
      throw new DelegationError("filesystem_evidence_unstable", "Executor-visible Git metadata changed while it was inspected.");
    }
    return content;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function collectCandidateEvidence(capsule, scope, options = {}) {
  const [head, dirtyPaths, filesystemPaths, privateControlPaths] = await Promise.all([
    getHead(capsule.capsuleRoot, capsule.gitControl),
    getStatusPaths(capsule.capsuleRoot, capsule.gitControl),
    getCapsuleFilesystemChanges(capsule),
    getPrivateControlChanges(capsule)
  ]);
  const committedPaths = await getCommittedDiffPaths(capsule.capsuleRoot, capsule.baseline, head, capsule.gitControl);
  const observedChangedPaths = [...new Set([...dirtyPaths, ...committedPaths, ...filesystemPaths])].sort();
  const baselineConsistent = head === capsule.baseline;
  let gitLinkConsistent = false;
  try {
    gitLinkConsistent = createHash("sha256")
      .update(await readBoundedCapsuleGitLink(path.join(capsule.capsuleRoot, ".git")))
      .digest("hex") === capsule.gitLinkSha256;
  } catch {
    gitLinkConsistent = false;
  }
  const { candidatePatch: rawCandidatePatch, patchPaths } = await candidatePatchFromCleanIndex(capsule);
  const credentialEvidence = options.credentialEvidenceTrusted === false
    ? { safe: false, reason: "evidence:sensitive grant changed", changedPaths: [] }
    : await inspectCandidateCredentials(
      capsule,
      observedChangedPaths,
      rawCandidatePatch,
      options.sensitiveValues
    );
  const changedPaths = credentialEvidence.changedPaths;
  const scopeBreaches = evaluatePathScope(changedPaths, scope);
  if (privateControlPaths.length > 0) scopeBreaches.push("task:private control changed");
  if (!gitLinkConsistent) scopeBreaches.push("git:executor-visible metadata changed");
  if (!baselineConsistent) scopeBreaches.push("git:HEAD changed from capsule baseline");
  if (JSON.stringify(patchPaths) !== JSON.stringify(observedChangedPaths)) {
    scopeBreaches.push("evidence:candidate patch incomplete");
  }
  if (!credentialEvidence.safe) scopeBreaches.push(credentialEvidence.reason);
  const candidatePatch = credentialEvidence.safe ? rawCandidatePatch : "";
  const candidatePatchSha256 = candidatePatch.length === 0
    ? null
    : `sha256:${createHash("sha256").update(candidatePatch).digest("hex")}`;
  return {
    head,
    baselineConsistent,
    gitLinkConsistent,
    privateControlChanged: privateControlPaths.length > 0,
    credentialEvidenceSafe: credentialEvidence.safe,
    changedPaths,
    scopeBreaches: [...new Set(scopeBreaches)].sort(),
    candidatePatch,
    candidatePatchSha256
  };
}

export async function verifySourceUnchanged(repository, capsule) {
  const baseline = await loadFilesystemBaseline(capsule, "source");
  let gitControlBaseline;
  try {
    gitControlBaseline = capsule.sourceGitControlBaseline
      ? assertFilesystemSnapshot(capsule.sourceGitControlBaseline)
      : assertFilesystemSnapshot(JSON.parse(await readFile(capsule.sourceGitControlBaselinePath, "utf8")));
  } catch (error) {
    if (error instanceof DelegationError) throw error;
    throw new DelegationError("filesystem_evidence_invalid", "Source Git-control baseline is missing or malformed.");
  }
  let gitIndexBaseline;
  try {
    gitIndexBaseline = capsule.sourceGitIndexBaseline
      ? assertGitIndexSnapshot(capsule.sourceGitIndexBaseline)
      : assertGitIndexSnapshot(JSON.parse(await readFile(capsule.sourceGitIndexBaselinePath, "utf8")));
  } catch (error) {
    if (error instanceof DelegationError) throw error;
    throw new DelegationError("git_index_evidence_invalid", "Source Git index baseline is missing or malformed.");
  }
  const [head, statusPaths, currentFilesystem, currentGitControls, currentGitIndex] = await Promise.all([
    getHead(repository.gitRoot),
    getStatusPaths(repository.gitRoot),
    snapshotFilesystem(repository.gitRoot, { exclude: [".git"], maxBytes: capsule.filesystemEvidenceMaxBytes }),
    snapshotGitControls(repository.gitRoot, { excludeIndexes: true }),
    snapshotGitIndex(repository.gitRoot)
  ]);
  const filesystemPaths = changedFilesystemPaths(baseline, currentFilesystem);
  const sameStatus = JSON.stringify(statusPaths) === JSON.stringify(capsule.sourceStatus);
  const currentFingerprint = sameStatus
    ? await sourceStateFingerprint(repository.gitRoot, statusPaths)
    : null;
  const sameFingerprint = capsule.sourceStateFingerprint === undefined
    ? true
    : currentFingerprint === capsule.sourceStateFingerprint;
  const gitControlPaths = changedFilesystemPaths(gitControlBaseline, currentGitControls);
  if (currentGitIndex.fingerprint !== gitIndexBaseline.fingerprint) gitControlPaths.push("index");
  return {
    unchanged: head === capsule.sourceHead && sameStatus && sameFingerprint && filesystemPaths.length === 0 && gitControlPaths.length === 0,
    head,
    statusPaths,
    filesystemPaths,
    gitControlPaths
  };
}

export async function cleanupCapsule(capsule, repository) {
  const rootInfo = await lstat(capsule.taskRoot).catch(() => null);
  if (
    !rootInfo?.isDirectory() || rootInfo.isSymbolicLink() ||
    !capsule.taskRootIdentity ||
    rootInfo.dev !== capsule.taskRootIdentity.dev || rootInfo.ino !== capsule.taskRootIdentity.ino
  ) {
    throw new DelegationError("cleanup_refused", "Task root identity changed before cleanup.");
  }
  const resolvedTaskRoot = await realpath(capsule.taskRoot);
  const marker = JSON.parse(await readFile(path.join(resolvedTaskRoot, "capsule.json"), "utf8"));
  if (
    typeof capsule.taskId !== "string" || capsule.taskId.length === 0 ||
    marker.taskId !== capsule.taskId ||
    marker.capsuleRoot !== capsule.capsuleRoot ||
    marker.sourceRoot !== repository.gitRoot ||
    marker.mode !== capsule.mode ||
    marker.gitDir !== capsule.gitControl?.gitDir ||
    marker.taskRootIdentity?.dev !== rootInfo.dev || marker.taskRootIdentity?.ino !== rootInfo.ino
  ) {
    throw new DelegationError("cleanup_refused", "Capsule marker does not match the requested task.");
  }
  if (capsule.mode === "trusted-worktree") {
    await checkedGit(["worktree", "remove", "--force", capsule.capsuleRoot], repository.gitRoot);
  }
  const beforeQuarantine = await lstat(capsule.taskRoot).catch(() => null);
  if (!beforeQuarantine?.isDirectory() || beforeQuarantine.dev !== rootInfo.dev || beforeQuarantine.ino !== rootInfo.ino) {
    throw new DelegationError("cleanup_refused", "Task root changed before cleanup quarantine.");
  }
  const quarantineRoot = `${capsule.taskRoot}.cleanup-${randomUUID()}`;
  await rename(capsule.taskRoot, quarantineRoot);
  const quarantined = await lstat(quarantineRoot);
  if (!quarantined.isDirectory() || quarantined.dev !== rootInfo.dev || quarantined.ino !== rootInfo.ino) {
    throw new DelegationError("cleanup_refused", "Task root identity changed during cleanup quarantine.");
  }
  await rm(quarantineRoot, { recursive: true, force: true });
}
