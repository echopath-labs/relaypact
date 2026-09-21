import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverWorkBuddy, inspectWorkBuddy, parseWorkBuddyResult, parseWorkBuddySupportedModels, runExecutor } from "../packages/executor-workbuddy/src/executor.mjs";
import { runDelegation } from "../packages/adapter-codex-workbuddy/src/run-delegation.mjs";
import { runCli } from "../packages/cli/src/main.mjs";
import { createGitRepository, makeEnvelope } from "./helpers.mjs";

function terminal(status = "completed", extra = {}) {
  return { type: "result", subtype: "success", is_error: false, permission_denials: [], result: JSON.stringify({ status, summary: "fixture" }), ...extra };
}
function processResult(records = [terminal()], extra = {}) {
  return { exitCode: 0, signal: null, stdout: JSON.stringify(records), stderr: "", ...extra };
}
const FIXTURE_MODEL = "deepseek-v4.1-flash";
function modelHelpResult(models = [FIXTURE_MODEL], extra = {}) {
  return {
    exitCode: 0, signal: null,
    stdout: `  --model <model>  Model for the current session. Currently supported: (${models.join(", ")})\n`,
    stderr: "", ...extra
  };
}
async function installation(t, edition = "mainland") {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "relaypact-workbuddy-test-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const appPath = path.join(root, "Selected.app");
  const home = path.join(root, "home");
  const intl = edition === "international";
  const cli = path.join(appPath, "Contents/Resources/app.asar.unpacked/cli");
  await mkdir(path.join(cli, "bin"), { recursive: true });
  await mkdir(path.join(cli, "dist"), { recursive: true });
  await mkdir(path.join(home, intl ? ".workbuddy-ai" : ".workbuddy"), { recursive: true });
  await writeFile(path.join(appPath, "Contents/Info.plist"), `<plist><dict><key>CFBundleIdentifier</key><string>${intl ? "com.workbuddy.workbuddy-ai" : "com.tencent.workbuddy.mac"}</string></dict></plist>`);
  await writeFile(path.join(cli, "product.json"), JSON.stringify({ productName: intl ? "WorkBuddy AI" : "WorkBuddy", applicationName: intl ? "workbuddy-ai" : "WorkBuddy", dataFolderName: intl ? ".workbuddy-ai" : ".workbuddy", isOversea: intl, authentication: { type: "cli-external-link", id: intl ? "workbuddy-desktop-ai" : "workbuddy-desktop" } }));
  await writeFile(path.join(cli, "package.json"), JSON.stringify({ publishConfig: { customPackage: { version: "2.137.1" } } }));
  await writeFile(path.join(cli, "bin/codebuddy"), "// offline fixture launcher\n");
  await writeFile(path.join(cli, "dist/codebuddy-headless.js"), "// offline fixture bundle\n");
  const workingDirectory = path.join(root, "workspace");
  await mkdir(workingDirectory);
  return {
    edition, model: FIXTURE_MODEL, appPath, home, workingDirectory, platform: "darwin",
    runModelProbe: async () => modelHelpResult()
  };
}

for (const edition of ["mainland", "international"]) {
  test(`${edition}: bind identity and native configuration without probing login`, async (t) => {
    const options = await installation(t, edition);
    const identity = await inspectWorkBuddy(options);
    assert.equal(identity.edition, edition);
    assert.equal(identity.configDir, path.join(options.home, edition === "mainland" ? ".workbuddy" : ".workbuddy-ai"));
    const ready = await discoverWorkBuddy(options);
    assert.equal(ready.state, "available");
    assert.equal(ready.authentication, "unverified");
    assert.equal(ready.model, FIXTURE_MODEL);
    assert.equal(ready.modelPreflight, "supported_by_native_help");
    assert.equal(ready.resumable, false);
    const opposite = await discoverWorkBuddy({ ...options, edition: edition === "mainland" ? "international" : "mainland" });
    assert.equal(opposite.reason, "workbuddy_edition_mismatch");
  });
}

test("missing selection, unsupported version, missing configuration and symlinked entry stay blocked", async (t) => {
  const options = await installation(t);
  assert.equal((await discoverWorkBuddy({ ...options, edition: undefined })).reason, "workbuddy_edition_required");
  const cli = path.join(options.appPath, "Contents/Resources/app.asar.unpacked/cli");
  await writeFile(path.join(cli, "package.json"), '{"publishConfig":{"customPackage":{"version":"99.0.0"}}}');
  assert.equal((await discoverWorkBuddy(options)).reason, "workbuddy_version_unverified");
  await writeFile(path.join(cli, "package.json"), '{"publishConfig":{"customPackage":{"version":"2.137.1"}}}');
  await rm(path.join(options.home, ".workbuddy"), { recursive: true });
  assert.equal((await discoverWorkBuddy(options)).reason, "workbuddy_configuration_unavailable");
  await mkdir(path.join(options.home, ".workbuddy"));
  await rm(path.join(cli, "bin/codebuddy"));
  await symlink(path.join(cli, "dist/codebuddy-headless.js"), path.join(cli, "bin/codebuddy"));
  assert.equal((await discoverWorkBuddy(options)).reason, "workbuddy_identity_invalid");
});

test("only a unique successful terminal and structured task status establish completion", () => {
  assert.deepEqual(parseWorkBuddyResult(JSON.stringify([{ type: "message", content: "untrusted input" }, terminal()])), { status: "completed", summary: "fixture" });
  for (const records of [[terminal(), terminal()], [terminal(), { type: "message" }], [null], { result: "completed" }, [{ type: "message", content: JSON.stringify(terminal()) }], [terminal("completed", { is_error: undefined })], [terminal("completed", { permission_denials: undefined })]]) {
    const result = parseWorkBuddyResult(JSON.stringify(records));
    assert.notEqual(result?.status, "completed");
  }
  assert.equal(parseWorkBuddyResult("not-json"), null);
  assert.deepEqual(parseWorkBuddyResult(JSON.stringify([terminal("completed", { permission_denials: [{}] })])), { status: "blocked" });
  assert.deepEqual(parseWorkBuddyResult(JSON.stringify([terminal("blocked")])), { status: "blocked", summary: "fixture" });
  assert.deepEqual(parseWorkBuddyResult(JSON.stringify([terminal("completed", { is_error: true })])), { status: "failed" });
  assert.deepEqual(parseWorkBuddyResult(JSON.stringify([terminal("completed", { model: FIXTURE_MODEL })])), { status: "completed", summary: "fixture", model: FIXTURE_MODEL });
  assert.deepEqual(parseWorkBuddySupportedModels(modelHelpResult([FIXTURE_MODEL, "other-model"]).stdout), [FIXTURE_MODEL, "other-model"]);
  assert.equal(parseWorkBuddySupportedModels(`${modelHelpResult().stdout}${modelHelpResult().stdout}`), null);
});

test("launch preserves native roots, binds one model, narrows tools and suppresses raw output", async (t) => {
  const options = await installation(t, "international");
  let runtimeRoot;
  const output = await runExecutor(makeEnvelope(options.workingDirectory), { ...options, workingDirectory: options.workingDirectory,
    runProcess: async (command, args, launch) => {
      assert.equal(command, process.execPath);
      assert.equal(args[args.indexOf("--tools") + 1], "Read,Write");
      assert.equal(args[args.indexOf("--permission-mode") + 1], "dontAsk");
      const settings = JSON.parse(args[args.indexOf("--settings") + 1]);
      assert.deepEqual(settings.permissions.ask, [`Read(/${options.workingDirectory}/**)`]);
      assert(settings.permissions.allow.includes(`Write(/${options.workingDirectory}/allowed.txt)`));
      assert(settings.permissions.deny.includes(`Write(/${options.workingDirectory}/private.txt)`));
      assert(!("model" in settings));
      assert(!args.includes("--allowedTools"), "Bare allowedTools would override path-limited grants.");
      assert(args.includes("--no-session-persistence"));
      assert(args.includes("--strict-mcp-config"));
      assert.equal(args.filter((value) => value === "--model").length, 1);
      assert.equal(args[args.indexOf("--model") + 1], FIXTURE_MODEL);
      assert(!args.includes("--fallback-model") && !args.includes("--resume") && !args.includes("-y"));
      assert.equal(launch.env.CODEBUDDY_CONFIG_DIR, path.join(options.home, ".workbuddy-ai"));
      assert.equal(launch.env.WORKBUDDY_CONFIG_DIR, launch.env.CODEBUDDY_CONFIG_DIR);
      assert.equal(launch.env.HOME, options.home);
      assert(!("NODE_OPTIONS" in launch.env) && !("CODEBUDDY_API_KEY" in launch.env));
      assert.equal(launch.maxCaptureBytes, 2 * 1024 * 1024);
      runtimeRoot = launch.env.TMPDIR;
      return processResult([terminal("completed", { result: '{"status":"completed","summary":"Bearer fake-private-provider-token"}', session_id: "private-session" })]);
    }
  });
  assert.equal(output.reportedStatus, "completed");
  assert.deepEqual(output.modelBinding, {
    value: FIXTURE_MODEL, source: "host_argument", mechanism: "process_argument",
    assurance: "preflight_supported", fallbackAllowed: false, boundAt: output.modelBinding.boundAt
  });
  assert.equal(output.modelObservation.state, "unavailable");
  assert(!JSON.stringify(output).includes("fake-private-provider-token"));
  assert(!JSON.stringify(output).includes("private-session"));
  await assert.rejects(readFile(path.join(runtimeRoot, "anything")), { code: "ENOENT" });
});

test("model selection is required, bounded and verified before task execution", async (t) => {
  const options = await installation(t);
  await assert.rejects(runDelegation(makeEnvelope(options.workingDirectory), { ...options, model: undefined }), { code: "workbuddy_model_required" });
  let launches = 0;
  const invalid = await runExecutor(makeEnvelope(options.workingDirectory), {
    ...options, model: "--paid-model", runProcess: async () => { launches += 1; return processResult(); }
  });
  assert.equal(invalid.failureCode, "workbuddy_model_invalid");
  const unsupported = await runExecutor(makeEnvelope(options.workingDirectory), {
    ...options, model: "other-model", runModelProbe: async () => modelHelpResult([FIXTURE_MODEL]),
    runProcess: async () => { launches += 1; return processResult(); }
  });
  assert.equal(unsupported.failureCode, "workbuddy_model_unsupported");
  for (const extra of [{ exitCode: 1 }, { timedOut: true }, { cancelled: true }, { stdoutTruncated: true }, { stderrTruncated: true }]) {
    const unavailable = await runExecutor(makeEnvelope(options.workingDirectory), {
      ...options, runModelProbe: async () => modelHelpResult([FIXTURE_MODEL], extra),
      runProcess: async () => { launches += 1; return processResult(); }
    });
    assert.equal(unavailable.failureCode, "workbuddy_model_probe_unavailable");
  }
  const malformed = await runExecutor(makeEnvelope(options.workingDirectory), {
    ...options, runModelProbe: async () => ({ ...modelHelpResult(), stdout: "Usage: codebuddy" }),
    runProcess: async () => { launches += 1; return processResult(); }
  });
  assert.equal(malformed.failureCode, "workbuddy_model_probe_unavailable");
  assert.equal(launches, 0);
});

test("reported model evidence is checked independently from the Host binding", async (t) => {
  const options = await installation(t);
  const matched = await runExecutor(makeEnvelope(options.workingDirectory), {
    ...options, runProcess: async () => processResult([terminal("completed", { model: FIXTURE_MODEL })])
  });
  assert.equal(matched.reportedStatus, "completed");
  assert.equal(matched.modelObservation.value, FIXTURE_MODEL);
  const mismatch = await runExecutor(makeEnvelope(options.workingDirectory), {
    ...options, runProcess: async () => processResult([terminal("completed", { model: "other-model" })])
  });
  assert.equal(mismatch.reportedStatus, "failed");
  assert.equal(mismatch.failureCode, "workbuddy_model_mismatch");
  assert.equal(mismatch.modelBinding.value, FIXTURE_MODEL);
  assert.equal(mismatch.modelObservation.value, "other-model");
});

test("timeout, cancellation, truncation and zero-exit login errors cannot pass", async (t) => {
  const options = await installation(t);
  for (const extra of [{ timedOut: true }, { cancelled: true }, { stdoutTruncated: true }, { stderrTruncated: true }, { signal: "SIGTERM" }, { exitCode: 1 }]) {
    const result = await runExecutor(makeEnvelope(options.workingDirectory), { ...options, runProcess: async () => processResult([terminal()], extra) });
    assert.equal(result.reportedStatus, "failed");
  }
  for (const exitCode of [0, 1, 42]) {
    for (const state of ["required", "failed"]) {
      const login = await runExecutor(makeEnvelope(options.workingDirectory), { ...options, runProcess: async () => processResult([], { exitCode, stdout: "", stderr: `Authentication ${state}. Please use /login command to sign in to your account` }) });
      assert.equal(login.reportedStatus, "blocked");
      assert.equal(login.failureCode, "workbuddy_authentication_unavailable");
      assert.equal(login.exitCode, exitCode);
    }
  }
  for (const bounds of [{ timedOut: true }, { cancelled: true }, { signal: "SIGTERM" }, { stdoutTruncated: true }, { stderrTruncated: true }]) {
    const result = await runExecutor(makeEnvelope(options.workingDirectory), { ...options, runProcess: async () => processResult([], {
      exitCode: 1, stderr: "Authentication failed. Please use /login", ...bounds
    }) });
    assert.equal(result.failureCode, "workbuddy_process_failed");
    assert.equal(result.reportedStatus, "failed");
  }
});

test("identity mutation and same-session requests stop before spawning", async (t) => {
  const options = await installation(t);
  let calls = 0;
  const result = await runExecutor(makeEnvelope(options.workingDirectory), { ...options, beforeVerifiedLaunch: async () => writeFile(path.join(options.appPath, "Contents/Resources/app.asar.unpacked/cli/bin/codebuddy"), "changed"), runProcess: async () => { calls++; return processResult(); } });
  assert.equal(calls, 0);
  assert.equal(result.failureCode, "workbuddy_identity_changed");
  assert.equal((await runExecutor(makeEnvelope(options.workingDirectory), { ...options, resumeSessionId: "session" })).failureCode, "workbuddy_fresh_task_required");
  await assert.rejects(runDelegation({}, { ...options, stateRoot: "state" }), { code: "workbuddy_fresh_task_required" });
});

test("Host rejects a claimed success when independent validation or path scope fails", async (t) => {
  const options = await installation(t);
  const root = await createGitRepository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = makeEnvelope(root, { validation: [{ id: "actual-output", argv: [process.execPath, "-e", "require('node:fs').accessSync('allowed.txt')"] }] });
  const absent = await runDelegation(input, { ...options, runProcess: async () => processResult() });
  assert.equal(absent.status, "failed");
  assert.equal(absent.hostAcceptance.eligible, false);
  assert.equal(absent.executor.modelBinding.value, FIXTURE_MODEL);
  assert.equal(absent.executor.modelBinding.fallbackAllowed, false);
  assert.equal(absent.executor.modelObservation.state, "unavailable");
  const breach = await runDelegation(input, { ...options, runProcess: async () => { await writeFile(path.join(root, "private.txt"), "breach"); return processResult(); } });
  assert.equal(breach.status, "rejected");
  assert.deepEqual(breach.scope.breaches, ["private.txt"]);
});

test("read-only prohibits file changes even within the original writable scope", async (t) => {
  const options = await installation(t);
  const root = await createGitRepository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const envelope = makeEnvelope(root);
  const result = await runDelegation(envelope, { ...options, readOnly: true, runProcess: async (command, args) => {
    assert.equal(args[args.indexOf("--tools") + 1], "Read");
    await writeFile(path.join(root, "allowed.txt"), "unexpected");
    return processResult();
  } });
  assert.equal(result.status, "rejected");
  assert(!envelope.scope.forbiddenPaths.includes("**"));
});

test("CLI requires explicit edition/model and rejects unsupported continuation options", async () => {
  for (const args of [["run-workbuddy", "--envelope", "missing"], ["run-workbuddy", "--edition", "mainland", "--envelope", "missing"], ["run-workbuddy", "--edition", "international", "--model", FIXTURE_MODEL, "--envelope", "missing", "--state-root", "state"], ["run-pi", "--edition", "mainland", "--envelope", "missing"]]) {
    const io = { stdout: { write() { assert.fail("must not dispatch"); } }, stderr: { write() {} }, exitCode: 0 };
    await runCli(args, io);
    assert.equal(io.exitCode, 1);
  }
});

test("read grants respect explicit authority and original prohibitions in both modes", async (t) => {
  const options = await installation(t);
  const root = await createGitRepository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const canonicalRoot = await realpath(root);
  for (const readOnly of [false, true]) {
    for (const readablePaths of [undefined, [], ["README.md"]]) {
      for (const forbiddenPaths of [["private.txt"], ["**"]]) {
        const scope = { allowedPaths: ["allowed.txt"], forbiddenPaths, ...(readablePaths === undefined ? {} : { readablePaths }) };
        const result = await runDelegation(makeEnvelope(root, { scope }), { ...options, readOnly, runProcess: async (command, args) => {
          const settings = JSON.parse(args[args.indexOf("--settings") + 1]).permissions;
          assert.deepEqual(settings.ask, [`Read(/${canonicalRoot}/**)`]);
          assert.deepEqual(settings.allow.filter((rule) => rule.startsWith("Read(")),
            (readablePaths ?? scope.allowedPaths).map((p) => `Read(/${canonicalRoot}/${p})`));
          for (const p of forbiddenPaths) {
            assert(settings.deny.includes(`Read(/${canonicalRoot}/${p})`));
            assert(settings.deny.includes(`Write(/${canonicalRoot}/${p})`));
          }
          assert(settings.deny.includes(`Read(/${canonicalRoot}/.git/**)`));
          if (readOnly) assert(settings.deny.includes(`Write(/${canonicalRoot}/**)`));
          const prompt = JSON.parse(args[args.indexOf("--print") + 1].split("\n\n").at(-1));
          assert.deepEqual(prompt.scope.forbiddenPaths, forbiddenPaths);
          assert(!args.includes("--allowedTools"));
          return processResult();
        } });
        assert.equal(result.status, "completed");
      }
    }
  }
});

test("doctor accepts each matrix route only with its matching explicit edition", async (t) => {
  for (const [route, edition] of [["codex-workbuddy", "mainland"], ["codex-workbuddy-ai", "international"]]) {
    const installationOptions = await installation(t, edition);
    let stdout = "", stderr = "";
    const io = { stdout: { write(text) { stdout += text; } }, stderr: { write(text) { stderr += text; } }, exitCode: 0 };
    await runCli(["doctor", "--route", route, "--edition", edition, "--app", installationOptions.appPath], io, { doctor: installationOptions });
    assert.equal(stderr, "");
    assert.equal(io.exitCode, 0);
    assert.equal(JSON.parse(stdout).edition, edition);
    assert.equal(JSON.parse(stdout).state, "available");
    stdout = ""; stderr = ""; io.exitCode = 0;
    await runCli(["doctor", "--route", route, "--edition", edition, "--model", FIXTURE_MODEL, "--app", installationOptions.appPath], io, { doctor: installationOptions });
    assert.equal(stderr, "");
    assert.equal(io.exitCode, 0);
    assert.equal(JSON.parse(stdout).model, FIXTURE_MODEL);
    assert.equal(JSON.parse(stdout).modelPreflight, "supported_by_native_help");
    for (const selection of [[], ["--edition", edition === "mainland" ? "international" : "mainland"]]) {
      stdout = ""; stderr = ""; io.exitCode = 0;
      await runCli(["doctor", "--route", route, ...selection, "--app", installationOptions.appPath], io, { doctor: installationOptions });
      assert.equal(stdout, "");
      assert.equal(io.exitCode, 1);
      assert.match(stderr, /edition/);
    }
  }
});

test("read-only rejects an acknowledged dirty baseline before native execution", async (t) => {
  const options = await installation(t);
  const root = await createGitRepository();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "allowed.txt"), "existing user work");
  const envelope = makeEnvelope(root, { repository: { dirtyTree: { allow: true, acknowledgedPaths: ["allowed.txt"] } } });
  await assert.rejects(runDelegation(envelope, { ...options, readOnly: true,
    runProcess: async () => assert.fail("dirty baseline must not launch the harness") }), { code: "dirty_tree" });
  assert.equal(envelope.repository.dirtyTree.allow, true);
  assert.equal(await readFile(path.join(root, "allowed.txt"), "utf8"), "existing user work");
});

test("unsupported context planning blocks without launching or claiming validation", async (t) => {
  const options = await installation(t);
  const root = await createGitRepository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await runDelegation(makeEnvelope(root, {
    scope: { discoverablePaths: ["**"] },
    contextPlanning: { strategy: "dependency-closure", seeds: ["README.md"], analyzers: ["node-esm"],
      budget: { maxFiles: 1, maxBytes: 1, maxDepth: 1 },
      readiness: [{ id: "must-block", argv: [process.execPath, "-e", "process.exit(42)"], timeoutMs: 1000, acceptableExitCodes: [0] }] }
  }), { ...options, runProcess: async () => assert.fail("unsupported planning must not launch the harness") });
  assert.equal(result.status, "blocked");
  assert.equal(result.executor.failureCode, "workbuddy_exposure_unsupported");
  assert.equal(result.hostAcceptance.eligible, false);
  assert(result.validations.every((item) => item.status === "not_run"));
});

test("native permission rules and prompt bind the same canonical repository path", async (t) => {
  const options = await installation(t);
  const alias = path.join(path.dirname(options.home), "workspace-alias");
  await symlink(options.workingDirectory, alias);
  const envelope = makeEnvelope(alias);
  const result = await runExecutor(envelope, { ...options, workingDirectory: alias,
    runProcess: async (command, args, launch) => {
      const prompt = args[args.indexOf("--print") + 1];
      const nativeEnvelope = JSON.parse(prompt.split("\n\n").at(-1));
      assert.equal(nativeEnvelope.repository.root, options.workingDirectory);
      assert.equal(launch.cwd, options.workingDirectory);
      const settings = JSON.parse(args[args.indexOf("--settings") + 1]);
      assert(settings.permissions.allow.includes(`Write(/${options.workingDirectory}/allowed.txt)`));
      assert(!JSON.stringify(settings).includes(alias));
      return processResult();
    }
  });
  assert.equal(result.reportedStatus, "completed");
  assert.equal(envelope.repository.root, alias);
});

test("native pattern syntax and unsupported isolation cannot silently widen authority", async (t) => {
  const options = await installation(t);
  let calls = 0;
  const run = async () => { calls++; return processResult(); };
  for (const pattern of ["file[ab].txt", "file(name).txt", "file{a,b}.txt"]) {
    const result = await runExecutor(makeEnvelope(options.workingDirectory, { scope: { allowedPaths: [pattern] } }), { ...options, runProcess: run });
    assert.equal(result.failureCode, "workbuddy_scope_unsupported");
  }
  const globRoot = path.join(options.workingDirectory, "root[1]");
  await mkdir(globRoot);
  assert.equal((await runExecutor(makeEnvelope(globRoot), { ...options, workingDirectory: globRoot, runProcess: run })).failureCode, "workbuddy_scope_unsupported");
  const sanitized = await runExecutor(makeEnvelope(options.workingDirectory, { execution: { exposureMode: "sanitized" } }), { ...options, runProcess: run });
  assert.equal(sanitized.failureCode, "workbuddy_exposure_unsupported");
  assert.equal(calls, 0);
});


for (const edition of ["mainland", "international"]) {
  test(`${edition}: configured evidence budget includes large ignored dependencies`, async (t) => {
    const options = await installation(t, edition);
    const root = await createGitRepository();
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(path.join(root, ".git", "info", "exclude"), "dependencies.bin\n");
    await writeFile(path.join(root, "dependencies.bin"), "");
    await truncate(path.join(root, "dependencies.bin"), 512 * 1024 * 1024 + 1);
    let launches = 0;
    const result = await runDelegation(makeEnvelope(root, {
      execution: { filesystemEvidenceMaxBytes: 600 * 1024 * 1024 }
    }), { ...options, runProcess: async () => { launches += 1; return processResult(); } });
    assert.equal(launches, 1);
    assert.equal(result.status, "completed");
    assert.equal(result.validations[0].status, "passed");
    assert.equal(result.filesystemEvidenceMaxBytes, 600 * 1024 * 1024);
  });
}
