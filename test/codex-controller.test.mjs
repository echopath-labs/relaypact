import { getCapsuleFilesystemChanges, verifySourceUnchanged } from "../packages/executor-codex/src/capsule.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  correctCodexDelegation,
  executeCodexDelegation,
  loadCodexDelegation,
  prepareCodexDelegation
} from "../packages/adapter-codex-codex/src/controller.mjs";
import { createGitRepository, makeEnvelope } from "./helpers.mjs";

const execFileAsync = promisify(execFile);

const profileRegistry = {
  schemaVersion: "1.0.0",
  profiles: {
    worker: {
      codexCommand: "codex",
      model: "worker-model",
      reasoning: "high",
      external: true
    }
  }
};

const compatibilityProcess = async (_command, args) => {
  if (args[0] === "--version") return { exitCode: 0, stdout: "codex-cli 0.147.0", stderr: "" };
  if (args[0] === "exec" && args[1] === "resume") return { exitCode: 0, stdout: "Resume usage --json --output-schema", stderr: "" };
  return { exitCode: 0, stdout: "--json --output-schema --profile --sandbox", stderr: "" };
};

function workerProcess(threadId = "delegated-thread-1") {
  return async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stderr: "",
    stdout: [
      JSON.stringify({ type: "thread.started", thread_id: threadId }),
      JSON.stringify({ type: "turn.completed", usage: {} })
    ].join("\n")
  });
}

function result(summary = "Done") {
  return {
    schemaVersion: "1.0.0",
    taskId: "test-task",
    status: "completed",
    summary,
    changedFiles: ["allowed.txt"],
    validations: [],
    residualRisks: [],
    blocking: null
  };
}

async function preparedFixture() {
  const root = await createGitRepository();
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "relaypact-controller-state-"));
  const envelope = makeEnvelope(root, {
    executionProfile: "worker",
    scope: { readablePaths: ["README.md"] }
  });
  return prepareCodexDelegation({ envelope, profileRegistry, stateRoot, hostInstanceId: "desktop-host-1" }, { compatibilityProcess });
}

async function plannedFixture(readiness = []) {
  const root = await createGitRepository();
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "entry.mjs"), "import './dependency.mjs';\n");
  await writeFile(path.join(root, "src", "dependency.mjs"), "export const value = true;\n");
  await execFileAsync("git", ["add", "src"], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "test: add planner fixture"], { cwd: root });
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "relaypact-controller-planned-"));
  const envelope = makeEnvelope(root, {
    executionProfile: "worker",
    scope: {
      allowedPaths: ["src/**/*.mjs"],
      forbiddenPaths: [".env", ".env.*", "private/**"],
      discoverablePaths: ["src/**/*.mjs"]
    },
    contextPlanning: {
      strategy: "dependency-closure",
      seeds: ["src/entry.mjs"],
      analyzers: ["node-esm"],
      budget: { maxFiles: 10, maxBytes: 10_000, maxDepth: 5 },
      readiness
    }
  });
  return { root, stateRoot, envelope };
}

test("controller preflights profile, compatibility, repository, and capsule before execution", async () => {
  const prepared = await preparedFixture();
  assert.equal(prepared.compatibility.version, "0.147.0");
  assert.equal(prepared.router.checked, false);
  assert.equal(prepared.profile.name, "worker");
  assert.equal(prepared.capsule.mode, "sanitized");
});

test("controller plans context, runs readiness in a minimized environment, and reloads the identity", async () => {
  const fixture = await plannedFixture([{
    id: "node-version",
    argv: [process.execPath, "--version"],
    timeoutMs: 1000,
    acceptableExitCodes: [0]
  }]);
  let readinessCalls = 0;
  const prepared = await prepareCodexDelegation({
    envelope: fixture.envelope,
    profileRegistry,
    stateRoot: fixture.stateRoot,
    hostInstanceId: "desktop-host-1"
  }, {
    compatibilityProcess,
    environment: { PATH: process.env.PATH, PRIVATE_TOKEN: "must-not-pass" },
    readinessProcess: async (_command, _args, options) => {
      readinessCalls += 1;
      assert.equal(options.env.PRIVATE_TOKEN, undefined);
      assert.match(options.env.HOME, /readiness-home$/);
      return { exitCode: 0, signal: null, timedOut: false, stdout: "ready", stderr: "" };
    }
  });
  assert.equal(readinessCalls, 1);
  assert.equal(prepared.readiness.outcome, "passed");
  assert.match(prepared.capsule.contextManifestFingerprint, /^sha256:/);
  const state = JSON.parse(await readFile(prepared.statePath, "utf8"));
  assert.equal(state.contextManifestFingerprint, prepared.capsule.contextManifestFingerprint);
  const loaded = await loadCodexDelegation(prepared.capsule.taskRoot, profileRegistry);
  assert.equal(loaded.readiness.outcome, "passed");
  assert.equal(loaded.capsule.contextManifest.fingerprint, state.contextManifestFingerprint);
});

test("planning and readiness failures occur before route checks or worker requests and clean provisional state", async () => {
  const planningFixture = await plannedFixture();
  await writeFile(path.join(planningFixture.root, "src", "entry.mjs"), "import './missing.mjs';\n");
  planningFixture.envelope.repository.dirtyTree = { allow: true, acknowledgedPaths: ["src/entry.mjs"] };
  let compatibilityCalls = 0;
  await assert.rejects(
    prepareCodexDelegation({
      envelope: planningFixture.envelope,
      profileRegistry,
      stateRoot: planningFixture.stateRoot,
      hostInstanceId: "desktop-host-1"
    }, { compatibilityProcess: async (...args) => { compatibilityCalls += 1; return compatibilityProcess(...args); } }),
    (error) => error.code === "context_file_missing"
  );
  assert.equal(compatibilityCalls, 0);
  assert.deepEqual(await readdir(planningFixture.stateRoot), []);

  const readinessFixture = await plannedFixture([{
    id: "structural-check",
    argv: [process.execPath, "--version"],
    timeoutMs: 1000,
    acceptableExitCodes: [0]
  }]);
  await assert.rejects(
    prepareCodexDelegation({
      envelope: readinessFixture.envelope,
      profileRegistry,
      stateRoot: readinessFixture.stateRoot,
      hostInstanceId: "desktop-host-1"
    }, {
      compatibilityProcess: async (...args) => { compatibilityCalls += 1; return compatibilityProcess(...args); },
      readinessProcess: async () => ({ exitCode: 2, signal: null, timedOut: false, stdout: "not ready", stderr: "" })
    }),
    (error) => error.code === "context_readiness_failed" && error.details.workerRequestCount === 0
  );
  assert.equal(compatibilityCalls, 0);
  assert.deepEqual(await readdir(readinessFixture.stateRoot), []);
});

test("readiness mutation is detected and the provisional capsule is discarded", async () => {
  const fixture = await plannedFixture([{
    id: "must-not-mutate",
    argv: [process.execPath, "--version"],
    timeoutMs: 1000,
    acceptableExitCodes: [0]
  }]);
  await assert.rejects(
    prepareCodexDelegation({
      envelope: fixture.envelope,
      profileRegistry,
      stateRoot: fixture.stateRoot,
      hostInstanceId: "desktop-host-1"
    }, {
      compatibilityProcess,
      readinessProcess: async (_command, _args, options) => {
        await writeFile(path.join(options.cwd, "readiness-mutation.txt"), "mutation\n");
        return { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "" };
      }
    }),
    (error) => error.code === "context_readiness_failed" && error.details.readiness.mutationDetected === true
  );
  assert.deepEqual(await readdir(fixture.stateRoot), []);
});

test("readiness private-control mutation is detected before worker execution", async () => {
  const fixture = await plannedFixture([{
    id: "must-not-mutate-controls",
    argv: [process.execPath, "--version"],
    timeoutMs: 1000,
    acceptableExitCodes: [0]
  }]);
  await assert.rejects(
    prepareCodexDelegation({
      envelope: fixture.envelope,
      profileRegistry,
      stateRoot: fixture.stateRoot,
      hostInstanceId: "desktop-host-1"
    }, {
      compatibilityProcess,
      readinessProcess: async (_command, _args, options) => {
        await writeFile(path.join(options.cwd, "..", "control", "task-envelope.json"), "{}\n");
        return { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "" };
      }
    }),
    (error) => error.code === "context_readiness_failed" && error.details.readiness.mutationDetected === true
  );
  assert.deepEqual(await readdir(fixture.stateRoot), []);
});

test("explicit task reload remains compatible when legacy readiness evidence is absent", async () => {
  const prepared = await preparedFixture();
  await rm(path.join(prepared.capsule.controlRoot, "readiness-evidence.json"));
  const loaded = await loadCodexDelegation(prepared.capsule.taskRoot, profileRegistry);
  assert.equal(loaded.readiness.outcome, "not_configured");
  assert.equal(loaded.capsule.inputMetadata.length, 1);
});

test("task reload rejects immutable private-control drift", async () => {
  const prepared = await preparedFixture();
  await writeFile(prepared.capsule.resultSchemaPath, "{}\n");
  await assert.rejects(
    loadCodexDelegation(prepared.capsule.taskRoot, profileRegistry),
    (error) => error.code === "task_state_mismatch" && /immutable private controls/.test(error.message)
  );
});

test("task reload rejects legacy state without a semantic Git index baseline", async () => {
  const prepared = await preparedFixture();
  await rm(prepared.capsule.capsuleGitIndexBaselinePath);
  await assert.rejects(
    loadCodexDelegation(prepared.capsule.taskRoot, profileRegistry),
    (error) => error.code === "task_state_mismatch" && /semantic Git index evidence/.test(error.message)
  );
});

test("controller executes and resumes correction in the same delegated session", async () => {
  const prepared = await preparedFixture();
  const first = await executeCodexDelegation(prepared, {
    codexHome: path.join(prepared.capsule.taskRoot, "codex-home"),
    runProcess: workerProcess(),
    readResultFile: async () => JSON.stringify(result("First result"))
  });
  assert.equal(first.state.lifecycleState, "awaiting_review");
  assert.equal(first.state.executorThreadId, "delegated-thread-1");
  assert.equal(first.state.relaypactInput.relaypactDeclaredInputBytes, first.relaypactInput.relaypactDeclaredInputBytes);

  const reloaded = await loadCodexDelegation(prepared.capsule.taskRoot, profileRegistry);
  const corrected = await correctCodexDelegation(reloaded, {
    taskId: prepared.envelope.taskId,
    profileFingerprint: prepared.profile.fingerprint,
    capsuleBaseline: prepared.capsule.baseline,
    priorResultIdentity: first.state.resultIdentity,
    prompt: "Fix the identified defect."
  }, {
    compatibilityProcess,
    codexHome: path.join(prepared.capsule.taskRoot, "codex-home"),
    runProcess: workerProcess(),
    readResultFile: async () => JSON.stringify(result("Corrected result"))
  });
  assert.equal(corrected.state.lifecycleState, "awaiting_review");
  assert.equal(corrected.state.executorThreadId, "delegated-thread-1");
  assert.equal(corrected.state.correctionSequence, 1);
  assert.equal(corrected.state.relaypactInput.relaypactDeclaredInputBytes, corrected.relaypactInput.relaypactDeclaredInputBytes);
});

test("correction refuses a changed worker sensitive-value set before invoking Codex", async () => {
  const prepared = await preparedFixture();
  const codexHome = path.join(prepared.capsule.taskRoot, "codex-home");
  await mkdir(codexHome, { recursive: true });
  await writeFile(path.join(codexHome, "auth.json"), `${JSON.stringify({ OPENAI_API_KEY: "first-worker-secret" })}\n`);
  let workerCalls = 0;
  const runProcess = async (...args) => {
    workerCalls += 1;
    return workerProcess()(...args);
  };
  const first = await executeCodexDelegation(prepared, {
    codexHome,
    runProcess,
    readResultFile: async () => JSON.stringify(result("First result"))
  });
  assert.equal(workerCalls, 1);
  await writeFile(path.join(codexHome, "auth.json"), `${JSON.stringify({ OPENAI_API_KEY: "rotated-worker-secret" })}\n`);
  const reloaded = await loadCodexDelegation(prepared.capsule.taskRoot, profileRegistry);
  const corrected = await correctCodexDelegation(reloaded, {
    taskId: prepared.envelope.taskId,
    profileFingerprint: prepared.profile.fingerprint,
    capsuleBaseline: prepared.capsule.baseline,
    priorResultIdentity: first.state.resultIdentity,
    prompt: "Fix the identified defect."
  }, {
    compatibilityProcess,
    codexHome,
    runProcess,
    readResultFile: async () => JSON.stringify(result("Must not run"))
  });
  assert.equal(workerCalls, 1);
  assert.equal(corrected.workerResult.status, "failed");
  assert.equal(corrected.workerResult.blocking.code, "sensitive_grant_changed");
});

test("worker auth drift is rejected before any Codex narrative is parsed", async () => {
  const prepared = await preparedFixture();
  const codexHome = path.join(prepared.capsule.taskRoot, "codex-home");
  const firstSecret = "first-runtime-secret";
  const refreshedSecret = "refreshed-runtime-secret";
  await mkdir(codexHome, { recursive: true });
  await writeFile(path.join(codexHome, "auth.json"), `${JSON.stringify({ OPENAI_API_KEY: firstSecret })}\n`);
  let resultReads = 0;
  const execution = await executeCodexDelegation(prepared, {
    codexHome,
    runProcess: async () => {
      await writeFile(path.join(codexHome, "auth.json"), `${JSON.stringify({ OPENAI_API_KEY: refreshedSecret })}\n`);
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stderr: refreshedSecret,
        stdout: `${JSON.stringify({ type: "thread.started", thread_id: "delegated-thread-1" })}\n${JSON.stringify({ type: "turn.completed", usage: {} })}\n`
      };
    },
    readResultFile: async () => {
      resultReads += 1;
      return JSON.stringify({ ...result(), summary: refreshedSecret });
    }
  });
  assert.equal(resultReads, 0);
  assert.equal(execution.workerResult.status, "failed");
  assert.equal(execution.workerResult.blocking.code, "sensitive_grant_changed");
  assert.doesNotMatch(JSON.stringify(execution), new RegExp(refreshedSecret));
});

test("planned correction requires the unchanged manifest identity before any route or worker call", async () => {
  const fixture = await plannedFixture();
  const prepared = await prepareCodexDelegation({
    envelope: fixture.envelope,
    profileRegistry,
    stateRoot: fixture.stateRoot,
    hostInstanceId: "desktop-host-1"
  }, { compatibilityProcess });
  const first = await executeCodexDelegation(prepared, {
    codexHome: path.join(prepared.capsule.taskRoot, "codex-home"),
    runProcess: workerProcess(),
    readResultFile: async () => JSON.stringify(result("Planned result"))
  });
  const identity = {
    taskId: prepared.envelope.taskId,
    profileFingerprint: prepared.profile.fingerprint,
    capsuleBaseline: prepared.capsule.baseline,
    contextManifestFingerprint: prepared.capsule.contextManifestFingerprint,
    priorResultIdentity: first.state.resultIdentity,
    prompt: "Fix the planned task."
  };
  let compatibilityCalls = 0;
  let workerCalls = 0;
  const correctionOptions = {
    compatibilityProcess: async (...args) => { compatibilityCalls += 1; return compatibilityProcess(...args); },
    codexHome: path.join(prepared.capsule.taskRoot, "codex-home"),
    runProcess: async (...args) => { workerCalls += 1; return workerProcess()(...args); },
    readResultFile: async () => JSON.stringify(result("Corrected planned result"))
  };
  const { contextManifestFingerprint: omitted, ...missingIdentity } = identity;
  void omitted;
  await assert.rejects(
    correctCodexDelegation(prepared, missingIdentity, correctionOptions),
    (error) => error.code === "resume_identity_mismatch" && /contextManifestFingerprint/.test(error.message)
  );
  await assert.rejects(
    correctCodexDelegation(prepared, { ...identity, contextManifestFingerprint: "sha256:different" }, correctionOptions),
    (error) => error.code === "resume_identity_mismatch" && /contextManifestFingerprint/.test(error.message)
  );
  const visibleManifestPath = path.join(prepared.capsule.capsuleRoot, ".relaypact", "context-manifest.json");
  const visibleManifest = await readFile(visibleManifestPath, "utf8");
  const tampered = { ...JSON.parse(visibleManifest), extra: true };
  await writeFile(visibleManifestPath, `${JSON.stringify(tampered)}\n`);
  await assert.rejects(
    correctCodexDelegation(prepared, identity, correctionOptions),
    (error) => error.code === "context_manifest_mismatch"
  );
  assert.equal(compatibilityCalls, 0);
  assert.equal(workerCalls, 0);

  await writeFile(visibleManifestPath, visibleManifest);
  const corrected = await correctCodexDelegation(prepared, identity, correctionOptions);
  assert.equal(corrected.state.correctionSequence, 1);
  assert.equal(workerCalls, 1);
});

test("controller fails when delegated identity cannot be separated from the host", async () => {
  const prepared = await preparedFixture();
  const execution = await executeCodexDelegation(prepared, {
    codexHome: path.join(prepared.capsule.taskRoot, "codex-home"),
    runProcess: workerProcess("desktop-host-1"),
    readResultFile: async () => JSON.stringify(result())
  });
  assert.equal(execution.state.lifecycleState, "failed");
  assert.equal(execution.lifecycleError.code, "executor_identity_unavailable");
});

test("controller refuses an unavailable named profile before capsule creation", async () => {
  const root = await createGitRepository();
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "relaypact-controller-missing-profile-"));
  const envelope = makeEnvelope(root, { executionProfile: "missing", scope: { readablePaths: ["README.md"] } });
  await assert.rejects(
    prepareCodexDelegation({ envelope, profileRegistry, stateRoot, hostInstanceId: "desktop-host-1" }, { compatibilityProcess }),
    (error) => error.code === "worker_profile_not_found"
  );
  assert.deepEqual(await readdir(stateRoot), []);
});

test("controller fails closed on router health without creating a capsule or fallback route", async () => {
  const root = await createGitRepository();
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "relaypact-controller-router-"));
  const routedRegistry = {
    schemaVersion: "1.0.0",
    profiles: {
      routed: {
        model: "router-only-model",
        external: true,
        router: { healthUrl: "http://127.0.0.1:10100/health", timeoutMs: 500 }
      }
    }
  };
  const envelope = makeEnvelope(root, { executionProfile: "routed", scope: { readablePaths: ["README.md"] } });
  await assert.rejects(
    prepareCodexDelegation({ envelope, profileRegistry: routedRegistry, stateRoot, hostInstanceId: "desktop-host-1" }, {
      compatibilityProcess,
      fetch: async () => ({ ok: false, status: 503 })
    }),
    (error) => error.code === "router_unavailable" && /routed/.test(error.message)
  );
  assert.deepEqual(await readdir(stateRoot), []);
});

test("controller rejects a missing direct provider credential and cleans provisional state", async () => {
  const root = await createGitRepository();
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "relaypact-controller-direct-missing-"));
  const directRegistry = {
    schemaVersion: "1.0.0",
    profiles: {
      direct: {
        model: "worker-model",
        external: true,
        provider: {
          name: "compatible-provider",
          baseUrl: "https://provider.example/v1",
          wireApi: "responses",
          credentialEnv: "PROVIDER_API_KEY"
        }
      }
    }
  };
  const envelope = makeEnvelope(root, { executionProfile: "direct", scope: { readablePaths: ["README.md"] } });
  await assert.rejects(
    prepareCodexDelegation({ envelope, profileRegistry: directRegistry, stateRoot, hostInstanceId: "desktop-host-1" }, {
      compatibilityProcess,
      environment: { PROVIDER_API_KEY: "" }
    }),
    (error) => error.code === "provider_credential_unavailable" && /PROVIDER_API_KEY/.test(error.message)
  );
  assert.deepEqual(await readdir(stateRoot), []);
});

test("controller prepares a direct provider only from host environment configuration", async () => {
  const root = await createGitRepository();
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "relaypact-controller-direct-"));
  const directRegistry = {
    schemaVersion: "1.0.0",
    profiles: {
      direct: {
        model: "worker-model",
        external: true,
        provider: {
          name: "compatible-provider",
          baseUrl: "https://provider.example/v1",
          wireApi: "responses",
          credentialEnv: "PROVIDER_API_KEY"
        }
      }
    }
  };
  const envelope = makeEnvelope(root, { executionProfile: "direct", scope: { readablePaths: ["README.md"] } });
  const prepared = await prepareCodexDelegation({ envelope, profileRegistry: directRegistry, stateRoot, hostInstanceId: "desktop-host-1" }, {
    compatibilityProcess,
    environment: { PROVIDER_API_KEY: "credential-value" }
  });
  assert.deepEqual(prepared.providerCredential, { checked: true, credentialEnv: "PROVIDER_API_KEY" });
  assert.equal(prepared.profile.provider.name, "compatible-provider");
  assert.doesNotMatch(JSON.stringify(prepared), /credential-value/);
});


test("Codex capsule reload binds the budget and scans large ignored source content", async (t) => {
  const root = await createGitRepository();
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "relaypact-budget-capsule-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(stateRoot, { recursive: true, force: true }); });
  await writeFile(path.join(root, ".git", "info", "exclude"), "dependencies.bin\n");
  await writeFile(path.join(root, "dependencies.bin"), "");
  await truncate(path.join(root, "dependencies.bin"), 512 * 1024 * 1024 + 1);
  const envelope = makeEnvelope(root, {
    executionProfile: "worker", scope: { readablePaths: ["README.md"] },
    execution: { filesystemEvidenceMaxBytes: 600 * 1024 * 1024 }
  });
  const prepared = await prepareCodexDelegation({ envelope, profileRegistry, stateRoot, hostInstanceId: "budget-host" }, { compatibilityProcess });
  const loaded = await loadCodexDelegation(prepared.capsule.taskRoot, profileRegistry);
  assert.equal(loaded.capsule.filesystemEvidenceMaxBytes, 600 * 1024 * 1024);
  assert.equal((await verifySourceUnchanged(loaded.repository, loaded.capsule)).unchanged, true);
  // Capsule postflight uses the same budget even when the original context was small.
  await writeFile(path.join(loaded.capsule.capsuleRoot, "allowed.txt"), "");
  await truncate(path.join(loaded.capsule.capsuleRoot, "allowed.txt"), 512 * 1024 * 1024 + 1);
  assert.ok((await getCapsuleFilesystemChanges(loaded.capsule)).includes("allowed.txt"));
  await truncate(path.join(loaded.capsule.capsuleRoot, "allowed.txt"), 600 * 1024 * 1024 + 1);
  await assert.rejects(getCapsuleFilesystemChanges(loaded.capsule), { code: "filesystem_evidence_exceeded" });
  const markerPath = path.join(prepared.capsule.taskRoot, "capsule.json");
  const marker = JSON.parse(await readFile(markerPath, "utf8"));
  marker.filesystemEvidenceMaxBytes += 1;
  await writeFile(markerPath, JSON.stringify(marker));
  await assert.rejects(loadCodexDelegation(prepared.capsule.taskRoot, profileRegistry), { code: "task_state_mismatch" });
});
