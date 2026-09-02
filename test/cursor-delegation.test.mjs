import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  runExecutor
} from "../packages/executor-cursor/src/executor.mjs";
import {
  authorizeDirectCorrection,
  beginDirectDelegation,
  failDirectDelegation,
  loadDirectDelegation,
  prepareDirectDelegation,
  recordDirectDelegationResult
} from "../packages/core/src/direct-lifecycle.mjs";
import { createDirectory, createGitRepository, makeEnvelope } from "./helpers.mjs";

const fakeCursor = fileURLToPath(new URL("./fixtures/fake-cursor-agent.mjs", import.meta.url));
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
  assert.deepEqual(calls, ["selected-cursor"]);
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
      cli, "correct-cursor", "--task-root", first.taskRoot, "--prompt", promptPath,
      "--executor", fakeCursor
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
