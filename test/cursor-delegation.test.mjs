import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
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
  authorizeDirectCorrection,
  beginDirectDelegation,
  failDirectDelegation,
  finalizeDirectTerminalDecision,
  loadDirectDelegation,
  prepareDirectDelegation,
  recordDirectDelegationResult
} from "../packages/core/src/direct-lifecycle.mjs";
import { createDirectory, createGitRepository, makeEnvelope } from "./helpers.mjs";

const fakeCursor = fileURLToPath(new URL("./fixtures/fake-cursor-agent.sh", import.meta.url));
const fakeCursorImplementation = fileURLToPath(new URL("./fixtures/fake-cursor-agent.mjs", import.meta.url));
const fakeCursorPackage = fileURLToPath(new URL("./fixtures/package.json", import.meta.url));
const cli = fileURLToPath(new URL("../bin/relaypact.mjs", import.meta.url));
const execFileAsync = promisify(execFile);
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
  const result = await execute(root, "read-only", { readOnly: true });
  assert.equal(result.status, "completed");
  assert.deepEqual(result.changedPaths, []);
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
      launchCommand: "/resolved/node",
      launchPrefix: ["/resolved/selected-cursor"],
      launcherFingerprint: `sha256:${"1".repeat(64)}`,
      launchCommandFingerprint: `sha256:${"2".repeat(64)}`,
      bundleRoot: "/resolved",
      bundleFingerprint: `sha256:${"3".repeat(64)}`,
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
    ["/resolved/selected-cursor", "--version"],
    ["/resolved/selected-cursor", "--help"]
  ]);
});

test("Cursor readiness refuses a CLI that lacks trust support", async () => {
  const readiness = await discoverCursorCli({
    executorCommand: "selected-cursor",
    resolveExecutable: async () => ({
      command: "/resolved/selected-cursor",
      launchCommand: "/resolved/node",
      launchPrefix: ["/resolved/selected-cursor"],
      launcherFingerprint: `sha256:${"1".repeat(64)}`,
      launchCommandFingerprint: `sha256:${"2".repeat(64)}`,
      bundleRoot: "/resolved",
      bundleFingerprint: `sha256:${"3".repeat(64)}`,
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
    const first = await runDelegation(makeEnvelope(root, { taskId: "cursor-read-only" }), {
      executorCommand: fakeCursor,
      readOnly: true,
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
    copyFile(fakeCursorImplementation, path.join(privateRoot, "fake-cursor-agent.mjs")),
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
    copyFile(fakeCursorImplementation, path.join(privateRoot, "fake-cursor-agent.mjs")),
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

test("Cursor execution launches verified private snapshots after original path replacement", async () => {
  const root = await createGitRepository();
  const privateRoot = await mkdtemp(path.join(os.tmpdir(), "relaypact-cursor-launch-snapshot-"));
  const mutableCursor = path.join(privateRoot, "cursor-agent");
  const marker = path.join(privateRoot, "mutable-path-executed");
  await Promise.all([
    copyFile(fakeCursor, mutableCursor),
    copyFile(fakeCursorImplementation, path.join(privateRoot, "fake-cursor-agent.mjs")),
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
  const mutableImplementation = path.join(privateRoot, "fake-cursor-agent.mjs");
  const marker = path.join(privateRoot, "mutable-companion-executed");
  await Promise.all([
    copyFile(fakeCursor, mutableCursor),
    copyFile(fakeCursorImplementation, mutableImplementation),
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
    const mutableImplementation = path.join(privateRoot, "fake-cursor-agent.mjs");
    await Promise.all([
      copyFile(fakeCursor, mutableCursor),
      copyFile(fakeCursorImplementation, mutableImplementation),
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
    assert.equal(loaded.state.executorCommand, fakeCursor);
    assert.match(loaded.state.executorFingerprint, /^sha256:[a-f0-9]{64}$/u);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(stateRoot, { recursive: true, force: true });
  }
});
