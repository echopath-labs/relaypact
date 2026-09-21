import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DelegationError } from "../../contracts/src/errors.mjs";
import { minimalEnvironment } from "./environment.mjs";
import { normalizeRelativePath } from "../../contracts/src/path-policy.mjs";
import { runProcess } from "./process.mjs";

const MAX_GIT_STDOUT_BYTES = 64 * 1024 * 1024;

function controlledArgs(args, gitControl) {
  return [
    ...(gitControl?.gitDir ? [`--git-dir=${gitControl.gitDir}`, `--work-tree=${gitControl.workTree}`] : []),
    "-c", "core.fsmonitor=false",
    "-c", `core.hooksPath=${os.devNull}`,
    ...args
  ];
}

async function runGit(args, cwd, { allowFailure = false, gitControl = undefined, outputEncoding = "utf8" } = {}) {
  const env = minimalEnvironment(process.env, {
    grants: {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0"
    }
  });
  const result = await runProcess("git", controlledArgs(args, gitControl), {
    cwd,
    env,
    timeoutMs: 30_000,
    outputEncoding,
    maxStdoutCaptureBytes: MAX_GIT_STDOUT_BYTES
  });
  if (result.stdoutTruncated || result.stderrTruncated) {
    throw new DelegationError("git_output_truncated", `Git command output exceeded the evidence capture bound: git ${args.join(" ")}.`);
  }
  if (!allowFailure && result.exitCode !== 0) {
    throw new DelegationError("git_error", `Git command failed: git ${args.join(" ")}.`);
  }
  return result;
}

function gitIndexFingerprint(snapshot) {
  return createHash("sha256").update(JSON.stringify({
    schemaVersion: snapshot.schemaVersion,
    objectFormat: snapshot.objectFormat,
    entries: snapshot.entries
  })).digest("hex");
}

function compareIndexEntries(left, right) {
  return left.path.localeCompare(right.path) || left.stage - right.stage;
}

function validateGitIndexPath(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || value.startsWith("/")) {
    throw new DelegationError("git_index_evidence_invalid", `${label} is not a repository-relative Git path.`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new DelegationError("git_index_evidence_invalid", `${label} is not a canonical repository-relative Git path.`);
  }
  return value;
}

export function assertGitIndexSnapshot(snapshot) {
  if (
    !snapshot || snapshot.schemaVersion !== "1.0.0" ||
    !["sha1", "sha256"].includes(snapshot.objectFormat) ||
    !Array.isArray(snapshot.entries) || typeof snapshot.fingerprint !== "string"
  ) {
    throw new DelegationError("git_index_evidence_invalid", "Git index evidence is missing or malformed.");
  }
  const objectIdLength = snapshot.objectFormat === "sha1" ? 40 : 64;
  const seen = new Set();
  for (const entry of snapshot.entries) {
    if (
      !entry || Object.keys(entry).sort().join(",") !== "assumeUnchanged,intentToAdd,mode,objectId,path,skipWorktree,stage" ||
      typeof entry.path !== "string" || validateGitIndexPath(entry.path, "Git index path") !== entry.path ||
      !/^[0-7]{6}$/u.test(entry.mode) ||
      typeof entry.objectId !== "string" || !new RegExp(`^[a-f0-9]{${objectIdLength}}$`, "u").test(entry.objectId) ||
      !Number.isInteger(entry.stage) || entry.stage < 0 || entry.stage > 3 ||
      typeof entry.assumeUnchanged !== "boolean" || typeof entry.skipWorktree !== "boolean" ||
      typeof entry.intentToAdd !== "boolean" || (entry.intentToAdd && entry.stage !== 0)
    ) {
      throw new DelegationError("git_index_evidence_invalid", "Git index evidence contains a malformed entry.");
    }
    const key = `${entry.path}\0${entry.stage}`;
    if (seen.has(key)) {
      throw new DelegationError("git_index_evidence_invalid", "Git index evidence contains a duplicate path and stage.");
    }
    seen.add(key);
  }
  if (JSON.stringify(snapshot.entries) !== JSON.stringify([...snapshot.entries].sort(compareIndexEntries))) {
    throw new DelegationError("git_index_evidence_invalid", "Git index evidence entries are not canonical.");
  }
  if (snapshot.fingerprint !== gitIndexFingerprint(snapshot)) {
    throw new DelegationError("git_index_evidence_invalid", "Git index evidence fingerprint does not match its contents.");
  }
  return snapshot;
}

function splitNulRecords(output, label) {
  if (!Buffer.isBuffer(output)) {
    throw new DelegationError("git_index_evidence_invalid", `${label} is not byte-safe output.`);
  }
  if (output.byteLength === 0) return [];
  if (output.at(-1) !== 0) {
    throw new DelegationError("git_index_evidence_invalid", `${label} is not NUL terminated.`);
  }
  const records = [];
  let start = 0;
  for (let index = 0; index < output.byteLength; index += 1) {
    if (output[index] !== 0) continue;
    records.push(output.subarray(start, index));
    start = index + 1;
  }
  return records;
}

function decodeGitPath(bytes, label) {
  const value = bytes.toString("utf8");
  if (!Buffer.from(value, "utf8").equals(bytes)) {
    throw new DelegationError("git_index_evidence_invalid", `${label} is not valid UTF-8 and cannot be represented without loss.`);
  }
  return validateGitIndexPath(value, label);
}

function parseNulPaths(output, label) {
  const paths = splitNulRecords(output, label).map((item) => decodeGitPath(item, label));
  if (new Set(paths).size !== paths.length) {
    throw new DelegationError("git_index_evidence_invalid", `${label} contains duplicate paths.`);
  }
  return paths;
}

function parseIndexEntries(output, objectFormat, intentToAddPaths) {
  const records = splitNulRecords(output, "Git index entry output");
  const objectIdLength = objectFormat === "sha1" ? 40 : 64;
  const entries = records.map((record) => {
    const separator = record.indexOf(0x09);
    if (separator < 0) {
      throw new DelegationError("git_index_evidence_invalid", "Git index entry output is malformed.");
    }
    const header = record.subarray(0, separator).toString("ascii");
    const match = header.match(new RegExp(`^([HSMRCK?hsmrck]) ([0-7]{6}) ([a-f0-9]{${objectIdLength}}) ([0-3])$`, "u"));
    if (!match) {
      throw new DelegationError("git_index_evidence_invalid", "Git index entry header is malformed or unsupported.");
    }
    const pathValue = decodeGitPath(record.subarray(separator + 1), "Git index path");
    const stage = Number(match[4]);
    return {
      path: pathValue,
      stage,
      mode: match[2],
      objectId: match[3],
      assumeUnchanged: match[1] === match[1].toLowerCase(),
      skipWorktree: match[1].toUpperCase() === "S",
      intentToAdd: stage === 0 && intentToAddPaths.has(pathValue)
    };
  }).sort(compareIndexEntries);
  const stageZeroPaths = new Set(entries.filter((entry) => entry.stage === 0).map((entry) => entry.path));
  for (const relative of intentToAddPaths) {
    if (!stageZeroPaths.has(relative)) {
      throw new DelegationError("git_index_evidence_invalid", "Intent-to-add evidence does not match a stage-zero index entry.");
    }
  }
  return entries;
}

async function collectGitIndexSnapshot(gitRoot, gitControl) {
  const [objectFormatResult, entriesResult, invisibleResult, visibleResult] = await Promise.all([
    runGit(["rev-parse", "--show-object-format"], gitRoot, { gitControl }),
    runGit(["ls-files", "--stage", "-v", "-z"], gitRoot, { gitControl, outputEncoding: null }),
    runGit(["diff", "--cached", "--name-only", "-z", "--ita-invisible-in-index", "--"], gitRoot, { gitControl, outputEncoding: null }),
    runGit(["diff", "--cached", "--name-only", "-z", "--ita-visible-in-index", "--"], gitRoot, { gitControl, outputEncoding: null })
  ]);
  const objectFormat = objectFormatResult.stdout.trim();
  if (!["sha1", "sha256"].includes(objectFormat)) {
    throw new DelegationError("git_index_evidence_invalid", "Git index object format is unsupported.");
  }
  const invisible = new Set(parseNulPaths(invisibleResult.stdout, "Git cached diff path"));
  const visible = new Set(parseNulPaths(visibleResult.stdout, "Git intent-to-add diff path"));
  for (const relative of invisible) {
    if (!visible.has(relative)) {
      throw new DelegationError("git_index_evidence_invalid", "Intent-to-add diff evidence is inconsistent.");
    }
  }
  const intentToAddPaths = new Set([...visible].filter((relative) => !invisible.has(relative)));
  const snapshot = {
    schemaVersion: "1.0.0",
    objectFormat,
    entries: parseIndexEntries(entriesResult.stdout, objectFormat, intentToAddPaths),
    fingerprint: ""
  };
  snapshot.fingerprint = gitIndexFingerprint(snapshot);
  return assertGitIndexSnapshot(snapshot);
}

export async function snapshotGitIndex(gitRoot, gitControl = undefined) {
  const first = await collectGitIndexSnapshot(gitRoot, gitControl);
  const second = await collectGitIndexSnapshot(gitRoot, gitControl);
  if (first.fingerprint !== second.fingerprint) {
    throw new DelegationError("git_index_evidence_unstable", "Git index semantics changed while evidence was collected.");
  }
  return first;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function resolveRepository(repository) {
  let requestedRoot;
  try {
    requestedRoot = await realpath(repository.root);
  } catch {
    throw new DelegationError("repository_not_found", "repository.root does not resolve to an existing path.");
  }

  const rootResult = await runGit(["rev-parse", "--show-toplevel"], requestedRoot, { allowFailure: true });
  if (rootResult.exitCode !== 0) {
    throw new DelegationError("not_git_repository", "repository.root is not a Git repository.");
  }
  const gitRoot = await realpath(rootResult.stdout.trim());
  if (gitRoot !== requestedRoot) {
    throw new DelegationError("repository_root_mismatch", "repository.root must be the explicit Git root.");
  }

  let workingDirectory;
  try {
    workingDirectory = await realpath(path.resolve(gitRoot, repository.workingDirectory));
  } catch {
    throw new DelegationError("working_directory_not_found", "repository.workingDirectory does not exist.");
  }
  if (!isInside(gitRoot, workingDirectory)) {
    throw new DelegationError("working_directory_escape", "repository.workingDirectory resolves outside the Git root.");
  }

  return { gitRoot, workingDirectory };
}

export async function getHead(gitRoot, gitControl = undefined) {
  const result = await runGit(["rev-parse", "HEAD"], gitRoot, { allowFailure: true, gitControl });
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

export async function getBranch(gitRoot, gitControl = undefined) {
  const result = await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], gitRoot, { allowFailure: true, gitControl });
  return result.exitCode === 0 ? result.stdout.trim() : "detached";
}

export function parseStatusPaths(output) {
  const records = output.split("\0");
  const paths = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    const status = record.slice(0, 2);
    const candidate = record.slice(3);
    if (candidate) paths.push(normalizeRelativePath(candidate, "Git status path"));
    if (status.includes("R") || status.includes("C")) {
      const source = records[index + 1];
      if (!source) {
        throw new DelegationError("git_error", "Git status rename or copy record is incomplete.");
      }
      paths.push(normalizeRelativePath(source, "Git status source path"));
      index += 1;
    }
  }
  return [...new Set(paths)].sort();
}

export async function getStatusPaths(gitRoot, gitControl = undefined) {
  const result = await runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"], gitRoot, { gitControl });
  return parseStatusPaths(result.stdout);
}

export async function getCommittedDiffPaths(gitRoot, headBefore, headAfter, gitControl = undefined) {
  if (!headBefore || !headAfter || headBefore === headAfter) return [];
  const result = await runGit(["diff", "--name-only", "-z", `${headBefore}..${headAfter}`], gitRoot, { gitControl });
  return result.stdout
    .split("\0")
    .filter(Boolean)
    .map((item) => normalizeRelativePath(item, "Git diff path"));
}

export async function collectGitState(gitRoot, gitControl = undefined) {
  const [head, branch, dirtyPaths] = await Promise.all([
    getHead(gitRoot, gitControl),
    getBranch(gitRoot, gitControl),
    getStatusPaths(gitRoot, gitControl)
  ]);
  return { head, branch, dirtyPaths };
}

export function enforceDirtyTreePolicy(state, dirtyTree) {
  if (state.dirtyPaths.length === 0) return;
  if (!dirtyTree.allow) {
    throw new DelegationError("dirty_tree", "Target repository has pre-existing uncommitted changes.", {
      paths: state.dirtyPaths
    });
  }
  const acknowledged = new Set(dirtyTree.acknowledgedPaths.map((item) => normalizeRelativePath(item)));
  const missing = state.dirtyPaths.filter((item) => !acknowledged.has(item));
  if (missing.length > 0) {
    throw new DelegationError("dirty_tree_unacknowledged", "Dirty-tree override does not acknowledge every pre-existing path.", {
      paths: missing
    });
  }
}
