import { runLocalDelegation } from "../packages/core/src/local-delegation.mjs";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { access, chmod, copyFile, link, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import { once } from "node:events";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { format, promisify } from "node:util";
import {
  correctDelegation,
  decideDelegation,
  runDelegation
} from "../packages/adapter-codex-cursor/src/run-delegation.mjs";
import {
  assertCursorResumeSession,
  cursorSessionEvidence,
  discoverCursorCli,
  materializeCursorExecutable,
  resolveCursorExecutable,
  runExecutor
} from "../packages/executor-cursor/src/executor.mjs";
import {
  abandonAndCleanupFailedDirectTask,
  abandonAndCleanupInterruptedDirectTask,
  authorizeDirectCorrection,
  beginDirectDelegation,
  executeDirectDelegation,
  failDirectDelegation,
  finalizeDirectTerminalDecision,
  loadDirectDelegation,
  prepareDirectDelegation,
  recordDirectDelegationResult,
  requireDirectExecutorSession
} from "../packages/core/src/direct-lifecycle.mjs";
import { createDirectory, createGitRepository, makeEnvelope } from "./helpers.mjs";
import { createSignedStateStore } from "../packages/core/src/signed-state.mjs";
import { assertRepositoryLinks, snapshotFilesystem, snapshotGitControls } from "../packages/core/src/filesystem-evidence.mjs";
import { snapshotGitIndex } from "../packages/core/src/git.mjs";
import { assertPackedRefsUnshadowed, checkpointObservationFingerprint } from "../packages/core/src/checkpoint-evidence.mjs";

const fakeCursorLauncherSource = fileURLToPath(new URL("./fixtures/fake-cursor-agent.sh", import.meta.url));
const fakeCursorImplementationSource = fileURLToPath(new URL("./fixtures/fake-cursor-agent.mjs", import.meta.url));
const fakeCursorRuntimeSource = fileURLToPath(new URL("./fixtures/fake-cursor-runtime.c", import.meta.url));
const fakeCursorPackageSource = fileURLToPath(new URL("./fixtures/package.json", import.meta.url));
const fakeCursorRoot = await mkdtemp(path.join(os.tmpdir(), "relaypact-cursor-fixture-"));
const fakeCursor = path.join(fakeCursorRoot, "cursor-agent");
const fakeCursorImplementation = path.join(fakeCursorRoot, "index.js");
const fakeCursorRuntime = path.join(fakeCursorRoot, "node");
const fakeCursorPackage = path.join(fakeCursorRoot, "package.json");
const fakeCursorCapabilities = path.join(fakeCursorRoot, "runtime-capabilities.json");
await Promise.all([
  copyFile(fakeCursorLauncherSource, fakeCursor),
  copyFile(fakeCursorImplementationSource, fakeCursorImplementation),
  copyFile(fakeCursorPackageSource, fakeCursorPackage)
]);
let fakeCursorRuntimeSupportsSystemCa = true;
try {
  execFileSync(process.env.CC || "cc", [fakeCursorRuntimeSource, "-O2", "-o", fakeCursorRuntime], {
    stdio: "pipe"
  });
} catch {
  await copyFile(process.execPath, fakeCursorRuntime);
  try {
    execFileSync(process.execPath, ["--use-system-ca", "--version"], { stdio: "ignore" });
  } catch {
    fakeCursorRuntimeSupportsSystemCa = false;
  }
}
await writeFile(fakeCursorCapabilities, `${JSON.stringify({ systemCa: fakeCursorRuntimeSupportsSystemCa })}\n`);
await Promise.all([
  chmod(fakeCursor, 0o755),
  chmod(fakeCursorImplementation, 0o755),
  chmod(fakeCursorRuntime, 0o755)
]);
test.after(() => rm(fakeCursorRoot, { recursive: true, force: true }));
const cli = fileURLToPath(new URL("../bin/relaypact.mjs", import.meta.url));
const execFileAsync = promisify(execFile);

async function nodeCursorFixture(privateRoot, transform) {
  const bundle = path.join(privateRoot, "fixture");
  await mkdir(bundle);
  await copyFile(fakeCursorLauncherSource, path.join(bundle, "cursor-agent"));
  await copyFile(fakeCursorPackageSource, path.join(bundle, "package.json"));
  await copyFile(process.execPath, path.join(bundle, "node"));
  await writeFile(path.join(bundle, "index.js"), transform(await readFile(fakeCursorImplementationSource, "utf8")));
  await chmod(path.join(bundle, "cursor-agent"), 0o755);
  await chmod(path.join(bundle, "node"), 0o755);
  return path.join(bundle, "cursor-agent");
}

test("Host termination cannot erase state while its Cursor process is still writing", { skip: process.platform === "win32" }, async () => {
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    const root = await createGitRepository();
    const privateRoot = await mkdtemp(path.join(os.tmpdir(), "relaypact-host-exit-test-"));
    let host, exit, executorPid;
    try {
      for (const name of ["state", "archive", "home", "runtime"]) await mkdir(path.join(privateRoot, name));
      const marker = path.join(privateRoot, "executor.json");
      const command = await nodeCursorFixture(privateRoot, source => source.replace("  setInterval(() => {}, 1000);", [
        "  let tick = 0; write('allowed.txt', String(tick));",
        `  writeFileSync(${JSON.stringify(marker)}, JSON.stringify({pid: process.pid}));`,
        "  setInterval(() => write('allowed.txt', String(++tick)), 40);",
        "  setTimeout(() => process.exit(0), 20000);"
      ].join("\n")));
      const envelope = makeEnvelope(root, { taskId: "cursor-hang", execution: { timeoutMs: 60_000 } });
      const moduleUrl = new URL("../packages/adapter-codex-cursor/src/run-delegation.mjs", import.meta.url).href;
      const options = { executorCommand: command, stateRoot: path.join(privateRoot, "state"), hostInstanceId: "fixture-host" };
      host = spawn(process.execPath, ["--input-type=module", "-e", `import {runDelegation} from ${JSON.stringify(moduleUrl)}; await runDelegation(${JSON.stringify(envelope)}, ${JSON.stringify(options)});`], {
        stdio: "ignore", env: { PATH: process.env.PATH, HOME: path.join(privateRoot, "home"), TMPDIR: path.join(privateRoot, "runtime") }
      });
      exit = once(host, "exit");
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const info = await readFile(marker, "utf8").catch(() => null);
        if (info) { executorPid = JSON.parse(info).pid; break; }
        await delay(30);
      }
      assert.ok(executorPid, "The offline Cursor fixture must reach active execution");
      const taskName = (await readdir(options.stateRoot)).find(name => name.startsWith("task-"));
      const taskRoot = path.join(options.stateRoot, taskName);
      const archiveRoot = path.join(privateRoot, "archive");
      await assert.rejects(decideDelegation(taskRoot, "abandon", "other-host", archiveRoot), error => error.code === "task_state_busy");
      host.kill(signal); await exit;
      assert.ok(alive(executorPid));
      for (const failureTransition of [false, true]) {
        if (failureTransition) await failDirectDelegation(await loadDirectDelegation(taskRoot));
        await assert.rejects(decideDelegation(taskRoot, "abandon", "other-host", archiveRoot), error => error.code === "execution_stop_unverified");
        await access(path.join(taskRoot, "state.json"));
        assert.deepEqual(await readdir(archiveRoot), []);
      }
      const before = await readFile(path.join(root, "allowed.txt"), "utf8");
      const heartbeatDeadline = Date.now() + 5_000;
      let after = before;
      while (Date.now() < heartbeatDeadline) {
        await delay(30);
        after = await readFile(path.join(root, "allowed.txt"), "utf8");
        if (after.length > 0 && after !== before) break;
      }
      assert.ok(after.length > 0 && after !== before, "The orphan fixture must continue writing after abandonment is refused");
    } finally {
      if (host && host.exitCode === null && host.signalCode === null) { host.kill("SIGKILL"); await exit; }
      if (executorPid && alive(executorPid)) {
        try { process.kill(-executorPid, "SIGKILL"); } catch { try { process.kill(executorPid, "SIGKILL"); } catch {} }
      }
      for (let i = 0; executorPid && alive(executorPid) && i < 50; i++) await delay(20);
      // Linux may retain an already-dead adopted zombie briefly.
      if (executorPid && alive(executorPid)) {
        const { stdout } = await execFileAsync("ps", ["-o", "stat=", "-p", String(executorPid)]);
        assert.match(stdout.trim(), /^Z/u);
      }
      await rm(root, { recursive: true, force: true });
      await rm(privateRoot, { recursive: true, force: true });
    }
  }
});

test("Cursor correction retains an unchanged ignored artifact from its first attempt", async () => {
  const root = await createGitRepository();
  const privateRoot = await mkdtemp(path.join(os.tmpdir(), "relaypact-ignored-correction-"));
  try {
    await writeFile(path.join(root, ".gitignore"), "ignored.txt\n");
    execFileSync("git", ["add", ".gitignore"], { cwd: root });
    execFileSync("git", ["commit", "-m", "test: ignored baseline"], { cwd: root, stdio: "ignore" });
    for (const name of ["state", "archive"]) await mkdir(path.join(privateRoot, name));
    const command = await nodeCursorFixture(privateRoot, source => source.replace(
      '  write("allowed.txt", correction ? "corrected cursor lifecycle edit\\n" : "initial cursor lifecycle edit\\n");',
      '  if (!correction) write("ignored.txt", "first attempt artifact\\n");\n  write("allowed.txt", correction ? "corrected cursor lifecycle edit\\n" : "initial cursor lifecycle edit\\n");'
    ));
    const first = await runDelegation(makeEnvelope(root, { taskId: "cursor-lifecycle", scope: { allowedPaths: ["allowed.txt", "ignored.txt"] } }), {
      executorCommand: command, stateRoot: path.join(privateRoot, "state"), hostInstanceId: "fixture-host"
    });
    assert.equal(first.review.executionResult.hostAcceptance.eligible, true);
    assert.deepEqual(first.review.executionResult.changedPaths, ["allowed.txt", "ignored.txt"]);
    for (let i = 0; i < 2; i++) {
      const corrected = await correctDelegation(first.taskRoot, "Change allowed.txt while preserving ignored.txt.");
      assert.equal(corrected.review.executionResult.status, "completed");
      assert.equal(corrected.review.executionResult.hostAcceptance.eligible, true);
      assert.deepEqual(corrected.review.executionResult.changedPaths, ["allowed.txt", "ignored.txt"]);
    }
    assert.equal(await readFile(path.join(root, "ignored.txt"), "utf8"), "first attempt artifact\n");
    const accepted = await decideDelegation(first.taskRoot, "accept", "fixture-host", path.join(privateRoot, "archive"));
    assert.equal(accepted.lifecycleState, "accepted");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(privateRoot, { recursive: true, force: true });
  }
});
const execute = (root, scenario, options = {}) => runDelegation(makeEnvelope(root, {
  taskId: `cursor-${scenario}`
}), { executorCommand: fakeCursor, ...options });

test("Cursor route completes bounded work but leaves host acceptance pending", async () => {
  const root = await createGitRepository();
  const result = await execute(root, "success");
  assert.equal(result.status, "completed");
  assert.deepEqual(result.changedPaths, ["allowed.txt"]);
  assert.equal(result.scope.compliant, true);
  assert.equal(result.validations[0].status, "passed");
  assert.deepEqual(result.hostAcceptance, { status: "pending", eligible: true, decidedBy: null });
  assert.equal(result.executor.modelObservation.value, "fixture-cursor-model");
  assert.equal(result.executor.modelObservation.assurance, "reported");
  assert.ok(result.residualRisks.some((item) => item.includes("harness-owned")));
});

test("Cursor route reports unavailable model observation without inventing a model", async () => {
  const root = await createGitRepository();
  const result = await execute(root, "model-unavailable");
  assert.equal(result.status, "completed");
  assert.deepEqual(result.executor.modelObservation, {
    state: "unavailable",
    value: null,
    source: "unavailable",
    assurance: "unknown",
    observedAt: result.executor.modelObservation.observedAt
  });
});

test("Cursor Auto model observation remains a harness-managed selector alias", async () => {
  const root = await createGitRepository();
  const result = await execute(root, "model-auto");
  assert.equal(result.status, "completed");
  assert.equal(result.executor.modelObservation.state, "harness_managed");
  assert.equal(result.executor.modelObservation.value, "Auto");
  assert.equal(result.executor.modelObservation.assurance, "selector_alias");
});

test("Cursor read-only route uses plan mode and does not grant force", async () => {
  const root = await createGitRepository();
  const envelope = makeEnvelope(root, {
    taskId: "cursor-read-only",
    scope: { allowedPaths: [], readablePaths: ["README.md"] },
    validation: []
  });
  let launchArgs;
  const result = await runDelegation(envelope, {
    readiness: {
      state: "ready",
      command: "cursor-agent",
      version: "2026.08.31-test",
      authenticated: true,
      structuredOutput: true,
      capabilities: { boundedWorkspace: true, sandbox: true, force: true, resume: true }
    },
    async runProcess(_command, args) {
      launchArgs = args;
      return {
        exitCode: 0, signal: null, timedOut: false, cancelled: false,
        stdoutTruncated: false, stderrTruncated: false,
        stdout: `${JSON.stringify({
          type: "result", subtype: "success", is_error: false,
          result: JSON.stringify({ status: "completed", summary: "read-only review complete" })
        })}\n`,
        stderr: ""
      };
    }
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(result.changedPaths, []);
  assert.deepEqual(launchArgs.slice(launchArgs.indexOf("--mode"), launchArgs.indexOf("--mode") + 2), ["--mode", "plan"]);
  assert(!launchArgs.includes("--force"));
});

test("explicit Cursor read-only mode rejects repository validation before launch", async () => {
  const root = await createGitRepository();
  let launched = false;
  await assert.rejects(runDelegation(makeEnvelope(root), {
    executorCommand: fakeCursor,
    readOnly: true,
    runProcess: async () => {
      launched = true;
      throw new Error("must not launch");
    }
  }), { code: "read_only_validation_unsupported" });
  assert.equal(launched, false);
  await rm(root, { recursive: true, force: true });
});

test("persistent Cursor rejects read-only validation before creating lifecycle state", async (t) => {
  const root = await createGitRepository();
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "relaypact-cursor-read-only-preflight-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  await assert.rejects(runDelegation(makeEnvelope(root, {
    scope: { allowedPaths: [], readablePaths: ["README.md"] }
  }), {
    executorCommand: fakeCursor,
    stateRoot,
    hostInstanceId: "cursor-host-1"
  }), { code: "read_only_validation_unsupported" });
  assert.deepEqual(await readdir(stateRoot), []);
});

test("persistent Cursor read-only evidence preserves an acknowledged dirty baseline", async (t) => {
  const root = await createGitRepository();
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "relaypact-cursor-read-only-baseline-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  await writeFile(path.join(root, "README.md"), "acknowledged local work\n");
  const result = await runDelegation(makeEnvelope(root, {
    taskId: "cursor-read-only",
    repository: { dirtyTree: { allow: true, acknowledgedPaths: ["README.md"] } },
    scope: { allowedPaths: [], readablePaths: ["README.md"] },
    validation: []
  }), {
    executorCommand: fakeCursor,
    stateRoot,
    hostInstanceId: "cursor-host-1"
  });
  assert.equal(result.review.executionResult.status, "completed");
  assert.deepEqual(result.review.executionResult.changedPaths, []);
  assert.deepEqual(result.review.executionResult.scope.breaches, []);
});

test("Cursor out-of-scope edits are independently rejected", async () => {
  const root = await createGitRepository();
  const result = await execute(root, "breach");
  assert.equal(result.status, "rejected");
  assert.deepEqual(result.scope.breaches, ["private.txt"]);
  assert.equal(result.validations[0].reason, "scope_breach");
  assert.equal(result.hostAcceptance.eligible, false);
});

test("Cursor Git-control mutation is independently rejected", async () => {
  const root = await createGitRepository();
  const result = await execute(root, "git-control");
  assert.equal(result.status, "rejected");
  assert.ok(result.scope.breaches.includes("git:metadata changed during delegated execution"));
});

test("Cursor receives a minimized environment without ambient credentials", async () => {
  const root = await createGitRepository();
  const emptyHome = await createDirectory();
  const result = await execute(root, "environment", {
    environment: { PATH: process.env.PATH, HOME: emptyHome, HOST_SECRET: "ambient-secret-must-not-cross" }
  });
  assert.equal(result.status, "completed");
  assert.doesNotMatch(JSON.stringify(result), /ambient-secret-must-not-cross/u);
});

test("Cursor bundle bootstrap ignores poisoned PATH helpers but preserves task tool PATH", async () => {
  const root = await createGitRepository();
  const poisonRoot = await mkdtemp(path.join(os.tmpdir(), "relaypact-cursor-path-poison-"));
  const poisonedMarkers = ["node", "realpath", "dirname", "basename", "readlink"]
    .map((name) => path.join(poisonRoot, `${name}.executed`));
  try {
    await Promise.all(["node", "realpath", "dirname", "basename", "readlink"].map(async (name) => {
      const executable = path.join(poisonRoot, name);
      await writeFile(executable, `#!/bin/sh\nprintf poisoned > ${JSON.stringify(path.join(poisonRoot, `${name}.executed`))}\nexit 97\n`);
      await chmod(executable, 0o755);
    }));
    const taskTool = path.join(poisonRoot, "cursor-user-tool");
    await writeFile(taskTool, "#!/bin/sh\nprintf available\n");
    await chmod(taskTool, 0o755);

    const result = await execute(root, "path-tool", {
      environment: { ...process.env, PATH: `${poisonRoot}:${process.env.PATH}` }
    });
    assert.equal(result.status, "completed");
    for (const marker of poisonedMarkers) {
      await assert.rejects(access(marker), (error) => error.code === "ENOENT");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(poisonRoot, { recursive: true, force: true });
  }
});

test("Cursor direct launch profile preserves runtime flags and invocation identity", async () => {
  const root = await createGitRepository();
  const result = await execute(root, "launch-profile");
  assert.equal(result.status, "completed");
  assert.equal(result.executor.summary, "Direct launch profile preserved.");
});

test("Cursor execution timeout is bounded and normalized", async () => {
  const root = await createGitRepository();
  const result = await runExecutor(makeEnvelope(root, {
    taskId: "cursor-hang",
    execution: { timeoutMs: 50 }
  }), {
    executorCommand: fakeCursor,
    workingDirectory: root
  });
  assert.equal(result.reportedStatus, "failed");
  assert.equal(result.timedOut, true);
  assert.match(result.summary, /timed out/i);
});

test("Cursor execution reserves a bounded event-stream capture budget", async () => {
  const root = await createGitRepository();
  let captureBytes = null;
  const result = await runExecutor(makeEnvelope(root, { taskId: "cursor-capture-budget" }), {
    readiness: {
      state: "ready",
      command: "cursor-agent",
      version: "2026.08.31-test",
      authenticated: true,
      structuredOutput: true,
      capabilities: { boundedWorkspace: true, sandbox: true, force: true, resume: true }
    },
    workingDirectory: root,
    async runProcess(_command, _args, options) {
      captureBytes = options.maxCaptureBytes;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        cancelled: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdout: `${JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: JSON.stringify({ status: "completed", summary: "review complete" })
        })}\n`,
        stderr: ""
      };
    }
  });
  assert.equal(captureBytes, 8 * 1024 * 1024);
  assert.equal(result.reportedStatus, "completed");
});

test("Cursor blocked and malformed terminal results remain ineligible", async () => {
  for (const [scenario, expected] of [
    ["blocked", "blocked"],
    ["malformed", "failed"],
    ["duplicate-terminal", "failed"],
    ["terminal-failure", "failed"],
    ["process-failure", "failed"]
  ]) {
    const root = await createGitRepository();
    const result = await execute(root, scenario);
    assert.equal(result.status, expected);
    assert.equal(result.hostAcceptance.eligible, false);
  }
});

test("Cursor accepts one formatted structured payload but rejects conflicting candidates", async () => {
  const root = await createGitRepository();
  try {
    const formatted = await execute(root, "formatted-result");
    assert.equal(formatted.status, "completed");
    assert.equal(formatted.executor.summary, "Formatted structured result.");

    const conflicting = await execute(root, "conflicting-formatted-result");
    assert.equal(conflicting.status, "failed");
    assert.equal(conflicting.executor.reportedStatus, "malformed");
    assert.equal(conflicting.hostAcceptance.eligible, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unavailable selected Cursor executable fails closed without harness fallback", async () => {
  const calls = [];
  const readiness = await discoverCursorCli({
    executorCommand: "selected-cursor",
    runProcess(command) {
      calls.push(command);
      throw new Error("missing");
    }
  });
  assert.equal(readiness.state, "blocked");
  assert.deepEqual(calls, []);
});

test("Cursor readiness refuses a CLI that lacks read-only mode support", async () => {
  const calls = [];
  const readiness = await discoverCursorCli({
    executorCommand: "selected-cursor",
    resolveExecutable: async () => ({
      command: "/resolved/selected-cursor",
      launchCommand: "/resolved/selected-cursor",
      launchPrefix: [],
      launcherFingerprint: `sha256:${"1".repeat(64)}`,
      launchCommandFingerprint: `sha256:${"1".repeat(64)}`,
      bundleRoot: null,
      bundleFingerprint: null,
      fingerprint: `sha256:${"0".repeat(64)}`
    }),
    async runProcess(_command, args) {
      calls.push(args);
      if (args.includes("--version")) {
        return { exitCode: 0, signal: null, stdout: "cursor-agent 2026.08.31-test", stderr: "" };
      }
      return {
        exitCode: 0,
        signal: null,
        stdout: "--print --output-format --workspace --sandbox --resume --force --trust",
        stderr: ""
      };
    }
  });
  assert.equal(readiness.state, "blocked");
  assert.deepEqual(calls, [
    ["--version"],
    ["--help"]
  ]);
});

test("Cursor readiness refuses a CLI that lacks trust support", async () => {
  const readiness = await discoverCursorCli({
    executorCommand: "selected-cursor",
    resolveExecutable: async () => ({
      command: "/resolved/selected-cursor",
      launchCommand: "/resolved/selected-cursor",
      launchPrefix: [],
      launcherFingerprint: `sha256:${"1".repeat(64)}`,
      launchCommandFingerprint: `sha256:${"1".repeat(64)}`,
      bundleRoot: null,
      bundleFingerprint: null,
      fingerprint: `sha256:${"0".repeat(64)}`
    }),
    async runProcess(_command, args) {
      if (args.includes("--version")) {
        return { exitCode: 0, signal: null, stdout: "cursor-agent 2026.08.31-test", stderr: "" };
      }
      return {
        exitCode: 0,
        signal: null,
        stdout: "--print --output-format --workspace --sandbox --resume --force --mode",
        stderr: ""
      };
    }
  });
  assert.equal(readiness.state, "blocked");
});

test("Cursor readiness refuses a user-mutable shebang interpreter", async () => {
  const privateRoot = await mkdtemp(path.join(os.tmpdir(), "relaypact-cursor-unpinned-shell-"));
  const interpreter = path.join(privateRoot, "bash");
  const launcher = path.join(privateRoot, "cursor-agent");
  try {
    await copyFile("/bin/bash", interpreter);
    await writeFile(launcher, `#!${interpreter}\nexit 0\n`);
    await Promise.all([chmod(interpreter, 0o755), chmod(launcher, 0o755)]);
    assert.equal(await resolveCursorExecutable(launcher), null);
  } finally {
    await rm(privateRoot, { recursive: true, force: true });
  }
});

test("Cursor session identity is private, digestible, and explicitly resumable", async () => {
  const root = await createGitRepository();
  const first = await runExecutor(makeEnvelope(root, { taskId: "cursor-model-unavailable" }), {
    executorCommand: fakeCursor,
    workingDirectory: root
  });
  const evidence = cursorSessionEvidence(first);
  assert.equal(evidence.resumable, true);
  assert.match(evidence.digest, /^sha256:[a-f0-9]{64}$/u);
  assert.doesNotMatch(JSON.stringify(first), /fixture-cursor-session/u);

  const resumed = await runExecutor(makeEnvelope(root, { taskId: "cursor-resume" }), {
    executorCommand: fakeCursor,
    workingDirectory: root,
    resumeSessionId: assertCursorResumeSession(first)
  });
  assert.equal(resumed.reportedStatus, "completed");
});

test("Cursor execution responds to host cancellation", async () => {
  const root = await createGitRepository();
  const controller = new AbortController();
  const execution = runExecutor(makeEnvelope(root, {
    taskId: "cursor-hang",
    execution: { timeoutMs: 10_000 }
  }), {
    executorCommand: fakeCursor,
    workingDirectory: root,
    signal: controller.signal
  });
  setTimeout(() => controller.abort(), 100);
  const result = await execution;
  assert.equal(result.reportedStatus, "failed");
  assert.equal(result.cancelled, true);
  assert.match(result.summary, /cancelled/i);
});

test("Cursor readiness forwards host cancellation and stops later probes", async () => {
  const root = await createGitRepository();
  const controller = new AbortController();
  const calls = [];
  const identity = {
    command: "/resolved/selected-cursor",
    launchCommand: "/resolved/selected-cursor",
    launchPrefix: [],
    launcherFingerprint: `sha256:${"1".repeat(64)}`,
    launchCommandFingerprint: `sha256:${"1".repeat(64)}`,
    bundleRoot: null,
    bundleFingerprint: null,
    fingerprint: `sha256:${"0".repeat(64)}`
  };
  try {
    const result = await runExecutor(makeEnvelope(root, { taskId: "cursor-cancel-readiness" }), {
      executorCommand: "selected-cursor",
      workingDirectory: root,
      signal: controller.signal,
      resolveExecutable: async () => identity,
      async runProcess(_command, args, options) {
        calls.push(args);
        assert.equal(options.signal, controller.signal);
        controller.abort();
        return {
          exitCode: null,
          signal: "SIGTERM",
          stdout: "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          timedOut: false,
          cancelled: true
        };
      }
    });
    assert.deepEqual(calls, [["--version"]]);
    assert.equal(result.reportedStatus, "failed");
    assert.equal(result.cancelled, true);
    assert.match(result.summary, /readiness was cancelled/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Cursor readiness does not publish ready after cancellation during final identity verification", async () => {
  const controller = new AbortController();
  const identity = {
    command: "/resolved/selected-cursor",
    launchCommand: "/resolved/selected-cursor",
    launchPrefix: [],
    launcherFingerprint: `sha256:${"1".repeat(64)}`,
    launchCommandFingerprint: `sha256:${"1".repeat(64)}`,
    bundleRoot: null,
    bundleFingerprint: null,
    fingerprint: `sha256:${"0".repeat(64)}`
  };
  let resolutions = 0;
  const readiness = await discoverCursorCli({
    executorCommand: "selected-cursor",
    signal: controller.signal,
    async resolveExecutable() {
      resolutions += 1;
      if (resolutions === 2) controller.abort();
      return identity;
    },
    async runProcess(_command, args, options) {
      assert.equal(options.signal, controller.signal);
      const output = args.includes("--version")
        ? "cursor-agent 2026.08.31-test"
        : args.includes("--help")
          ? "--print --output-format --workspace --sandbox --resume --force --mode --trust"
          : "Authenticated";
      return {
        exitCode: 0,
        signal: null,
        stdout: output,
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        timedOut: false,
        cancelled: false
      };
    }
  });
  assert.equal(resolutions, 2);
  assert.equal(readiness.state, "interrupted");
});

test("cancelling a cold embedded-runtime probe stops readiness without caching cancellation", async () => {
  const privateRoot = await mkdtemp(path.join(os.tmpdir(), "relaypact-probe-abort-"));
  const controller = new AbortController();
  try {
    const command = await nodeCursorFixture(privateRoot, source => source);
    // A distinct fingerprint ensures this exercises the cold runtime probe.
    await writeFile(command, `${await readFile(command, "utf8")}\n# cancellation fixture\n`);
    const calls = [];
    const interrupted = await discoverCursorCli({
      executorCommand: command,
      signal: controller.signal,
      async runProcess(_command, args, options) {
        calls.push(args);
        assert.equal(options.signal, controller.signal);
        assert.deepEqual(args, ["--use-system-ca", "--version"]);
        controller.abort();
        return { exitCode: null, signal: "SIGTERM", cancelled: true, stdout: "", stderr: "" };
      }
    });
    assert.equal(interrupted.state, "interrupted");
    assert.equal(calls.length, 1);
    let retried = 0;
    const identity = await resolveCursorExecutable(command, {
      async runProcess(_command, args) {
        assert.deepEqual(args, ["--use-system-ca", "--version"]);
        retried++;
        return { exitCode: 0, signal: null, stdout: process.version, stderr: "" };
      }
    });
    assert.equal(retried, 1);
    assert.deepEqual(identity.runtimeArguments, ["--use-system-ca"]);
    const cancelled = new AbortController(); cancelled.abort();
    assert.equal(await resolveCursorExecutable(command, { signal: cancelled.signal }), null);
  } finally {
    await rm(privateRoot, { recursive: true, force: true });
  }
});

test("Cursor uses the long print flag admitted by readiness without requiring its short alias", async () => {
  const root = await createGitRepository();
  const privateRoot = await mkdtemp(path.join(os.tmpdir(), "relaypact-print-contract-"));
  try {
    const command = await nodeCursorFixture(privateRoot, source => source.replace(
      'const prompt = process.argv.at(-1) ?? "";',
      'if (process.argv.includes("-p") || !process.argv.includes("--print")) process.exit(64);\nconst prompt = process.argv.at(-1) ?? "";'
    ));
    assert.equal((await discoverCursorCli({ executorCommand: command })).state, "ready");
    const result = await runDelegation(makeEnvelope(root, { taskId: "cursor-success" }), { executorCommand: command });
    assert.equal(result.status, "completed");
    assert.deepEqual(result.changedPaths, ["allowed.txt"]);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(privateRoot, { recursive: true, force: true });
  }
});

test("Host cancellation reaches validation and prevents later validation launches", async () => {
  const root = await createGitRepository();
  const controller = new AbortController();
  let calls = 0;
  const result = await runDelegation(makeEnvelope(root, {
    taskId: "cursor-success",
    validation: [
      { id: "cancelled", argv: [process.execPath, "-e", "process.exit(0)"] },
      { id: "must-not-start", argv: [process.execPath, "-e", "process.exit(0)"] }
    ]
  }), {
    executorCommand: fakeCursor,
    signal: controller.signal,
    async validationProcess(_command, _args, options) {
      calls += 1;
      assert.equal(options.signal, controller.signal);
      controller.abort();
      return {
        exitCode: null,
        signal: "SIGTERM",
        stdout: "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        timedOut: false,
        cancelled: true
      };
    }
  });
  assert.equal(calls, 1);
  assert.deepEqual(result.validations.map(({ id, status, reason }) => ({ id, status, reason })), [
    { id: "cancelled", status: "failed", reason: "cancelled" },
    { id: "must-not-start", status: "not_run", reason: "cancelled" }
  ]);
});

test("Cursor readiness is privacy-safe and does not invoke a model", async () => {
  const readiness = await discoverCursorCli({ executorCommand: fakeCursor });
  assert.equal(readiness.state, "ready");
  assert.equal(readiness.authenticated, true);
  assert.equal(readiness.version, "2026.08.25-3e8eec8");
  assert.equal(Object.hasOwn(readiness, "account"), false);
});

test("CLI exposes only explicit Cursor execution and diagnostics", async () => {
  const root = await createGitRepository();
  const envelope = path.join(root, "..", `cursor-envelope-${path.basename(root)}.json`);
  await writeFile(envelope, JSON.stringify(makeEnvelope(root, { taskId: "cursor-success" })));
  const execution = await execFileAsync(process.execPath, [cli, "run-cursor", "--envelope", envelope, "--executor", fakeCursor]);
  const result = JSON.parse(execution.stdout);
  assert.equal(result.status, "completed");
  assert.equal(result.hostAcceptance.status, "pending");

  const diagnostic = await execFileAsync(process.execPath, [cli, "doctor", "--route", "codex-cursor", "--executor", fakeCursor]);
  const doctor = JSON.parse(diagnostic.stdout);
  assert.equal(doctor.state, "ready");
  assert.equal(doctor.route, "codex-cursor");
  assert.equal(doctor.executor.command, "cursor CLI");
  assert.doesNotMatch(diagnostic.stdout, /fixture-cursor-session/u);
});

test("CLI exposes explicit persistent Cursor run, correction, and terminal decision", async () => {
  const root = await createGitRepository();
  const privateRoot = await mkdtemp(path.join(os.tmpdir(), "relaypact-cursor-cli-lifecycle-"));
  const stateRoot = path.join(privateRoot, "state");
  const archiveRoot = path.join(privateRoot, "archive");
  const envelopePath = path.join(privateRoot, "envelope.json");
  const promptPath = path.join(privateRoot, "correction.txt");
  await Promise.all([
    mkdir(stateRoot),
    mkdir(archiveRoot),
    writeFile(envelopePath, JSON.stringify(makeEnvelope(root, { taskId: "cursor-lifecycle" }))),
    writeFile(promptPath, "Use the corrected bounded content.")
  ]);
  try {
    const first = JSON.parse((await execFileAsync(process.execPath, [
      cli, "run-cursor", "--envelope", envelopePath, "--executor", fakeCursor,
      "--state-root", stateRoot, "--host-instance", "cursor-host-1"
    ])).stdout);
    assert.equal(first.review.lifecycleState, "awaiting_review");
    const corrected = JSON.parse((await execFileAsync(process.execPath, [
      cli, "correct-cursor", "--task-root", first.taskRoot, "--prompt", promptPath
    ])).stdout);
    assert.equal(corrected.review.correctionSequence, 1);
    const decided = JSON.parse((await execFileAsync(process.execPath, [
      cli, "decide-cursor", "--task-root", corrected.taskRoot, "--action", "accept",
      "--actor", "cursor-host-1", "--archive-root", archiveRoot
    ])).stdout);
    assert.equal(decided.acceptance.status, "accepted");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(privateRoot, { recursive: true, force: true });
  }
});

test("persistent Cursor CLI returns non-zero for a failed execution result", async () => {
  const root = await createGitRepository();
  const privateRoot = await mkdtemp(path.join(os.tmpdir(), "relaypact-cursor-cli-failure-"));
  const stateRoot = path.join(privateRoot, "state");
  const envelopePath = path.join(privateRoot, "envelope.json");
  await Promise.all([
    mkdir(stateRoot),
    writeFile(envelopePath, JSON.stringify(makeEnvelope(root, { taskId: "cursor-malformed" })))
  ]);
  try {
    await assert.rejects(
      execFileAsync(process.execPath, [
        cli, "run-cursor", "--envelope", envelopePath, "--executor", fakeCursor,
        "--state-root", stateRoot, "--host-instance", "cursor-host-1"
      ]),
      (error) => {
        assert.equal(error.code, 1);
        assert.equal(JSON.parse(error.stdout).review.executionResult.status, "failed");
        return true;
      }
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(privateRoot, { recursive: true, force: true });
  }
});

test("persistent Cursor correction preserves the original read-only authority", async () => {
  const root = await createGitRepository();
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "relaypact-cursor-read-only-state-"));
  try {
    const first = await runDelegation(makeEnvelope(root, {
      taskId: "cursor-read-only",
      scope: { allowedPaths: [], readablePaths: ["README.md"] },
      validation: []
    }), {
      executorCommand: fakeCursor,
      stateRoot,
      hostInstanceId: "cursor-host-1"
    });
    const loaded = await loadDirectDelegation(first.taskRoot, {
      routeId: "codex-cursor",
      executorHarness: "cursor"
    });
    assert.equal(loaded.state.executionMode, "read_only");

    const corrected = await correctDelegation(first.taskRoot, "Inspect again without granting write authority.");
    assert.equal(corrected.review.executionResult.status, "completed");
    assert.equal(corrected.review.correctionSequence, 1);
    assert.deepEqual(corrected.review.executionResult.changedPaths, []);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("Cursor persistent lifecycle resumes correction and archives an explicit terminal decision", async (context) => {
  const root = await createGitRepository();
  const privateRoot = await mkdtemp(path.join(os.tmpdir(), "relaypact-cursor-lifecycle-"));
  const stateRoot = path.join(privateRoot, "state");
  const archiveRoot = path.join(privateRoot, "archive");
  await Promise.all([mkdir(stateRoot), mkdir(archiveRoot)]);
  try {
    const first = await runDelegation(makeEnvelope(root, { taskId: "cursor-lifecycle" }), {
      executorCommand: fakeCursor,
      stateRoot,
      hostInstanceId: "cursor-host-1"
    });
    assert.equal(first.review.lifecycleState, "awaiting_review");
    assert.equal(first.review.executionResult.hostAcceptance.status, "pending");
    assert.doesNotMatch(JSON.stringify(first), /fixture-cursor-session/u);

    const corrected = await correctDelegation(first.taskRoot, "Replace the initial edit with the corrected content.", {
      executorCommand: fakeCursor
    });
    assert.equal(corrected.review.correctionSequence, 1);
    assert.equal(corrected.review.executionResult.hostAcceptance.eligible, true);
    assert.equal(await readFile(path.join(root, "allowed.txt"), "utf8"), "corrected cursor lifecycle edit\n");

    const decided = await decideDelegation(
      corrected.taskRoot,
      "accept",
      "cursor-host-1",
      archiveRoot
    );
    assert.equal(decided.lifecycleState, "accepted");
    assert.equal(decided.acceptance.status, "accepted");
    assert.doesNotMatch(await readFile(decided.archive.reviewPath, "utf8"), /fixture-cursor-session/u);
    await assert.rejects(access(corrected.taskRoot), (error) => error.code === "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(privateRoot, { recursive: true, force: true });
  }
  context.diagnostic("Cursor correction retained Auto/harness configuration ownership and resumed only the protected original session.");
});

test("persistent Cursor evidence never restores a validation secret embedded in a changed path", async () => {
  const root = await createGitRepository();
  const privateRoot = await mkdtemp(path.join(os.tmpdir(), "relaypact-cursor-sensitive-path-"));
  const stateRoot = path.join(privateRoot, "state");
  const archiveRoot = path.join(privateRoot, "archive");
  const secret = "validation-secret-path-value";
  await Promise.all([mkdir(stateRoot), mkdir(archiveRoot)]);
  try {
    const result = await runDelegation(makeEnvelope(root, {
      taskId: "cursor-formatted-result",
      scope: { allowedPaths: ["README.md", "*-artifact.txt"] },
      validation: [{
        id: "write-sensitive-path",
        argv: [
          process.execPath,
          "-e",
          "require('node:fs').writeFileSync(process.env.RELAYPACT_VALIDATION_SECRET + '-artifact.txt', 'fixture')"
        ]
      }]
    }), {
      executorCommand: fakeCursor,
      stateRoot,
      hostInstanceId: "cursor-host-1",
      validationEnv: { RELAYPACT_VALIDATION_SECRET: secret }
    });
    assert.equal(result.review.executionResult.status, "rejected");
    assert.deepEqual(result.review.executionResult.changedPaths, []);
    assert.ok(result.review.executionResult.scope.breaches.includes("evidence:credential value detected"));
    assert.ok(result.review.executionResult.scope.breaches.includes("evidence:persistent postflight path mismatch"));
    assert.doesNotMatch(JSON.stringify(result), new RegExp(secret, "u"));
    assert.doesNotMatch(await readFile(result.evidence.reviewPath, "utf8"), new RegExp(secret, "u"));

    await assert.rejects(correctDelegation(result.taskRoot, "Inspect again.", { executorCommand: fakeCursor }), error => error.code === "execution_context_mismatch");
    const corrected = await correctDelegation(result.taskRoot, "Inspect again.", {
      executorCommand: fakeCursor, validationEnv: { RELAYPACT_VALIDATION_SECRET: secret }
    });
    assert.equal(corrected.review.executionResult.hostAcceptance.eligible, false);
    assert.deepEqual(corrected.review.executionResult.changedPaths, []);
    assert.doesNotMatch(JSON.stringify(corrected), new RegExp(secret, "u"));
    assert.doesNotMatch(await readFile(corrected.evidence.reviewPath, "utf8"), new RegExp(secret, "u"));
    assert.doesNotMatch(await readFile(result.statePath, "utf8"), new RegExp(secret, "u"));
    const rejected = await decideDelegation(result.taskRoot, "reject", "cursor-host-1", archiveRoot);
    assert.doesNotMatch(await readFile(rejected.archive.reviewPath, "utf8"), new RegExp(secret, "u"));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(privateRoot, { recursive: true, force: true });
  }
});

test("neutral direct lifecycle errors map to the Cursor session contract at the adapter boundary", async () => {
  const root = await createGitRepository();
  const privateRoot = await mkdtemp(path.join(os.tmpdir(), "relaypact-cursor-neutral-session-"));
  const stateRoot = path.join(privateRoot, "state");
  const archiveRoot = path.join(privateRoot, "archive");
  await Promise.all([mkdir(stateRoot), mkdir(archiveRoot)]);
  try {
    const envelope = makeEnvelope(root, { taskId: "cursor-read-only", validation: [] });
    const executionResult = await runDelegation(envelope, { executorCommand: fakeCursor, readOnly: true });
    let prepared = await prepareDirectDelegation({
      envelope,
      stateRoot,
      hostInstanceId: "cursor-host-1",
      routeId: "codex-cursor",
      executorHarness: "cursor"
    });
    prepared = await beginDirectDelegation(prepared);
    const recorded = await recordDirectDelegationResult(prepared, executionResult);
    const loaded = await loadDirectDelegation(prepared.taskRoot, {
      routeId: "codex-cursor",
      executorHarness: "cursor"
    });
    assert.throws(
      () => requireDirectExecutorSession(loaded.state),
      (error) => error.code === "executor_session_unavailable"
    );
    await assert.rejects(
      correctDelegation(prepared.taskRoot, "Attempt a correction without a session."),
      (error) => error.code === "cursor_session_unavailable"
    );
    assert.equal(recorded.review.lifecycleState, "awaiting_review");
    await decideDelegation(prepared.taskRoot, "reject", "cursor-host-1", archiveRoot);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(privateRoot, { recursive: true, force: true });
  }
});

test("prepared tasks can be abandoned but unverified running or failed tasks retain state", async () => {
  for (const lifecycleState of ["prepared", "running"]) {
    const root = await createGitRepository();
    const privateRoot = await mkdtemp(path.join(os.tmpdir(), `relaypact-cursor-interrupted-${lifecycleState}-`));
    const stateRoot = path.join(privateRoot, "state");
    const archiveRoot = path.join(privateRoot, "archive");
    await Promise.all([mkdir(stateRoot), mkdir(archiveRoot)]);
    try {
      let prepared = await prepareDirectDelegation({
        envelope: makeEnvelope(root, { taskId: `cursor-interrupted-${lifecycleState}` }),
        stateRoot,
        hostInstanceId: "cursor-host-1",
        routeId: "codex-cursor",
        executorHarness: "cursor"
      });
      if (lifecycleState === "running") {
        prepared = await beginDirectDelegation(prepared);
        await assert.rejects(decideDelegation(prepared.taskRoot, "abandon", "cursor-host-1", archiveRoot), error => error.code === "execution_stop_unverified");
        await failDirectDelegation(prepared);
        await assert.rejects(decideDelegation(prepared.taskRoot, "abandon", "cursor-host-1", archiveRoot), error => error.code === "execution_stop_unverified");
        await access(prepared.statePath);
        assert.deepEqual(await readdir(archiveRoot), []);
        continue;
      }
      const abandoned = await decideDelegation(prepared.taskRoot, "abandon", "cursor-host-1", archiveRoot);
      assert.equal(abandoned.lifecycleState, "abandoned");
      const receipt = JSON.parse(await readFile(abandoned.archive.receiptPath, "utf8"));
      assert.equal(receipt.priorLifecycleState, lifecycleState);
      assert.equal(receipt.lifecycleState, "abandoned");
      await assert.rejects(access(prepared.taskRoot), (error) => error.code === "ENOENT");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(privateRoot, { recursive: true, force: true });
    }
  }
});

test("legacy completion gaps and restarted running attempts cannot inherit cleanup authority", async () => {
  const root = await createGitRepository();
  const privateRoot = await mkdtemp(path.join(os.tmpdir(), "relaypact-legacy-completion-"));
  const stateRoot = path.join(privateRoot, "state"), archiveRoot = path.join(privateRoot, "archive");
  await Promise.all([mkdir(stateRoot), mkdir(archiveRoot)]);
  try {
    const prepared = await beginDirectDelegation(await prepareDirectDelegation({
      envelope: makeEnvelope(root), stateRoot, hostInstanceId: "fixture-host",
      routeId: "codex-cursor", executorHarness: "cursor"
    }));
    // Create an authentic older-schema state with no execution-completion field.
    const store = createSignedStateStore(prepared.statePath, value => value);
    await store.withLock(async ({read, persist}) => {
      const state = await read(); delete state.executionSettled;
      await persist(state);
    });
    await assert.rejects(decideDelegation(prepared.taskRoot, "abandon", "other-host", archiveRoot), error => error.code === "execution_stop_unverified");
    // A Host can die after completion but before review persistence. A restarted
    // operation must invalidate that prior completion before invoking its work.
    await store.withLock(async ({read, persist}) => persist({...await read(), executionSettled: true}));
    const loaded = await loadDirectDelegation(prepared.taskRoot);
    await assert.rejects(executeDirectDelegation(loaded, async active => {
      assert.equal(active.state.executionSettled, false);
      assert.equal((await loadDirectDelegation(prepared.taskRoot)).state.executionSettled, false);
      throw new Error("fixture execution interrupted");
    }), /fixture execution interrupted/u);
    assert.equal((await loadDirectDelegation(prepared.taskRoot)).state.lifecycleState, "failed");
    await assert.rejects(decideDelegation(prepared.taskRoot, "abandon", "other-host", archiveRoot), error => error.code === "execution_stop_unverified");
    assert.deepEqual(await readdir(archiveRoot), []);
  } finally {
    await rm(root, {recursive: true, force: true});
    await rm(privateRoot, {recursive: true, force: true});
  }
});

test("an active direct execution lease refuses concurrent abandonment", async () => {
  const root = await createGitRepository();
  const privateRoot = await mkdtemp(path.join(os.tmpdir(), "relaypact-cursor-active-lease-"));
  const stateRoot = path.join(privateRoot, "state");
  const archiveRoot = path.join(privateRoot, "archive");
  await Promise.all([mkdir(stateRoot), mkdir(archiveRoot)]);
  let releaseExecution;
  try {
    const envelope = makeEnvelope(root, { taskId: "cursor-read-only", validation: [] });
    const executionResult = await runDelegation(envelope, { executorCommand: fakeCursor, readOnly: true });
    const prepared = await prepareDirectDelegation({
      envelope,
      stateRoot,
      hostInstanceId: "cursor-host-1",
      routeId: "codex-cursor",
      executorHarness: "cursor"
    });
    let executionStarted;
    const started = new Promise((resolve) => { executionStarted = resolve; });
    const release = new Promise((resolve) => { releaseExecution = resolve; });
    const active = executeDirectDelegation(prepared, async () => {
      executionStarted();
      await release;
      return { executionResult, session: {} };
    });
    await started;
    const running = await loadDirectDelegation(prepared.taskRoot, {
      routeId: "codex-cursor",
      executorHarness: "cursor"
    });
    assert.equal(running.state.lifecycleState, "running");
    await assert.rejects(
      decideDelegation(prepared.taskRoot, "abandon", "cursor-host-2", archiveRoot),
      (error) => error.code === "task_state_busy"
    );
    releaseExecution();
    const recorded = await active;
    assert.equal(recorded.review.lifecycleState, "awaiting_review");
    await decideDelegation(prepared.taskRoot, "reject", "cursor-host-1", archiveRoot);
  } finally {
    releaseExecution?.();
    await rm(root, { recursive: true, force: true });
    await rm(privateRoot, { recursive: true, force: true });
  }
});

test("Cursor terminal decision refuses candidate drift after persistent review", async () => {
  const root = await createGitRepository();
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "relaypact-cursor-state-"));
  const archiveRoot = await mkdtemp(path.join(os.tmpdir(), "relaypact-cursor-archive-"));
  try {
    const first = await runDelegation(makeEnvelope(root, { taskId: "cursor-lifecycle" }), {
      executorCommand: fakeCursor,
      stateRoot,
      hostInstanceId: "cursor-host-1"
    });
    await writeFile(path.join(root, "allowed.txt"), "changed after review\n");
    await assert.rejects(
      decideDelegation(first.taskRoot, "accept", "cursor-host-1", archiveRoot),
      (error) => error.code === "stale_review"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(stateRoot, { recursive: true, force: true });
    await rm(archiveRoot, { recursive: true, force: true });
  }
});

async function staleRetirementFixture(t, correction = false, seed) {
  const root = await createGitRepository(), stateRoot = await createDirectory(), archiveRoot = await createDirectory();
  t.after(async () => { for (const directory of [root, stateRoot, archiveRoot]) await rm(directory, { recursive: true, force: true }); });
  await seed?.(root);
  const first = await runDelegation(makeEnvelope(root, { taskId: "cursor-read-only", scope: { allowedPaths: [] }, validation: [] }), {
    executorCommand: fakeCursor, stateRoot, hostInstanceId: "host"
  });
  if (correction) {
    const corrected = await correctDelegation(first.taskRoot, "Complete the same read-only review.");
    first.evidence = corrected.evidence;
  }
  const prepared = await loadDirectDelegation(first.taskRoot);
  const originalReview = JSON.parse(await readFile(first.evidence.reviewPath, "utf8"));
  await writeFile(path.join(root, "host-doc.md"), "authorized Host documentation edit\n");
  return { root, stateRoot, archiveRoot, first, prepared, originalReview };
}

test("stale review retirement explicitly abandons a corrected task without accepting, refreshing or reverting evidence", async (t) => {
  const { root, archiveRoot, first, prepared, originalReview } = await staleRetirementFixture(t, true);
  assert.equal(originalReview.correctionSequence, 1);
  for (const action of ["accept", "reject", "abandon"]) {
    await assert.rejects(decideDelegation(first.taskRoot, action, "host", archiveRoot), { code: "stale_review" });
  }
  await assert.rejects(authorizeDirectCorrection(prepared, "Review again."), { code: "stale_review" });
  const before = await snapshotFilesystem(root, { exclude: [".git"] });
  const controls = await snapshotGitControls(root, { excludeIndexes: true }), index = await snapshotGitIndex(root);
  const args = [cli, "decide-cursor", "--task-root", first.taskRoot, "--action", "abandon", "--actor", "host", "--archive-root", archiveRoot, "--retire-stale-review"];
  const result = JSON.parse((await execFileAsync(process.execPath, args)).stdout);
  assert.equal(result.lifecycleState, "abandoned");
  assert.deepEqual(result.acceptance, { status: "abandoned", eligible: false, decidedBy: "host" });
  const archived = JSON.parse(await readFile(result.archive.reviewPath, "utf8"));
  assert.deepEqual(archived.staleReviewRetirement.originalReview, originalReview);
  assert.equal(archived.staleReviewRetirement.reason, "filesystem_changed_after_review");
  assert.equal(archived.staleReviewRetirement.observedFilesystemFingerprint, before.fingerprint);
  assert.equal(archived.staleReviewRetirement.reviewedFilesystemFingerprint, prepared.state.reviewFilesystemFingerprint);
  assert.notEqual(before.fingerprint, prepared.state.reviewFilesystemFingerprint);
  assert.doesNotMatch(JSON.stringify(archived), /fixture-cursor-session/u);
  assert.equal((await snapshotFilesystem(root, { exclude: [".git"] })).fingerprint, before.fingerprint);
  assert.equal((await snapshotGitControls(root, { excludeIndexes: true })).fingerprint, controls.fingerprint);
  assert.equal((await snapshotGitIndex(root)).fingerprint, index.fingerprint);
  assert.equal(await readFile(path.join(root, "host-doc.md"), "utf8"), "authorized Host documentation edit\n");
  await assert.rejects(access(first.taskRoot), { code: "ENOENT" });
  assert.deepEqual(JSON.parse((await execFileAsync(process.execPath, args)).stdout), result);
});

for (const hazard of ["accept", "reject", "unchanged", "unsettled", "legacy", "signature", "review", "task-root", "archive", "archive-symlink", "index", "git-control", "HEAD", "branch", "live-lock"]) {
  test(`stale review retirement refuses ${hazard}`, async (t) => {
    const { root, stateRoot, archiveRoot, first, prepared } = await staleRetirementFixture(t);
    let targetArchive = archiveRoot;
    const signedStore = createSignedStateStore(first.statePath, () => {});
    const codes = {
      accept: "invalid_host_action", reject: "invalid_host_action", unchanged: "stale_review_required",
      unsettled: "execution_stop_unverified", legacy: "execution_stop_unverified", signature: "task_state_unavailable",
      review: "review_identity_mismatch", "task-root": "task_state_mismatch", archive: "invalid_archive_root",
      "archive-symlink": "invalid_archive_root",
      index: "stale_review", "git-control": "stale_review", HEAD: "stale_review", branch: "stale_review", "live-lock": "task_state_busy"
    };
    if (hazard === "unchanged") await rm(path.join(root, "host-doc.md"));
    if (["unsettled", "legacy"].includes(hazard)) {
      const state = { ...prepared.state, executionSettled: false };
      if (hazard === "legacy") delete state.executionSettled;
      await signedStore.persist(state);
    }
    if (hazard === "signature") await writeFile(first.statePath, JSON.stringify({ ...prepared.state, hostInstanceId: "forged" }));
    if (hazard === "review") {
      const review = JSON.parse(await readFile(first.evidence.reviewPath, "utf8"));
      review.executionResult.summary = "forged";
      await writeFile(first.evidence.reviewPath, JSON.stringify(review));
    }
    if (hazard === "task-root") {
      await rename(first.taskRoot, first.taskRoot + "-original"); await mkdir(first.taskRoot);
      for (const file of ["state.json", "task-envelope.json", "initial-filesystem.json"]) await copyFile(path.join(first.taskRoot + "-original", file), path.join(first.taskRoot, file));
    }
    if (hazard === "archive") targetArchive = root;
    if (hazard === "archive-symlink") { targetArchive = path.join(stateRoot, "archive-link"); await symlink(archiveRoot, targetArchive); }
    if (hazard === "index") execFileSync("git", ["add", "host-doc.md"], { cwd: root });
    if (hazard === "git-control") execFileSync("git", ["config", "test.retirement", "changed"], { cwd: root });
    if (hazard === "HEAD") execFileSync("git", ["commit", "--allow-empty", "-m", "external commit"], { cwd: root, stdio: "ignore" });
    if (hazard === "branch") execFileSync("git", ["switch", "-c", "external-branch"], { cwd: root, stdio: "ignore" });
    const decision = () => decideDelegation(first.taskRoot, ["accept", "reject"].includes(hazard) ? hazard : "abandon", "host", targetArchive, { retireStaleReview: true });
    if (hazard === "live-lock") await signedStore.withLock(async () => assert.rejects(decision(), { code: codes[hazard] }));
    else await assert.rejects(decision(), { code: codes[hazard] });
    assert.deepEqual(await readdir(archiveRoot), []);
    await access(first.taskRoot);
  });
}

for (const phase of ["beforeFinalBasisCheck", "afterTerminalStateCommit"]) {
  test(`stale review retirement refuses further drift at ${phase} and remains retryable`, async (t) => {
    const { root, archiveRoot, first, prepared } = await staleRetirementFixture(t);
    await assert.rejects(finalizeDirectTerminalDecision(prepared, "abandon", "host", archiveRoot, {
      retireStaleReview: true,
      [phase]: () => writeFile(path.join(root, "host-doc.md"), "additional edit\n")
    }), { code: "stale_review" });
    assert.equal((await loadDirectDelegation(first.taskRoot)).state.lifecycleState, "awaiting_review");
    assert.deepEqual(await readdir(archiveRoot), []);
    const result = await decideDelegation(first.taskRoot, "abandon", "host", archiveRoot, { retireStaleReview: true });
    assert.equal(result.lifecycleState, "abandoned");
    assert.equal(await readFile(path.join(root, "host-doc.md"), "utf8"), "additional edit\n");
  });
}

test("stale review retirement partial cleanup verifies archive, actor and directory on retry", async (t) => {
  const { root, archiveRoot, first, prepared, originalReview } = await staleRetirementFixture(t);
  await assert.rejects(finalizeDirectTerminalDecision(prepared, "abandon", "host", archiveRoot, {
    retireStaleReview: true,
    async removeTask(taskRoot) { await rm(path.join(taskRoot, "state.json")); throw new Error("injected removal failure"); }
  }), /injected removal failure/u);
  await writeFile(path.join(root, "host-doc.md"), "later independent work\n");
  await assert.rejects(decideDelegation(first.taskRoot, "abandon", "different-host", archiveRoot), { code: "cleanup_refused" });
  await assert.rejects(decideDelegation(first.taskRoot, "accept", "host", archiveRoot), { code: "cleanup_refused" });
  const reviewFile = path.join(archiveRoot, (await readdir(archiveRoot))[0], "host-review.json");
  const bytes = await readFile(reviewFile);
  await writeFile(reviewFile, "{}");
  await assert.rejects(decideDelegation(first.taskRoot, "abandon", "host", archiveRoot), { code: "archive_verification_failed" });
  await writeFile(reviewFile, bytes);
  await rename(first.taskRoot, first.taskRoot + "-original"); await mkdir(first.taskRoot);
  await writeFile(path.join(first.taskRoot, "unrelated.txt"), "keep");
  await assert.rejects(decideDelegation(first.taskRoot, "abandon", "host", archiveRoot), { code: "cleanup_refused" });
  assert.equal(await readFile(path.join(first.taskRoot, "unrelated.txt"), "utf8"), "keep");
  await rm(first.taskRoot, { recursive: true }); await rename(first.taskRoot + "-original", first.taskRoot);
  const result = await decideDelegation(first.taskRoot, "abandon", "host", archiveRoot);
  assert.equal(result.lifecycleState, "abandoned");
  assert.deepEqual(JSON.parse(await readFile(reviewFile)).staleReviewRetirement.originalReview, originalReview);
  assert.equal(await readFile(path.join(root, "host-doc.md"), "utf8"), "later independent work\n");
  assert.equal((await readdir(archiveRoot)).length, 1);
  assert.deepEqual(await decideDelegation(first.taskRoot, "abandon", "host", archiveRoot), result);
});

test("stale review retirement serializes competing decisions", async (t) => {
  const { archiveRoot, first } = await staleRetirementFixture(t);
  const outcomes = await Promise.allSettled(["host-a", "host-b"].map(actor => (
    decideDelegation(first.taskRoot, "abandon", actor, archiveRoot, { retireStaleReview: true })
  )));
  assert.equal(outcomes.filter(item => item.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter(item => item.status === "rejected").length, 1);
  assert.equal((await readdir(archiveRoot)).length, 1);
});

test("stale review retirement prepared receipt cannot use a missing cleanup proof after further drift", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async (t) => {
  const { root, stateRoot, archiveRoot, first, prepared, originalReview } = await staleRetirementFixture(t);
  const integrityRoot = path.join(stateRoot, ".relaypact-integrity");
  t.after(() => chmod(integrityRoot, 0o700).catch(() => {}));
  await assert.rejects(finalizeDirectTerminalDecision(prepared, "abandon", "host", archiveRoot, {
    retireStaleReview: true, afterTerminalStateCommit: () => chmod(integrityRoot, 0o500)
  }), { code: "EACCES" });
  await chmod(integrityRoot, 0o700);
  const receiptName = (await readdir(integrityRoot)).find(name => name.endsWith(".cleanup.json"));
  assert.equal(JSON.parse(await readFile(path.join(integrityRoot, receiptName))).phase, "prepared");
  const signedStore = createSignedStateStore(first.statePath, () => {});
  const authorized = await signedStore.read();
  const incomplete = { ...authorized, stateRevision: authorized.stateRevision - 1 };
  delete incomplete.cleanupAuthorization;
  await signedStore.persist(incomplete);
  await writeFile(path.join(root, "host-doc.md"), "later independent work\n");
  await assert.rejects(decideDelegation(first.taskRoot, "abandon", "host", archiveRoot), { code: "stale_review" });
  await access(first.taskRoot);
  await signedStore.persist(authorized);
  const result = await decideDelegation(first.taskRoot, "abandon", "host", archiveRoot);
  assert.equal(result.lifecycleState, "abandoned");
  assert.deepEqual(JSON.parse(await readFile(result.archive.reviewPath)).staleReviewRetirement.originalReview, originalReview);
  assert.equal(await readFile(path.join(root, "host-doc.md"), "utf8"), "later independent work\n");
});

test("Cursor terminal decision remains pending when evidence changes during archival", async () => {
  const root = await createGitRepository();
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "relaypact-cursor-terminal-race-state-"));
  const archiveRoot = await mkdtemp(path.join(os.tmpdir(), "relaypact-cursor-terminal-race-archive-"));
  try {
    const first = await runDelegation(makeEnvelope(root, { taskId: "cursor-lifecycle" }), {
      executorCommand: fakeCursor,
      stateRoot,
      hostInstanceId: "cursor-host-1"
    });
    const prepared = await loadDirectDelegation(first.taskRoot, {
      routeId: "codex-cursor",
      executorHarness: "cursor"
    });
    const reviewedContent = await readFile(path.join(root, "allowed.txt"), "utf8");
    await assert.rejects(
      finalizeDirectTerminalDecision(prepared, "accept", "cursor-host-1", archiveRoot, {
        beforeFinalBasisCheck: () => writeFile(path.join(root, "allowed.txt"), "changed during terminal archival\n")
      }),
      (error) => error.code === "stale_review"
    );
    const pending = await loadDirectDelegation(first.taskRoot, {
      routeId: "codex-cursor",
      executorHarness: "cursor"
    });
    assert.equal(pending.state.lifecycleState, "awaiting_review");
    assert.deepEqual(await readdir(archiveRoot), []);
    await writeFile(path.join(root, "allowed.txt"), reviewedContent);
    const recovered = await finalizeDirectTerminalDecision(pending, "accept", "cursor-host-1", archiveRoot);
    assert.equal(recovered.state.lifecycleState, "accepted");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(stateRoot, { recursive: true, force: true });
    await rm(archiveRoot, { recursive: true, force: true });
  }
});

test("Cursor terminal decision rolls back when evidence changes after terminal state commit", async () => {
  const root = await createGitRepository();
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "relaypact-cursor-postcommit-race-state-"));
  const archiveRoot = await mkdtemp(path.join(os.tmpdir(), "relaypact-cursor-postcommit-race-archive-"));
  try {
    const first = await runDelegation(makeEnvelope(root, { taskId: "cursor-lifecycle" }), {
      executorCommand: fakeCursor,
      stateRoot,
      hostInstanceId: "cursor-host-1"
    });
    const prepared = await loadDirectDelegation(first.taskRoot, {
      routeId: "codex-cursor",
      executorHarness: "cursor"
    });
    const reviewedContent = await readFile(path.join(root, "allowed.txt"), "utf8");
    await assert.rejects(
      finalizeDirectTerminalDecision(prepared, "accept", "cursor-host-1", archiveRoot, {
        afterTerminalStateCommit: () => writeFile(path.join(root, "allowed.txt"), "changed after terminal commit\n")
      }),
      (error) => error.code === "stale_review"
    );
    const pending = await loadDirectDelegation(first.taskRoot, {
      routeId: "codex-cursor",
      executorHarness: "cursor"
    });
    assert.equal(pending.state.lifecycleState, "awaiting_review");
    assert.deepEqual(await readdir(archiveRoot), []);
    await writeFile(path.join(root, "allowed.txt"), reviewedContent);
    const recovered = await finalizeDirectTerminalDecision(pending, "accept", "cursor-host-1", archiveRoot);
    assert.equal(recovered.state.lifecycleState, "accepted");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(stateRoot, { recursive: true, force: true });
    await rm(archiveRoot, { recursive: true, force: true });
  }
});

test("Cursor correction authorization enters running in one signed revision", async () => {
  const root = await createGitRepository();
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "relaypact-cursor-atomic-correction-"));
  try {
    const first = await runDelegation(makeEnvelope(root, { taskId: "cursor-atomic-correction" }), {
      executorCommand: fakeCursor,
      stateRoot,
      hostInstanceId: "cursor-host-1"
    });
    const loaded = await loadDirectDelegation(first.taskRoot, {
      routeId: "codex-cursor",
      executorHarness: "cursor"
    });
    const authorized = await authorizeDirectCorrection(loaded, "Apply one bounded correction.");
    assert.equal(authorized.state.lifecycleState, "running");
    assert.equal(authorized.state.correctionSequence, loaded.state.correctionSequence + 1);
    assert.equal(authorized.state.stateRevision, loaded.state.stateRevision + 1);
    assert.equal(authorized.resumeSessionId, loaded.state.sessionHandle);
    assert.equal((await failDirectDelegation(authorized)).lifecycleState, "failed");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("review evidence persistence failure cannot publish awaiting_review state", async () => {
  const root = await createGitRepository();
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "relaypact-cursor-review-atomicity-"));
  try {
    const envelope = makeEnvelope(root, { taskId: "cursor-review-atomicity" });
    let prepared = await prepareDirectDelegation({
      envelope,
      stateRoot,
      hostInstanceId: "cursor-host-1",
      routeId: "codex-cursor",
      executorHarness: "cursor"
    });
    prepared = await beginDirectDelegation(prepared);
    const result = await runDelegation(envelope, { executorCommand: fakeCursor });
    await mkdir(path.join(prepared.taskRoot, "evidence", "review-0.json"));
    await assert.rejects(
      recordDirectDelegationResult(prepared, result),
      (error) => error.code === "task_state_unavailable"
    );
    const loaded = await loadDirectDelegation(prepared.taskRoot, {
      routeId: "codex-cursor",
      executorHarness: "cursor"
    });
    assert.equal(loaded.state.lifecycleState, "running");
    assert.equal((await failDirectDelegation(loaded)).lifecycleState, "failed");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("Cursor persistent lifecycle refuses ineligible acceptance but permits explicit rejection", async () => {
  const root = await createGitRepository();
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "relaypact-cursor-state-"));
  const archiveRoot = await mkdtemp(path.join(os.tmpdir(), "relaypact-cursor-archive-"));
  try {
    const first = await runDelegation(makeEnvelope(root, { taskId: "cursor-breach" }), {
      executorCommand: fakeCursor,
      stateRoot,
      hostInstanceId: "cursor-host-1"
    });
    assert.equal(first.review.executionResult.hostAcceptance.eligible, false);
    await assert.rejects(
      decideDelegation(first.taskRoot, "accept", "cursor-host-1", archiveRoot),
      (error) => error.code === "acceptance_ineligible"
    );
    const rejected = await decideDelegation(first.taskRoot, "reject", "cursor-host-1", archiveRoot);
    assert.equal(rejected.acceptance.status, "rejected");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(stateRoot, { recursive: true, force: true });
    await rm(archiveRoot, { recursive: true, force: true });
  }
});

test("Cursor persistent lifecycle refuses a tampered review artifact", async () => {
  const root = await createGitRepository();
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "relaypact-cursor-state-"));
  const archiveRoot = await mkdtemp(path.join(os.tmpdir(), "relaypact-cursor-archive-"));
  try {
    const first = await runDelegation(makeEnvelope(root, { taskId: "cursor-lifecycle" }), {
      executorCommand: fakeCursor,
      stateRoot,
      hostInstanceId: "cursor-host-1"
    });
    const review = JSON.parse(await readFile(first.evidence.reviewPath, "utf8"));
    review.executionResult.summary = "tampered review summary";
    await writeFile(first.evidence.reviewPath, `${JSON.stringify(review, null, 2)}\n`);
    await assert.rejects(
      decideDelegation(first.taskRoot, "reject", "cursor-host-1", archiveRoot),
      (error) => error.code === "review_identity_mismatch"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(stateRoot, { recursive: true, force: true });
    await rm(archiveRoot, { recursive: true, force: true });
  }
});

test("Cursor correction refuses a changed executor session identity", async () => {
  const root = await createGitRepository();
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "relaypact-cursor-state-"));
  try {
    const first = await runDelegation(makeEnvelope(root, { taskId: "cursor-session-drift" }), {
      executorCommand: fakeCursor,
      stateRoot,
      hostInstanceId: "cursor-host-1"
    });
    await assert.rejects(
      correctDelegation(first.taskRoot, "Keep the correction inside the original session.", { executorCommand: fakeCursor }),
      (error) => error.code === "cursor_session_mismatch"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("Cursor correction refuses executable content drift before lifecycle mutation", async () => {
  const root = await createGitRepository();
  const privateRoot = await mkdtemp(path.join(os.tmpdir(), "relaypact-cursor-binary-drift-"));
  const stateRoot = path.join(privateRoot, "state");
  const mutableCursor = path.join(privateRoot, "cursor-agent");
  await mkdir(stateRoot);
  await Promise.all([
    copyFile(fakeCursor, mutableCursor),
    copyFile(fakeCursorImplementation, path.join(privateRoot, "index.js")),
    copyFile(fakeCursorRuntime, path.join(privateRoot, "node")),
    copyFile(fakeCursorPackage, path.join(privateRoot, "package.json"))
  ]);
  await chmod(mutableCursor, 0o755);
  try {
    const first = await runDelegation(makeEnvelope(root, { taskId: "cursor-lifecycle" }), {
      executorCommand: mutableCursor,
      stateRoot,
      hostInstanceId: "cursor-host-1"
    });
    await writeFile(mutableCursor, `${await readFile(mutableCursor, "utf8")}\n// executable identity changed\n`);
    await assert.rejects(
      correctDelegation(first.taskRoot, "Do not disclose the session to a changed executable."),
      (error) => error.code === "cursor_executor_mismatch"
    );
    const loaded = await loadDirectDelegation(first.taskRoot, {
      routeId: "codex-cursor",
      executorHarness: "cursor"
    });
    assert.equal(loaded.state.lifecycleState, "awaiting_review");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(privateRoot, { recursive: true, force: true });
  }
});

test("Cursor correction refuses shebang interpreter drift before session disclosure", async () => {
  const root = await createGitRepository();
  const privateRoot = await mkdtemp(path.join(os.tmpdir(), "relaypact-cursor-interpreter-drift-"));
  const stateRoot = path.join(privateRoot, "state");
  const trustedBin = path.join(privateRoot, "trusted-bin");
  const replacementBin = path.join(privateRoot, "replacement-bin");
  const mutableCursor = path.join(privateRoot, "cursor-agent");
  await Promise.all([mkdir(stateRoot), mkdir(trustedBin), mkdir(replacementBin)]);
  await Promise.all([
    copyFile(fakeCursor, mutableCursor),
    copyFile(fakeCursorImplementation, path.join(privateRoot, "index.js")),
    copyFile(fakeCursorRuntime, path.join(privateRoot, "node")),
    copyFile(fakeCursorPackage, path.join(privateRoot, "package.json")),
    symlink("/bin/bash", path.join(trustedBin, "bash")),
    symlink("/bin/sh", path.join(replacementBin, "bash"))
  ]);
  await chmod(mutableCursor, 0o755);
  try {
    const first = await runDelegation(makeEnvelope(root, { taskId: "cursor-lifecycle" }), {
      executorCommand: mutableCursor,
      environment: { ...process.env, PATH: `${trustedBin}:${path.dirname(process.execPath)}:/usr/bin:/bin` },
      stateRoot,
      hostInstanceId: "cursor-host-1"
    });
    await assert.rejects(
      correctDelegation(first.taskRoot, "Do not disclose the session through a changed interpreter.", {
        environment: { ...process.env, PATH: `${replacementBin}:${path.dirname(process.execPath)}:/usr/bin:/bin` }
      }),
      (error) => error.code === "execution_context_mismatch"
    );
    const loaded = await loadDirectDelegation(first.taskRoot, {
      routeId: "codex-cursor",
      executorHarness: "cursor"
    });
    assert.equal(loaded.state.lifecycleState, "awaiting_review");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(privateRoot, { recursive: true, force: true });
  }
});

test("Cursor execution launches verified private snapshots after original path replacement", async () => {
  const root = await createGitRepository();
  const privateRoot = await mkdtemp(path.join(os.tmpdir(), "relaypact-cursor-launch-snapshot-"));
  const mutableCursor = path.join(privateRoot, "cursor-agent");
  const marker = path.join(privateRoot, "mutable-path-executed");
  await Promise.all([
    copyFile(fakeCursor, mutableCursor),
    copyFile(fakeCursorImplementation, path.join(privateRoot, "index.js")),
    copyFile(fakeCursorRuntime, path.join(privateRoot, "node")),
    copyFile(fakeCursorPackage, path.join(privateRoot, "package.json"))
  ]);
  await chmod(mutableCursor, 0o755);
  try {
    const result = await runExecutor(makeEnvelope(root, { taskId: "cursor-success" }), {
      executorCommand: mutableCursor,
      workingDirectory: root,
      async beforeVerifiedLaunch() {
        await writeFile(mutableCursor, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 9\n`);
        await chmod(mutableCursor, 0o755);
      }
    });
    assert.equal(result.reportedStatus, "completed");
    await assert.rejects(access(marker), (error) => error.code === "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(privateRoot, { recursive: true, force: true });
  }
});

test("Cursor execution snapshots launcher-relative companion code before session disclosure", async () => {
  const root = await createGitRepository();
  const privateRoot = await mkdtemp(path.join(os.tmpdir(), "relaypact-cursor-bundle-snapshot-"));
  const mutableCursor = path.join(privateRoot, "cursor-agent");
  const mutableImplementation = path.join(privateRoot, "index.js");
  const marker = path.join(privateRoot, "mutable-companion-executed");
  await Promise.all([
    copyFile(fakeCursor, mutableCursor),
    copyFile(fakeCursorImplementation, mutableImplementation),
    copyFile(fakeCursorRuntime, path.join(privateRoot, "node")),
    copyFile(fakeCursorPackage, path.join(privateRoot, "package.json"))
  ]);
  await chmod(mutableCursor, 0o755);
  try {
    const result = await runExecutor(makeEnvelope(root, { taskId: "cursor-success" }), {
      executorCommand: mutableCursor,
      workingDirectory: root,
      async beforeVerifiedLaunch() {
        await writeFile(mutableImplementation, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "executed");\nprocess.exit(9);\n`);
      }
    });
    assert.equal(result.reportedStatus, "completed");
    await assert.rejects(access(marker), (error) => error.code === "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(privateRoot, { recursive: true, force: true });
  }
});

test("Cursor bundle materialization refuses added, removed, and symlinked companions", async () => {
  for (const mutation of ["added", "removed", "symlinked"]) {
    const privateRoot = await mkdtemp(path.join(os.tmpdir(), `relaypact-cursor-bundle-${mutation}-`));
    const mutableCursor = path.join(privateRoot, "cursor-agent");
    const mutableImplementation = path.join(privateRoot, "index.js");
    await Promise.all([
      copyFile(fakeCursor, mutableCursor),
      copyFile(fakeCursorImplementation, mutableImplementation),
      copyFile(fakeCursorRuntime, path.join(privateRoot, "node")),
      copyFile(fakeCursorPackage, path.join(privateRoot, "package.json"))
    ]);
    await chmod(mutableCursor, 0o755);
    try {
      const identity = await resolveCursorExecutable(mutableCursor);
      assert.ok(identity);
      if (mutation === "added") {
        await writeFile(path.join(privateRoot, "injected.index.js"), "throw new Error('must not run');\n");
      } else if (mutation === "removed") {
        await rm(mutableImplementation);
      } else {
        await rm(mutableImplementation);
        await symlink(fakeCursorImplementation, mutableImplementation);
      }
      await assert.rejects(
        materializeCursorExecutable(identity),
        (error) => error.code === "cursor_executor_mismatch"
      );
    } finally {
      await rm(privateRoot, { recursive: true, force: true });
    }
  }
});

test("Cursor identity mismatch remains machine-readable after postflight", async () => {
  const root = await createGitRepository();
  const privateRoot = await mkdtemp(path.join(os.tmpdir(), "relaypact-cursor-failure-code-"));
  const mutableCursor = path.join(privateRoot, "cursor-agent");
  const mutableImplementation = path.join(privateRoot, "index.js");
  await Promise.all([
    copyFile(fakeCursor, mutableCursor),
    copyFile(fakeCursorImplementation, mutableImplementation),
    copyFile(fakeCursorRuntime, path.join(privateRoot, "node")),
    copyFile(fakeCursorPackage, path.join(privateRoot, "package.json"))
  ]);
  await chmod(mutableCursor, 0o755);
  try {
    const readiness = await discoverCursorCli({ executorCommand: mutableCursor });
    assert.equal(readiness.state, "ready");
    await writeFile(mutableImplementation, "#!/bin/sh\nexit 97\n");

    const result = await runDelegation(makeEnvelope(root, { taskId: "cursor-identity-failure" }), {
      executorCommand: mutableCursor,
      readiness
    });
    assert.equal(result.status, "failed");
    assert.equal(result.executor.reportedStatus, "failed");
    assert.equal(result.executor.failureCode, "cursor_executor_mismatch");
    assert.match(result.executor.summary, /identity changed/i);
    assert.equal(result.hostAcceptance.eligible, false);
    assert.equal(result.scope.compliant, true);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(privateRoot, { recursive: true, force: true });
  }
});

test("failed persistent Cursor task can be explicitly abandoned and archived", async () => {
  const root = await createGitRepository();
  const privateRoot = await mkdtemp(path.join(os.tmpdir(), "relaypact-cursor-failed-cleanup-"));
  const stateRoot = path.join(privateRoot, "state");
  const archiveRoot = path.join(privateRoot, "archive");
  await Promise.all([mkdir(stateRoot), mkdir(archiveRoot)]);
  try {
    const first = await runDelegation(makeEnvelope(root, { taskId: "cursor-session-drift" }), {
      executorCommand: fakeCursor,
      stateRoot,
      hostInstanceId: "cursor-host-1"
    });
    await assert.rejects(
      correctDelegation(first.taskRoot, "Trigger the bounded session mismatch."),
      (error) => error.code === "cursor_session_mismatch"
    );
    const failed = await loadDirectDelegation(first.taskRoot, {
      routeId: "codex-cursor",
      executorHarness: "cursor"
    });
    assert.equal(failed.state.lifecycleState, "failed");

    const abandoned = await decideDelegation(first.taskRoot, "abandon", "cursor-host-1", archiveRoot);
    assert.equal(abandoned.lifecycleState, "abandoned");
    assert.equal(abandoned.acceptance.status, "abandoned");
    assert.doesNotMatch(await readFile(abandoned.archive.receiptPath, "utf8"), /fixture-cursor-session/u);
    await assert.rejects(access(first.taskRoot), (error) => error.code === "ENOENT");
    assert.equal(await readFile(path.join(root, "allowed.txt"), "utf8"), "corrected cursor lifecycle edit\n");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(privateRoot, { recursive: true, force: true });
  }
});

test("concurrent failed-task abandonment publishes only one committed receipt", async () => {
  const root = await createGitRepository();
  const privateRoot = await mkdtemp(path.join(os.tmpdir(), "relaypact-cursor-failed-race-"));
  const stateRoot = path.join(privateRoot, "state");
  const archiveRoot = path.join(privateRoot, "archive");
  await Promise.all([mkdir(stateRoot), mkdir(archiveRoot)]);
  try {
    const first = await runDelegation(makeEnvelope(root, { taskId: "cursor-session-drift" }), {
      executorCommand: fakeCursor,
      stateRoot,
      hostInstanceId: "cursor-host-1"
    });
    await assert.rejects(
      correctDelegation(first.taskRoot, "Trigger the bounded session mismatch."),
      (error) => error.code === "cursor_session_mismatch"
    );
    const prepared = await loadDirectDelegation(first.taskRoot, {
      routeId: "codex-cursor",
      executorHarness: "cursor"
    });
    const outcomes = await Promise.allSettled([
      abandonAndCleanupFailedDirectTask(prepared, "cursor-host-1", archiveRoot),
      abandonAndCleanupFailedDirectTask(prepared, "cursor-host-2", archiveRoot)
    ]);
    assert.equal(outcomes.filter(({ status }) => status === "fulfilled").length, 1);
    assert.equal(outcomes.filter(({ status }) => status === "rejected").length, 1);
    assert.equal((await readdir(archiveRoot)).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(privateRoot, { recursive: true, force: true });
  }
});

test("Cursor correction refuses an executor command that differs from signed state", async () => {
  const root = await createGitRepository();
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "relaypact-cursor-executor-drift-"));
  try {
    const first = await runDelegation(makeEnvelope(root, { taskId: "cursor-lifecycle" }), {
      executorCommand: fakeCursor,
      stateRoot,
      hostInstanceId: "cursor-host-1"
    });
    await assert.rejects(
      correctDelegation(first.taskRoot, "Keep the original executor command.", { executorCommand: "/different/cursor-agent" }),
      (error) => error.code === "cursor_executor_mismatch"
    );
    const loaded = await loadDirectDelegation(first.taskRoot, {
      routeId: "codex-cursor",
      executorHarness: "cursor"
    });
    assert.equal(loaded.state.lifecycleState, "awaiting_review");
    assert.equal(loaded.state.executorCommand, await realpath(fakeCursor));
    assert.match(loaded.state.executorFingerprint, /^sha256:[a-f0-9]{64}$/u);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(stateRoot, { recursive: true, force: true });
  }
});

for (const [label, outcome] of Object.entries({
  timeout: { exitCode: null, timedOut: true },
  signal: { exitCode: null, signal: "SIGKILL" },
  cancellation: { exitCode: null, cancelled: true },
  truncated: { exitCode: 0, stdout: process.version, stdoutTruncated: true },
  failure: { exitCode: 1, stderr: "temporary runtime failure" },
  missingVersion: { exitCode: 0 }
})) {
  test(`Cursor ${label} probe cannot become a cached no-flag identity`, async () => {
    const privateRoot = await mkdtemp(path.join(os.tmpdir(), "relaypact-probe-unknown-"));
    try {
      const command = await nodeCursorFixture(privateRoot, source => source);
      await writeFile(command, `${await readFile(command, "utf8")}\n# indeterminate-${label}\n`);
      const unavailableProbe = async () => ({ stdout: "", stderr: "", signal: null, ...outcome });
      if (label === "timeout") {
        const readiness = await discoverCursorCli({ executorCommand: command, runProcess: unavailableProbe });
        assert.equal(readiness.state, "blocked");
      }
      await assert.rejects(resolveCursorExecutable(command, {
        runProcess: unavailableProbe
      }), error => error.code === "cursor_runtime_probe_unavailable");
      let retries = 0;
      const identity = await resolveCursorExecutable(command, {
        async runProcess() { retries++; return { exitCode: 0, signal: null, stdout: process.version, stderr: "" }; }
      });
      assert.equal(retries, 1);
      assert.deepEqual(identity.runtimeArguments, ["--use-system-ca"]);
      const repeated = await resolveCursorExecutable(command, {
        async runProcess() { throw new Error("conclusive result should already be cached"); }
      });
      assert.equal(repeated.fingerprint, identity.fingerprint);
    } finally {
      await rm(privateRoot, { recursive: true, force: true });
    }
  });
}

test("Cursor conclusively unsupported system CA flag retains the no-flag identity", async () => {
  const privateRoot = await mkdtemp(path.join(os.tmpdir(), "relaypact-probe-unsupported-"));
  try {
    const command = await nodeCursorFixture(privateRoot, source => source);
    await writeFile(command, `${await readFile(command, "utf8")}\n# explicit unsupported fixture\n`);
    const identity = await resolveCursorExecutable(command, {
      async runProcess() { return { exitCode: 9, signal: null, stdout: "", stderr: "node: bad option: --use-system-ca\n" }; }
    });
    assert.deepEqual(identity.runtimeArguments, []);
    const repeated = await resolveCursorExecutable(command, {
      async runProcess() { throw new Error("conclusive result should already be cached"); }
    });
    assert.equal(repeated.fingerprint, identity.fingerprint);
  } finally {
    await rm(privateRoot, { recursive: true, force: true });
  }
});



test("Cursor correction binds effective environments and grants before any probe", async () => {
  const root = await createGitRepository();
  const privateRoot = await mkdtemp(path.join(os.tmpdir(), "relaypact-context-"));
  try {
    const stateRoot = path.join(privateRoot, "state");
    await mkdir(stateRoot);
    const first = await runDelegation(makeEnvelope(root, { taskId: "cursor-lifecycle" }), { executorCommand: fakeCursor, stateRoot, hostInstanceId: "host" });
    const before = await readFile(first.statePath, "utf8");
    for (const override of [
      { environment: { ...process.env, HOME: privateRoot } },
      { environment: { ...process.env, PATH: "/different/bin" } },
      { validationEnvironment: { ...process.env, PATH: "/different/bin" } },
      { validationEnv: { NEW_GRANT: "new-authority" } }
    ]) {
      await assert.rejects(correctDelegation(first.taskRoot, "Continue.", {
        ...override, async runProcess() { assert.fail("must reject before probing"); }
      }), error => error.code === "execution_context_mismatch");
      assert.equal(await readFile(first.statePath, "utf8"), before);
    }
    const corrected = await correctDelegation(first.taskRoot, "Continue.", { environment: { ...process.env, NOT_FORWARDED: "ignored" } });
    assert.equal(corrected.review.executionResult.hostAcceptance.eligible, true);
  } finally { await rm(root, { recursive: true, force: true }); await rm(privateRoot, { recursive: true, force: true }); }
});

for (const phase of ["executor", "validation"]) {
  test(`Cursor ${phase} settlement survives oversized postflight failure and permits abandon`, async () => {
    const root = await createGitRepository();
    const privateRoot = await mkdtemp(path.join(os.tmpdir(), "relaypact-settlement-"));
    try {
      const stateRoot = path.join(privateRoot, "state"), archiveRoot = path.join(privateRoot, "archive");
      await mkdir(stateRoot); await mkdir(archiveRoot);
      const oversized = "require('node:fs').writeFileSync('allowed.txt', ''); require('node:fs').truncateSync('allowed.txt', 513 * 1024 * 1024)";
      const command = phase === "executor" ? await nodeCursorFixture(privateRoot, source => source + "\nspawnSync(process.execPath, ['-e', " + JSON.stringify(oversized) + "]);\n") : fakeCursor;
      await assert.rejects(runDelegation(makeEnvelope(root, {
        taskId: "cursor-lifecycle",
        ...(phase === "validation" ? { validation: [{ id: "oversized", argv: [process.execPath, "-e", oversized] }] } : {})
      }), { executorCommand: command, stateRoot, hostInstanceId: "host" }));
      const taskRoot = path.join(stateRoot, (await readdir(stateRoot)).find(name => name.startsWith("task-")));
      const prepared = await loadDirectDelegation(taskRoot, { routeId: "codex-cursor", executorHarness: "cursor" });
      assert.equal(prepared.state.lifecycleState, "failed");
      assert.equal(prepared.state.executionSettled, true);
      await abandonAndCleanupFailedDirectTask(prepared, "host", archiveRoot);
      await assert.rejects(access(taskRoot), error => error.code === "ENOENT");
    } finally { await rm(root, { recursive: true, force: true }); await rm(privateRoot, { recursive: true, force: true }); }
  });
}

test("Cursor nonzero complete terminal stream retains its observed model", async () => {
  const root = await createGitRepository();
  const privateRoot = await mkdtemp(path.join(os.tmpdir(), "relaypact-nonzero-model-"));
  try {
    const command = await nodeCursorFixture(privateRoot, source => source + "\nprocess.exitCode = 7;\n");
    const result = await runExecutor(makeEnvelope(root, { taskId: "cursor-terminal-failure" }), { executorCommand: command, workingDirectory: root });
    assert.equal(result.reportedStatus, "failed");
    assert.equal(result.exitCode, 7);
    assert.equal(result.modelObservation.state, "observed");
    assert.equal(result.modelObservation.value, "fixture-cursor-model");
    assert.throws(() => assertCursorResumeSession(result));
  } finally { await rm(root, { recursive: true, force: true }); await rm(privateRoot, { recursive: true, force: true }); }
});

test("Cursor legacy context cannot resume but remains available for terminal review", async () => {
  const root = await createGitRepository();
  const privateRoot = await mkdtemp(path.join(os.tmpdir(), "relaypact-legacy-context-"));
  try {
    const stateRoot = path.join(privateRoot, "state"), archiveRoot = path.join(privateRoot, "archive");
    await mkdir(stateRoot); await mkdir(archiveRoot);
    const first = await runDelegation(makeEnvelope(root, { taskId: "cursor-lifecycle" }), { executorCommand: fakeCursor, stateRoot, hostInstanceId: "host" });
    await createSignedStateStore(first.statePath, state => state).withLock(async ({ read, persist }) => {
      const state = await read();
      delete state.executionContextFingerprint;
      await persist(state, { expectedRevision: state.stateRevision });
    });
    await assert.rejects(correctDelegation(first.taskRoot, "Continue."), error => error.code === "execution_context_unavailable");
    assert.equal((await decideDelegation(first.taskRoot, "reject", "host", archiveRoot)).lifecycleState, "rejected");
  } finally { await rm(root, { recursive: true, force: true }); await rm(privateRoot, { recursive: true, force: true }); }
});

test("Cursor correction scope errors never expose validation grants in forbidden filenames", async () => {
  const root = await createGitRepository();
  const privateRoot = await mkdtemp(path.join(os.tmpdir(), "relaypact-scope-secret-"));
  const secret = "forbidden-validation-value";
  try {
    const stateRoot = path.join(privateRoot, "state"); await mkdir(stateRoot);
    const first = await runDelegation(makeEnvelope(root, { taskId: "cursor-lifecycle", validation: [{
      id: "secret-file", argv: [process.execPath, "-e", "require('node:fs').writeFileSync(process.env.GRANT + '.txt', 'fixture')"]
    }] }), { executorCommand: fakeCursor, stateRoot, hostInstanceId: "host", validationEnv: { GRANT: secret } });
    await assert.rejects(correctDelegation(first.taskRoot, "Continue.", { validationEnv: { GRANT: secret } }), error => {
      assert.equal(error.code, "scope_breach");
      assert.ok(!JSON.stringify(error).includes(secret)); return true;
    });
  } finally { await rm(root, { recursive: true, force: true }); await rm(privateRoot, { recursive: true, force: true }); }
});

test("Cursor returned narratives and model values redact exact validation grants", async () => {
  const root = await createGitRepository();
  const privateRoot = await mkdtemp(path.join(os.tmpdir(), "relaypact-narrative-secret-"));
  const secret = "opaque-narrative-value";
  try {
    const command = await nodeCursorFixture(privateRoot, source => source.replaceAll("fixture-cursor-model", "x".repeat(179) + secret).replace("Host authority is required.", "x".repeat(3979) + secret));
    const result = await runDelegation(makeEnvelope(root, { taskId: "cursor-blocked" }), { executorCommand: command, validationEnv: { GRANT: secret } });
    assert.equal(result.status, "blocked");
    assert.ok(!JSON.stringify(result).includes(secret));
    assert.equal(result.executor.modelObservation.state, "observed");
    assert.ok(!JSON.stringify(result).includes(secret.slice(0, 10)));
  } finally { await rm(root, { recursive: true, force: true }); await rm(privateRoot, { recursive: true, force: true }); }
});

test("Cursor validation settlement precedes isolated environment cleanup failure", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
  const root = await createGitRepository();
  const privateRoot = await mkdtemp(path.join(os.tmpdir(), "relaypact-validation-cleanup-"));
  let validationRoot;
  try {
    const stateRoot = path.join(privateRoot, "state"), archiveRoot = path.join(privateRoot, "archive");
    await mkdir(stateRoot); await mkdir(archiveRoot);
    await assert.rejects(runDelegation(makeEnvelope(root, { taskId: "cursor-lifecycle" }), {
      executorCommand: fakeCursor, stateRoot, hostInstanceId: "host",
      async validationProcess(command, args, options) {
        validationRoot = path.dirname(options.env.HOME);
        await chmod(validationRoot, 0);
        return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      }
    }), error => error.code === "EACCES");
    const taskRoot = path.join(stateRoot, (await readdir(stateRoot)).find(name => name.startsWith("task-")));
    const prepared = await loadDirectDelegation(taskRoot, { routeId: "codex-cursor", executorHarness: "cursor" });
    assert.equal(prepared.state.executionSettled, true);
    await abandonAndCleanupFailedDirectTask(prepared, "host", archiveRoot);
    await assert.rejects(access(taskRoot), error => error.code === "ENOENT");
  } finally {
    if (validationRoot) { await chmod(validationRoot, 0o700); await rm(validationRoot, { recursive: true, force: true }); }
    await rm(root, { recursive: true, force: true }); await rm(privateRoot, { recursive: true, force: true });
  }
});

for (const action of ["accept", "reject", "abandon"]) {
  test(`Cursor ${action} cleanup retries partial removal without repeating the decision`, async () => {
    const root = await createGitRepository(), stateRoot = await createDirectory(), archiveRoot = await createDirectory();
    try {
      const first = await runDelegation(makeEnvelope(root, { taskId: "cursor-lifecycle" }), { executorCommand: fakeCursor, stateRoot, hostInstanceId: "host" });
      const prepared = await loadDirectDelegation(first.taskRoot);
      await assert.rejects(finalizeDirectTerminalDecision(prepared, action, "host", archiveRoot, {
        async removeTask(taskRoot) {
          await rm(path.join(taskRoot, "state.json"));
          await rm(path.join(taskRoot, "task-envelope.json"));
          throw Object.assign(new Error("injected partial removal"), { code: "EACCES" });
        }
      }), error => error.code === "EACCES");
      await assert.rejects(decideDelegation(first.taskRoot, action, "other-host", archiveRoot), error => error.code === "cleanup_refused");
      await assert.rejects(decideDelegation(first.taskRoot, action === "accept" ? "reject" : "accept", "host", archiveRoot), error => error.code === "cleanup_refused");
      const archivePath = path.join(archiveRoot, (await readdir(archiveRoot))[0], "host-review.json");
      const original = await readFile(archivePath, "utf8");
      const altered = JSON.parse(original); altered.taskId = "other-task";
      await writeFile(archivePath, JSON.stringify(altered));
      await assert.rejects(decideDelegation(first.taskRoot, action, "host", archiveRoot), error => error.code === "archive_verification_failed");
      await writeFile(archivePath, original);
      const displaced = first.taskRoot + "-displaced";
      await rename(first.taskRoot, displaced); await mkdir(first.taskRoot);
      await assert.rejects(decideDelegation(first.taskRoot, action, "host", archiveRoot), error => error.code === "cleanup_refused");
      await rm(first.taskRoot, { recursive: true }); await rename(displaced, first.taskRoot);
      // A fresh CLI process must recover without the removed envelope/state files.
      const { stdout } = await execFileAsync(process.execPath, [cli, "decide-cursor", "--task-root", first.taskRoot, "--action", action, "--actor", "host", "--archive-root", archiveRoot]);
      const result = JSON.parse(stdout);
      assert.equal(result.lifecycleState, action === "accept" ? "accepted" : action === "reject" ? "rejected" : "abandoned");
      assert.equal((await readdir(archiveRoot)).length, 1);
      assert.deepEqual(await decideDelegation(first.taskRoot, action, "host", archiveRoot), result);
      await assert.rejects(access(first.taskRoot), error => error.code === "ENOENT");
      const recoveryFile = path.join(stateRoot, ".relaypact-integrity", (await readdir(path.join(stateRoot, ".relaypact-integrity"))).find(name => name.endsWith(".cleanup.json")));
      assert.doesNotMatch(await readFile(recoveryFile, "utf8"), /fixture-cursor-session/u);
      await mkdir(first.taskRoot); await writeFile(path.join(first.taskRoot, "keep.txt"), "replacement");
      await assert.rejects(decideDelegation(first.taskRoot, action, "host", archiveRoot), error => error.code === "cleanup_refused");
      assert.equal(await readFile(path.join(first.taskRoot, "keep.txt"), "utf8"), "replacement");
    } finally { await rm(root, { recursive: true, force: true }); await rm(stateRoot, { recursive: true, force: true }); await rm(archiveRoot, { recursive: true, force: true }); }
  });
}

for (const lifecycle of ["prepared", "failed"]) {
  test(`Cursor ${lifecycle} abandonment receipt supports partial cleanup recovery`, async () => {
    const root = await createGitRepository(), stateRoot = await createDirectory(), archiveRoot = await createDirectory();
    try {
      let prepared = await prepareDirectDelegation({ envelope: makeEnvelope(root), stateRoot, hostInstanceId: "host", routeId: "codex-cursor", executorHarness: "cursor" });
      if (lifecycle === "failed") {
        await assert.rejects(executeDirectDelegation(prepared, async active => { await active.markExecutionSettled(); throw new Error("fixture failure"); }));
        prepared = await loadDirectDelegation(prepared.taskRoot);
      }
      const abandon = lifecycle === "failed" ? abandonAndCleanupFailedDirectTask : abandonAndCleanupInterruptedDirectTask;
      await assert.rejects(abandon(prepared, "host", archiveRoot, { async removeTask(taskRoot) { await rm(path.join(taskRoot, "state.json")); throw new Error("partial deletion"); } }));
      const completed = await decideDelegation(prepared.taskRoot, "abandon", "host", archiveRoot);
      assert.equal(completed.lifecycleState, "abandoned");
      assert.ok(completed.archive.receiptPath.endsWith(`${lifecycle === "failed" ? "failure" : "interruption"}-receipt.json`));
      assert.deepEqual(await decideDelegation(prepared.taskRoot, "abandon", "host", archiveRoot), completed);
    } finally { await rm(root, { recursive: true, force: true }); await rm(stateRoot, { recursive: true, force: true }); await rm(archiveRoot, { recursive: true, force: true }); }
  });
}

test("Cursor correction refuses reviewed-content drift after authorization and before launch", async () => {
  for (const phase of ["authorized", "reloaded", "launch"]) {
    const root = await createGitRepository(), stateRoot = await createDirectory();
    try {
      const first = await runDelegation(makeEnvelope(root, { taskId: "cursor-lifecycle" }), { executorCommand: fakeCursor, stateRoot, hostInstanceId: "host" });
      if (phase !== "launch") {
        const authorized = await authorizeDirectCorrection(await loadDirectDelegation(first.taskRoot), "Correct this task.");
        await writeFile(path.join(root, "allowed.txt"), "external edit");
        await assert.rejects(executeDirectDelegation(phase === "reloaded" ? await loadDirectDelegation(first.taskRoot) : authorized, async () => { assert.fail("executor cannot receive stale candidate"); }), error => error.code === "stale_review");
      } else {
        await assert.rejects(correctDelegation(first.taskRoot, "Correct this task.", { beforeVerifiedLaunch: () => writeFile(path.join(root, "allowed.txt"), "external edit") }), error => error.code === "stale_review");
      }
      assert.equal(await readFile(path.join(root, "allowed.txt"), "utf8"), "external edit");
      assert.equal((await loadDirectDelegation(first.taskRoot)).state.executionSettled, true);
    } finally { await rm(root, { recursive: true, force: true }); await rm(stateRoot, { recursive: true, force: true }); }
  }
});

const completedLocalExecutor = () => ({ reportedStatus: "completed", summary: "fixture", residualRisks: [], exitCode: 0, signal: null });
for (const variant of ["absolute-file", "relative-file", "directory", "chain", "dangling", "cycle"]) {
  test(`local execution refuses pre-existing ${variant} escaping repository link`, async () => {
    const root = await createGitRepository(), outside = await createDirectory();
    try {
      const victim = path.join(outside, "victim.txt"); await writeFile(victim, "unchanged");
      const target = variant === "directory" ? outside : variant === "dangling" ? path.join(outside, "missing") : variant === "cycle" ? "allowed.txt" : variant === "relative-file" ? path.relative(root, victim) : victim;
      if (variant === "chain") { await symlink(victim, path.join(root, "middle")); await symlink("middle", path.join(root, "allowed.txt")); }
      else await symlink(target, path.join(root, "allowed.txt"));
      await execFileAsync("git", ["add", "."], { cwd: root }); await execFileAsync("git", ["commit", "-m", "fixture link"], { cwd: root });
      await assert.rejects(runLocalDelegation(makeEnvelope(root), {
        execute() { assert.fail("unsafe link must block executor"); }, validationProcess() { assert.fail("unsafe link must block validation"); }
      }), error => error.code === "repository_link_unsafe");
      assert.equal(await readFile(victim, "utf8"), "unchanged");
    } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
  });
}

test("local repository link checks preserve internal aliases and stop later validations", async () => {
  const root = await createGitRepository(), outside = await createDirectory();
  try {
    await symlink("README.md", path.join(root, "allowed.txt"));
    await execFileAsync("git", ["add", "."], { cwd: root }); await execFileAsync("git", ["commit", "-m", "fixture internal link"], { cwd: root });
    const legitimate = await runLocalDelegation(makeEnvelope(root), { async execute() { await writeFile(path.join(root, "allowed.txt"), "internal edit"); return completedLocalExecutor(); } });
    assert.equal(legitimate.hostAcceptance.eligible, true); assert.deepEqual(legitimate.changedPaths, ["README.md"]);
    await execFileAsync("git", ["add", "."], { cwd: root }); await execFileAsync("git", ["commit", "-m", "fixture internal edit"], { cwd: root });
    const victim = path.join(outside, "victim.txt"); await writeFile(victim, "unchanged");
    const envelope = makeEnvelope(root, { validation: [
      { id: "create-link", argv: [process.execPath, "-e", "require('node:fs').unlinkSync('allowed.txt');require('node:fs').symlinkSync(process.env.LINK_TARGET,'allowed.txt')"] },
      { id: "must-not-write", argv: [process.execPath, "-e", "require('node:fs').writeFileSync('allowed.txt','unsafe')"] }
    ] });
    await assert.rejects(runLocalDelegation(envelope, { execute: completedLocalExecutor, validationEnv: { LINK_TARGET: victim } }), error => error.code === "repository_link_unsafe");
    assert.equal(await readFile(victim, "utf8"), "unchanged");
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test("local repository link checks admit dot-prefixed internal target directories", async () => {
  const root = await createGitRepository();
  try {
    await mkdir(path.join(root, "..internal"));
    await writeFile(path.join(root, "..internal", "file.txt"), "before");
    await symlink("..internal", path.join(root, "alias"));
    await execFileAsync("git", ["add", "."], { cwd: root }); await execFileAsync("git", ["commit", "-m", "fixture dotted internal directory"], { cwd: root });
    const result = await runLocalDelegation(makeEnvelope(root, { scope: { allowedPaths: ["..internal/**", "alias/**"] } }), {
      async execute() { await writeFile(path.join(root, "alias", "file.txt"), "after"); return completedLocalExecutor(); }
    });
    assert.equal(result.hostAcceptance.eligible, true);
    assert.deepEqual(result.changedPaths, ["..internal/file.txt"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Cursor correction rechecks candidate bytes inside authorization lock", async () => {
  const root = await createGitRepository(), stateRoot = await createDirectory();
  try {
    const first = await runDelegation(makeEnvelope(root, { taskId: "cursor-lifecycle" }), {
      executorCommand: fakeCursor, stateRoot, hostInstanceId: "host"
    });
    const prepared = await loadDirectDelegation(first.taskRoot);
    const before = await readFile(first.statePath, "utf8");
    const allowedPaths = prepared.envelope.scope.allowedPaths;
    let injected = false;
    Object.defineProperty(prepared.envelope.scope, "allowedPaths", {
      get() {
        // Scope evaluation follows the initial basis read but precedes lock acquisition.
        if (!injected) {
          injected = true;
          execFileSync(process.execPath, ["-e", "require('node:fs').writeFileSync('allowed.txt', 'external edit')"], { cwd: root });
        }
        return allowedPaths;
      }
    });
    await assert.rejects(authorizeDirectCorrection(prepared, "Continue."), error => error.code === "stale_review");
    assert.equal(injected, true);
    assert.equal(await readFile(first.statePath, "utf8"), before);
    assert.equal(await readFile(path.join(root, "allowed.txt"), "utf8"), "external edit");
  } finally { await rm(root, { recursive: true, force: true }); await rm(stateRoot, { recursive: true, force: true }); }
});

for (const targetLocation of ["outside", "inside"]) {
  test(`local execution refuses ${targetLocation} hard links before any process`, async () => {
    const root = await createGitRepository(), outside = await createDirectory();
    try {
      const victim = path.join(targetLocation === "outside" ? outside : root, "victim.txt");
      await writeFile(victim, "unchanged");
      await link(victim, path.join(root, "allowed.txt"));
      await execFileAsync("git", ["add", "."], { cwd: root });
      await execFileAsync("git", ["commit", "-m", "fixture hard link"], { cwd: root });
      let launched = false;
      await assert.rejects(runLocalDelegation(makeEnvelope(root, { validation: [] }), {
        async execute() { launched = true; await writeFile(path.join(root, "allowed.txt"), "outside mutation"); return completedLocalExecutor(); }
      }), error => error.code === "repository_link_unsafe");
      assert.equal(launched, false);
      assert.equal(await readFile(victim, "utf8"), "unchanged");
    } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
  });
}

test("repository hard-link checks use current metadata for an older snapshot", async () => {
  const root = await createGitRepository(), outside = await createDirectory();
  try {
    const snapshot = await snapshotFilesystem(root, { exclude: [".git"] });
    await link(path.join(root, "README.md"), path.join(outside, "alias.txt"));
    await assert.rejects(assertRepositoryLinks(root, snapshot), error => error.code === "repository_link_unsafe");
    await rm(path.join(outside, "alias.txt"));
    await assertRepositoryLinks(root, snapshot);
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test("local hard-link checks stop validation after executor introduces an alias", async () => {
  const root = await createGitRepository(), outside = await createDirectory();
  try {
    const victim = path.join(outside, "victim.txt"); await writeFile(victim, "unchanged");
    const result = await runLocalDelegation(makeEnvelope(root), {
      async execute() { await link(victim, path.join(root, "allowed.txt")); return completedLocalExecutor(); },
      validationProcess() { assert.fail("hard link must block validation"); }
    });
    assert.equal(result.hostAcceptance.eligible, false);
    assert.equal(await readFile(victim, "utf8"), "unchanged");
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test("local hard-link checks stop later validations after an alias is introduced", async () => {
  const root = await createGitRepository(), outside = await createDirectory();
  try {
    const victim = path.join(outside, "victim.txt"); await writeFile(victim, "unchanged");
    const envelope = makeEnvelope(root, { validation: [
      { id: "create-hard-link", argv: [process.execPath, "-e", "require('node:fs').linkSync(process.env.LINK_TARGET,'allowed.txt')"] },
      { id: "must-not-write", argv: [process.execPath, "-e", "require('node:fs').writeFileSync('allowed.txt','unsafe')"] }
    ] });
    await assert.rejects(runLocalDelegation(envelope, { execute: completedLocalExecutor, validationEnv: { LINK_TARGET: victim } }), error => error.code === "repository_link_unsafe");
    assert.equal(await readFile(victim, "utf8"), "unchanged");
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

for (const action of ["accept", "reject", "abandon"]) {
  test(`Cursor ${action} cleanup ignores later candidate edits after receipt promotion failure`, { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
    const root = await createGitRepository(), stateRoot = await createDirectory(), archiveRoot = await createDirectory();
    const integrityRoot = path.join(stateRoot, ".relaypact-integrity");
    try {
      const first = await runDelegation(makeEnvelope(root, { taskId: "cursor-lifecycle" }), { executorCommand: fakeCursor, stateRoot, hostInstanceId: "host" });
      const prepared = await loadDirectDelegation(first.taskRoot);
      await assert.rejects(finalizeDirectTerminalDecision(prepared, action, "host", archiveRoot, {
        // The existing key remains readable; only cleanup-receipt promotion cannot write.
        afterTerminalStateCommit: () => chmod(integrityRoot, 0o500)
      }), error => error.code === "EACCES");
      await chmod(integrityRoot, 0o700);
      const receiptName = (await readdir(integrityRoot)).find(name => name.endsWith(".cleanup.json"));
      assert.equal(JSON.parse(await readFile(path.join(integrityRoot, receiptName), "utf8")).phase, "prepared");
      await writeFile(path.join(root, "allowed.txt"), "legitimate later work");
      const completed = await decideDelegation(first.taskRoot, action, "host", archiveRoot);
      assert.equal(completed.lifecycleState, action === "accept" ? "accepted" : action === "reject" ? "rejected" : "abandoned");
      assert.equal(await readFile(path.join(root, "allowed.txt"), "utf8"), "legitimate later work");
      assert.equal((await readdir(archiveRoot)).length, 1);
      await assert.rejects(access(first.taskRoot), error => error.code === "ENOENT");
      assert.deepEqual(await decideDelegation(first.taskRoot, action, "host", archiveRoot), completed);
    } finally { await chmod(integrityRoot, 0o700).catch(() => {}); await rm(root, { recursive: true, force: true }); await rm(stateRoot, { recursive: true, force: true }); await rm(archiveRoot, { recursive: true, force: true }); }
  });
}

for (const proof of ["missing", "different-archive", "different-revision"]) {
  test(`Cursor cleanup refuses ${proof} authorization after repository drift`, { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
    const root = await createGitRepository(), stateRoot = await createDirectory(), archiveRoot = await createDirectory();
    const integrityRoot = path.join(stateRoot, ".relaypact-integrity");
    try {
      const first = await runDelegation(makeEnvelope(root, { taskId: "cursor-lifecycle" }), { executorCommand: fakeCursor, stateRoot, hostInstanceId: "host" });
      await assert.rejects(finalizeDirectTerminalDecision(await loadDirectDelegation(first.taskRoot), "accept", "host", archiveRoot, {
        afterTerminalStateCommit: () => chmod(integrityRoot, 0o500)
      }), error => error.code === "EACCES");
      await chmod(integrityRoot, 0o700);
      const signedStore = createSignedStateStore(first.statePath, () => {});
      const authorized = await signedStore.read();
      const incomplete = { ...authorized };
      if (proof === "missing") { delete incomplete.cleanupAuthorization; incomplete.stateRevision -= 1; }
      if (proof === "different-archive") incomplete.cleanupAuthorization = `sha256:${"0".repeat(64)}`;
      if (proof === "different-revision") incomplete.stateRevision += 1;
      await signedStore.persist(incomplete);
      await writeFile(path.join(root, "allowed.txt"), "legitimate later work");
      await assert.rejects(decideDelegation(first.taskRoot, "accept", "host", archiveRoot), error => error.code === (proof === "missing" ? "stale_review" : "cleanup_refused"));
      await access(first.taskRoot);
      assert.equal((await readdir(archiveRoot)).length, 1);
      await signedStore.persist(authorized);
      assert.equal((await decideDelegation(first.taskRoot, "accept", "host", archiveRoot)).lifecycleState, "accepted");
      assert.equal(await readFile(path.join(root, "allowed.txt"), "utf8"), "legitimate later work");
    } finally { await chmod(integrityRoot, 0o700).catch(() => {}); await rm(root, { recursive: true, force: true }); await rm(stateRoot, { recursive: true, force: true }); await rm(archiveRoot, { recursive: true, force: true }); }
  });
}

test("Cursor larger static bundle preserves complete snapshot and companion identity", async () => {
  const privateRoot = await mkdtemp(path.join(os.tmpdir(), "relaypact-large-bundle-"));
  let materialized;
  try {
    const command = await nodeCursorFixture(privateRoot, source => source);
    const companion = path.join(path.dirname(command), "cursor-agent-worker-sea");
    await writeFile(companion, "");
    await truncate(companion, 600 * 1024 * 1024);
    await chmod(companion, 0o755);
    const identity = await resolveCursorExecutable(command);
    assert.ok(identity, "current larger installations must be admitted");
    materialized = await materializeCursorExecutable(identity);
    const copied = path.join(path.dirname(materialized.identity.launchCommand), "cursor-agent-worker-sea");
    assert.equal((await stat(copied)).size, 600 * 1024 * 1024);
    assert.notEqual(copied, companion);
    await writeFile(companion, "changed static executable");
    await assert.rejects(materializeCursorExecutable(identity), error => error.code === "cursor_executor_mismatch");
    assert.equal((await stat(copied)).size, 600 * 1024 * 1024);
  } finally {
    await materialized?.cleanup();
    await rm(privateRoot, { recursive: true, force: true });
  }
});

test("Cursor static bundle above 768 MiB is refused before runtime probing", async () => {
  const privateRoot = await mkdtemp(path.join(os.tmpdir(), "relaypact-oversized-bundle-"));
  try {
    const command = await nodeCursorFixture(privateRoot, source => source);
    const companion = path.join(path.dirname(command), "cursor-agent-sea");
    await writeFile(companion, "");
    await truncate(companion, 768 * 1024 * 1024 + 1);
    let probes = 0;
    const identity = await resolveCursorExecutable(command, {
      async runProcess() { probes++; throw new Error("oversized bundle must not execute"); }
    });
    assert.equal(identity, null);
    assert.equal(probes, 0);
  } finally {
    await rm(privateRoot, { recursive: true, force: true });
  }
});

test("Cursor cold correction probe failure preserves signed task state", async () => {
  const root = await createGitRepository();
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "relaypact-cold-correction-"));
  try {
    const first = await runDelegation(makeEnvelope(root, { taskId: "cursor-lifecycle" }), {
      executorCommand: fakeCursor, stateRoot, hostInstanceId: "cursor-host-1"
    });
    const before = await readFile(first.statePath, "utf8");
    const adapterUrl = new URL("../packages/adapter-codex-cursor/src/run-delegation.mjs", import.meta.url).href;
    const script = `
      const { correctDelegation } = await import(process.argv[1]);
      let calls = 0;
      try {
        await correctDelegation(process.argv[2], "Keep the same task scope.", {
          async runProcess(_command, args) {
            calls++;
            if (JSON.stringify(args) !== JSON.stringify(["--use-system-ca", "--version"])) {
              throw new Error("unexpected executor launch");
            }
            return { exitCode: null, timedOut: true, stdout: "", stderr: "" };
          }
        });
        throw new Error("correction unexpectedly started");
      } catch (error) {
        if (error.code !== "cursor_runtime_probe_unavailable") throw error;
        console.log(JSON.stringify({ code: error.code, calls }));
      }
    `;
    const { stdout } = await execFileAsync(process.execPath,
      ["--input-type=module", "-e", script, adapterUrl, first.taskRoot]);
    assert.deepEqual(JSON.parse(stdout), { code: "cursor_runtime_probe_unavailable", calls: 1 });
    assert.equal(await readFile(first.statePath, "utf8"), before);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(stateRoot, { recursive: true, force: true });
  }
});


test("Cursor CLI blocked execution is nonzero for both one-shot and persistent review", async (context) => {
  const root = await createGitRepository();
  const inputs = await mkdtemp(path.join(os.tmpdir(), "relaypact-cursor-cli-blocked-"));
  context.after(async () => { await rm(root, { recursive: true, force: true }); await rm(inputs, { recursive: true, force: true }); });
  const envelope = path.join(inputs, "envelope.json"), state = path.join(inputs, "state");
  await mkdir(state);
  await writeFile(envelope, JSON.stringify(makeEnvelope(root, { taskId: "cursor-blocked" })));
  for (const extra of [[], ["--state-root", state, "--host-instance", "fixture-host"]]) {
    await assert.rejects(execFileAsync(process.execPath, [cli, "run-cursor", "--envelope", envelope, "--executor", fakeCursor, ...extra]), error => {
      assert.equal(error.code, 2, error.stderr || error.stdout);
      const result = JSON.parse(error.stdout);
      assert.equal(result.review?.executionResult.status ?? result.status, "blocked");
      assert.equal((result.review?.executionResult.hostAcceptance ?? result.hostAcceptance).status, "pending");
      return true;
    });
  }
});


test("persistent Cursor carries a larger evidence budget through correction and acceptance", async (t) => {
  const root = await createGitRepository();
  const privateRoot = await createDirectory();
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(privateRoot, { recursive: true, force: true }); });
  const archiveRoot = path.join(privateRoot, "archive");
  await mkdir(archiveRoot);
  await writeFile(path.join(root, ".git", "info", "exclude"), "dependencies.bin\n");
  await writeFile(path.join(root, "dependencies.bin"), "");
  await truncate(path.join(root, "dependencies.bin"), 512 * 1024 * 1024 + 1);
  const maxBytes = 600 * 1024 * 1024;
  const first = await runDelegation(makeEnvelope(root, { taskId: "cursor-lifecycle", execution: { filesystemEvidenceMaxBytes: maxBytes } }), {
    executorCommand: fakeCursor, stateRoot: privateRoot, hostInstanceId: "budget-host"
  });
  assert.equal(first.review.executionResult.validations[0].status, "passed");
  assert.equal(first.review.executionResult.filesystemEvidenceMaxBytes, maxBytes);
  const prepared = await loadDirectDelegation(first.taskRoot);
  assert.equal(prepared.state.filesystemEvidenceMaxBytes, maxBytes);
  const corrected = await correctDelegation(first.taskRoot, "Make the corrected edit.", { executorCommand: fakeCursor });
  assert.equal(corrected.review.executionResult.hostAcceptance.eligible, true);
  assert.equal(corrected.review.executionResult.filesystemEvidenceMaxBytes, maxBytes);
  const decided = await decideDelegation(first.taskRoot, "accept", "budget-host", archiveRoot);
  assert.equal(decided.acceptance.status, "accepted");
});

test("direct lifecycle rejects budget drift between signed state and envelope", async (t) => {
  const root = await createGitRepository();
  const stateRoot = await createDirectory();
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(stateRoot, { recursive: true, force: true }); });
  const prepared = await prepareDirectDelegation({
    envelope: makeEnvelope(root, { execution: { filesystemEvidenceMaxBytes: 1024 } }),
    stateRoot, hostInstanceId: "budget-host", routeId: "codex-cursor", executorHarness: "cursor", executionMode: "write"
  });
  const envelopePath = path.join(prepared.taskRoot, "task-envelope.json");
  const envelope = JSON.parse(await readFile(envelopePath, "utf8"));
  envelope.execution.filesystemEvidenceMaxBytes = 2048;
  await writeFile(envelopePath, JSON.stringify(envelope));
  await assert.rejects(loadDirectDelegation(prepared.taskRoot), { code: "task_state_mismatch" });
});

test("direct legacy state defaults to 512 MiB and signed budget mismatch is rejected", async (t) => {
  const root = await createGitRepository();
  const stateRoot = await createDirectory();
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(stateRoot, { recursive: true, force: true }); });
  const prepared = await prepareDirectDelegation({
    envelope: makeEnvelope(root), stateRoot, hostInstanceId: "budget-host",
    routeId: "codex-cursor", executorHarness: "cursor", executionMode: "write"
  });
  const store = createSignedStateStore(prepared.statePath, value => value);
  await store.withLock(async ({ read, persist }) => {
    const state = await read();
    delete state.filesystemEvidenceMaxBytes;
    await persist(state);
  });
  assert.equal((await loadDirectDelegation(prepared.taskRoot)).state.filesystemEvidenceMaxBytes, undefined);
  await store.withLock(async ({ read, persist }) => {
    await persist({ ...await read(), filesystemEvidenceMaxBytes: 1024 });
  });
  await assert.rejects(loadDirectDelegation(prepared.taskRoot), { code: "task_state_mismatch" });
});

// Exercise Node's own Error renderer, rather than hand-writing its wrapper.
const inspectedPermissionError = new Error("EACCES: permission denied, opendir '/workspace/private'");
inspectedPermissionError.stack = undefined;
Object.assign(inspectedPermissionError, { code: "EACCES", syscall: "opendir", path: "/workspace/private", session_id: "private-session" });
const inspectedPermissionText = format(inspectedPermissionError);
assert.ok(inspectedPermissionText.startsWith("[Error: EACCES:"));

for (const [name, stderr, recognized, overrides] of [
  ["empty-property-block", "[Error: EACCES: permission denied, opendir '/workspace'] {\n}", false, {}],
  ["blank-property-block", "[Error: EACCES: permission denied, opendir '/workspace'] {\n\n  \n\t\n}", false, {}],
  ["padded-property-block", "[Error: EACCES: permission denied, opendir '/workspace'] {\n  \n  code: 'EACCES'\n\t\n}", true, {}],
  ["unclosed-property-block", "[Error: EACCES: permission denied, opendir '/workspace'] {", false, {}],
  ["unclosed-property-values", "[Error: EACCES: permission denied, opendir '/workspace'] {\n  code: 'EACCES'", false, {}],
  ["property-value-brace", "[Error: EACCES: permission denied, opendir '/workspace'] {\n  value: '}'", false, {}],
  ["unrelated-close", "[Error: EACCES: permission denied, opendir '/workspace'] {\nunrelated output\n}", false, {}],
  ["property-close-trailing", "[Error: EACCES: permission denied, opendir '/workspace'] {\n} trailing", false, {}],
  ["complete-property-crlf", "[Error: EACCES: permission denied, opendir '/workspace'] {\r\n  code: 'EACCES'\r\n}\r\n", true, {}],
  ["apostrophe-path", "EACCES: permission denied, open '/tmp/lock'ed/file'", true, {}],
  ["apostrophe-two-paths", "Error: EPERM: operation not permitted, rename '/tmp/old's' -> '/tmp/new's'", true, {}],
  ["apostrophe-wrapper", "[Error: EACCES: permission denied, open '/tmp/lock'ed/file'] {\n  code: 'EACCES'\n}", true, {}],
  ["apostrophe-unclosed", "EACCES: permission denied, open '/tmp/lock'ed/file", false, {}],
  ["node-inspected-error", inspectedPermissionText, true, {}],
  ["bracketed-no-properties", "[Error: EPERM: operation not permitted, mkdir '/private/home']", true, {}],
  ["bracketed-rename", "[Error: EPERM: operation not permitted, rename '/old' -> '/new'] {\n  code: 'EPERM'\n}", true, {}],
  ["bracket-missing-close", "[Error: EACCES: permission denied, opendir '/workspace/private'", false, {}],
  ["bracket-missing-open", "Error: EACCES: permission denied, opendir '/workspace/private'] {", false, {}],
  ["bracket-trailing-text", "[Error: EACCES: permission denied, opendir '/workspace/private'] arbitrary", false, {}],
  ["bracket-incomplete-path", "[Error: EACCES: permission denied, opendir] {", false, {}],
  ["eperm", "Error: EPERM: operation not permitted, mkdir '/private/home/session-private'", true, {}],
  ["eacces", "EACCES: permission denied, open '/workspace/private'", true, {}],
  ["secrets", "Error: EPERM: operation not permitted, mkdir '/private/home'\nBearer sensitive-provider-value session_id=private-session api_key=private-key", true, {}],
  ["opendir", "Error: EACCES: permission denied, opendir '/workspace'", true, {}],
  ["mkdtemp", "Error: EACCES: permission denied, mkdtemp '/workspace/prefixXXXXXX'", true, {}],
  ["opendir-missing-path", "EACCES: permission denied, opendir", false, {}],
  ["mkdtemp-unclosed-path", "EACCES: permission denied, mkdtemp '/workspace/prefixXXXXXX", false, {}],
  ["lstat", "Error: EACCES: permission denied, lstat '/workspace'", true, {}],
  ["chmod", "Error: EPERM: operation not permitted, chmod '/workspace'", true, {}],
  ["rename", "Error: EACCES: permission denied, rename '/old' -> '/new'", true, {}],
  ["crlf-stack", "Error: EPERM: operation not permitted, mkdir '/workspace'\r\n    at nativeCall", true, {}],
  ["provider-text", "EACCES: permission denied, open provider connection", false, {}],
  ["missing-path", "EPERM: operation not permitted, mkdir", false, {}],
  ["unclosed-path", "EPERM: operation not permitted, mkdir '/workspace", false, {}],
  ["trailing-text", "EPERM: operation not permitted, mkdir '/workspace' unrelated", false, {}],
  ["rename-missing-destination", "EPERM: operation not permitted, rename '/workspace'", false, {}],
  ["unknown-operation", "EPERM: operation not permitted, connect '/workspace'", false, {}],
  ["unknown", "provider failed: private-provider-response", false, {}],
  ["malformed", '{"message":"EPERM"}', false, {}],
  ["oversized", "Error: EPERM: operation not permitted, mkdir " + "x".repeat(8192), false, {}],
  ["truncated", "Error: EPERM: operation not permitted, mkdir '/private/home'", false, { stderrTruncated: true }],
  ["timeout", "Error: EPERM: operation not permitted, mkdir '/private/home'", false, { timedOut: true }],
  ["cancelled", "Error: EPERM: operation not permitted, mkdir '/private/home'", false, { cancelled: true }]
]) {
  test(`Cursor failure evidence safely classifies ${name}`, async (t) => {
    const root = await createGitRepository();
    t.after(() => rm(root, { recursive: true, force: true }));
    const result = await runDelegation(makeEnvelope(root, { validation: [] }), {
      readOnly: true,
      readiness: { state: "ready", command: "cursor-agent", version: "2026.08.31-test", authenticated: true, structuredOutput: true,
        capabilities: { boundedWorkspace: true, sandbox: true, force: true, resume: true } },
      async runProcess() { return { exitCode: 1, signal: null, stdout: "", stderr, ...overrides }; }
    });
    assert.equal(result.status, "failed");
    assert.equal(result.hostAcceptance.eligible, false);
    assert.deepEqual(result.changedPaths, []);
    assert.equal(result.executor.summary.includes("filesystem permission denial"), recognized);
    const serialized = JSON.stringify(result);
    for (const secret of ["/private/home", "session-private", "private-session", "private-key", "sensitive-provider-value", "private-provider-response", "'/workspace/private'"]) {
      assert.equal(serialized.includes(secret), false, secret);
    }
    assert.ok(result.executor.summary.length < 300);
  });
}

async function checkpointFixture(t, existingRef = false, directRef = false) {
  const f = await staleRetirementFixture(t, true, typeof existingRef === "function" ? existingRef : existingRef ? root => execFileSync("git", ["update-ref", "refs/aux-checkpoints/existing/1", execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim()], { cwd: root }) : undefined);
  const git = (args, input) => execFileSync("git", args, { cwd: f.root, input, encoding: "utf8" }).trim();
  const ref = "refs/aux-checkpoints/practice/1";
  const saved = JSON.parse(await readFile(path.join(f.first.taskRoot, "evidence", "git-controls-1.json")));
  const blob = git(["hash-object", "-w", "--stdin"], "synthetic checkpoint\n");
  const tree = git(["mktree"], `100644 blob ${blob}\tcheckpoint.txt\n`);
  const commit = git(["commit-tree", tree, "-p", git(["rev-parse", "HEAD"]), "-m", "synthetic checkpoint"]);
  if (directRef) { await mkdir(path.dirname(path.join(f.root, ".git", ref)), { recursive: true }); await writeFile(path.join(f.root, ".git", ref), `${commit}\n`); }
  else git(["update-ref", ref, commit]);
  async function proof(refs = [ref]) {
    const controls = await snapshotGitControls(f.root, { excludeIndexes: true, includeDirectories: true });
    const old = new Set([...saved.controls.entries, ...saved.controls.directories].map(entry => entry.path));
    return { schemaVersion: "1.0.0", stateIntegrity: f.prepared.state.integrity, actor: "host", reason: "Approve synthetic checkpoint additions only",
      filesystemFingerprint: (await snapshotFilesystem(f.root, { exclude: [".git"] })).fingerprint,
      observationFingerprint: checkpointObservationFingerprint(controls), checkpointRefs: refs,
      addedPaths: [...controls.entries, ...controls.directories].filter(entry => !old.has(entry.path)).map(entry => entry.path.replace(/^store-[a-f0-9]+\//u, "")) };
  }
  return { ...f, git, ref, blob, tree, commit, saved, proof };
}

async function checkpointCurrent(f) {
  return { state: await readFile(f.first.statePath), review: await readFile(f.first.evidence.reviewPath),
    controls: checkpointObservationFingerprint(await snapshotGitControls(f.root, { excludeIndexes: true, includeDirectories: true })),
    filesystem: (await snapshotFilesystem(f.root, { exclude: [".git"] })).fingerprint, index: (await snapshotGitIndex(f.root)).fingerprint };
}

test("checkpoint retirement CLI preserves approved corrected review and all repository data", async t => {
  const f = await checkpointFixture(t), proof = await f.proof(), before = await checkpointCurrent(f);
  for (const action of ["accept", "reject", "abandon"]) await assert.rejects(decideDelegation(f.first.taskRoot, action, "host", f.archiveRoot), { code: "stale_review" });
  await assert.rejects(decideDelegation(f.first.taskRoot, "abandon", "host", f.archiveRoot, { retireStaleReview: true }), { code: "stale_review" });
  const file = path.join(f.stateRoot, "checkpoint.json"); await writeFile(file, JSON.stringify(proof), { mode: 0o600 });
  const args = [cli, "decide-cursor", "--task-root", f.first.taskRoot, "--action", "abandon", "--actor", "host", "--archive-root", f.archiveRoot, "--retire-stale-review", "--checkpoint-evidence", file];
  const result = JSON.parse((await execFileAsync(process.execPath, args)).stdout);
  assert.equal(result.lifecycleState, "abandoned"); assert.equal(result.acceptance.eligible, false);
  const archive = JSON.parse(await readFile(result.archive.reviewPath));
  assert.deepEqual(archive.staleReviewRetirement.originalReview, f.originalReview);
  assert.deepEqual(archive.staleReviewRetirement.checkpoint.originalControls, f.saved.controls);
  assert.equal(archive.staleReviewRetirement.checkpoint.approval.observationFingerprint, before.controls);
  assert.equal(checkpointObservationFingerprint(await snapshotGitControls(f.root, { excludeIndexes: true, includeDirectories: true })), before.controls);
  assert.equal((await snapshotFilesystem(f.root, { exclude: [".git"] })).fingerprint, before.filesystem);
  assert.equal((await snapshotGitIndex(f.root)).fingerprint, before.index);
  assert.equal(f.git(["rev-parse", f.ref]), f.commit);
  assert.deepEqual(JSON.parse((await execFileAsync(process.execPath, args)).stdout), result);
});

for (const hazard of ["state", "actor", "reason", "paths", "observation", "filesystem", "legacy", "baseline", "unreferenced", "config", "index", "HEAD", "branch", "ref-rewrite", "empty-directory", "directory-replacement", "reserved-ref", "malformed-object", "signature", "unsettled", "live-lock", "proof-symlink", "proof-size", "too-many-refs", "object-hardlink", "commondir", "OID", "proof-permissions"]) {
  test(`checkpoint retirement refuses ${hazard} and preserves current evidence`, async t => {
    const f = await checkpointFixture(t, hazard === "ref-rewrite"); let proof = await f.proof();
    if (hazard === "state") proof.stateIntegrity = "forged";
    if (hazard === "actor") proof.actor = "other";
    if (hazard === "reason") proof.reason = "";
    if (hazard === "paths") proof.addedPaths.pop();
    if (hazard === "observation") proof.observationFingerprint = "0".repeat(64);
    if (hazard === "filesystem") proof.filesystemFingerprint = "0".repeat(64);
    const baseline = path.join(f.first.taskRoot, "evidence", "git-controls-1.json");
    if (hazard === "legacy") await rm(baseline);
    if (hazard === "baseline") await writeFile(baseline, JSON.stringify({ ...f.saved, integrity: "forged" }));
    if (hazard === "unreferenced") f.git(["hash-object", "-w", "--stdin"], "unreferenced blob\n");
    if (hazard === "config") f.git(["config", "test.checkpoint", "changed"]);
    if (hazard === "index") { const [mode, oid] = f.git(["ls-files", "-s"]).split("\n")[0].split(/\s+/u); f.git(["update-index", "--add", "--cacheinfo", `${mode},${oid},index-alias.txt`]); }
    if (hazard === "HEAD") f.git(["commit", "--allow-empty", "-m", "later development"]);
    if (hazard === "branch") f.git(["switch", "-c", "later-development"]);
    if (hazard === "ref-rewrite") f.git(["update-ref", "refs/aux-checkpoints/existing/1", f.commit]);
    if (hazard === "empty-directory") await mkdir(path.join(f.root, ".git", "unapproved-empty"));
    if (hazard === "directory-replacement") { const fingerprint = (await snapshotGitControls(f.root, { excludeIndexes: true })).fingerprint; await rename(path.join(f.root, ".git/refs/tags"), path.join(f.stateRoot, "original-tags")); await mkdir(path.join(f.root, ".git/refs/tags")); assert.equal((await snapshotGitControls(f.root, { excludeIndexes: true })).fingerprint, fingerprint); }
    if (hazard === "reserved-ref") { await writeFile(path.join(f.root, ".git/refs/heads/checkpoint"), `${f.commit}\n`); proof = await f.proof([f.ref, "refs/heads/checkpoint"]); }
    if (hazard === "malformed-object") { const object = path.join(f.root, ".git/objects", f.blob.slice(0, 2), f.blob.slice(2)); await chmod(object, 0o600); await writeFile(object, "malformed"); }
    if (hazard === "object-hardlink") await link(path.join(f.root, ".git/objects", f.blob.slice(0, 2), f.blob.slice(2)), path.join(f.stateRoot, "shared-object"));
    if (hazard === "commondir") await writeFile(path.join(f.root, ".git/commondir"), ".\n");
    if (hazard === "OID") { const old = path.join(f.root, ".git/objects", f.blob.slice(0, 2), f.blob.slice(2)); await chmod(old, 0o600); const { deflateSync } = await import("node:zlib"); await writeFile(old, deflateSync(Buffer.from("blob 1\0x"))); }
    if (hazard === "proof-permissions") { const file = path.join(f.stateRoot, "proof.json"); await writeFile(file, JSON.stringify(proof)); await chmod(file, 0o644); proof = file; }
    if (hazard === "signature") await writeFile(f.first.statePath, JSON.stringify({ ...f.prepared.state, hostInstanceId: "forged" }));
    if (hazard === "unsettled") await createSignedStateStore(f.first.statePath, () => {}).persist({ ...f.prepared.state, executionSettled: false });
    if (["unreferenced", "config", "index", "HEAD", "branch", "ref-rewrite", "empty-directory", "directory-replacement", "malformed-object", "OID", "commondir"].includes(hazard)) proof = await f.proof();
    if (hazard === "too-many-refs") { const refs = [f.ref, ...Array.from({ length: 16 }, (_, n) => `refs/aux/r${n}`)]; for (const ref of refs.slice(1)) f.git(["update-ref", ref, f.commit]); proof = await f.proof(refs); }
    if (hazard === "proof-symlink" || hazard === "proof-size") {
      const file = path.join(f.stateRoot, "proof.json"); await writeFile(file, hazard === "proof-size" ? JSON.stringify(proof) + " ".repeat(256 * 1024) : JSON.stringify(proof), { mode: 0o600 });
      if (hazard === "proof-symlink") { await symlink(file, file + ".link"); proof = file + ".link"; } else proof = file;
    }
    const before = await checkpointCurrent(f), decide = () => decideDelegation(f.first.taskRoot, "abandon", "host", f.archiveRoot, { retireStaleReview: true, checkpointEvidence: proof });
    if (hazard === "live-lock") await createSignedStateStore(f.first.statePath, () => {}).withLock(async () => assert.rejects(decide(), { code: "task_state_busy" }));
    else await assert.rejects(decide());
    assert.deepEqual(await checkpointCurrent(f), before); assert.deepEqual(await readdir(f.archiveRoot), []);
  });
}

for (const phase of ["beforeFinalBasisCheck", "afterTerminalStateCommit"]) {
  test(`checkpoint retirement refuses full control drift at ${phase}`, async t => {
    const f = await checkpointFixture(t), proof = await f.proof();
    await assert.rejects(finalizeDirectTerminalDecision(f.prepared, "abandon", "host", f.archiveRoot, {
      retireStaleReview: true, checkpointEvidence: proof,
      [phase]: async () => { await rename(path.join(f.root, ".git/refs/tags"), path.join(f.stateRoot, "original-tags")); await mkdir(path.join(f.root, ".git/refs/tags")); }
    }), { code: "stale_review" });
    assert.equal((await loadDirectDelegation(f.first.taskRoot)).state.lifecycleState, "awaiting_review");
    assert.deepEqual(await readdir(f.archiveRoot), []);
  });
}

test("checkpoint retirement partial cleanup keeps signed proof and original retry authority", async t => {
  const f = await checkpointFixture(t), proof = await f.proof();
  await assert.rejects(finalizeDirectTerminalDecision(f.prepared, "abandon", "host", f.archiveRoot, {
    retireStaleReview: true, checkpointEvidence: proof, async removeTask(root) { await rm(path.join(root, "state.json")); throw new Error("partial cleanup"); }
  }), /partial cleanup/u);
  f.git(["hash-object", "-w", "--stdin"], "later independent work\n");
  await assert.rejects(decideDelegation(f.first.taskRoot, "abandon", "other", f.archiveRoot), { code: "cleanup_refused" });
  const result = await decideDelegation(f.first.taskRoot, "abandon", "host", f.archiveRoot);
  assert.equal(result.acceptance.eligible, false); assert.equal(f.git(["rev-parse", f.ref]), f.commit);
});

for (const action of ["accept", "reject", "abandon-without-opt-in"]) {
  test(`checkpoint retirement option refuses ${action}`, async t => {
    const f = await checkpointFixture(t);
    await assert.rejects(decideDelegation(f.first.taskRoot, action.startsWith("abandon") ? "abandon" : action, "host", f.archiveRoot, {
      retireStaleReview: action !== "abandon-without-opt-in", checkpointEvidence: await f.proof()
    }), { code: "invalid_host_action" });
  });
}

for (const budget of ["object-size", "total-inflated", "graph-depth"]) {
  test(`checkpoint retirement refuses ${budget} overflow`, async t => {
    const f = await checkpointFixture(t), { createHash } = await import("node:crypto"), { deflateSync } = await import("node:zlib");
    let parent = f.commit;
    for (let n = 0; n < (budget === "graph-depth" ? 257 : budget === "total-inflated" ? 6 : 1); n += 1) {
      const body = Buffer.from(`tree ${f.tree}\nparent ${parent}\nauthor Fixture <fixture@example.invalid> 1 +0000\ncommitter Fixture <fixture@example.invalid> 1 +0000\n\n` + "x".repeat(budget === "object-size" ? 17 * 1024 * 1024 : budget === "total-inflated" ? 12 * 1024 * 1024 : 1));
      const object = Buffer.concat([Buffer.from(`commit ${body.length}\0`), body]);
      parent = createHash("sha1").update(object).digest("hex");
      const dir = path.join(f.root, ".git/objects", parent.slice(0, 2)); await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, parent.slice(2)), deflateSync(object));
    }
    f.git(["update-ref", f.ref, parent]);
    const before = await checkpointCurrent(f);
    await assert.rejects(decideDelegation(f.first.taskRoot, "abandon", "host", f.archiveRoot, { retireStaleReview: true, checkpointEvidence: await f.proof() }), { code: "checkpoint_evidence_invalid" });
    assert.deepEqual(await checkpointCurrent(f), before); assert.deepEqual(await readdir(f.archiveRoot), []);
  });
}

test("checkpoint retirement serializes concurrent valid decisions", async t => {
  const f = await checkpointFixture(t), proof = await f.proof();
  const results = await Promise.allSettled([1, 2].map(() => decideDelegation(f.first.taskRoot, "abandon", "host", f.archiveRoot, { retireStaleReview: true, checkpointEvidence: proof })));
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1); assert.equal((await readdir(f.archiveRoot)).length, 1);
});

for (const packedRef of ["refs/aux-checkpoints/practice/1", "refs/aux-checkpoints/practice", "refs/aux-checkpoints/practice/1/child", "refs/aux-checkpoints/PRACTICE/1", "refs/aux-checkpoints/PRACTICE", "refs/aux-checkpoints/PRACTICE/1/CHILD", "refs/aux-checkpoints/unrelated"]) {
  test(`checkpoint retirement checks packed ref collision ${packedRef}`, async t => {
    const f = await checkpointFixture(t, root => {
      execFileSync("git", ["update-ref", packedRef, "HEAD"], { cwd: root });
      execFileSync("git", ["pack-refs", "--all", "--prune"], { cwd: root });
    }, true);
    const before = await checkpointCurrent(f), proof = await f.proof();
    const decide = () => decideDelegation(f.first.taskRoot, "abandon", "host", f.archiveRoot, { retireStaleReview: true, checkpointEvidence: proof });
    if (packedRef.endsWith("unrelated")) assert.equal((await decide()).acceptance.eligible, false);
    else { await assert.rejects(decide(), { code: "checkpoint_evidence_invalid" }); assert.deepEqual(await checkpointCurrent(f), before); assert.deepEqual(await readdir(f.archiveRoot), []); }
  });
}

test("checkpoint retirement refuses trailing compressed bytes", async t => {
  const f = await checkpointFixture(t), file = path.join(f.root, ".git/objects", f.blob.slice(0, 2), f.blob.slice(2));
  await chmod(file, 0o600); await writeFile(file, Buffer.concat([await readFile(file), Buffer.from("trailing garbage")]));
  const before = await checkpointCurrent(f);
  await assert.rejects(decideDelegation(f.first.taskRoot, "abandon", "host", f.archiveRoot, { retireStaleReview: true, checkpointEvidence: await f.proof() }), { code: "checkpoint_evidence_invalid" });
  assert.deepEqual(await checkpointCurrent(f), before); assert.deepEqual(await readdir(f.archiveRoot), []);
});

for (const lateParent of [false, true]) {
  test(`checkpoint retirement follows Git parent ordering (late=${lateParent})`, async t => {
    const f = await checkpointFixture(t), who = "Fixture <fixture@example.invalid> 1 +0000";
    const hidden = f.git(["commit-tree", f.tree, "-m", "otherwise unreachable"]);
    const headers = `author ${who}\ncommitter ${who}\n`;
    const body = `tree ${f.tree}\nparent ${f.commit}\n${lateParent ? headers : ""}parent ${hidden}\n${lateParent ? "" : headers}\ntip\n`;
    const tip = f.git(["hash-object", "-t", "commit", "-w", "--stdin"], body);
    f.git(["update-ref", f.ref, tip]);
    assert.equal(f.git(["rev-list", f.ref]).split("\n").includes(hidden), !lateParent);
    const before = await checkpointCurrent(f), proof = await f.proof();
    const decide = () => decideDelegation(f.first.taskRoot, "abandon", "host", f.archiveRoot, { retireStaleReview: true, checkpointEvidence: proof });
    if (!lateParent) assert.equal((await decide()).acceptance.eligible, false);
    else { await assert.rejects(decide(), { code: "checkpoint_evidence_invalid" }); assert.deepEqual(await checkpointCurrent(f), before); assert.deepEqual(await readdir(f.archiveRoot), []); }
  });
}

test("checkpoint retirement accepts sixteen real auxiliary refs", async t => {
  const f = await checkpointFixture(t), refs = [f.ref, ...Array.from({ length: 15 }, (_, n) => `refs/aux/r${n}`)];
  for (const ref of refs.slice(1)) f.git(["update-ref", ref, f.commit]);
  const result = await decideDelegation(f.first.taskRoot, "abandon", "host", f.archiveRoot, { retireStaleReview: true, checkpointEvidence: await f.proof(refs) });
  assert.equal(result.lifecycleState, "abandoned"); assert.equal(result.acceptance.eligible, false);
});


test("checkpoint retirement accepts an unrelated packed UTF-8 ref containing byte A0", async t => {
  const ref = "refs/aux-other/cafà";
  const f = await checkpointFixture(t, root => {
    execFileSync("git", ["update-ref", ref, "HEAD"], { cwd: root });
    execFileSync("git", ["pack-refs", "--all", "--prune"], { cwd: root });
  }, true);
  assert.ok((await readFile(path.join(f.root, ".git/packed-refs"))).includes(0xa0));
  const result = await decideDelegation(f.first.taskRoot, "abandon", "host", f.archiveRoot, { retireStaleReview: true, checkpointEvidence: await f.proof() });
  assert.equal(result.lifecycleState, "abandoned"); assert.equal(result.acceptance.eligible, false);
  assert.equal(f.git(["rev-parse", ref]), f.git(["rev-parse", "HEAD"]));
});

for (const hazard of ["valid", "malformed", "hash", "size"]) {
  test(`checkpoint retirement packed reader independently checks ${hazard}`, async t => {
    const { createHash } = await import("node:crypto");
    const root = await createDirectory(); t.after(() => rm(root, { recursive: true, force: true }));
    const file = path.join(root, "packed-refs"), oid = "a".repeat(40);
    const bytes = Buffer.from(hazard === "malformed" ? "garbage line\n" : `${oid} refs/aux-other/cafà\n`);
    await writeFile(file, bytes);
    const entry = { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    if (hazard === "hash") entry.sha256 = "0".repeat(64);
    if (hazard === "size") entry.bytes += 1;
    const check = () => assertPackedRefsUnshadowed(file, entry, ["refs/aux-checkpoints/new"], () => {});
    if (hazard === "valid") await check();
    else await assert.rejects(check(), { code: "checkpoint_evidence_invalid" });
    assert.deepEqual(await readFile(file), bytes);
  });
}
