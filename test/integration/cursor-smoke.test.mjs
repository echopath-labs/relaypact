import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { runDelegation } from "../../packages/adapter-codex-cursor/src/run-delegation.mjs";
import {
  assertCursorResumeSession,
  cursorSessionEvidence,
  discoverCursorCli,
  runExecutor
} from "../../packages/executor-cursor/src/executor.mjs";
import { createGitRepository, makeEnvelope } from "../helpers.mjs";

const readinessEnabled = process.env.RELAYPACT_CURSOR_READINESS === "1";
const executionEnabled = process.env.RELAYPACT_CURSOR_SMOKE === "1";

test("opt-in real Cursor readiness probe does not invoke a model", { skip: !readinessEnabled }, async (context) => {
  const result = await discoverCursorCli({ executorCommand: process.env.RELAYPACT_CURSOR_COMMAND });
  context.diagnostic(JSON.stringify({
    state: result.state,
    version: result.version,
    authenticated: result.authenticated,
    structuredOutput: result.structuredOutput,
    capabilities: result.capabilities
  }));
  assert.equal(result.state, "ready");
});

test("opt-in real Cursor read-only delegation", { skip: !executionEnabled }, async (context) => {
  const root = await createGitRepository();
  try {
    const result = await runDelegation(makeEnvelope(root, {
      taskId: "real-cursor-read-only",
      objective: "Inspect README.md and report that it contains the fixture heading without changing any file.",
      expectedOutcome: "The executor returns completed and the repository remains unchanged.",
      instructions: [
        "Read README.md.",
        "Do not create, edit, delete, rename, stage, or commit any file.",
        "Return the required structured completed result after confirming the heading."
      ],
      validation: [{
        id: "cursor-read-only-clean",
        argv: ["git", "diff", "--exit-code"],
        timeoutMs: 30_000
      }],
      execution: { timeoutMs: 300_000 }
    }), {
      executorCommand: process.env.RELAYPACT_CURSOR_COMMAND,
      readOnly: true
    });
    context.diagnostic(JSON.stringify({
      status: result.status,
      executorStatus: result.executor.reportedStatus,
      changedPathCount: result.changedPaths.length,
      scopeCompliant: result.scope.compliant,
      modelObservation: result.executor.modelObservation,
      acceptanceStatus: result.hostAcceptance.status
    }));
    assert.equal(result.status, "completed");
    assert.deepEqual(result.changedPaths, []);
    assert.equal(result.hostAcceptance.status, "pending");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("opt-in real Cursor bounded-write delegation", { skip: !executionEnabled }, async (context) => {
  const root = await createGitRepository();
  const outputFile = "allowed.txt";
  const outputContent = "delegated Cursor smoke ok\n";
  try {
    const result = await runDelegation(makeEnvelope(root, {
      taskId: "real-cursor-smoke",
      objective: `Create ${outputFile} with the exact requested content.`,
      expectedOutcome: `${outputFile} contains the requested content and validation passes.`,
      scope: { allowedPaths: [outputFile], forbiddenPaths: [".git/**", ".env", ".env.*"] },
      instructions: [`Create only ${outputFile}.`, `Its full content must be exactly ${JSON.stringify(outputContent)}.`],
      validation: [{
        id: "cursor-smoke-content",
        argv: [process.execPath, "-e", `const fs=require('node:fs');process.exit(fs.readFileSync(${JSON.stringify(outputFile)},'utf8')===${JSON.stringify(outputContent)}?0:1)`],
        timeoutMs: 30_000
      }],
      execution: { timeoutMs: 300_000 }
    }), { executorCommand: process.env.RELAYPACT_CURSOR_COMMAND });
    context.diagnostic(JSON.stringify({
      status: result.status,
      executorStatus: result.executor.reportedStatus,
      modelObservation: result.executor.modelObservation,
      changedPathCount: result.changedPaths.length,
      scopeCompliant: result.scope.compliant,
      acceptanceStatus: result.hostAcceptance.status
    }));
    assert.equal(result.status, "completed");
    assert.equal(await readFile(path.join(root, outputFile), "utf8"), outputContent);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("opt-in real Cursor same-session resume", { skip: !executionEnabled }, async (context) => {
  const root = await createGitRepository();
  const envelope = makeEnvelope(root, {
    taskId: "real-cursor-resume",
    objective: "Inspect README.md without changing files and return the required completed JSON result.",
    expectedOutcome: "The same Cursor session can be resumed without repository mutation.",
    instructions: [
      "Read README.md and do not change any file.",
      "Return the required structured completed result."
    ],
    execution: { timeoutMs: 300_000 }
  });
  try {
    const first = await runExecutor(envelope, {
      executorCommand: process.env.RELAYPACT_CURSOR_COMMAND,
      workingDirectory: root,
      readOnly: true
    });
    assert.equal(first.reportedStatus, "completed");
    const session = cursorSessionEvidence(first);
    assert.equal(session.resumable, true);

    const resumed = await runExecutor({
      ...envelope,
      objective: "Continue the same session, confirm README.md is still unchanged, and return the required completed JSON result."
    }, {
      executorCommand: process.env.RELAYPACT_CURSOR_COMMAND,
      workingDirectory: root,
      readOnly: true,
      resumeSessionId: assertCursorResumeSession(first)
    });
    context.diagnostic(JSON.stringify({
      firstStatus: first.reportedStatus,
      resumedStatus: resumed.reportedStatus,
      sessionDigest: session.digest,
      firstModelObservation: first.modelObservation,
      resumedModelObservation: resumed.modelObservation
    }));
    assert.equal(resumed.reportedStatus, "completed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("opt-in real Cursor cancellation", { skip: !executionEnabled }, async (context) => {
  const root = await createGitRepository();
  const controller = new AbortController();
  try {
    const readiness = await discoverCursorCli({ executorCommand: process.env.RELAYPACT_CURSOR_COMMAND });
    assert.equal(readiness.state, "ready");
    const envelope = makeEnvelope(root, {
      taskId: "real-cursor-cancel",
      objective: "Run a local wait command for 30 seconds, then return the required structured completed result.",
      expectedOutcome: "The host cancels the delegated execution before completion.",
      instructions: [
        `Run ${process.execPath} -e ${JSON.stringify("setTimeout(() => {}, 30000)")}.`,
        "After it finishes, return the required structured completed result."
      ],
      execution: { timeoutMs: 120_000 }
    });
    const execution = runExecutor(envelope, {
      executorCommand: process.env.RELAYPACT_CURSOR_COMMAND,
      workingDirectory: root,
      readiness,
      signal: controller.signal
    });
    const abortTimer = setTimeout(() => controller.abort(), 5_000);
    const result = await execution;
    clearTimeout(abortTimer);
    context.diagnostic(JSON.stringify({
      reportedStatus: result.reportedStatus,
      cancelled: result.cancelled,
      timedOut: result.timedOut,
      signal: result.signal
    }));
    assert.equal(result.reportedStatus, "failed");
    assert.equal(result.cancelled, true);
    assert.equal(result.timedOut, false);
  } finally {
    controller.abort();
    await rm(root, { recursive: true, force: true });
  }
});
