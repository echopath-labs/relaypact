import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { runDelegation } from "../packages/adapter-codex-cursor/src/run-delegation.mjs";
import {
  assertCursorResumeSession,
  cursorSessionEvidence,
  discoverCursorCli,
  runExecutor
} from "../packages/executor-cursor/src/executor.mjs";
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
