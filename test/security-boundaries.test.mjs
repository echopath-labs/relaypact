import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmod, lstat, mkdir, readFile, readdir, realpath, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  collectCandidateEvidence,
  copyVerifiedInput,
  preflightCapsule,
  prepareCapsule
} from "../packages/executor-codex/src/capsule.mjs";
import { persistPendingReview, runHostValidations } from "../packages/host-codex/src/review.mjs";
import {
  authorizeCorrection,
  createTaskState,
  readTaskState,
  recordWorkerResult,
  transitionTaskState
} from "../packages/executor-codex/src/state.mjs";
import { prepareTaskCodexHome } from "../packages/executor-codex/src/worker.mjs";
import { analyzeNodeEsm } from "../packages/core/src/context/node-esm.mjs";
import { planDelegationContext } from "../packages/core/src/context/planner.mjs";
import { validateTaskEnvelope } from "../packages/contracts/src/envelope.mjs";
import { changedFilesystemPaths, snapshotFilesystem, snapshotGitControls } from "../packages/core/src/filesystem-evidence.mjs";
import { getStatusPaths, snapshotGitIndex } from "../packages/core/src/git.mjs";
import { evaluatePathScope } from "../packages/contracts/src/path-policy.mjs";
import { runProcess } from "../packages/core/src/process.mjs";
import { createSignedStateStore } from "../packages/core/src/signed-state.mjs";
import { runDelegation } from "../packages/adapter-codex-pi/src/run-delegation.mjs";
import { createDirectory, createGitRepository, makeEnvelope } from "./helpers.mjs";

const fakePi = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));
const workerSchema = fileURLToPath(new URL("../packages/contracts/schemas/codex-worker-result.schema.json", import.meta.url));
const execFileAsync = promisify(execFile);

const profile = {
  name: "native-worker",
  codexCommand: "codex",
  codexProfile: "native-worker",
  model: "worker-model",
  reasoning: "high",
  external: false,
  environmentAllowlist: [],
  router: undefined,
  provider: undefined,
  fingerprint: "sha256:profile"
};

test("process capture reports truncation and hard timeout settlement", async () => {
  const output = await runProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(200000))"]);
  assert.equal(output.stdoutTruncated, true);
  assert.ok(Buffer.byteLength(output.stdout) <= 128 * 1024);

  const started = performance.now();
  const timeout = await runProcess(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], {
    timeoutMs: 1000,
    terminationGraceMs: 30,
    hardSettleGraceMs: 30
  });
  assert.equal(timeout.timedOut, true);
  assert.equal(timeout.hardKilled, true);
  assert.ok(performance.now() - started < 2500);
});

test("process termination remains single-reason while timeout and cancellation overlap", async () => {
  const controller = new AbortController();
  const execution = runProcess(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], {
    timeoutMs: 300,
    terminationGraceMs: 200,
    hardSettleGraceMs: 30,
    signal: controller.signal
  });
  setTimeout(() => controller.abort(), 350);
  const result = await execution;
  assert.equal(result.timedOut, true);
  assert.equal(result.cancelled, false);
  assert.equal(result.hardKilled, true);
});

test("signed state recovers a lock whose owning process has exited", async () => {
  const root = await createDirectory();
  const taskRoot = path.join(root, "task");
  await mkdir(taskRoot);
  const statePath = path.join(taskRoot, "state.json");
  const stateStore = createSignedStateStore(statePath, () => {});
  await stateStore.create({ stateRevision: 0, integrity: "unsigned-placeholder" });
  await stateStore.withLock(async () => {});

  const integrityRoot = path.join(root, ".relaypact-integrity");
  const keyName = (await readdir(integrityRoot)).find((name) => name.endsWith(".key"));
  const lockPath = path.join(integrityRoot, "locks", keyName.replace(/\.key$/u, ".lock"));
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const deadPid = child.pid;
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  await writeFile(lockPath, `${JSON.stringify({ pid: deadPid, acquiredAt: new Date().toISOString() })}\n`, { mode: 0o600 });

  const observed = await stateStore.withLock(async ({ read }) => read());
  assert.equal(observed.stateRevision, 0);
  await assert.rejects(lstat(lockPath), (error) => error.code === "ENOENT");
});

test("signed state never reclaims a lock owned by a live process", async () => {
  const root = await createDirectory();
  const taskRoot = path.join(root, "task");
  await mkdir(taskRoot);
  const statePath = path.join(taskRoot, "state.json");
  const stateStore = createSignedStateStore(statePath, () => {});
  await stateStore.create({ stateRevision: 0, integrity: "unsigned-placeholder" });
  await stateStore.withLock(async () => {});

  const integrityRoot = path.join(root, ".relaypact-integrity");
  const keyName = (await readdir(integrityRoot)).find((name) => name.endsWith(".key"));
  const lockPath = path.join(integrityRoot, "locks", keyName.replace(/\.key$/u, ".lock"));
  await writeFile(lockPath, `${JSON.stringify({ pid: process.pid, acquiredAt: new Date(0).toISOString() })}\n`, { mode: 0o600 });

  await assert.rejects(
    stateStore.withLock(async () => {}),
    (error) => error.code === "task_state_busy"
  );
});

test("signed state reclaims a lock when the PID belongs to a different process identity", async () => {
  const root = await createDirectory();
  const taskRoot = path.join(root, "task");
  await mkdir(taskRoot);
  const statePath = path.join(taskRoot, "state.json");
  const stateStore = createSignedStateStore(statePath, () => {}, {
    processIdentity: async () => "process-start:new-owner"
  });
  await stateStore.create({ stateRevision: 0, integrity: "unsigned-placeholder" });
  await stateStore.withLock(async () => {});

  const integrityRoot = path.join(root, ".relaypact-integrity");
  const keyName = (await readdir(integrityRoot)).find((name) => name.endsWith(".key"));
  const lockPath = path.join(integrityRoot, "locks", keyName.replace(/\.key$/u, ".lock"));
  await writeFile(lockPath, `${JSON.stringify({
    pid: process.pid,
    processIdentity: "process-start:old-owner",
    acquiredAt: new Date().toISOString()
  })}\n`, { mode: 0o600 });

  const observed = await stateStore.withLock(async ({ read }) => read());
  assert.equal(observed.stateRevision, 0);
  await assert.rejects(lstat(lockPath), (error) => error.code === "ENOENT");
});

test("signed state age-bounds a live lock when process identity is unavailable", async () => {
  const root = await createDirectory();
  const taskRoot = path.join(root, "task");
  await mkdir(taskRoot);
  const statePath = path.join(taskRoot, "state.json");
  const stateStore = createSignedStateStore(statePath, () => {}, {
    processIdentity: async () => null
  });
  await stateStore.create({ stateRevision: 0, integrity: "unsigned-placeholder" });
  await stateStore.withLock(async () => {});

  const integrityRoot = path.join(root, ".relaypact-integrity");
  const keyName = (await readdir(integrityRoot)).find((name) => name.endsWith(".key"));
  const lockPath = path.join(integrityRoot, "locks", keyName.replace(/\.key$/u, ".lock"));
  await writeFile(lockPath, `${JSON.stringify({
    pid: process.pid,
    processIdentity: null,
    acquiredAt: new Date().toISOString()
  })}\n`, { mode: 0o600 });

  await assert.rejects(
    stateStore.withLock(async () => {}),
    (error) => error.code === "task_state_busy"
  );
  const stale = new Date(Date.now() - 16 * 60_000);
  await utimes(lockPath, stale, stale);
  const observed = await stateStore.withLock(async ({ read }) => read());
  assert.equal(observed.stateRevision, 0);
  await assert.rejects(lstat(lockPath), (error) => error.code === "ENOENT");
});

test("signed state renews an unidentified live owner's lock lease", async () => {
  const root = await createDirectory();
  const taskRoot = path.join(root, "task");
  await mkdir(taskRoot);
  const statePath = path.join(taskRoot, "state.json");
  const stateStore = createSignedStateStore(statePath, () => {}, {
    processIdentity: async () => null,
    lockLeaseMs: 40,
    lockHeartbeatMs: 10
  });
  await stateStore.create({ stateRevision: 0, integrity: "unsigned-placeholder" });
  let release;
  const held = stateStore.withLock(() => new Promise((resolve) => { release = resolve; }));
  await new Promise((resolve) => setTimeout(resolve, 80));
  await assert.rejects(
    stateStore.withLock(async () => {}),
    (error) => error.code === "task_state_busy"
  );
  release();
  await held;
});

async function processIsExecuting(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
  if (process.platform === "linux") {
    try {
      const value = await readFile(`/proc/${pid}/stat`, "utf8");
      const commandEnd = value.lastIndexOf(")");
      const state = commandEnd >= 0 ? value.slice(commandEnd + 1).trim().split(/\s+/u)[0] : null;
      if (state === "Z") return false;
    } catch (error) {
      if (new Set(["ENOENT", "ESRCH"]).has(error?.code)) return false;
      throw error;
    }
  }
  return true;
}

test("process runner terminates same-group descendants after the leader exits", async () => {
  const source = [
    "const { spawn } = require('node:child_process');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    "child.unref();",
    "process.stdout.write(String(child.pid));"
  ].join("\n");
  const result = await runProcess(process.execPath, ["-e", source]);
  assert.equal(result.exitCode, 0);
  assert.equal(result.groupCleanupAttempted, process.platform !== "win32");
  if (process.platform !== "win32") {
    const pid = Number(result.stdout);
    let alive = true;
    for (let attempt = 0; attempt < 30 && alive; attempt += 1) {
      alive = await processIsExecuting(pid);
      if (alive) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(alive, false);
  }
});

test("machine Git evidence fails closed instead of parsing a truncated prefix", async () => {
  const root = await createGitRepository();
  for (let index = 0; index < 1500; index += 1) {
    const name = `${String(index).padStart(4, "0")}-${"x".repeat(90)}.txt`;
    await writeFile(path.join(root, name), "x");
  }
  await assert.rejects(getStatusPaths(root), (error) => error.code === "git_output_truncated");
});

test("canonical Git index identity ignores stat cache and preserves unusual paths", async () => {
  const root = await createGitRepository();
  const unusualPath = "tab\tline\nname.txt";
  await writeFile(path.join(root, unusualPath), "unusual\n");
  await execFileAsync("git", ["add", "--", unusualPath], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "test: unusual path"], { cwd: root });
  const controlsBefore = await snapshotGitControls(root, { excludeIndexes: true });
  const before = await snapshotGitIndex(root);
  assert.equal(before.entries.find((entry) => entry.path === unusualPath)?.stage, 0);
  const rawBefore = await readFile(path.join(root, ".git", "index"));
  const refreshedPath = path.join(root, "README.md");
  const refreshedAt = new Date(Date.now() + 60_000);
  await utimes(refreshedPath, refreshedAt, refreshedAt);
  await execFileAsync("git", ["update-index", "--refresh"], { cwd: root });
  const rawAfter = await readFile(path.join(root, ".git", "index"));
  const after = await snapshotGitIndex(root);
  const controlsAfter = await snapshotGitControls(root, { excludeIndexes: true });
  assert.notDeepEqual(rawAfter, rawBefore);
  assert.equal(after.fingerprint, before.fingerprint);
  assert.equal(controlsAfter.fingerprint, controlsBefore.fingerprint);
});

test("canonical Git index identity preserves slash and literal backslash path spelling", { skip: process.platform === "win32" }, async () => {
  const root = await createGitRepository();
  await mkdir(path.join(root, "dir"));
  await writeFile(path.join(root, "dir", "file.txt"), "slash\n");
  await writeFile(path.join(root, "dir\\file.txt"), "backslash\n");
  await execFileAsync("git", ["add", "--", "dir/file.txt", "dir\\file.txt"], { cwd: root });
  const snapshot = await snapshotGitIndex(root);
  const paths = snapshot.entries.map((entry) => entry.path);
  assert.ok(paths.includes("dir/file.txt"));
  assert.ok(paths.includes("dir\\file.txt"));
  assert.notEqual(paths.indexOf("dir/file.txt"), paths.indexOf("dir\\file.txt"));
});

test("canonical Git index identity binds security flags", async () => {
  const root = await createGitRepository();
  const baseline = await snapshotGitIndex(root);
  await execFileAsync("git", ["update-index", "--assume-unchanged", "README.md"], { cwd: root });
  const assumed = await snapshotGitIndex(root);
  assert.notEqual(assumed.fingerprint, baseline.fingerprint);
  assert.equal(assumed.entries[0].assumeUnchanged, true);
  await execFileAsync("git", ["update-index", "--no-assume-unchanged", "README.md"], { cwd: root });
  await execFileAsync("git", ["update-index", "--skip-worktree", "README.md"], { cwd: root });
  const skipped = await snapshotGitIndex(root);
  assert.notEqual(skipped.fingerprint, baseline.fingerprint);
  assert.equal(skipped.entries[0].skipWorktree, true);
  await execFileAsync("git", ["update-index", "--no-skip-worktree", "README.md"], { cwd: root });
  await writeFile(path.join(root, "intent.txt"), "intent\n");
  await execFileAsync("git", ["add", "-N", "--", "intent.txt"], { cwd: root });
  const intent = await snapshotGitIndex(root);
  assert.notEqual(intent.fingerprint, baseline.fingerprint);
  assert.equal(intent.entries.find((entry) => entry.path === "intent.txt")?.intentToAdd, true);
});

test("canonical Git index identity rejects staged content, paths, deletion, mode, and conflicts", async () => {
  const mutation = async (mutate) => {
    const root = await createGitRepository();
    const before = await snapshotGitIndex(root);
    await mutate(root);
    const after = await snapshotGitIndex(root);
    assert.notEqual(after.fingerprint, before.fingerprint);
    return { root, after };
  };
  await mutation(async (root) => {
    await writeFile(path.join(root, "added.txt"), "added\n");
    await execFileAsync("git", ["add", "added.txt"], { cwd: root });
  });
  await mutation(async (root) => {
    await writeFile(path.join(root, "README.md"), "modified\n");
    await execFileAsync("git", ["add", "README.md"], { cwd: root });
  });
  await mutation(async (root) => {
    await execFileAsync("git", ["rm", "README.md"], { cwd: root });
  });
  const mode = await mutation(async (root) => {
    await chmod(path.join(root, "README.md"), 0o755);
    await execFileAsync("git", ["add", "README.md"], { cwd: root });
  });
  assert.equal(mode.after.entries[0].mode, "100755");
  const conflict = await mutation(async (root) => {
    await execFileAsync("git", ["switch", "-c", "other"], { cwd: root });
    await writeFile(path.join(root, "README.md"), "other\n");
    await execFileAsync("git", ["commit", "-am", "test: other"], { cwd: root });
    await execFileAsync("git", ["switch", "main"], { cwd: root });
    await writeFile(path.join(root, "README.md"), "main\n");
    await execFileAsync("git", ["commit", "-am", "test: main"], { cwd: root });
    await assert.rejects(execFileAsync("git", ["merge", "other"], { cwd: root }));
  });
  assert.deepEqual(conflict.after.entries.map((entry) => entry.stage), [1, 2, 3]);
});

test("canonical Git index identity rejects non-UTF-8 paths without lossy collisions", async () => {
  const root = await createGitRepository();
  const objectSource = path.join(root, "object-source.txt");
  await writeFile(objectSource, "invalid path fixture\n");
  const objectId = (await execFileAsync("git", ["hash-object", "-w", objectSource], { cwd: root })).stdout.trim();
  const pathBytes = Buffer.concat([Buffer.from("bad-"), Buffer.from([0xff]), Buffer.from(".txt")]);
  const indexInfo = Buffer.concat([Buffer.from(`100644 ${objectId}\t`), pathBytes, Buffer.from([0])]);
  const update = await runProcess("git", ["update-index", "-z", "--index-info"], { cwd: root, input: indexInfo });
  assert.equal(update.exitCode, 0);
  await assert.rejects(
    snapshotGitIndex(root),
    (error) => error.code === "git_index_evidence_invalid" && /valid UTF-8/.test(error.message)
  );
});

test("filesystem evidence bounds directory traversal independently of file bytes", async () => {
  const root = await createDirectory();
  await mkdir(path.join(root, "one", "two"), { recursive: true });
  await assert.rejects(
    snapshotFilesystem(root, { maxFiles: 10, maxDirectories: 2 }),
    (error) => error.code === "filesystem_evidence_exceeded" && /directory-count/.test(error.message)
  );
});

test("Git-control evidence covers a linked worktree common directory", async () => {
  const root = await createGitRepository();
  const linkedRoot = await createDirectory();
  await execFileAsync("git", ["worktree", "add", "--detach", linkedRoot], { cwd: root });
  const head = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  const objectPath = path.join(root, ".git", "objects", head.slice(0, 2), head.slice(2));
  const before = await snapshotGitControls(linkedRoot);
  await chmod(objectPath, 0o600);
  await writeFile(objectPath, "corrupted shared object\n");
  const after = await snapshotGitControls(linkedRoot);
  assert.ok(changedFilesystemPaths(before, after).length > 0);
});

test("index exclusion preserves refs named index and sibling worktree indexes", async () => {
  const root = await createGitRepository();
  await execFileAsync("git", ["branch", "index"], { cwd: root });
  const refBefore = await snapshotGitControls(root, { excludeIndexes: true });
  const refPath = path.join(root, ".git", "refs", "heads", "index");
  await writeFile(refPath, `${(await readFile(refPath, "utf8")).trim()}\n# changed\n`);
  const refAfter = await snapshotGitControls(root, { excludeIndexes: true });
  assert.notEqual(refAfter.fingerprint, refBefore.fingerprint);

  const siblingRoot = await createGitRepository();
  const linkedRoot = await createDirectory();
  await execFileAsync("git", ["worktree", "add", "--detach", linkedRoot], { cwd: siblingRoot });
  const siblingBefore = await snapshotGitControls(linkedRoot, { excludeIndexes: true });
  const refreshedAt = new Date(Date.now() + 60_000);
  await utimes(path.join(siblingRoot, "README.md"), refreshedAt, refreshedAt);
  await execFileAsync("git", ["update-index", "--refresh"], { cwd: siblingRoot });
  const siblingAfter = await snapshotGitControls(linkedRoot, { excludeIndexes: true });
  assert.notEqual(siblingAfter.fingerprint, siblingBefore.fingerprint);
});

test("Git-control evidence covers configured alternate object stores", async () => {
  const root = await createGitRepository();
  const alternate = await createGitRepository();
  const infoRoot = path.join(root, ".git", "objects", "info");
  await mkdir(infoRoot, { recursive: true });
  await writeFile(path.join(infoRoot, "alternates"), `${path.join(alternate, ".git", "objects")}\n`);
  const head = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: alternate })).stdout.trim();
  const objectPath = path.join(alternate, ".git", "objects", head.slice(0, 2), head.slice(2));
  const before = await snapshotGitControls(root);
  await chmod(objectPath, 0o600);
  await writeFile(objectPath, "corrupted alternate object\n");
  const after = await snapshotGitControls(root);
  assert.ok(changedFilesystemPaths(before, after).length > 0);
});

test("Git-control evidence rejects an oversized top-level Git pointer", async () => {
  const root = await createGitRepository();
  const linkedRoot = await createDirectory();
  await execFileAsync("git", ["worktree", "add", "--detach", linkedRoot], { cwd: root });
  await writeFile(path.join(linkedRoot, ".git"), `gitdir: ${"x".repeat(300 * 1024)}\n`);
  await assert.rejects(
    snapshotGitControls(linkedRoot),
    (error) => error.code === "git_control_unavailable" && /unsafe type or size/.test(error.message)
  );
});

test("Git alternate traversal enforces one global edge budget", async () => {
  const root = await createGitRepository();
  const alternate = await createGitRepository();
  const primaryObjects = path.join(root, ".git", "objects");
  const alternateObjects = path.join(alternate, ".git", "objects");
  await mkdir(path.join(primaryObjects, "info"), { recursive: true });
  await mkdir(path.join(alternateObjects, "info"), { recursive: true });
  await writeFile(
    path.join(primaryObjects, "info", "alternates"),
    `${Array.from({ length: 1024 }, () => alternateObjects).join("\n")}\n`
  );
  await writeFile(path.join(alternateObjects, "info", "alternates"), `${primaryObjects}\n`);
  await assert.rejects(
    snapshotGitControls(root),
    (error) => error.code === "filesystem_evidence_exceeded" && /edge-count/.test(error.message)
  );
});

test("Pi and host validation receive isolated environments", async () => {
  const root = await createGitRepository();
  const envelope = makeEnvelope(root, {
    executionProfile: { provider: "fixture-provider", model: "fixture-model" },
    validation: [{
      id: "environment",
      argv: [process.execPath, "-e", "process.exit(process.env.HOST_SECRET===undefined&&process.env.HOME.includes('relaypact-validation-')?0:9)"],
      timeoutMs: 10_000
    }]
  });
  const result = await runDelegation(envelope, {
    executorCommand: fakePi,
    executorEnv: { FAKE_PI_SCENARIO: "environment" },
    environment: { ...process.env, HOST_SECRET: "must-not-pass" },
    validationEnvironment: { ...process.env, HOST_SECRET: "must-not-pass" }
  });
  assert.equal(result.executor.summary, "Environment isolated.");
  assert.equal(result.validations[0].status, "passed");
});

test("Codex host validation strips secrets from its environment", async () => {
  const root = await createDirectory();
  let observed;
  const results = await runHostValidations(makeEnvelope(root), { taskRoot: root, capsuleRoot: root }, {
    environment: { PATH: process.env.PATH, HOST_SECRET: "must-not-pass" },
    runProcess: async (_command, _args, options) => {
      observed = options.env;
      return { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false };
    }
  });
  assert.equal(results[0].status, "passed");
  assert.equal(observed.HOST_SECRET, undefined);
  assert.ok(observed.HOME.startsWith(root));
});

test("host validation redacts exact values from explicit environment grants", async () => {
  const root = await createDirectory();
  const secret = "q7z";
  const results = await runHostValidations(makeEnvelope(root), { taskRoot: root, capsuleRoot: root }, {
    validationEnv: { EXPLICIT_VALUE: secret },
    runProcess: async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: `observed ${secret}`,
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false
    })
  });
  assert.doesNotMatch(JSON.stringify(results), new RegExp(secret));
  assert.match(results[0].summary, /REDACTED_EXACT_VALUE/);
});

test("host validation never reuses a predictable executor-created home", async () => {
  const root = await createDirectory();
  const predictable = path.join(root, "validation-home");
  await mkdir(predictable);
  await writeFile(path.join(predictable, ".gitconfig"), "[alias]\n  status = !false\n");
  let observedHome;
  const results = await runHostValidations(makeEnvelope(root), { taskRoot: root, capsuleRoot: root }, {
    runProcess: async (_command, _args, options) => {
      observedHome = options.env.HOME;
      return { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false };
    }
  });
  assert.equal(results[0].status, "passed");
  assert.notEqual(observedHome, predictable);
  assert.match(observedHome, /validation-home-/);
});

test("Codex state root must be a pre-existing real directory", async () => {
  const root = await createGitRepository();
  const actualState = await createDirectory();
  const linkedState = `${actualState}-link`;
  await symlink(actualState, linkedState);
  await assert.rejects(
    preflightCapsule({
      envelope: makeEnvelope(root, { scope: { readablePaths: ["README.md"] } }),
      repository: { gitRoot: await realpath(root) },
      profile,
      stateRoot: linkedState,
      workerResultSchemaPath: workerSchema
    }),
    (error) => error.code === "invalid_state_root"
  );
});

test("host review ignores an executor-replaced Git pointer and reports the tamper", async () => {
  const root = await createGitRepository();
  await writeFile(path.join(root, "allowed.txt"), "before\n");
  const envelope = makeEnvelope(root, { scope: { readablePaths: ["README.md", "allowed.txt"] } });
  const prepared = await prepareCapsule({
    envelope,
    repository: { gitRoot: await realpath(root) },
    profile,
    stateRoot: await createDirectory(),
    workerResultSchemaPath: workerSchema
  });
  const fakeGit = path.join(prepared.taskRoot, "attacker-git");
  await mkdir(fakeGit);
  await writeFile(path.join(fakeGit, "config"), "[core]\nfsmonitor = !false\n");
  await writeFile(path.join(prepared.capsuleRoot, ".git"), `gitdir: ${fakeGit}\n`);
  await writeFile(path.join(prepared.capsuleRoot, "allowed.txt"), "after\n");
  const evidence = await collectCandidateEvidence(prepared, envelope.scope);
  assert.ok(evidence.scopeBreaches.includes("git:executor-visible metadata changed"));
  assert.ok(evidence.changedPaths.includes("allowed.txt"));
  assert.match(evidence.candidatePatch, /after/);
});

test("copying refuses a source whose identity changed after preflight", async () => {
  const root = await createGitRepository();
  const envelope = makeEnvelope(root, { scope: { readablePaths: ["README.md"] } });
  const preflight = await preflightCapsule({
    envelope,
    repository: { gitRoot: await realpath(root) },
    profile,
    stateRoot: await createDirectory(),
    workerResultSchemaPath: workerSchema
  });
  await writeFile(path.join(root, "README.md"), "changed after preflight\n");
  await assert.rejects(
    copyVerifiedInput(preflight.inputs[0], path.join(await createDirectory(), "README.md")),
    (error) => error.code === "context_source_changed"
  );
});

test("context planner rejects over-budget metadata before reading bytes", async () => {
  const root = await createDirectory();
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "entry.mjs"), "export const value = 1;\n");
  let read = false;
  const envelope = makeEnvelope(root, {
    scope: { allowedPaths: ["src/**/*.mjs"], forbiddenPaths: [], discoverablePaths: ["src/**/*.mjs"] },
    contextPlanning: {
      strategy: "dependency-closure",
      seeds: ["src/entry.mjs"],
      analyzers: ["node-esm"],
      budget: { maxFiles: 2, maxBytes: 10, maxDepth: 1 },
      readiness: []
    }
  });
  await assert.rejects(planDelegationContext(envelope, root, {
    fs: {
      lstat: async (file) => {
        const value = await lstat(file);
        if (file.endsWith("entry.mjs")) {
          return { ...value, size: 100, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false };
        }
        return value;
      },
      readFile: async () => {
        read = true;
        return Buffer.from("must not read");
      }
    }
  }), (error) => error.code === "context_budget_exceeded");
  assert.equal(read, false);
});

test("dependency analysis has a deterministic token bound", () => {
  const result = analyzeNodeEsm({
    relativePath: "src/adversarial.mjs",
    source: `${"identifier ".repeat(200_100)};`
  });
  assert.ok(result.references.some((item) => item.reason === "dependency analyzer token budget exceeded"));
});

test("native Codex home projects only selected config and supported auth fields", async () => {
  const taskRoot = await createDirectory();
  const capsuleRoot = path.join(taskRoot, "capsule");
  await mkdir(capsuleRoot);
  const sourceHome = await createDirectory();
  await writeFile(path.join(sourceHome, "config.toml"), "[mcp_servers.unrelated]\ncommand='must-not-copy'\n");
  await writeFile(path.join(sourceHome, "native-worker.config.toml"), "[profiles.native-worker]\nmodel = 'worker-model'\n");
  await writeFile(path.join(sourceHome, "auth.json"), JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: { access_token: "selected-auth" },
    last_refresh: "now",
    unrelated_provider_token: "must-not-copy"
  }));
  const codexHome = await prepareTaskCodexHome({ taskRoot, capsuleRoot }, profile, { sourceCodexHome: sourceHome });
  const config = await readFile(path.join(codexHome, "config.toml"), "utf8");
  const auth = JSON.parse(await readFile(path.join(codexHome, "auth.json"), "utf8"));
  assert.doesNotMatch(config, /mcp_servers|must-not-copy/);
  assert.equal(auth.unrelated_provider_token, undefined);
  assert.equal(auth.tokens.access_token, "selected-auth");
  assert.equal((await lstat(path.join(codexHome, "config.toml"))).isSymbolicLink(), false);
  await writeFile(path.join(codexHome, "auth.json"), JSON.stringify({ tokens: { access_token: "task-tamper" } }), { mode: 0o600 });
  await writeFile(path.join(sourceHome, "auth.json"), JSON.stringify({ tokens: { access_token: "current-host-auth" } }));
  await prepareTaskCodexHome({ taskRoot, capsuleRoot }, profile, { sourceCodexHome: sourceHome });
  const refreshed = JSON.parse(await readFile(path.join(codexHome, "auth.json"), "utf8"));
  assert.equal(refreshed.tokens.access_token, "current-host-auth");
});

test("native Codex profile snapshot rejects unrelated capability tables", async () => {
  const taskRoot = await createDirectory();
  const capsuleRoot = path.join(taskRoot, "capsule");
  await mkdir(capsuleRoot);
  const sourceHome = await createDirectory();
  await writeFile(path.join(sourceHome, "native-worker.config.toml"), "[mcp_servers.unrelated]\ncommand='tool'\n");
  await assert.rejects(
    prepareTaskCodexHome({ taskRoot, capsuleRoot }, profile, { sourceCodexHome: sourceHome }),
    (error) => error.code === "codex_profile_projection_unsupported"
  );
});

test("native Codex profile snapshot rejects authority widening and credential-bearing URLs", async () => {
  for (const content of [
    "[profiles.native-worker]\nsandbox_mode = 'danger-full-access'\n",
    "[profiles.native-worker]\nmodel_provider = 'unsafe'\n\n[model_providers.unsafe]\nbase_url = \"https://user:secret@example.invalid/v1\"\n"
  ]) {
    const taskRoot = await createDirectory();
    const capsuleRoot = path.join(taskRoot, "capsule");
    await mkdir(capsuleRoot);
    const sourceHome = await createDirectory();
    await writeFile(path.join(sourceHome, "native-worker.config.toml"), content);
    await assert.rejects(
      prepareTaskCodexHome({ taskRoot, capsuleRoot }, profile, { sourceCodexHome: sourceHome }),
      (error) => error.code === "codex_profile_projection_unsupported"
    );
  }
});

test("task state rejects path-like correction sequences and unknown fields", async () => {
  const root = await createDirectory();
  const capsule = { taskRoot: root, taskId: "task", baseline: "baseline", contextManifestFingerprint: null, privateControlBaseline: { fingerprint: "sha256:private-control" } };
  const { statePath, state } = await createTaskState({ capsule, profile, hostInstanceId: "host" });
  await writeFile(statePath, JSON.stringify({ ...state, correctionSequence: "../../escape" }));
  await assert.rejects(readTaskState(statePath), (error) => error.code === "task_state_unavailable");
  await writeFile(statePath, JSON.stringify({ ...state, unexpected: true }));
  await assert.rejects(readTaskState(statePath), (error) => error.code === "task_state_unavailable");
  await writeFile(statePath, JSON.stringify({
    ...state,
    relaypactInput: {
      relaypactPromptBytes: 10,
      relaypactResultSchemaBytes: 5,
      relaypactDeclaredInputBytes: 99
    }
  }));
  await assert.rejects(readTaskState(statePath), (error) => error.code === "task_state_unavailable");
});

test("concurrent correction authorization cannot overwrite task lifecycle state", async () => {
  const root = await createDirectory();
  const capsule = { taskRoot: root, taskId: "task", baseline: "baseline", contextManifestFingerprint: null, privateControlBaseline: { fingerprint: "sha256:private-control" } };
  const { statePath } = await createTaskState({ capsule, profile, hostInstanceId: "host" });
  await transitionTaskState(statePath, "running");
  const reviewed = await recordWorkerResult(statePath, {
    threadId: "worker",
    result: {
      schemaVersion: "1.0.0",
      taskId: "task",
      status: "completed",
      summary: "done",
      changedFiles: [],
      validations: [],
      residualRisks: [],
      blocking: null
    }
  });
  const identity = {
    taskId: "task",
    profileFingerprint: profile.fingerprint,
    capsuleBaseline: "baseline",
    priorResultIdentity: reviewed.resultIdentity
  };
  const outcomes = await Promise.allSettled([
    authorizeCorrection(statePath, identity),
    authorizeCorrection(statePath, identity)
  ]);
  assert.equal(outcomes.filter((item) => item.status === "fulfilled").length, 1);
  const state = await readTaskState(statePath);
  assert.equal(state.correctionSequence, 1);
  assert.equal(state.lifecycleState, "correction_requested");
});

test("review evidence cannot overwrite an existing correction sequence", async () => {
  const root = await createDirectory();
  const capsule = { taskRoot: root, taskId: "task", baseline: "baseline", contextManifestFingerprint: null, privateControlBaseline: { fingerprint: "sha256:private-control" } };
  const { statePath } = await createTaskState({ capsule, profile, hostInstanceId: "host" });
  const prepared = { statePath, capsule };
  const review = { packet: { status: "pending" }, candidatePatch: "patch" };
  await persistPendingReview(prepared, review);
  await assert.rejects(persistPendingReview(prepared, review), (error) => error.code === "EEXIST");
});

test("scope paths require canonical spelling and forbidden matching is case-safe", () => {
  assert.throws(
    () => validateTaskEnvelope(makeEnvelope("/absolute/repository", { scope: { allowedPaths: ["src/./file.mjs"] } })),
    (error) => error.code === "invalid_path"
  );
  assert.deepEqual(evaluatePathScope(["SRC/private.txt"], {
    allowedPaths: ["SRC/**"],
    forbiddenPaths: ["src/**"]
  }), ["SRC/private.txt"]);
});
