import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { inflateSync } from "node:zlib";
import { DelegationError } from "../../contracts/src/errors.mjs";
import { assertFilesystemSnapshot, snapshotGitControls } from "./filesystem-evidence.mjs";
import { existingGitObjectType, snapshotGitIndex } from "./git.mjs";
import { canonicalize, keyedFingerprint } from "./signed-state.mjs";

const fail = () => { throw new DelegationError("checkpoint_evidence_invalid", "Checkpoint evidence is missing, unsafe, stale or outside the supported addition boundary."); };
const hash = value => createHash("sha256").update(value).digest("hex");
export const checkpointObservationFingerprint = controls => hash(canonicalize(controls));
const baselinePath = (taskRoot, sequence) => path.join(taskRoot, "evidence", `git-controls-${sequence}.json`);
const binding = state => Object.fromEntries(["taskId", "routeId", "executorHarness", "repositoryRoot", "taskRootDev", "taskRootIno", "stateRevision", "correctionSequence", "resultIdentity", "reviewFingerprint"].map(key => [key, state[key]]));

export async function assertPackedRefsUnshadowed(file, entry, refs, tick) {
  // Fold only ASCII; latin1 preserves UTF-8 bytes for unrelated packed names.
  const fold = value => value.replace(/[A-Z]/gu, letter => letter.toLowerCase());
  const approved = refs.map(fold);
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size !== entry.bytes) fail();
    const digest = createHash("sha256"), chunk = Buffer.alloc(64 * 1024);
    let offset = 0, pending = "";
    const line = value => {
      if (!value || value.startsWith("#") || /^\^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(value)) return;
      const match = value.match(/^[a-f0-9]{40}(?:[a-f0-9]{24})? (refs\/[^\x00-\x20\x7f]+)$/u);
      const packed = match && fold(match[1]);
      if (!match || approved.some(ref => ref === packed || ref.startsWith(`${packed}/`) || packed.startsWith(`${ref}/`))) fail();
    };
    while (true) {
      tick();
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, entry.bytes - offset + 1), offset);
      if (!bytesRead) break;
      offset += bytesRead;
      if (offset > entry.bytes) fail();
      digest.update(chunk.subarray(0, bytesRead));
      pending += chunk.subarray(0, bytesRead).toString("latin1");
      const lines = pending.split("\n"); pending = lines.pop();
      for (const value of lines) line(value);
      // An oversized line cannot name any supported (<=1024 byte) approval.
      if (pending.length > 64 * 1024) fail();
    }
    line(pending);
    const after = await handle.stat(), named = await lstat(file);
    if (offset !== entry.bytes || digest.digest("hex") !== entry.sha256 || after.size !== info.size ||
        after.mtimeMs !== info.mtimeMs || after.nlink !== 1 || named.dev !== info.dev || named.ino !== info.ino || named.isSymbolicLink()) fail();
  } finally { await handle.close(); }
}

export async function readCheckpointJson(file, maximumBytes) {
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || (before.mode & 0o777) !== 0o600 || before.size > maximumBytes) fail();
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await handle.stat();
    if (info.dev !== before.dev || info.ino !== before.ino || info.size !== before.size || !info.isFile()) fail();
    const bytes = Buffer.alloc(info.size + 1); let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    const after = await handle.stat(), named = await lstat(file);
    if (offset !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.nlink !== 1 ||
        named.dev !== info.dev || named.ino !== info.ino || named.isSymbolicLink() || (named.mode & 0o777) !== 0o600) fail();
    return JSON.parse(bytes.subarray(0, offset).toString("utf8"));
  } finally { await handle.close(); }
}

export async function persistCheckpointBaseline(prepared, state, controls) {
  const record = { schemaVersion: "1.0.0", binding: binding(state), controls };
  let bytes = 1024;
  for (const entry of [...controls.entries, ...controls.directories]) { bytes += Buffer.byteLength(JSON.stringify(entry)); if (bytes > 60 * 1024 * 1024) return; }
  const signed = { ...record, integrity: await keyedFingerprint(prepared.statePath, "checkpoint-baseline", record) };
  const content = `${JSON.stringify(signed)}\n`, file = baselinePath(prepared.taskRoot, state.correctionSequence);
  try { await writeFile(file, content, { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if (error.code !== "EEXIST" || canonicalize(await readCheckpointJson(file, 64 * 1024 * 1024)) !== canonicalize(signed)) throw error;
  }
}

async function verify(prepared, state, actor, input) {
  const deadline = Date.now() + 30_000, signal = AbortSignal.timeout(30_000);
  const tick = () => { signal.throwIfAborted(); if (Date.now() >= deadline) fail(); };
  const proof = typeof input === "string" ? await readCheckpointJson(input, 256 * 1024) : input;
  if (!proof || Buffer.byteLength(JSON.stringify(proof)) > 256 * 1024 ||
      Object.keys(proof).sort().join(",") !== "actor,addedPaths,checkpointRefs,filesystemFingerprint,observationFingerprint,reason,schemaVersion,stateIntegrity" ||
      proof.schemaVersion !== "1.0.0" || proof.stateIntegrity !== state.integrity || proof.actor !== actor ||
      typeof proof.reason !== "string" || !proof.reason.trim() || Buffer.byteLength(proof.reason) > 4096 ||
      !/^[a-f0-9]{64}$/u.test(proof.observationFingerprint) || !/^[a-f0-9]{64}$/u.test(proof.filesystemFingerprint) ||
      !Array.isArray(proof.addedPaths) || proof.addedPaths.length > 8192 || !Array.isArray(proof.checkpointRefs) ||
      proof.checkpointRefs.length < 1 || proof.checkpointRefs.length > 16) fail();
  const safeRef = ref => typeof ref === "string" && ref.length <= 1024 && /^refs\/[A-Za-z0-9_-]+\/[A-Za-z0-9_./-]+$/u.test(ref) &&
    !/^(?:refs\/(?:heads|tags|remotes|replace|bisect|notes|rewritten|worktree|prefetch|stash)\/)/u.test(ref) &&
    ref.split("/").every(part => part && !part.startsWith(".") && !part.endsWith(".") && !part.endsWith(".lock")) && !ref.includes("..");
  if (!proof.checkpointRefs.every(safeRef) || new Set(proof.checkpointRefs).size !== proof.checkpointRefs.length) fail();
  const gitDirectory = path.join(state.repositoryRoot, ".git"), gitInfo = await lstat(gitDirectory);
  if (!gitInfo.isDirectory() || gitInfo.isSymbolicLink() || await realpath(gitDirectory) !== gitDirectory) fail();
  for (const file of ["commondir", "objects/info/alternates", "objects/info/http-alternates"]) {
    if (await lstat(path.join(gitDirectory, file)).catch(error => { if (error.code === "ENOENT") return null; throw error; })) fail();
  }
  const saved = await readCheckpointJson(baselinePath(prepared.taskRoot, state.correctionSequence), 64 * 1024 * 1024);
  const { integrity, ...record } = saved;
  if (record.schemaVersion !== "1.0.0" || Object.keys(record).sort().join(",") !== "binding,controls,schemaVersion" ||
      integrity !== await keyedFingerprint(prepared.statePath, "checkpoint-baseline", record) ||
      canonicalize(record.binding) !== canonicalize(binding(state)) || record.controls.fingerprint !== state.reviewGitControlFingerprint) fail();
  const before = assertFilesystemSnapshot(record.controls), now = await snapshotGitControls(state.repositoryRoot, { excludeIndexes: true, includeDirectories: true, signal });
  if (now.entries.some(entry => entry.type !== "file") || !Array.isArray(before.directories) || checkpointObservationFingerprint(now) !== proof.observationFingerprint) fail();
  const namespace = `store-${hash(gitDirectory).slice(0, 16)}/`;
  if (![...before.entries, ...before.directories, ...now.entries, ...now.directories].every(entry => entry.path.startsWith(namespace))) fail();
  const relative = entry => entry.path.slice(namespace.length);
  const additions = [];
  for (const key of ["entries", "directories"]) {
    const old = new Map(before[key].map(entry => [entry.path, canonicalize(entry)]));
    const current = new Map(now[key].map(entry => [entry.path, canonicalize(entry)]));
    if ([...old].some(([name, value]) => current.get(name) !== value)) fail();
    additions.push(...now[key].filter(entry => !old.has(entry.path)).map(relative));
  }
  if (additions.length < 1 || canonicalize([...additions].sort()) !== canonicalize([...proof.addedPaths].sort())) fail();
  const oldFiles = new Set(before.entries.map(entry => entry.path));
  const files = now.entries.filter(entry => !oldFiles.has(entry.path));
  if (files.length > 4096 + 16 || files.some(entry => entry.type !== "file")) fail();
  const oldDirs = new Set(before.directories.map(entry => entry.path));
  const directories = now.directories.filter(entry => !oldDirs.has(entry.path));
  if (directories.some(dir => !files.some(file => file.path.startsWith(`${dir.path}/`)))) fail();
  const remaining = { schemaVersion: now.schemaVersion, entries: now.entries.filter(entry => oldFiles.has(entry.path)),
    totals: { files: now.totals.files - files.length, directories: now.totals.directories - directories.length,
      bytes: now.totals.bytes - files.reduce((n, entry) => n + entry.bytes, 0) } };
  if (hash(JSON.stringify({ schemaVersion: remaining.schemaVersion, totals: remaining.totals, entries: remaining.entries })) !== before.fingerprint) fail();
  const packedRefs = before.entries.find(entry => relative(entry) === "packed-refs");
  if (packedRefs) await assertPackedRefsUnshadowed(path.join(gitDirectory, "packed-refs"), packedRefs, proof.checkpointRefs, tick);
  tick();
  const index = await snapshotGitIndex(state.repositoryRoot);
  if (index.fingerprint !== state.reviewGitIndexFingerprint) fail();
  const length = index.objectFormat === "sha1" ? 40 : 64;
  const oidPattern = new RegExp(`^[a-f0-9]{${length}}$`, "u"), objectPath = new RegExp(`^objects/([a-f0-9]{2})/([a-f0-9]{${length - 2}})$`, "u");
  const objects = new Map(), roots = []; let inflatedBytes = 0;
  for (const entry of files) {
    tick();
    const name = relative(entry), absolute = path.join(gitDirectory, name), info = await lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size !== entry.bytes) fail();
    const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    let data;
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== info.dev || opened.ino !== info.ino || entry.bytes > 16 * 1024 * 1024) fail();
      data = Buffer.alloc(entry.bytes + 1); let offset = 0;
      while (offset < data.length) { const result = await handle.read(data, offset, data.length - offset, offset); if (!result.bytesRead) break; offset += result.bytesRead; }
      const after = await handle.stat(), named = await lstat(absolute);
      if (offset !== entry.bytes || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.nlink !== 1 || named.dev !== opened.dev || named.ino !== opened.ino || named.isSymbolicLink()) fail();
      data = data.subarray(0, offset);
    } finally { await handle.close(); }
    if (hash(data) !== entry.sha256) fail();
    if (proof.checkpointRefs.includes(name)) {
      const target = data.toString("utf8");
      if (!new RegExp(`^[a-f0-9]{${length}}\\n?$`, "u").test(target)) fail();
      roots.push([target.trim(), "commit", 0]); continue;
    }
    const match = name.match(objectPath);
    if (!match) fail();
    const oid = match[1] + match[2];
    let decoded;
    try {
      const inflated = inflateSync(data, { maxOutputLength: Math.min(16 * 1024 * 1024, 64 * 1024 * 1024 - inflatedBytes), info: true });
      if (inflated.engine.bytesWritten !== data.length) fail();
      decoded = inflated.buffer;
    } catch { fail(); }
    inflatedBytes += decoded.length;
    if (inflatedBytes > 64 * 1024 * 1024 || createHash(index.objectFormat).update(decoded).digest("hex") !== oid) fail();
    const separator = decoded.indexOf(0), header = decoded.subarray(0, separator).toString("utf8").match(/^(blob|tree|commit) ([0-9]+)$/u);
    if (separator < 0 || separator > 80 || !header || header[2] !== String(decoded.length - separator - 1)) fail();
    objects.set(oid, { type: header[1], body: decoded.subarray(separator + 1) });
  }
  if (roots.length !== proof.checkpointRefs.length || objects.size > 4096) fail();
  const seen = new Map(), existing = new Map(), queue = [...roots];
  const enqueue = entry => { tick(); if (queue.length >= 8192) fail(); queue.push(entry); };
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    tick();
    const [oid, expected, depth] = queue[cursor];
    if (!oidPattern.test(oid) || depth > 256) fail();
    if (seen.has(oid)) { if (seen.get(oid) !== expected) fail(); continue; }
    const object = objects.get(oid);
    if (!object) {
      if (!existing.has(oid)) existing.set(oid, await existingGitObjectType(state.repositoryRoot, oid, Math.max(1, deadline - Date.now())));
      if (existing.get(oid) !== expected) fail();
      continue;
    }
    if (object.type !== expected) fail();
    seen.set(oid, expected);
    if (expected === "commit") {
      const text = object.body.toString("utf8").split("\n\n")[0], lines = text.split("\n");
      if (!lines[0].startsWith("tree ")) fail();
      enqueue([lines[0].slice(5), "tree", depth + 1]);
      for (const line of lines.slice(1)) {
        if (!line.startsWith("parent ")) break;
        enqueue([line.slice(7), "commit", depth + 1]);
      }
    } else if (expected === "tree") {
      let offset = 0; const names = new Set();
      while (offset < object.body.length) {
        const space = object.body.indexOf(32, offset), end = object.body.indexOf(0, space + 1);
        if (space < offset || end < space || end + 1 + length / 2 > object.body.length) fail();
        const mode = object.body.subarray(offset, space).toString("utf8"), name = object.body.subarray(space + 1, end);
        if (!name.length || name.includes(47) || [".", ".."].includes(name.toString()) || names.has(name.toString("hex"))) fail();
        names.add(name.toString("hex"));
        const target = object.body.subarray(end + 1, end + 1 + length / 2).toString("hex");
        if (!["40000", "100644", "100755", "120000", "160000"].includes(mode)) fail();
        if (mode !== "160000") enqueue([target, mode === "40000" ? "tree" : "blob", depth + 1]);
        offset = end + 1 + length / 2;
      }
    }
  }
  if ([...objects.keys()].some(oid => !seen.has(oid))) fail();
  tick();
  return { kind: "checkpoint_additions", originalControls: before, observedControls: now, approval: proof };
}

export async function verifyCheckpointEvidence(...args) {
  try { return await verify(...args); } catch { fail(); }
}
