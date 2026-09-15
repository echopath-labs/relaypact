import { createHash } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import { lstat, open, opendir, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { DelegationError } from "../../contracts/src/errors.mjs";

const DEFAULT_MAX_FILES = 100_000;
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_DEPTH = 256;
const GIT_CONTROL_EXCLUDES = [];
const MAX_GIT_POINTER_BYTES = 256 * 1024;
const MAX_GIT_ALTERNATES = 1_024;
const MAX_GIT_ALTERNATE_EDGES = 1_024;
const MAX_GIT_POINTER_GRAPH_BYTES = 4 * 1024 * 1024;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function hashFile(absolute) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(absolute);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

function snapshotFingerprint(snapshot) {
  return sha256(JSON.stringify({ schemaVersion: snapshot.schemaVersion, totals: snapshot.totals, entries: snapshot.entries }));
}

export function assertFilesystemSnapshot(snapshot) {
  if (!snapshot || snapshot.schemaVersion !== "1.0.0" || !Array.isArray(snapshot.entries) || !snapshot.totals) {
    throw new DelegationError("filesystem_evidence_invalid", "Filesystem evidence is missing or malformed.");
  }
  if (snapshot.fingerprint !== snapshotFingerprint(snapshot)) {
    throw new DelegationError("filesystem_evidence_invalid", "Filesystem evidence fingerprint does not match its contents.");
  }
  return snapshot;
}

async function collect(root, options = {}) {
  const entries = [];
  const maximumFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maximumBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maximumDirectories = options.maxDirectories ?? maximumFiles;
  const maximumDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const excluded = new Set(options.exclude ?? []);
  let totalBytes = 0;
  let totalDirectories = 0;

  async function add(relative, absolute, depth = 0) {
    if (excluded.has(relative) || [...excluded].some((prefix) => relative.startsWith(`${prefix}/`))) return;
    if (depth > maximumDepth) {
      throw new DelegationError("filesystem_evidence_exceeded", "Filesystem evidence exceeded its directory-depth bound.");
    }
    let info;
    try {
      info = await lstat(absolute);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw new DelegationError("filesystem_evidence_unavailable", `Filesystem evidence cannot inspect: ${relative || "."}.`);
    }
    if (info.isDirectory()) {
      totalDirectories += 1;
      if (totalDirectories > maximumDirectories) {
        throw new DelegationError("filesystem_evidence_exceeded", "Filesystem evidence exceeded its directory-count bound.");
      }
      const directory = await opendir(absolute);
      const children = [];
      for await (const child of directory) children.push(child.name);
      children.sort((left, right) => left.localeCompare(right));
      for (const child of children) {
        const childRelative = relative ? `${relative}/${child}` : child;
        await add(childRelative, path.join(absolute, child), depth + 1);
      }
      return;
    }
    if (entries.length >= maximumFiles) {
      throw new DelegationError("filesystem_evidence_exceeded", "Filesystem evidence exceeded its file-count bound.");
    }
    const record = { path: relative, mode: info.mode & 0o7777 };
    if (info.isFile()) {
      if (!Number.isSafeInteger(info.size) || info.size < 0 || totalBytes + info.size > maximumBytes) {
        throw new DelegationError("filesystem_evidence_exceeded", "Filesystem evidence exceeded its byte bound.");
      }
      const before = { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs };
      record.type = "file";
      record.bytes = info.size;
      record.sha256 = await hashFile(absolute);
      const after = await lstat(absolute);
      if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
        throw new DelegationError("filesystem_evidence_unstable", `Filesystem changed while evidence was collected: ${relative}.`);
      }
      totalBytes += info.size;
    } else if (info.isSymbolicLink()) {
      record.type = "symlink";
      record.target = await readlink(absolute);
    } else {
      record.type = "other";
    }
    entries.push(record);
  }

  if (options.selectedPaths) {
    for (const relative of [...options.selectedPaths].sort()) await add(relative, path.join(root, ...relative.split("/")));
  } else {
    await add("", root);
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  const snapshot = {
    schemaVersion: "1.0.0",
    totals: { files: entries.length, directories: totalDirectories, bytes: totalBytes },
    entries,
    fingerprint: ""
  };
  snapshot.fingerprint = snapshotFingerprint(snapshot);
  return snapshot;
}

export async function snapshotFilesystem(root, options = {}) {
  return collect(await realpath(root), options);
}

export async function assertRepositoryLinks(repositoryRoot, snapshotInput) {
  const root = await realpath(repositoryRoot);
  const snapshot = snapshotInput ?? await snapshotFilesystem(root, { exclude: [".git"] });
  for (const entry of assertFilesystemSnapshot(snapshot).entries) {
    if (entry.type !== "symlink" && entry.type !== "file") continue;
    const absolute = path.join(root, ...entry.path.split("/"));
    try {
      if (entry.type === "file") {
        // A snapshot cannot prove that other names for an inode stay in scope.
        // Read the current link count even when the caller supplies an older snapshot.
        const info = await lstat(absolute);
        if (!info.isFile() || info.nlink !== 1) throw new Error("unsafe link");
        continue;
      }
      const target = await realpath(absolute);
      if (!isInside(root, target) || await readlink(absolute) !== entry.target) throw new Error("unsafe link");
    } catch {
      throw new DelegationError("repository_link_unsafe", "Repository files must have a single link and symlinks must resolve to stable targets inside the delegated repository before execution.");
    }
  }
}

async function resolveGitDirectory(repositoryRoot) {
  const candidate = path.join(repositoryRoot, ".git");
  const info = await lstat(candidate);
  if (info.isDirectory()) return realpath(candidate);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new DelegationError("git_control_unavailable", "Repository Git control path has an unsafe type.");
  }
  const pointer = await readBoundedGitPointer(candidate, "Repository Git control pointer");
  const match = pointer.match(/^gitdir:\s*(.+)\s*$/u);
  if (!match) throw new DelegationError("git_control_unavailable", "Repository Git control pointer is malformed.");
  try {
    return await realpath(path.resolve(repositoryRoot, match[1]));
  } catch {
    throw new DelegationError("git_control_unavailable", "Repository Git control pointer does not resolve to a real directory.");
  }
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function readBoundedGitPointer(pointerPath, label, { optional = false } = {}) {
  let before;
  try {
    before = await lstat(pointerPath);
  } catch (error) {
    if (optional && error?.code === "ENOENT") return null;
    throw new DelegationError("git_control_unavailable", `${label} is unavailable.`);
  }
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_GIT_POINTER_BYTES) {
    throw new DelegationError("git_control_unavailable", `${label} has an unsafe type or size.`);
  }
  let handle;
  try {
    handle = await open(pointerPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
    const opened = await handle.stat();
    if (
      !opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino ||
      opened.size !== before.size || opened.mtimeMs !== before.mtimeMs
    ) {
      throw new DelegationError("filesystem_evidence_unstable", `${label} changed while evidence was collected.`);
    }
    const content = await handle.readFile({ encoding: "utf8" });
    const after = await handle.stat();
    if (
      !after.isFile() || after.dev !== before.dev || after.ino !== before.ino ||
      after.size !== before.size || after.mtimeMs !== before.mtimeMs
    ) {
      throw new DelegationError("filesystem_evidence_unstable", `${label} changed while evidence was collected.`);
    }
    return content;
  } catch (error) {
    if (error instanceof DelegationError) throw error;
    throw new DelegationError("git_control_unavailable", `${label} cannot be read safely.`);
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function resolveCommonGitDirectory(gitDirectory) {
  const pointer = await readBoundedGitPointer(
    path.join(gitDirectory, "commondir"),
    "Git common-directory pointer",
    { optional: true }
  );
  if (pointer === null) return gitDirectory;
  const value = pointer.trim();
  if (!value || value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    throw new DelegationError("git_control_unavailable", "Git common-directory pointer is malformed.");
  }
  const common = await realpath(path.resolve(gitDirectory, value)).catch(() => null);
  const info = common ? await lstat(common).catch(() => null) : null;
  if (!info?.isDirectory() || info.isSymbolicLink()) {
    throw new DelegationError("git_control_unavailable", "Git common directory is unavailable or unsafe.");
  }
  return common;
}

async function discoverAlternateObjectDirectories(primaryObjectDirectory) {
  const queue = [primaryObjectDirectory];
  const scheduled = new Set([path.resolve(primaryObjectDirectory)]);
  const visited = new Set();
  const discovered = [];
  let cursor = 0;
  let totalEdges = 0;
  let totalPointerBytes = 0;
  while (cursor < queue.length) {
    const requested = queue[cursor];
    cursor += 1;
    const resolved = await realpath(requested).catch(() => null);
    const info = resolved ? await lstat(resolved).catch(() => null) : null;
    if (!info?.isDirectory() || info.isSymbolicLink()) {
      throw new DelegationError("git_control_unavailable", "Git object directory is unavailable or unsafe.");
    }
    if (visited.has(resolved)) continue;
    visited.add(resolved);
    discovered.push(resolved);
    if (discovered.length > MAX_GIT_ALTERNATES + 1) {
      throw new DelegationError("filesystem_evidence_exceeded", "Git alternate-object evidence exceeded its store-count bound.");
    }
    const pointer = await readBoundedGitPointer(
      path.join(resolved, "info", "alternates"),
      "Git alternates pointer",
      { optional: true }
    );
    if (pointer === null) continue;
    totalPointerBytes += Buffer.byteLength(pointer);
    if (totalPointerBytes > MAX_GIT_POINTER_GRAPH_BYTES) {
      throw new DelegationError("filesystem_evidence_exceeded", "Git alternate-object evidence exceeded its pointer-byte bound.");
    }
    const lines = pointer.split(/\r?\n/u).filter((line) => line.length > 0);
    if (lines.length > MAX_GIT_ALTERNATES) {
      throw new DelegationError("filesystem_evidence_exceeded", "Git alternates pointer exceeded its entry-count bound.");
    }
    for (const line of lines) {
      totalEdges += 1;
      if (totalEdges > MAX_GIT_ALTERNATE_EDGES) {
        throw new DelegationError("filesystem_evidence_exceeded", "Git alternate-object evidence exceeded its edge-count bound.");
      }
      if (line.includes("\0") || line.trim() !== line || line.length > 16 * 1024) {
        throw new DelegationError("git_control_unavailable", "Git alternates pointer contains an unsupported path.");
      }
      const requestedAlternate = path.resolve(path.isAbsolute(line) ? line : path.resolve(resolved, line));
      if (!scheduled.has(requestedAlternate)) {
        scheduled.add(requestedAlternate);
        queue.push(requestedAlternate);
      }
    }
  }
  return discovered;
}

export async function snapshotGitControls(repositoryRoot, options = {}) {
  const gitDirectory = await resolveGitDirectory(repositoryRoot);
  const commonDirectory = await resolveCommonGitDirectory(gitDirectory);
  const objectDirectories = await discoverAlternateObjectDirectories(path.join(commonDirectory, "objects"));
  const roots = new Set([commonDirectory]);
  if (!isInside(commonDirectory, gitDirectory)) roots.add(gitDirectory);
  for (const objectDirectory of objectDirectories) {
    if (![...roots].some((root) => isInside(root, objectDirectory))) roots.add(objectDirectory);
  }
  const orderedRoots = [...roots].sort();
  const entries = [];
  let totalFiles = 0;
  let totalDirectories = 0;
  let totalBytes = 0;
  for (const root of orderedRoots) {
    const currentIndex = path.join(gitDirectory, "index");
    const relativeIndex = isInside(root, currentIndex)
      ? path.relative(root, currentIndex).split(path.sep).join("/")
      : null;
    const snapshot = await collect(root, {
      exclude: [
        ...GIT_CONTROL_EXCLUDES,
        ...(options.excludeIndexes === true && relativeIndex ? [relativeIndex] : [])
      ],
      maxFiles: DEFAULT_MAX_FILES - totalFiles,
      maxDirectories: DEFAULT_MAX_FILES - totalDirectories,
      maxBytes: DEFAULT_MAX_BYTES - totalBytes
    });
    const namespace = `store-${sha256(root).slice(0, 16)}`;
    entries.push(...snapshot.entries.map((entry) => ({ ...entry, path: `${namespace}/${entry.path}` })));
    totalFiles += snapshot.totals.files;
    totalDirectories += snapshot.totals.directories;
    totalBytes += snapshot.totals.bytes;
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  const snapshot = {
    schemaVersion: "1.0.0",
    totals: { files: totalFiles, directories: totalDirectories, bytes: totalBytes },
    entries,
    fingerprint: ""
  };
  snapshot.fingerprint = snapshotFingerprint(snapshot);
  return snapshot;
}

export function changedFilesystemPaths(beforeInput, afterInput) {
  const before = assertFilesystemSnapshot(beforeInput);
  const after = assertFilesystemSnapshot(afterInput);
  const left = new Map(before.entries.map((entry) => [entry.path, JSON.stringify(entry)]));
  const right = new Map(after.entries.map((entry) => [entry.path, JSON.stringify(entry)]));
  return [...new Set([...left.keys(), ...right.keys()])]
    .filter((relative) => left.get(relative) !== right.get(relative))
    .sort();
}
