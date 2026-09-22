import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, realpath, rm, truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { validateTaskEnvelope } from "../packages/contracts/src/envelope.mjs";
import { parseStatusPaths } from "../packages/core/src/git.mjs";
import { runDelegation } from "../packages/adapter-codex-pi/src/run-delegation.mjs";
import { discoverPiCli, materializePiExecutable, resolvePiExecutable } from "../packages/executor-pi/src/executor.mjs";
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

const readyPiHelp = [
  "--print", "--mode text json", "--no-session", "--no-extensions", "--no-skills",
  "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve",
  "--tools", "--provider", "--model", "--thinking"
].join("\n");
const piIdentity = (fingerprint = "a".repeat(64)) => ({
  command: "/fixture/pi",
  resolvedCommand: "/fixture/pi-runtime",
  executableFingerprint: `sha256:${fingerprint}`
});
const piProbeResult = (stdout, overrides = {}) => ({
  exitCode: 0,
  signal: null,
  stdout,
  stderr: "",
  timedOut: false,
  cancelled: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  ...overrides
});

function piDoctorFixture(overrides = {}) {
  const calls = [];
  const identities = [...(overrides.identities ?? [piIdentity(), piIdentity()])];
  return {
    calls,
    resolveExecutable: async () => identities.shift() ?? null,
    runProcess: async (command, args, options) => {
      calls.push({ command, args, options });
      if (args[0] === "--version") return overrides.version ?? piProbeResult("0.84.0\n");
      return overrides.help ?? piProbeResult(`${readyPiHelp}\n`);
    }
  };
}

test("Pi doctor discovery is model-free and isolates settings from the project and ambient environment", async () => {
  const fixture = piDoctorFixture();
  const readiness = await discoverPiCli({
    ...fixture,
    environment: { PATH: "/fixture", HOME: "/Users/private", SECRET_TOKEN: "opaque" },
    executorCommand: "/fixture/pi"
  });
  assert.equal(readiness.state, "ready");
  assert.equal(readiness.version, "0.84.0");
  assert.equal(readiness.executableStable, true);
  assert.equal(readiness.settingsIsolated, true);
  assert.equal(Object.values(readiness.capabilities).every(Boolean), true);
  assert.deepEqual(fixture.calls.map((item) => item.args), [["--version"], ["--help"]]);
  assert.equal(fixture.calls.every((item) => item.options.cwd.includes("relaypact-pi-doctor-")), true);
  assert.equal(fixture.calls.every((item) => item.options.env.HOME.includes("relaypact-pi-doctor-")), true);
  assert.equal(fixture.calls.every((item) => item.options.env.PI_CODING_AGENT_DIR.includes("relaypact-pi-doctor-")), true);
  assert.equal(fixture.calls.every((item) => item.options.env.SECRET_TOKEN === undefined), true);
});

test("Pi doctor discovery blocks unsupported, missing, and mutated executables", async () => {
  const unsupported = piDoctorFixture({ version: piProbeResult("0.83.9\n") });
  assert.equal((await discoverPiCli({ ...unsupported, executorCommand: "/fixture/pi" })).reason, "unsupported_version");

  const prerelease = piDoctorFixture({ version: piProbeResult("0.84.0-beta.1\n") });
  const prereleaseResult = await discoverPiCli({ ...prerelease, executorCommand: "/fixture/pi" });
  assert.equal(prereleaseResult.reason, "unsupported_version");
  assert.equal(prereleaseResult.version, "0.84.0-beta.1");

  const laterPrerelease = piDoctorFixture({ version: piProbeResult("0.85.0-beta.1\n") });
  assert.equal((await discoverPiCli({ ...laterPrerelease, executorCommand: "/fixture/pi" })).state, "ready");

  const missingCapability = piDoctorFixture({ help: piProbeResult(readyPiHelp.replace("--thinking", "")) });
  assert.equal((await discoverPiCli({ ...missingCapability, executorCommand: "/fixture/pi" })).reason, "unsupported_capabilities");

  const missingMode = piDoctorFixture({ help: piProbeResult(readyPiHelp.replace("--mode text json", "text json")) });
  assert.equal((await discoverPiCli({ ...missingMode, executorCommand: "/fixture/pi" })).reason, "unsupported_capabilities");

  const unrelatedText = piDoctorFixture({ help: piProbeResult(`${readyPiHelp.replace("--mode text json", "--mode json")}\n--system-prompt <text>`) });
  assert.equal((await discoverPiCli({ ...unrelatedText, executorCommand: "/fixture/pi" })).reason, "unsupported_capabilities");

  const missing = piDoctorFixture({ identities: [] });
  assert.equal((await discoverPiCli({ ...missing, executorCommand: "/fixture/pi" })).reason, "missing");

  const mutated = piDoctorFixture({ identities: [piIdentity("a".repeat(64)), piIdentity("b".repeat(64))] });
  const mutationResult = await discoverPiCli({ ...mutated, executorCommand: "/fixture/pi" });
  assert.equal(mutationResult.reason, "mutated");
  assert.equal(mutationResult.executableFingerprint, null);
});

test("Pi doctor converts snapshot failures into sanitized blocked readiness", async () => {
  const fixture = piDoctorFixture();
  const privatePath = ["", "Users", "private", "pi", "package"].join("/");
  const readiness = await discoverPiCli({
    ...fixture,
    executorCommand: "/fixture/pi",
    materializeExecutable: async () => { throw new Error(`copy failed at ${privatePath}`); }
  });
  assert.equal(readiness.state, "blocked");
  assert.equal(readiness.reason, "mutated");
  assert.equal(readiness.command, "/fixture/pi");
  assert.equal(JSON.stringify(readiness).includes(privatePath), false);
  assert.equal(fixture.calls.length, 0);
});

test("Pi doctor blocks when either disposable state cleanup fails", async () => {
  const fixture = piDoctorFixture();
  const readiness = await discoverPiCli({
    ...fixture,
    executorCommand: "/fixture/pi",
    materializeExecutable: async (identity) => ({
      identity,
      cleanup: async () => { throw new Error("snapshot cleanup failed"); }
    })
  });
  assert.equal(readiness.state, "blocked");
  assert.equal(readiness.reason, "cleanup_failed");
  assert.equal(fixture.calls.length, 2);
});

test("Pi executable resolution rejects working-directory-relative launch paths", async () => {
  assert.equal(await resolvePiExecutable("./fake-pi.mjs", { environment: { PATH: process.env.PATH } }), null);
});

test("Pi delegation never resolves a relative executor inside the target repository", async () => {
  const root = await createGitRepository();
  const relativeExecutor = path.join(root, "target-pi.mjs");
  await writeFile(relativeExecutor, [
    "#!/usr/bin/env node",
    'import { writeFileSync } from "node:fs";',
    'writeFileSync("allowed.txt", "target-controlled executor ran\\n");',
    'process.stdout.write(JSON.stringify({ status: "completed", summary: "ran" }));'
  ].join("\n"));
  await chmod(relativeExecutor, 0o700);
  await execFileAsync("git", ["add", "target-pi.mjs"], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "test: add target executor"], { cwd: root });

  const result = await runDelegation(withFixturePiRoute(makeEnvelope(root)), {
    executorCommand: "./target-pi.mjs"
  });
  assert.equal(result.status, "failed");
  assert.match(result.executor.summary, /could not be resolved/u);
  await assert.rejects(readFile(path.join(root, "allowed.txt"), "utf8"), { code: "ENOENT" });
});

test("Pi launch identity covers imported package files and execution uses an immutable snapshot", async (context) => {
  const root = await createDirectory();
  context.after(() => rm(root, { recursive: true, force: true }));
  const entry = path.join(root, "pi.mjs");
  const dependency = path.join(root, "version.mjs");
  await writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "fixture-pi",
    private: true,
    type: "module",
    bin: { pi: "pi.mjs" }
  }));
  await writeFile(entry, [
    "#!/usr/bin/env node",
    'import { version } from "./version.mjs";',
    'if (process.argv.includes("--version")) process.stdout.write(`${version}\\n`);'
  ].join("\n"));
  await chmod(entry, 0o700);
  await writeFile(dependency, 'export const version = "0.84.0";\n');

  const before = await resolvePiExecutable(entry);
  assert.equal(before?.kind, "node-package");
  const snapshot = await materializePiExecutable(before);
  context.after(() => snapshot.cleanup());

  await writeFile(dependency, 'export const version = "9.9.9";\n');
  const after = await resolvePiExecutable(entry);
  assert.notEqual(after?.executableFingerprint, before.executableFingerprint);

  const { stdout } = await execFileAsync(snapshot.identity.launchCommand, [
    ...snapshot.identity.launchPrefix,
    "--version"
  ]);
  assert.equal(stdout, "0.84.0\n");
});

test("Pi snapshot includes dependencies hoisted beside the selected package", async (context) => {
  const workspace = await createDirectory();
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const modules = path.join(workspace, "node_modules");
  const packageRoot = path.join(modules, "fixture-pi");
  const dependencyRoot = path.join(modules, "hoisted-value");
  await mkdir(packageRoot, { recursive: true });
  await mkdir(dependencyRoot, { recursive: true });
  const entry = path.join(packageRoot, "pi.mjs");
  const dependency = path.join(dependencyRoot, "index.mjs");
  await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
    name: "fixture-pi",
    private: true,
    type: "module",
    bin: { pi: "pi.mjs" },
    dependencies: { "hoisted-value": "1.0.0" }
  }));
  await writeFile(entry, [
    "#!/usr/bin/env node",
    'import { version } from "hoisted-value";',
    'if (process.argv.includes("--version")) process.stdout.write(`${version}\\n`);'
  ].join("\n"));
  await chmod(entry, 0o700);
  await writeFile(path.join(dependencyRoot, "package.json"), JSON.stringify({
    name: "hoisted-value",
    version: "1.0.0",
    type: "module",
    exports: "./index.mjs"
  }));
  await writeFile(dependency, 'export const version = "0.84.0";\n');

  const before = await resolvePiExecutable(entry);
  assert.equal(before?.packageGraph.nodes.length, 2);
  const snapshot = await materializePiExecutable(before);
  context.after(() => snapshot.cleanup());
  await writeFile(dependency, 'export const version = "9.9.9";\n');
  const after = await resolvePiExecutable(entry);
  assert.notEqual(after?.executableFingerprint, before.executableFingerprint);

  const { stdout } = await execFileAsync(snapshot.identity.launchCommand, [
    ...snapshot.identity.launchPrefix,
    "--version"
  ]);
  assert.equal(stdout, "0.84.0\n");
});

test("Pi identity snapshots the Node runtime selected by the entry shebang", async (context) => {
  const root = await createDirectory();
  context.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  const packageRoot = path.join(root, "pi-package");
  await mkdir(bin);
  await mkdir(packageRoot);
  const selectedNode = path.join(bin, "selected-node");
  await copyFile(process.execPath, selectedNode);
  await chmod(selectedNode, 0o700);
  const nodeLauncher = path.join(bin, "node");
  await writeFile(nodeLauncher, `#!/bin/sh\nexec "${selectedNode}" "$@"\n`);
  await chmod(nodeLauncher, 0o700);
  const entry = path.join(packageRoot, "pi.mjs");
  await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
    name: "fixture-pi-runtime",
    private: true,
    type: "module",
    bin: { pi: "pi.mjs" }
  }));
  await writeFile(entry, [
    "#!/usr/bin/env node",
    'if (process.argv.includes("--version")) process.stdout.write("0.84.0\\n");'
  ].join("\n"));
  await chmod(entry, 0o700);

  const identity = await resolvePiExecutable(entry, { environment: { PATH: bin } });
  assert.equal(identity?.runtimeCommand, await realpath(selectedNode));
  assert.notEqual(identity.runtimeCommand, await realpath(process.execPath));
  const snapshot = await materializePiExecutable(identity);
  context.after(() => snapshot.cleanup());
  const { stdout } = await execFileAsync(snapshot.identity.launchCommand, [
    ...snapshot.identity.launchPrefix,
    "--version"
  ]);
  assert.equal(stdout, "0.84.0\n");
});

test("Pi doctor discovery blocks timed-out, truncated, and settings-write probes without retaining diagnostics", async () => {
  const timedOut = piDoctorFixture({ version: piProbeResult("", { timedOut: true }) });
  assert.equal((await discoverPiCli({ ...timedOut, executorCommand: "/fixture/pi" })).reason, "timed_out");

  const truncated = piDoctorFixture({ help: piProbeResult(readyPiHelp, { stdoutTruncated: true }) });
  assert.equal((await discoverPiCli({ ...truncated, executorCommand: "/fixture/pi" })).reason, "truncated");

  const privatePath = ["", "Users", "private", "secret", "settings.json.lock"].join("/");
  const settingsWrite = piDoctorFixture({
    help: piProbeResult(readyPiHelp, { stderr: `Warning: EACCES permission denied, mkdir '${privatePath}'` })
  });
  const settingsResult = await discoverPiCli({ ...settingsWrite, executorCommand: "/fixture/pi" });
  assert.equal(settingsResult.reason, "settings_write_attempt");
  assert.equal(settingsResult.settingsIsolated, false);
  assert.equal(JSON.stringify(settingsResult).includes(privatePath), false);
});

test("CLI admits the experimental Pi doctor route with an explicit executable", async () => {
  const { stdout } = await execFileAsync(process.execPath, [cli, "doctor", "--route", "codex-pi", "--executor", fakePi]);
  const result = JSON.parse(stdout);
  assert.equal(result.state, "ready");
  assert.equal(result.route, "codex-pi");
  assert.equal(result.executor.source, "explicit-pi-cli");
  assert.equal(result.executor.version, "0.84.0");
  assert.equal(result.limitations.some((item) => item.includes("experimental")), true);
});

test("CLI support metadata is sanitized and keeps Pi experimental", async () => {
  const { stdout } = await execFileAsync(process.execPath, [cli, "support"], {
    env: { PATH: process.env.PATH, HOME: path.dirname(cli) }
  });
  const support = JSON.parse(stdout);
  assert.deepEqual(support.routes.map(({ id, status }) => ({ id, status })), [
    { id: "codex-codex", status: "public-preview" },
    { id: "codex-pi", status: "experimental" },
    { id: "codex-cursor", status: "experimental" },
    { id: "codex-workbuddy", status: "experimental" },
    { id: "codex-workbuddy-ai", status: "experimental" }
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

test("unchanged acknowledged dirty paths are preserved without write authority", async () => {
  const root = await createGitRepository();
  await writeFile(path.join(root, "baseline.txt"), "preserve me\n");
  const envelope = makeEnvelope(root, {
    repository: { dirtyTree: { allow: true, acknowledgedPaths: ["baseline.txt"] } },
    scope: { allowedPaths: ["allowed.txt"] }
  });
  const result = await execute(envelope, "success");
  assert.equal(result.status, "completed");
  assert.deepEqual(result.baseline.dirtyPathsBefore, ["baseline.txt"]);
  assert.deepEqual(result.changedPaths, ["allowed.txt"]);
  assert.deepEqual(result.scope.breaches, []);
  assert.equal(result.validations[0].status, "passed");
});

test("acknowledged dirty paths retain no executor write authority", async () => {
  const root = await createGitRepository();
  await writeFile(path.join(root, "baseline.txt"), "preserve me\n");
  const envelope = makeEnvelope(root, {
    repository: { dirtyTree: { allow: true, acknowledgedPaths: ["baseline.txt"] } },
    scope: { allowedPaths: ["allowed.txt"] }
  });
  const result = await execute(envelope, "baseline-breach");
  assert.equal(result.status, "rejected");
  assert.ok(result.changedPaths.includes("baseline.txt"));
  assert.ok(result.scope.breaches.includes("baseline.txt"));
  assert.equal(result.validations[0].reason, "scope_breach");
});

test("zero write authority disables Pi write-capable tools", async () => {
  const root = await createGitRepository();
  const envelope = makeEnvelope(root, {
    taskId: "pi-zero-write-authority",
    scope: { allowedPaths: [], readablePaths: ["README.md"] },
    validation: []
  });
  const result = await execute(envelope, "zero-write-tools");
  assert.equal(result.status, "completed");
  assert.deepEqual(result.changedPaths, []);
  assert.equal(result.executor.summary, "Zero write authority preserved.");
});

test("zero write direct execution rejects repository validation before launch", async () => {
  const root = await createGitRepository();
  const envelope = makeEnvelope(root, {
    taskId: "pi-zero-write-validation",
    scope: { allowedPaths: [], readablePaths: ["README.md"] }
  });
  let launched = false;
  await assert.rejects(runDelegation(envelope, {
    executorCommand: process.execPath,
    executorArgs: [fakePi],
    runProcess: async () => {
      launched = true;
      throw new Error("must not launch");
    }
  }), { code: "read_only_validation_unsupported" });
  assert.equal(launched, false);
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

const finalPayload = { status: "completed", summary: 'Braces { } and escaped "quotes" remain literal.', residualRisks: [] };
const finalCompact = JSON.stringify(finalPayload);
const finalPretty = JSON.stringify(finalPayload, null, 2);
const finalOutputCases = [
  ["compact JSON", ` \n${finalCompact}\n`, "completed"],
  ["multiline JSON", finalPretty, "completed"],
  ["JSON fence", `\`\`\`json\n${finalPretty}\n\`\`\``, "completed"],
  ["unlabelled fence", `\`\`\`\r\n${finalPretty}\r\n\`\`\``, "completed"],
  ["blocked fence", `\`\`\`json\n${JSON.stringify({ status: "blocked", summary: "Authority required." }, null, 2)}\n\`\`\``, "blocked"],
  ["failed JSON", JSON.stringify({ status: "failed", summary: "Unable to finish." }), "failed"],
  ["prose and multiline JSON", `Done.\n${finalPretty}`, "malformed"],
  ["prose and compact JSON", `Done.\n${finalCompact}`, "malformed"],
  ["prose and fenced JSON", `Done.\n\`\`\`json\n${finalPretty}\n\`\`\``, "malformed"],
  ["conflicting JSON objects", `${JSON.stringify({ status: "blocked", summary: "Stop." })}\n${finalCompact}`, "malformed"],
  ["multiple fences", `\`\`\`json\n${finalCompact}\n\`\`\`\n\`\`\`json\n${finalCompact}\n\`\`\``, "malformed"],
  ["event wrapper", JSON.stringify({ type: "message_end", message: { content: [{ type: "text", text: finalPretty }] } }), "malformed"],
  ["array", `[${finalCompact}]`, "malformed"],
  ["incomplete JSON after result", `${finalCompact}\n{`, "malformed"],
  ["unterminated fence", `\`\`\`json\n${finalCompact}`, "malformed"],
  ["invalid status", '{"status":"accepted","summary":"Done"}', "malformed"],
  ["missing summary", '{"status":"completed"}', "malformed"],
  ["non-string summary", '{"status":"completed","summary":42}', "malformed"]
];

for (const [label, stdout, reportedStatus] of finalOutputCases) {
  test(`Pi final output: ${label}`, async () => {
    const root = await createGitRepository();
    const result = await runDelegation(withFixturePiRoute(makeEnvelope(root)), {
      executorCommand: fakePi,
      executorEnv: { FAKE_PI_SCENARIO: "final-output", FAKE_PI_FINAL_OUTPUT: stdout }
    });
    assert.equal(result.executor.reportedStatus, reportedStatus);
    assert.equal(result.status, reportedStatus === "malformed" ? "failed" : reportedStatus);
    assert.equal(result.validations[0].status, reportedStatus === "completed" ? "passed" : "not_run");
    assert.equal(result.hostAcceptance.eligible, reportedStatus === "completed");
    assert.equal(result.hostAcceptance.status, "pending");
    if (reportedStatus === "completed") assert.equal(result.executor.summary, finalPayload.summary);
  });
}

test("Pi final output: prompt requires the complete object without prose", async () => {
  const root = await createGitRepository();
  const result = await execute(makeEnvelope(root), "final-output-prompt");
  assert.equal(result.status, "completed");
  assert.equal(result.hostAcceptance.eligible, true);
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


test("Pi verbose progress does not displace its bounded final report", async () => {
  const root = await createGitRepository();
  try {
    const result = await execute(makeEnvelope(root), "large-progress");
    assert.equal(result.status, "completed");
    assert.equal(result.validations[0].status, "passed");
    assert.deepEqual(result.changedPaths, ["allowed.txt"]);
    assert.deepEqual(result.hostAcceptance, { status: "pending", eligible: true, decidedBy: null });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const scenario of ["oversized-final", "oversized-stderr"]) {
  test(`Pi still rejects ${scenario} rather than accepting a clipped report`, async () => {
    const root = await createGitRepository();
    try {
      const result = await execute(makeEnvelope(root), scenario);
      assert.equal(result.status, "failed");
      assert.match(result.executor.summary, /capture bound/u);
      assert.equal(result.validations[0].status, "not_run");
      assert.equal(result.hostAcceptance.eligible, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}


test("Pi scans ignored installed content above the default only with a Host budget", async (t) => {
  const root = await createGitRepository();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, ".git", "info", "exclude"), "dependencies.bin\n");
  const ignored = path.join(root, "dependencies.bin");
  await writeFile(ignored, "");
  await truncate(ignored, 512 * 1024 * 1024 + 1);
  await assert.rejects(execute(makeEnvelope(root), "success"), error =>
    error.code === "filesystem_evidence_exceeded" && /536870912 bytes/.test(error.message));
  const result = await execute(makeEnvelope(root, {
    execution: { filesystemEvidenceMaxBytes: 600 * 1024 * 1024 }
  }), "success");
  assert.equal(result.status, "completed");
  assert.equal(result.validations[0].status, "passed");
  assert.equal(result.filesystemEvidenceMaxBytes, 600 * 1024 * 1024);
  assert.deepEqual(result.changedPaths, ["allowed.txt"]);
});


test("configured budgets retain ignored scope breaches and reject postflight growth", async (t) => {
  const root = await createGitRepository();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, ".git", "info", "exclude"), "ignored.txt\n");
  const result = await execute(makeEnvelope(root, { execution: { filesystemEvidenceMaxBytes: 1024 } }), "ignored-breach");
  assert.equal(result.status, "rejected");
  assert.ok(result.changedPaths.includes("ignored.txt"));
  assert.equal(result.hostAcceptance.eligible, false);
  await rm(path.join(root, "allowed.txt"));
  await rm(path.join(root, "ignored.txt"));
  // The baseline README fits in ten bytes; the worker's allowed edit does not.
  await assert.rejects(execute(makeEnvelope(root, { execution: { filesystemEvidenceMaxBytes: 10 } }), "success"), { code: "filesystem_evidence_exceeded" });
});
