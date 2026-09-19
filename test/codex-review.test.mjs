import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, appendFile, mkdir, mkdtemp, readFile, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { archiveAndCleanupTerminalTask, recordTerminalDecision } from "../packages/host-codex/src/actions.mjs";
import { executeCodexDelegation, prepareCodexDelegation } from "../packages/adapter-codex-codex/src/controller.mjs";
import { buildHostReviewPacket, extractAggregateMetrics, persistPendingReview } from "../packages/host-codex/src/review.mjs";
import { authorizeCorrection, readTaskState } from "../packages/executor-codex/src/state.mjs";
import { snapshotGitIndex } from "../packages/core/src/git.mjs";
import { createGitRepository, makeEnvelope } from "./helpers.mjs";

const execFileAsync = promisify(execFile);

const profileRegistry = {
  schemaVersion: "1.0.0",
  profiles: { worker: { model: "worker-model", external: true } }
};

const compatibilityProcess = async (_command, args) => {
  if (args[0] === "--version") return { exitCode: 0, stdout: "codex-cli 0.147.0", stderr: "" };
  if (args[1] === "resume") return { exitCode: 0, stdout: "Resume --json", stderr: "" };
  return { exitCode: 0, stdout: "--json --output-schema --profile --sandbox", stderr: "" };
};

const completed = {
  schemaVersion: "1.0.0",
  taskId: "test-task",
  status: "completed",
  summary: "Completed the bounded edit.",
  changedFiles: ["allowed.txt"],
  validations: [],
  residualRisks: [],
  blocking: null
};

async function executeFixture(overrides = {}) {
  const root = await createGitRepository();
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "relaypact-review-state-"));
  const resolvedOverrides = typeof overrides === "function" ? overrides(root) : overrides;
  const envelope = makeEnvelope(root, {
    executionProfile: "worker",
    scope: { readablePaths: ["README.md"] },
    ...resolvedOverrides
  });
  const prepared = await prepareCodexDelegation({ envelope, profileRegistry, stateRoot, hostInstanceId: "desktop-host-1" }, { compatibilityProcess });
  const execution = await executeCodexDelegation(prepared, {
    codexHome: path.join(prepared.capsule.taskRoot, "codex-home"),
    runProcess: async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stderr: "",
      stdout: `${JSON.stringify({ type: "thread.started", thread_id: "worker-thread-1" })}\n${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 9 } })}\n`
    }),
    readResultFile: async () => JSON.stringify(completed)
  });
  return { root, prepared, execution };
}

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function rehashReview(review) {
  const { reviewIdentity, ...packet } = review.packet;
  const input = { packet, candidatePatchSha256: sha256(review.candidatePatch ?? "") };
  review.packet.reviewIdentity = {
    ...reviewIdentity,
    candidatePatchSha256: input.candidatePatchSha256,
    fingerprint: sha256(canonicalize(input))
  };
}

test("host review separates worker claims, observed evidence, and validation", async () => {
  const fixture = await executeFixture();
  await writeFile(path.join(fixture.prepared.capsule.capsuleRoot, "allowed.txt"), "bounded change\n");
  const review = await buildHostReviewPacket(fixture.prepared, fixture.execution, { durationMs: 125 });
  assert.equal(review.packet.executorSelfReport.summary, completed.summary);
  assert.equal(review.packet.contextEvidence.plan.mode, "explicit");
  assert.equal(review.packet.contextEvidence.readiness.outcome, "not_configured");
  assert.equal(review.packet.contextEvidence.executorContextGap, null);
  assert.deepEqual(review.packet.hostObserved.changedPaths, ["allowed.txt"]);
  assert.equal(review.packet.hostObserved.filesystemEvidenceMaxBytes, 536870912);
  assert.deepEqual(review.packet.hostObserved.scopeBreaches, []);
  assert.equal(review.packet.validations[0].status, "passed");
  assert.equal(review.packet.acceptance.status, "pending");
  assert.equal(review.packet.acceptance.eligible, true);
  assert.equal(review.packet.metrics.relaypactDeclaredInputBytes, fixture.execution.relaypactInput.relaypactDeclaredInputBytes);
  assert.match(review.candidatePatch, /bounded change/);
});

test("terminal review rebuild preserves HMAC-bound RelayPact input metrics", async () => {
  const fixture = await executeFixture();
  await writeFile(path.join(fixture.prepared.capsule.capsuleRoot, "allowed.txt"), "bounded change\n");
  const review = await buildHostReviewPacket(fixture.prepared, fixture.execution);
  const decided = await recordTerminalDecision(fixture.prepared, review, "accept", "desktop-host-1");
  assert.deepEqual(
    {
      relaypactPromptBytes: decided.packet.metrics.relaypactPromptBytes,
      relaypactResultSchemaBytes: decided.packet.metrics.relaypactResultSchemaBytes,
      relaypactDeclaredInputBytes: decided.packet.metrics.relaypactDeclaredInputBytes
    },
    fixture.execution.relaypactInput
  );
});

test("host review prefers HMAC-bound input metrics over caller-supplied execution values", async () => {
  const fixture = await executeFixture();
  await writeFile(path.join(fixture.prepared.capsule.capsuleRoot, "allowed.txt"), "bounded change\n");
  const review = await buildHostReviewPacket(fixture.prepared, {
    ...fixture.execution,
    relaypactInput: {
      relaypactPromptBytes: 1,
      relaypactResultSchemaBytes: 1,
      relaypactDeclaredInputBytes: 2
    }
  });
  assert.equal(
    review.packet.metrics.relaypactDeclaredInputBytes,
    fixture.execution.relaypactInput.relaypactDeclaredInputBytes
  );
});

test("host-observed scope breach makes completion ineligible", async () => {
  const fixture = await executeFixture();
  await writeFile(path.join(fixture.prepared.capsule.capsuleRoot, "private.txt"), "breach\n");
  const review = await buildHostReviewPacket(fixture.prepared, fixture.execution);
  assert.deepEqual(review.packet.hostObserved.scopeBreaches, ["private.txt"]);
  assert.equal(review.packet.acceptance.eligible, false);
  assert.equal(review.packet.validations[0].status, "not_run");
  await assert.rejects(
    recordTerminalDecision(fixture.prepared, review, "accept", "desktop-host-1"),
    (error) => error.code === "acceptance_ineligible"
  );
});

test("validation-time source mutation makes completion ineligible", async () => {
  const fixture = await executeFixture();
  await writeFile(path.join(fixture.prepared.capsule.capsuleRoot, "allowed.txt"), "bounded change\n");
  const review = await buildHostReviewPacket(fixture.prepared, fixture.execution, {
    runProcess: async () => {
      await writeFile(path.join(fixture.root, "README.md"), "mutated\n");
      return { exitCode: 0, signal: null, timedOut: false, stdout: "passed", stderr: "" };
    }
  });
  assert.equal(review.packet.validations[0].status, "passed");
  assert.equal(review.sourceUnchanged, false);
  assert.equal(review.packet.hostObserved.evidenceAvailable, false);
  assert.equal(review.packet.acceptance.eligible, false);
  assert.match(await readFile(path.join(fixture.root, "README.md"), "utf8"), /mutated/);
  assert(review.packet.unresolvedRisks.some((item) => item.includes("source workspace changed")));
});

test("validation-time source Git-control mutation makes completion ineligible", async () => {
  const fixture = await executeFixture();
  await writeFile(path.join(fixture.prepared.capsule.capsuleRoot, "allowed.txt"), "bounded change\n");
  const review = await buildHostReviewPacket(fixture.prepared, fixture.execution, {
    runProcess: async () => {
      await appendFile(path.join(fixture.root, ".git", "config"), "\n[relaypact-test]\n\tvalue = true\n");
      return { exitCode: 0, signal: null, timedOut: false, stdout: "passed", stderr: "" };
    }
  });
  assert.equal(review.sourceUnchanged, false);
  assert.equal(review.packet.acceptance.eligible, false);
  assert(review.packet.unresolvedRisks.some((item) => item.includes("source workspace changed")));
});

test("validation-time out-of-scope capsule mutation is final scope evidence", async () => {
  const fixture = await executeFixture({
    validation: [{
      id: "mutate-capsule",
      argv: [
        process.execPath,
        "-e",
        "require('node:fs').writeFileSync('private.txt', 'validation mutation\\n')"
      ],
      timeoutMs: 10_000
    }]
  });
  await writeFile(path.join(fixture.prepared.capsule.capsuleRoot, "allowed.txt"), "bounded change\n");
  const review = await buildHostReviewPacket(fixture.prepared, fixture.execution);
  assert.equal(review.packet.validations[0].status, "passed");
  assert.deepEqual(review.packet.hostObserved.changedPaths, ["allowed.txt", "private.txt"]);
  assert.deepEqual(review.packet.hostObserved.scopeBreaches, ["private.txt"]);
  assert.equal(review.packet.acceptance.eligible, false);
  assert.match(review.candidatePatch, /validation mutation/);
});

test("validation grants written into candidate files are never retained as evidence", async () => {
  const secret = "validation-only-secret-value";
  const fixture = await executeFixture();
  const review = await buildHostReviewPacket(fixture.prepared, fixture.execution, {
    validationEnv: { VALIDATION_SECRET: secret },
    runProcess: async () => {
      await writeFile(path.join(fixture.prepared.capsule.capsuleRoot, "allowed.txt"), `${secret}\n`);
      return { exitCode: 0, signal: null, timedOut: false, stdout: "passed", stderr: "" };
    }
  });
  assert.equal(review.packet.hostObserved.credentialEvidenceSafe, false);
  assert.equal(review.packet.acceptance.eligible, false);
  assert.equal(review.candidatePatch, "");
  assert.doesNotMatch(JSON.stringify(review), new RegExp(secret));
});

test("validation credential-bearing paths are omitted from retained review evidence", async () => {
  const secret = "validation-path-secret-value";
  const fixture = await executeFixture({
    scope: { allowedPaths: ["*.txt"], readablePaths: ["README.md"], forbiddenPaths: [] }
  });
  const review = await buildHostReviewPacket(fixture.prepared, fixture.execution, {
    validationEnv: { VALIDATION_SECRET: secret },
    runProcess: async () => {
      await writeFile(path.join(fixture.prepared.capsule.capsuleRoot, `${secret}.txt`), "safe contents\n");
      return { exitCode: 0, signal: null, timedOut: false, stdout: "passed", stderr: "" };
    }
  });
  assert.equal(review.packet.hostObserved.credentialEvidenceSafe, false);
  assert.deepEqual(review.packet.hostObserved.changedPaths, []);
  assert.ok(review.packet.hostObserved.scopeBreaches.includes("evidence:credential value detected"));
  assert.equal(review.packet.acceptance.eligible, false);
  assert.equal(review.candidatePatch, "");
  assert.doesNotMatch(JSON.stringify(review), new RegExp(secret));
});

test("Codex validation output redacts the complete worker and validation grant union", async () => {
  const root = await createGitRepository();
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "relaypact-review-state-"));
  const prepared = await prepareCodexDelegation({
    envelope: makeEnvelope(root, { executionProfile: "worker", scope: { readablePaths: ["README.md"] } }),
    profileRegistry,
    stateRoot,
    hostInstanceId: "desktop-host-1"
  }, { compatibilityProcess });
  const codexHome = path.join(prepared.capsule.taskRoot, "codex-home");
  const secret = "codex-worker-secret-decoded-by-validation";
  await mkdir(codexHome, { recursive: true });
  await writeFile(path.join(codexHome, "auth.json"), `${JSON.stringify({ OPENAI_API_KEY: secret })}\n`);
  const execution = await executeCodexDelegation(prepared, {
    codexHome,
    runProcess: async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stderr: "",
      stdout: `${JSON.stringify({ type: "thread.started", thread_id: "worker-validation-redaction" })}\n${JSON.stringify({ type: "turn.completed", usage: {} })}\n`
    }),
    readResultFile: async () => JSON.stringify(completed)
  });
  await writeFile(
    path.join(prepared.capsule.capsuleRoot, "allowed.txt"),
    `${Buffer.from(secret, "utf8").toString("base64")}\n`
  );
  const review = await buildHostReviewPacket(prepared, execution, {
    runProcess: async () => ({ exitCode: 0, signal: null, timedOut: false, stdout: secret, stderr: "" })
  });
  assert.equal(review.packet.validations[0].status, "passed");
  assert.match(review.packet.validations[0].summary, /REDACTED_EXACT_VALUE/);
  assert.equal(review.packet.acceptance.eligible, true);
  assert.doesNotMatch(JSON.stringify(review), new RegExp(secret));
});

test("validation uses the same immutable grant snapshot for binding and execution", async () => {
  const oldSecret = "first-validation-secret";
  const newSecret = "second-validation-secret";
  let reads = 0;
  const validationEnv = {};
  Object.defineProperty(validationEnv, "VALIDATION_SECRET", {
    enumerable: true,
    get() {
      reads += 1;
      return reads === 1 ? oldSecret : newSecret;
    }
  });
  const fixture = await executeFixture();
  const review = await buildHostReviewPacket(fixture.prepared, fixture.execution, {
    validationEnv,
    runProcess: async (_command, _args, options) => {
      await writeFile(path.join(fixture.prepared.capsule.capsuleRoot, "allowed.txt"), `${options.env.VALIDATION_SECRET}\n`);
      return { exitCode: 0, signal: null, timedOut: false, stdout: "passed", stderr: "" };
    }
  });
  assert.equal(reads, 1);
  assert.equal(review.packet.hostObserved.credentialEvidenceSafe, false);
  assert.equal(review.packet.acceptance.eligible, false);
  assert.equal(review.candidatePatch, "");
});

test("native credential rotation before review invalidates raw candidate evidence", async () => {
  const root = await createGitRepository();
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "relaypact-review-state-"));
  const prepared = await prepareCodexDelegation({
    envelope: makeEnvelope(root, { executionProfile: "worker", scope: { readablePaths: ["README.md"] } }),
    profileRegistry,
    stateRoot,
    hostInstanceId: "desktop-host-1"
  }, { compatibilityProcess });
  const codexHome = path.join(prepared.capsule.taskRoot, "codex-home");
  const oldSecret = "old-native-secret-value";
  const newSecret = "new-native-secret-value";
  await mkdir(codexHome, { recursive: true });
  await writeFile(path.join(codexHome, "auth.json"), `${JSON.stringify({ OPENAI_API_KEY: oldSecret })}\n`);
  const execution = await executeCodexDelegation(prepared, {
    codexHome,
    runProcess: async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stderr: "",
      stdout: `${JSON.stringify({ type: "thread.started", thread_id: "worker-thread-1" })}\n${JSON.stringify({ type: "turn.completed", usage: {} })}\n`
    }),
    readResultFile: async () => JSON.stringify(completed)
  });
  await writeFile(path.join(prepared.capsule.capsuleRoot, "allowed.txt"), `${oldSecret}\n`);
  await writeFile(path.join(codexHome, "auth.json"), `${JSON.stringify({ OPENAI_API_KEY: newSecret })}\n`);
  const review = await buildHostReviewPacket(prepared, execution);
  assert.equal(review.packet.hostObserved.credentialEvidenceSafe, false);
  assert.equal(review.packet.acceptance.eligible, false);
  assert.equal(review.candidatePatch, "");
  assert.doesNotMatch(JSON.stringify(review), new RegExp(oldSecret));
});

test("pending review evidence refuses a validation-created directory symlink", async () => {
  const fixture = await executeFixture();
  const redirected = await mkdtemp(path.join(os.tmpdir(), "relaypact-review-redirect-"));
  const review = await buildHostReviewPacket(fixture.prepared, fixture.execution, {
    runProcess: async () => {
      await symlink(redirected, path.join(fixture.prepared.capsule.taskRoot, "evidence"));
      return { exitCode: 0, signal: null, timedOut: false, stdout: "passed", stderr: "" };
    }
  });
  await assert.rejects(
    persistPendingReview(fixture.prepared, review),
    (error) => error.code === "evidence_path_invalid"
  );
});

test("ignored capsule mutation remains visible to host filesystem evidence", async () => {
  const fixture = await executeFixture({
    scope: { allowedPaths: ["allowed.txt", ".gitignore"], readablePaths: ["README.md"] }
  });
  await writeFile(path.join(fixture.prepared.capsule.capsuleRoot, ".gitignore"), "ignored.txt\n");
  await writeFile(path.join(fixture.prepared.capsule.capsuleRoot, "ignored.txt"), "hidden mutation\n");
  const review = await buildHostReviewPacket(fixture.prepared, fixture.execution);
  assert.ok(review.packet.hostObserved.changedPaths.includes("ignored.txt"));
  assert.deepEqual(review.packet.hostObserved.scopeBreaches, ["ignored.txt"]);
  assert.equal(review.packet.acceptance.eligible, false);
});

test("validation-time private control mutation makes completion ineligible", async () => {
  const fixture = await executeFixture();
  await writeFile(path.join(fixture.prepared.capsule.capsuleRoot, "allowed.txt"), "bounded change\n");
  const review = await buildHostReviewPacket(fixture.prepared, fixture.execution, {
    runProcess: async () => {
      await writeFile(path.join(fixture.prepared.capsule.taskRoot, "capsule.json"), "{}\n");
      return { exitCode: 0, signal: null, timedOut: false, stdout: "passed", stderr: "" };
    }
  });
  assert.equal(review.packet.hostObserved.privateControlChanged, true);
  assert.equal(review.packet.acceptance.eligible, false);
  assert(review.packet.unresolvedRisks.some((item) => item.includes("Private task controls changed")));
});

test("worker-time private control mutation blocks validation and acceptance", async () => {
  const fixture = await executeFixture();
  await writeFile(path.join(fixture.prepared.capsule.taskRoot, "capsule.json"), "{}\n");
  const review = await buildHostReviewPacket(fixture.prepared, fixture.execution);
  assert.equal(review.packet.hostObserved.privateControlChanged, true);
  assert.ok(review.packet.hostObserved.scopeBreaches.includes("task:private control changed"));
  assert.equal(review.packet.validations[0].status, "not_run");
  assert.equal(review.packet.acceptance.eligible, false);
});

test("metrics keep only bounded aggregates and mark unavailable usage", () => {
  const metrics = extractAggregateMetrics({
    taskId: "private/task/path",
    profile: { fingerprint: "sha256:1234567890abcdef9999" },
    execution: {
      eventCount: 2,
      usage: { input_tokens: 8, prompt: "secret prompt", sourcePath: path.join(path.sep, "private", "source"), apiKey: "secret" },
      relaypactInput: {
        relaypactPromptBytes: 1200,
        relaypactResultSchemaBytes: 800,
        relaypactDeclaredInputBytes: 2000,
        prompt: "must not be retained"
      }
    },
    contextEvidence: {
      plan: {
        mode: "planned",
        strategy: "dependency-closure",
        fingerprint: "sha256:private-path-and-fingerprint",
        selectedFileCount: 4,
        selectedBytes: 2048,
        unresolvedReferenceCount: 0,
        budgetUtilization: { files: 0.4, bytes: 0.2, maxDepth: 7 }
      },
      readiness: { outcome: "passed", summary: "raw readiness output" },
      executorContextGap: { code: "context_gap", message: "missing /private/secret.mjs" }
    }
  });
  assert.equal(metrics.inputTokens, 8);
  assert.equal(metrics.outputTokens, "unavailable");
  assert.equal(metrics.relaypactPromptBytes, 1200);
  assert.equal(metrics.relaypactResultSchemaBytes, 800);
  assert.equal(metrics.relaypactDeclaredInputBytes, 2000);
  assert.equal(metrics.durationMs, "unavailable");
  assert.equal(metrics.contextMode, "planned");
  assert.equal(metrics.selectedFileCount, 4);
  assert.equal(metrics.readinessOutcome, "passed");
  assert.equal(metrics.contextBlockCategory, "executor_context_gap");
  assert.equal(metrics.newTaskRequired, true);
  const serialized = JSON.stringify(metrics);
  assert.doesNotMatch(serialized, /secret prompt|must not be retained|sourcePath|apiKey|private\/task|private-path|raw readiness|private\/secret/);
});

test("metrics do not infer missing RelayPact byte counts from provider tokens or context", () => {
  const metrics = extractAggregateMetrics({
    taskId: "task",
    profile: { fingerprint: "sha256:1234567890abcdef9999" },
    execution: { eventCount: 1, usage: { input_tokens: 86_580 } },
    contextEvidence: { plan: { mode: "explicit", selectedFileCount: 4, selectedBytes: 1126 } }
  });
  assert.equal(metrics.inputTokens, 86_580);
  assert.equal(metrics.selectedBytes, 1126);
  assert.equal(metrics.relaypactPromptBytes, "unavailable");
  assert.equal(metrics.relaypactResultSchemaBytes, "unavailable");
  assert.equal(metrics.relaypactDeclaredInputBytes, "unavailable");
});

test("metrics reject non-integer and unsafe RelayPact byte observations", () => {
  const metrics = extractAggregateMetrics({
    taskId: "task",
    profile: { fingerprint: "sha256:1234567890abcdef9999" },
    execution: {
      eventCount: 1,
      usage: {},
      relaypactInput: {
        relaypactPromptBytes: 1.5,
        relaypactResultSchemaBytes: Number.MAX_SAFE_INTEGER + 1,
        relaypactDeclaredInputBytes: -1
      }
    }
  });
  assert.equal(metrics.relaypactPromptBytes, "unavailable");
  assert.equal(metrics.relaypactResultSchemaBytes, "unavailable");
  assert.equal(metrics.relaypactDeclaredInputBytes, "unavailable");
});

test("host review keeps executor context gaps separate from readiness and validation", async () => {
  const fixture = await executeFixture();
  const execution = {
    ...fixture.execution,
    workerResult: {
      ...completed,
      status: "blocked",
      summary: "Required task context is missing.",
      changedFiles: [],
      blocking: { code: "context_gap", message: "Missing repository-relative fixture data/example.json." }
    }
  };
  const review = await buildHostReviewPacket(fixture.prepared, execution);
  assert.deepEqual(review.packet.contextEvidence.executorContextGap, {
    code: "context_gap",
    message: "Missing repository-relative fixture data/example.json."
  });
  assert.equal(review.packet.contextEvidence.readiness.outcome, "not_configured");
  assert.equal(review.packet.validations[0].status, "not_run");
  assert.equal(review.packet.acceptance.eligible, false);
});

test("terminal host decision archives review evidence before task-scoped cleanup", async () => {
  const fixture = await executeFixture();
  await writeFile(path.join(fixture.prepared.capsule.capsuleRoot, "allowed.txt"), "accepted change\n");
  const review = await buildHostReviewPacket(fixture.prepared, fixture.execution);
  const decided = await recordTerminalDecision(fixture.prepared, review, "accept", "desktop-host-1");
  assert.equal(decided.packet.acceptance.status, "accepted");
  const archiveRoot = await mkdtemp(path.join(os.tmpdir(), "relaypact-review-archive-"));
  const symlinkRoot = `${archiveRoot}-link`;
  await symlink(archiveRoot, symlinkRoot);
  await assert.rejects(
    archiveAndCleanupTerminalTask(fixture.prepared, decided, symlinkRoot),
    (error) => error.code === "invalid_archive_root"
  );
  await access(fixture.prepared.capsule.taskRoot);
  const archive = await archiveAndCleanupTerminalTask(fixture.prepared, decided, archiveRoot);
  assert.equal(JSON.parse(await readFile(archive.packetPath, "utf8")).acceptance.status, "accepted");
  assert.match(await readFile(archive.patchPath, "utf8"), /accepted change/);
  await assert.rejects(access(fixture.prepared.capsule.taskRoot));
  await access(fixture.root);
});

test("terminal acceptance tolerates a private index stat-cache refresh", async () => {
  const fixture = await executeFixture();
  await writeFile(path.join(fixture.prepared.capsule.capsuleRoot, "allowed.txt"), "accepted change\n");
  const review = await buildHostReviewPacket(fixture.prepared, fixture.execution);
  const indexPath = path.join(fixture.prepared.capsule.gitControl.gitDir, "index");
  const rawBefore = await readFile(indexPath);
  const semanticBefore = await snapshotGitIndex(
    fixture.prepared.capsule.capsuleRoot,
    fixture.prepared.capsule.gitControl
  );
  const refreshedAt = new Date("2001-01-01T00:00:00.000Z");
  await utimes(path.join(fixture.prepared.capsule.capsuleRoot, "README.md"), refreshedAt, refreshedAt);
  await execFileAsync("git", [
    `--git-dir=${fixture.prepared.capsule.gitControl.gitDir}`,
    `--work-tree=${fixture.prepared.capsule.gitControl.workTree}`,
    "update-index",
    "--refresh"
  ], { cwd: fixture.prepared.capsule.capsuleRoot });
  assert.notDeepEqual(await readFile(indexPath), rawBefore);
  const semanticAfter = await snapshotGitIndex(
    fixture.prepared.capsule.capsuleRoot,
    fixture.prepared.capsule.gitControl
  );
  assert.equal(semanticAfter.fingerprint, semanticBefore.fingerprint);
  const decided = await recordTerminalDecision(fixture.prepared, review, "accept", "desktop-host-1");
  assert.equal(decided.packet.acceptance.status, "accepted");
});

test("acceptance refuses candidate changes made after host review", async () => {
  const fixture = await executeFixture();
  const candidate = path.join(fixture.prepared.capsule.capsuleRoot, "allowed.txt");
  await writeFile(candidate, "reviewed change\n");
  const review = await buildHostReviewPacket(fixture.prepared, fixture.execution);
  await writeFile(candidate, "changed after review\n");
  await assert.rejects(
    recordTerminalDecision(fixture.prepared, review, "accept", "desktop-host-1"),
    (error) => error.code === "stale_review"
  );
});

test("negative terminal decisions refuse candidate evidence changed after host review", async () => {
  for (const action of ["reject", "abandon"]) {
    const fixture = await executeFixture();
    const candidate = path.join(fixture.prepared.capsule.capsuleRoot, "allowed.txt");
    await writeFile(candidate, "reviewed change\n");
    const review = await buildHostReviewPacket(fixture.prepared, fixture.execution);
    review.candidatePatch = review.candidatePatch.replace("reviewed change", "forged archive content");
    rehashReview(review);
    await assert.rejects(
      recordTerminalDecision(fixture.prepared, review, action, "desktop-host-1"),
      (error) => error.code === "stale_review"
    );
  }
});

test("acceptance refuses a tampered review packet", async () => {
  const fixture = await executeFixture();
  await writeFile(path.join(fixture.prepared.capsule.capsuleRoot, "allowed.txt"), "reviewed change\n");
  const review = await buildHostReviewPacket(fixture.prepared, fixture.execution);
  review.packet.unresolvedRisks.push("injected after review");
  await assert.rejects(
    recordTerminalDecision(fixture.prepared, review, "accept", "desktop-host-1"),
    (error) => error.code === "review_identity_mismatch"
  );
});

test("acceptance refuses an old review after correction authorization", async () => {
  const fixture = await executeFixture();
  await writeFile(path.join(fixture.prepared.capsule.capsuleRoot, "allowed.txt"), "reviewed change\n");
  const review = await buildHostReviewPacket(fixture.prepared, fixture.execution);
  const state = await readTaskState(fixture.prepared.statePath);
  await authorizeCorrection(fixture.prepared.statePath, {
    taskId: fixture.prepared.envelope.taskId,
    profileFingerprint: fixture.prepared.profile.fingerprint,
    capsuleBaseline: fixture.prepared.capsule.baseline,
    contextManifestFingerprint: fixture.prepared.capsule.contextManifestFingerprint,
    priorResultIdentity: state.resultIdentity
  });
  await assert.rejects(
    recordTerminalDecision(fixture.prepared, review, "accept", "desktop-host-1"),
    (error) => error.code === "stale_review"
  );
});

test("acceptance recomputes eligibility instead of trusting a rehashed packet", async () => {
  const fixture = await executeFixture();
  await writeFile(path.join(fixture.prepared.capsule.capsuleRoot, "allowed.txt"), "reviewed change\n");
  const failingValidation = async () => ({
    exitCode: 1,
    signal: null,
    timedOut: false,
    stdout: "failed",
    stderr: ""
  });
  const review = await buildHostReviewPacket(fixture.prepared, fixture.execution, { runProcess: failingValidation });
  assert.equal(review.packet.acceptance.eligible, false);
  review.packet.acceptance.eligible = true;
  rehashReview(review);
  await assert.rejects(
    recordTerminalDecision(fixture.prepared, review, "accept", "desktop-host-1", { runProcess: failingValidation }),
    (error) => error.code === "stale_review" || error.code === "acceptance_ineligible"
  );
});
