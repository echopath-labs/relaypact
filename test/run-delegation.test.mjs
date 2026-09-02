import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { validateTaskEnvelope } from "../packages/contracts/src/envelope.mjs";
import { parseStatusPaths } from "../packages/core/src/git.mjs";
import { runDelegation } from "../packages/adapter-codex-pi/src/run-delegation.mjs";
import { createDirectory, createGitRepository, makeEnvelope } from "./helpers.mjs";

const fakePi = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));
const cli = fileURLToPath(new URL("../bin/relaypact.mjs", import.meta.url));
const execFileAsync = promisify(execFile);
const withFixturePiRoute = (envelope) => envelope.executionProfile === undefined
  ? { ...envelope, executionProfile: { provider: "fixture-provider", model: "fixture-model" } }
  : envelope;
const execute = (envelope, scenario) => runDelegation(withFixturePiRoute(envelope), {
  executorCommand: fakePi,
  executorEnv: { FAKE_PI_SCENARIO: scenario }
});

test("successful execution remains pending host acceptance", async () => {
  const root = await createGitRepository();
  const result = await execute(makeEnvelope(root), "success");
  assert.equal(result.status, "completed");
  assert.deepEqual(result.changedPaths, ["allowed.txt"]);
  assert.equal(result.scope.compliant, true);
  assert.equal(result.validations[0].status, "passed");
  assert.deepEqual(result.hostAcceptance, { status: "pending", eligible: true, decidedBy: null });
});

test("CLI reads an envelope file and emits a structured result", async () => {
  const root = await createGitRepository();
  const envelopeFile = path.join(root, "..", `envelope-${path.basename(root)}.json`);
  await writeFile(envelopeFile, JSON.stringify(withFixturePiRoute(makeEnvelope(root))));
  const { stdout } = await execFileAsync(process.execPath, [cli, "run-pi", "--envelope", envelopeFile, "--executor", fakePi], {
    env: { ...process.env, FAKE_PI_SCENARIO: "success" }
  });
  const result = JSON.parse(stdout);
  assert.equal(result.status, "completed");
  assert.equal(result.hostAcceptance.status, "pending");
});

test("CLI support metadata is sanitized and keeps Pi experimental", async () => {
  const { stdout } = await execFileAsync(process.execPath, [cli, "support"], {
    env: { PATH: process.env.PATH, HOME: path.dirname(cli) }
  });
  const support = JSON.parse(stdout);
  assert.deepEqual(support.routes.map(({ id, status }) => ({ id, status })), [
    { id: "codex-codex", status: "public-preview" },
    { id: "codex-pi", status: "experimental" },
    { id: "codex-cursor", status: "experimental" }
  ]);
  assert.equal(support.routes[0].rootPluginActivation, true);
  assert.equal(support.routes[1].rootPluginActivation, false);
  assert.equal(support.routes[2].rootPluginActivation, false);
  assert.doesNotMatch(stdout, /credentialEnv|api[_-]?key|token/i);
});

test("CLI refuses the removed ambiguous run command", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [cli, "run", "--envelope", "unused.json"]),
    (error) => /Use 'run-pi' explicitly/.test(error.stderr)
  );
});

test("missing required envelope field is rejected before execution", () => {
  const envelope = makeEnvelope("/absolute/repository");
  delete envelope.objective;
  assert.throws(() => validateTaskEnvelope(envelope), (error) => error.code === "invalid_envelope");
});

test("non-Git target is rejected", async () => {
  const root = await createDirectory();
  await assert.rejects(execute(makeEnvelope(root), "success"), (error) => error.code === "not_git_repository");
});

test("dirty tree is refused by default", async () => {
  const root = await createGitRepository();
  await writeFile(path.join(root, "README.md"), "dirty\n");
  await assert.rejects(execute(makeEnvelope(root), "nochange"), (error) => error.code === "dirty_tree");
});

test("dirty tree override requires and records acknowledged paths", async () => {
  const root = await createGitRepository();
  await writeFile(path.join(root, "README.md"), "dirty\n");
  const envelope = makeEnvelope(root, {
    repository: { dirtyTree: { allow: true, acknowledgedPaths: ["README.md"] } }
  });
  const result = await execute(envelope, "nochange");
  assert.equal(result.status, "completed");
  assert.deepEqual(result.baseline.dirtyPathsBefore, ["README.md"]);
  assert(result.residualRisks.some((item) => item.includes("acknowledged uncommitted changes")));
});

test("staged rename requires acknowledgement of both source and destination", async () => {
  const root = await createGitRepository();
  await writeFile(path.join(root, "outside.txt"), "outside\n");
  await execFileAsync("git", ["add", "outside.txt"], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "test: add rename source"], { cwd: root });
  await execFileAsync("git", ["mv", "outside.txt", "allowed.txt"], { cwd: root });
  const envelope = makeEnvelope(root, {
    repository: { dirtyTree: { allow: true, acknowledgedPaths: ["allowed.txt"] } }
  });
  await assert.rejects(
    execute(envelope, "nochange"),
    (error) => error.code === "dirty_tree_unacknowledged" &&
      error.details.paths.includes("outside.txt")
  );
});

test("porcelain rename and copy records retain both path identities", () => {
  assert.deepEqual(
    parseStatusPaths("R  allowed.txt\0outside.txt\0C  copy.txt\0source.txt\0"),
    ["allowed.txt", "copy.txt", "outside.txt", "source.txt"]
  );
});

test("executor blocked result skips validation", async () => {
  const root = await createGitRepository();
  const result = await execute(makeEnvelope(root), "blocked");
  assert.equal(result.status, "blocked");
  assert.equal(result.validations[0].status, "not_run");
  assert.equal(result.hostAcceptance.eligible, false);
});

test("executor process failure redacts credential-like output", async () => {
  const root = await createGitRepository();
  const result = await execute(makeEnvelope(root), "failed");
  assert.equal(result.status, "failed");
  assert.equal(result.executor.reportedStatus, "failed");
  assert(!JSON.stringify(result).includes(["top", "secret"].join("-")));
  assert.equal(Object.hasOwn(result.executor, "stdout"), false);
  assert.equal(Object.hasOwn(result.executor, "stderr"), false);
});

test("malformed executor output is normalized as failed", async () => {
  const root = await createGitRepository();
  const result = await execute(makeEnvelope(root), "malformed");
  assert.equal(result.status, "failed");
  assert.equal(result.executor.reportedStatus, "malformed");
});

test("executor interruption is normalized as failed", async () => {
  const root = await createGitRepository();
  const envelope = makeEnvelope(root, { execution: { timeoutMs: 50 } });
  const result = await execute(envelope, "hang");
  assert.equal(result.status, "failed");
  assert.match(result.executor.summary, /timed out/i);
});

test("validation failure makes work ineligible for acceptance", async () => {
  const root = await createGitRepository();
  const envelope = makeEnvelope(root, {
    validation: [{ id: "fail", argv: [process.execPath, "-e", "process.exit(2)"], timeoutMs: 10_000 }]
  });
  const result = await execute(envelope, "success");
  assert.equal(result.status, "failed");
  assert.equal(result.validations[0].status, "failed");
  assert.equal(result.hostAcceptance.eligible, false);
});

test("missing validation executable is recorded as not run", async () => {
  const root = await createGitRepository();
  const envelope = makeEnvelope(root, {
    validation: [{ id: "missing", argv: ["definitely-not-an-installed-command"] }]
  });
  const result = await execute(envelope, "success");
  assert.equal(result.status, "failed");
  assert.equal(result.validations[0].status, "not_run");
  assert.equal(result.validations[0].reason, "spawn_error");
});

test("missing executor executable is normalized as failed", async () => {
  const root = await createGitRepository();
  const result = await runDelegation(withFixturePiRoute(makeEnvelope(root)), {
    executorCommand: "definitely-not-an-installed-executor"
  });
  assert.equal(result.status, "failed");
  assert.equal(result.executor.reportedStatus, "failed");
  assert.match(result.executor.summary, /could not start/i);
});

test("out-of-scope edit is independently rejected", async () => {
  const root = await createGitRepository();
  const result = await execute(makeEnvelope(root), "breach");
  assert.equal(result.status, "rejected");
  assert.deepEqual(result.scope.breaches, ["private.txt"]);
  assert.equal(result.validations[0].reason, "scope_breach");
  assert.equal(result.hostAcceptance.eligible, false);
});

test("ignored out-of-scope edit is independently rejected", async () => {
  const root = await createGitRepository();
  await writeFile(path.join(root, ".gitignore"), "ignored.txt\n");
  await execFileAsync("git", ["add", ".gitignore"], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "test: add ignore rule"], { cwd: root });
  const result = await execute(makeEnvelope(root), "ignored-breach");
  assert.equal(result.status, "rejected");
  assert.ok(result.changedPaths.includes("ignored.txt"));
  assert.ok(result.scope.breaches.includes("ignored.txt"));
  assert.equal(result.hostAcceptance.eligible, false);
});

test("behavior-bearing Git metadata mutation is independently rejected", async () => {
  const root = await createGitRepository();
  const result = await execute(makeEnvelope(root), "git-hook-breach");
  assert.equal(result.status, "rejected");
  assert.ok(result.scope.breaches.includes("git:metadata changed during delegated execution"));
  assert.equal(result.hostAcceptance.eligible, false);
});

test("pre-existing Git object mutation is independently rejected", async () => {
  const root = await createGitRepository();
  const source = path.join(root, "orphan-source.txt");
  await writeFile(source, "orphan object evidence\n");
  const { stdout } = await execFileAsync("git", ["hash-object", "-w", source], { cwd: root });
  await rm(source);
  const objectId = stdout.trim();
  const result = await runDelegation(withFixturePiRoute(makeEnvelope(root)), {
    executorCommand: fakePi,
    executorEnv: {
      FAKE_PI_SCENARIO: "git-object-breach",
      FAKE_PI_OBJECT_PATH: `${objectId.slice(0, 2)}/${objectId.slice(2)}`
    }
  });
  assert.equal(result.scope.compliant, false);
  assert.ok(result.scope.breaches.includes("git:metadata changed during delegated execution"));
});

test("Pi configuration credentials are redacted and make contaminated source ineligible", async () => {
  const root = await createGitRepository();
  const piConfig = await createDirectory();
  const secret = "opaque-pi-config-secret-value";
  await writeFile(path.join(piConfig, "auth.json"), `${JSON.stringify({ test: { type: "api_key", key: secret } })}\n`);
  await writeFile(path.join(piConfig, "settings.json"), `${JSON.stringify({ defaultProvider: "test", defaultModel: "fixture-model" })}\n`);
  const result = await runDelegation(makeEnvelope(root, {
    executionProfile: { provider: "test", model: "fixture-model" }
  }), {
    executorCommand: fakePi,
    executorEnv: { FAKE_PI_SCENARIO: "config-secret", PI_CODING_AGENT_DIR: piConfig }
  });
  assert.equal(result.status, "rejected");
  assert.ok(result.scope.breaches.includes("evidence:credential value detected"));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
});

test("Pi credential-bearing paths are omitted from retained evidence and rejected", async () => {
  const root = await createGitRepository();
  const secret = "opaque-path-secret-value";
  const result = await runDelegation(withFixturePiRoute(makeEnvelope(root, {
    scope: { allowedPaths: ["*.txt"], forbiddenPaths: [] }
  })), {
    executorCommand: fakePi,
    executorEnv: { FAKE_PI_SCENARIO: "credential-path", FAKE_PI_PATH_SECRET: secret }
  });
  assert.equal(result.status, "rejected");
  assert.deepEqual(result.changedPaths, []);
  assert.ok(result.scope.breaches.includes("evidence:credential value detected"));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
});

test("Pi provider URLs reject userinfo, query parameters, and fragments", async () => {
  for (const baseUrl of [
    "https://user:opaque-url-secret@provider.example/v1",
    "https://provider.example/v1?token=opaque-url-secret",
    "https://provider.example/v1#opaque-url-secret"
  ]) {
    const root = await createGitRepository();
    const piConfig = await createDirectory();
    await writeFile(path.join(piConfig, "settings.json"), `${JSON.stringify({ defaultProvider: "test", defaultModel: "fixture-model" })}\n`);
    await writeFile(path.join(piConfig, "models.json"), `${JSON.stringify({
      providers: { test: { baseUrl, api: "openai-responses", apiKey: "placeholder", models: [] } }
    })}\n`);
    const result = await runDelegation(makeEnvelope(root, {
      executionProfile: { provider: "test", model: "fixture-model" }
    }), {
      executorCommand: fakePi,
      executorEnv: { FAKE_PI_SCENARIO: "success", PI_CODING_AGENT_DIR: piConfig }
    });
    assert.notEqual(result.status, "completed");
    assert.equal(result.hostAcceptance.eligible, false);
    assert.doesNotMatch(JSON.stringify(result), /opaque-url-secret/);
  }
});

test("Pi executor grants are snapshotted exactly once", async () => {
  const root = await createGitRepository();
  const firstSecret = "first-pi-environment-secret";
  const secondSecret = "second-pi-environment-secret";
  let reads = 0;
  const executorEnv = { FAKE_PI_SCENARIO: "env-secret" };
  Object.defineProperty(executorEnv, "FAKE_PI_SECRET", {
    enumerable: true,
    get() {
      reads += 1;
      return reads === 1 ? firstSecret : secondSecret;
    }
  });
  const result = await runDelegation(withFixturePiRoute(makeEnvelope(root)), { executorCommand: fakePi, executorEnv });
  assert.equal(reads, 1);
  assert.equal(result.status, "rejected");
  assert.ok(result.scope.breaches.includes("evidence:credential value detected"));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(firstSecret));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secondSecret));
});

test("Pi validation output redacts the complete executor and validation grant union", async () => {
  const root = await createGitRepository();
  const secret = "pi-worker-secret-decoded-by-validation";
  const envelope = makeEnvelope(root, {
    validation: [{
      id: "decode-fixture",
      argv: [
        process.execPath,
        "-e",
        "const fs=require('node:fs');console.log(Buffer.from(fs.readFileSync('allowed.txt','utf8').trim(),'base64').toString('utf8'))"
      ],
      timeoutMs: 10_000
    }]
  });
  const result = await runDelegation(withFixturePiRoute(envelope), {
    executorCommand: fakePi,
    executorEnv: { FAKE_PI_SCENARIO: "encoded-secret", FAKE_PI_SECRET: secret }
  });
  assert.equal(result.status, "completed");
  assert.equal(result.validations[0].status, "passed");
  assert.match(result.validations[0].output, /REDACTED_EXACT_VALUE/);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
});

test("Pi provider URL path components join the exact sensitive-value inventory", async () => {
  const root = await createGitRepository();
  const piConfig = await createDirectory();
  const secret = "opaque-provider-path-secret";
  await writeFile(path.join(piConfig, "settings.json"), `${JSON.stringify({ defaultProvider: "test", defaultModel: "fixture-model" })}\n`);
  await writeFile(path.join(piConfig, "models.json"), `${JSON.stringify({
    providers: {
      test: {
        baseUrl: `https://provider.example/v1/${secret}`,
        api: "openai-responses",
        apiKey: "placeholder",
        models: []
      }
    }
  })}\n`);
  const result = await runDelegation(makeEnvelope(root, {
    executionProfile: { provider: "test", model: "fixture-model" }
  }), {
    executorCommand: fakePi,
    executorEnv: { FAKE_PI_SCENARIO: "config-url-secret", PI_CODING_AGENT_DIR: piConfig }
  });
  assert.equal(result.status, "rejected");
  assert.ok(result.scope.breaches.includes("evidence:credential value detected"));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
});

test("Pi auth projection rejects command and provider-specific credential semantics before launch", async () => {
  for (const credential of [
    { type: "api_key", key: "!printf command-resolved-secret" },
    { type: "api_key", key: "literal-key", env: { PROVIDER_BASE_URL: "https://derived.example/v1" } },
    { type: "oauth", access: "oauth-access-secret", refresh: "oauth-refresh-secret" }
  ]) {
    const root = await createGitRepository();
    const piConfig = await createDirectory();
    await writeFile(path.join(piConfig, "settings.json"), `${JSON.stringify({ defaultProvider: "test", defaultModel: "fixture-model" })}\n`);
    await writeFile(path.join(piConfig, "auth.json"), `${JSON.stringify({ test: credential })}\n`);
    const result = await runDelegation(makeEnvelope(root, {
      executionProfile: { provider: "test", model: "fixture-model" }
    }), {
      executorCommand: fakePi,
      executorEnv: { FAKE_PI_SCENARIO: "success", PI_CODING_AGENT_DIR: piConfig }
    });
    assert.notEqual(result.status, "completed");
    assert.equal(result.hostAcceptance.eligible, false);
    await assert.rejects(readFile(path.join(root, "allowed.txt"), "utf8"), (error) => error.code === "ENOENT");
    assert.doesNotMatch(JSON.stringify(result), /command-resolved-secret|oauth-access-secret|oauth-refresh-secret|derived\.example/);
  }
});

test("Pi provider URL inventory preserves raw authority spelling and dot segments", async () => {
  const root = await createGitRepository();
  const piConfig = await createDirectory();
  const rawAuthority = "PrivateTenant.Example:8443";
  await writeFile(path.join(piConfig, "settings.json"), `${JSON.stringify({ defaultProvider: "test", defaultModel: "fixture-model" })}\n`);
  await writeFile(path.join(piConfig, "models.json"), `${JSON.stringify({
    providers: {
      test: {
        baseUrl: `https://${rawAuthority}/PrivateCarrier/../v1`,
        api: "openai-responses",
        apiKey: "placeholder",
        models: []
      }
    }
  })}\n`);
  const result = await runDelegation(makeEnvelope(root, {
    executionProfile: { provider: "test", model: "fixture-model" }
  }), {
    executorCommand: fakePi,
    executorEnv: { FAKE_PI_SCENARIO: "config-url-raw-host", PI_CODING_AGENT_DIR: piConfig }
  });
  assert.equal(result.status, "rejected");
  assert.ok(result.scope.breaches.includes("evidence:credential value detected"));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(rawAuthority));
});

test("Pi provider URL projection rejects paths that exceed the decoding bound", async () => {
  const root = await createGitRepository();
  const piConfig = await createDirectory();
  await writeFile(path.join(piConfig, "settings.json"), `${JSON.stringify({ defaultProvider: "test", defaultModel: "fixture-model" })}\n`);
  await writeFile(path.join(piConfig, "models.json"), `${JSON.stringify({
    providers: {
      test: {
        baseUrl: "https://provider.example/v1/carrier%25252Fopaque-value",
        api: "openai-responses",
        apiKey: "placeholder",
        models: []
      }
    }
  })}\n`);
  const result = await runDelegation(makeEnvelope(root, {
    executionProfile: { provider: "test", model: "fixture-model" }
  }), {
    executorCommand: fakePi,
    executorEnv: { FAKE_PI_SCENARIO: "success", PI_CODING_AGENT_DIR: piConfig }
  });
  assert.notEqual(result.status, "completed");
  assert.equal(result.hostAcceptance.eligible, false);
  assert.match(result.executor.summary, /decoding bound/);
  assert.doesNotMatch(JSON.stringify(result), /opaque-value/);
  await assert.rejects(readFile(path.join(root, "allowed.txt"), "utf8"), (error) => error.code === "ENOENT");
});

test("Pi provider URL projection rejects malformed percent encoding before launch", async () => {
  const root = await createGitRepository();
  const piConfig = await createDirectory();
  await writeFile(path.join(piConfig, "settings.json"), `${JSON.stringify({ defaultProvider: "test", defaultModel: "fixture-model" })}\n`);
  await writeFile(path.join(piConfig, "models.json"), `${JSON.stringify({
    providers: {
      test: {
        baseUrl: "https://provider.example/bad%ZZ/carrier%252Fopaque-value",
        api: "openai-responses",
        apiKey: "placeholder",
        models: []
      }
    }
  })}\n`);
  const result = await runDelegation(makeEnvelope(root, {
    executionProfile: { provider: "test", model: "fixture-model" }
  }), {
    executorCommand: fakePi,
    executorEnv: { FAKE_PI_SCENARIO: "success", PI_CODING_AGENT_DIR: piConfig }
  });
  assert.notEqual(result.status, "completed");
  assert.equal(result.hostAcceptance.eligible, false);
  assert.match(result.executor.summary, /unsupported URL path encoding/);
  assert.doesNotMatch(JSON.stringify(result), /opaque-value|bad%ZZ/);
  await assert.rejects(readFile(path.join(root, "allowed.txt"), "utf8"), (error) => error.code === "ENOENT");
});

test("Pi launch binds the resolved host route and ignores hostile project settings", async () => {
  const root = await createGitRepository();
  await mkdir(path.join(root, ".pi"));
  await writeFile(path.join(root, ".pi", "settings.json"), `${JSON.stringify({
    defaultProvider: "hostile-project-provider",
    defaultModel: "hostile-project-model"
  })}\n`);
  await execFileAsync("git", ["add", ".pi/settings.json"], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "test: add hostile project settings"], { cwd: root });
  const piConfig = await createDirectory();
  const expectedProvider = "host-selected-provider";
  const expectedModel = "host-selected-model";
  await writeFile(path.join(piConfig, "settings.json"), `${JSON.stringify({
    defaultProvider: expectedProvider,
    defaultModel: expectedModel
  })}\n`);
  await writeFile(path.join(piConfig, "auth.json"), `${JSON.stringify({
    [expectedProvider]: { type: "api_key", key: "host-selected-provider-key" }
  })}\n`);
  const result = await runDelegation(makeEnvelope(root), {
    executorCommand: fakePi,
    executorEnv: {
      FAKE_PI_SCENARIO: "route-bound",
      FAKE_PI_EXPECTED_PROVIDER: expectedProvider,
      FAKE_PI_EXPECTED_MODEL: expectedModel,
      PI_CODING_AGENT_DIR: piConfig
    }
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(result.changedPaths, ["allowed.txt"]);
  assert.equal(result.executor.summary, "Resolved route was host-bound.");
});

test("Pi short credentials remain in exact-value evidence controls", async () => {
  const root = await createGitRepository();
  const piConfig = await createDirectory();
  const secret = "q7z";
  await writeFile(path.join(piConfig, "settings.json"), `${JSON.stringify({ defaultProvider: "test", defaultModel: "fixture-model" })}\n`);
  await writeFile(path.join(piConfig, "auth.json"), `${JSON.stringify({ test: { type: "api_key", key: secret } })}\n`);
  const result = await runDelegation(makeEnvelope(root, {
    executionProfile: { provider: "test", model: "fixture-model" }
  }), {
    executorCommand: fakePi,
    executorEnv: { FAKE_PI_SCENARIO: "config-secret", PI_CODING_AGENT_DIR: piConfig }
  });
  assert.equal(result.status, "rejected");
  assert.ok(result.scope.breaches.includes("evidence:credential value detected"));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
});

test("staged rename from an unapproved source is independently rejected", async () => {
  const root = await createGitRepository();
  await writeFile(path.join(root, "outside.txt"), "outside\n");
  await execFileAsync("git", ["add", "outside.txt"], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "test: add staged rename source"], { cwd: root });
  const envelope = makeEnvelope(root, {
    scope: { allowedPaths: ["allowed.txt"], forbiddenPaths: [] }
  });
  const result = await execute(envelope, "staged-rename");
  assert.equal(result.status, "rejected");
  assert.deepEqual(result.changedPaths, ["allowed.txt", "outside.txt"]);
  assert.deepEqual(result.scope.breaches, ["git:metadata changed during delegated execution", "outside.txt"]);
  assert.equal(result.hostAcceptance.eligible, false);
});

test("branch changes are rejected as baseline breaches", async () => {
  const root = await createGitRepository();
  const result = await execute(makeEnvelope(root), "branch-change");
  assert.equal(result.status, "rejected");
  assert(result.scope.breaches.includes("git:branch changed during delegated execution"));
});

test("credential-like fields are rejected from the envelope", () => {
  const envelope = makeEnvelope("/absolute/repository", {
    executionProfile: { provider: "example", [["api", "Key"].join("")]: "do-not-store" }
  });
  assert.throws(() => validateTaskEnvelope(envelope), (error) => error.code === "invalid_envelope" || error.code === "credential_in_envelope");
});

test("credential-like validation arguments are rejected", () => {
  const envelope = makeEnvelope("/absolute/repository", {
    validation: [{ id: "unsafe", argv: ["tool", "--api-key", "do-not-store"] }]
  });
  assert.throws(() => validateTaskEnvelope(envelope), (error) => error.code === "credential_in_envelope");
  const environmentAssignment = makeEnvelope("/absolute/repository", {
    validation: [{ id: "unsafe", argv: ["env", "API_KEY=do-not-store", "tool"] }]
  });
  assert.throws(() => validateTaskEnvelope(environmentAssignment), (error) => error.code === "credential_in_envelope");
  const authorizationHeader = makeEnvelope("/tmp/project", {
    validation: [{
      id: "unsafe",
      argv: ["curl", "-H", ["Authorization", ["Bear", "er"].join(""), "public-preview-must-not-store"].join(": ").replace(": public", " public")]
    }]
  });
  assert.throws(() => validateTaskEnvelope(authorizationHeader), (error) => error.code === "credential_in_envelope");
});
