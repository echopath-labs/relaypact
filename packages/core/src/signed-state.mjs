import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DelegationError } from "../../contracts/src/errors.mjs";

const STALE_LOCK_MS = 15 * 60_000;

export function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function integrityRoot(statePath) {
  return path.join(path.dirname(path.dirname(statePath)), ".relaypact-integrity");
}

function integrityKeyPath(statePath) {
  const task = createHash("sha256").update(path.resolve(path.dirname(statePath))).digest("hex");
  return path.join(integrityRoot(statePath), `${task}.key`);
}

async function loadIntegrityKey(statePath, { create = false } = {}) {
  const root = integrityRoot(statePath);
  const keyPath = integrityKeyPath(statePath);
  if (create) await mkdir(root, { recursive: true, mode: 0o700 });
  if (create) {
    try {
      await writeFile(keyPath, randomBytes(32), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  let info;
  try {
    info = await lstat(keyPath);
  } catch {
    throw new DelegationError("task_state_unavailable", "Host lifecycle integrity key is unavailable.");
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size !== 32 || (info.mode & 0o777) !== 0o600) {
    throw new DelegationError("task_state_unavailable", "Host lifecycle integrity key has an unsafe type, size, or mode.");
  }
  return readFile(keyPath);
}

function unsignedState(state) {
  const { integrity: ignored, ...unsigned } = state;
  void ignored;
  return unsigned;
}

function stateMac(state, key) {
  return `hmac-sha256:${createHmac("sha256", key).update(canonicalize(unsignedState(state))).digest("hex")}`;
}

export function createSignedStateStore(statePath, validateState) {
  async function reclaimStaleLock(lockPath) {
    const info = await lstat(lockPath).catch(() => null);
    if (!info || !info.isFile() || info.isSymbolicLink() || info.size > 4096) return false;
    let owner = null;
    try {
      owner = JSON.parse(await readFile(lockPath, "utf8"));
    } catch {
      // A malformed private lock is reclaimable only after a conservative age bound.
    }
    if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) {
      try {
        process.kill(owner.pid, 0);
        return false;
      } catch (error) {
        if (error?.code !== "ESRCH") return false;
      }
    } else if (Date.now() - info.mtimeMs < STALE_LOCK_MS) {
      return false;
    }
    const current = await lstat(lockPath).catch(() => null);
    if (!current || current.dev !== info.dev || current.ino !== info.ino) return false;
    await rm(lockPath, { force: true });
    return true;
  }

  async function readUnlocked() {
    let state;
    try {
      state = JSON.parse(await readFile(statePath, "utf8"));
    } catch {
      throw new DelegationError("task_state_unavailable", "Task lifecycle state is missing or malformed.");
    }
    validateState(state);
    const key = await loadIntegrityKey(statePath);
    const expected = Buffer.from(stateMac(state, key));
    const actual = Buffer.from(state.integrity);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new DelegationError("task_state_unavailable", "Task lifecycle state failed host integrity verification.");
    }
    return state;
  }

  async function persist(state, { exclusive = false, expectedRevision = undefined } = {}) {
    const key = await loadIntegrityKey(statePath, { create: exclusive });
    const signed = { ...state, integrity: stateMac(state, key) };
    validateState(signed);
    if (exclusive) {
      await writeFile(statePath, `${JSON.stringify(signed, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      await chmod(statePath, 0o600);
      return signed;
    }
    if (expectedRevision !== undefined) {
      const current = await readUnlocked();
      if (current.stateRevision !== expectedRevision) {
        throw new DelegationError("task_state_conflict", "Task lifecycle changed before the state update could commit.");
      }
    }
    const temporary = `${statePath}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(signed, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, statePath);
    await chmod(statePath, 0o600);
    return signed;
  }

  async function withLock(operation) {
    const lockRoot = path.join(integrityRoot(statePath), "locks");
    await mkdir(lockRoot, { recursive: true, mode: 0o700 });
    const lockPath = path.join(lockRoot, `${path.basename(integrityKeyPath(statePath), ".key")}.lock`);
    let handle;
    let lockIdentity;
    try {
      try {
        handle = await open(lockPath, "wx", 0o600);
      } catch (error) {
        if (error?.code !== "EEXIST" || !await reclaimStaleLock(lockPath)) throw error;
        handle = await open(lockPath, "wx", 0o600);
      }
      lockIdentity = await handle.stat();
      try {
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`);
      } catch (error) {
        await handle.close().catch(() => {});
        await rm(lockPath, { force: true }).catch(() => {});
        throw error;
      }
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw new DelegationError("task_state_busy", "Task lifecycle state is being updated by another host action.");
      }
      throw error;
    }
    try {
      return await operation({ read: readUnlocked, persist, key: () => loadIntegrityKey(statePath) });
    } finally {
      await handle.close().catch(() => {});
      const current = await lstat(lockPath).catch(() => null);
      if (current && current.dev === lockIdentity.dev && current.ino === lockIdentity.ino) {
        await rm(lockPath, { force: true }).catch(() => {});
      }
    }
  }

  return {
    create: (state) => persist(state, { exclusive: true }),
    key: () => loadIntegrityKey(statePath),
    read: readUnlocked,
    persist,
    withLock,
    removeIntegrityAnchor: () => rm(integrityKeyPath(statePath), { force: true })
  };
}

export async function keyedFingerprint(statePath, purpose, value) {
  const key = await loadIntegrityKey(statePath);
  return `hmac-sha256:${createHmac("sha256", key).update(canonicalize({ purpose, value })).digest("hex")}`;
}
