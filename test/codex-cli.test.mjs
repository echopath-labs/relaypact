import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createGitRepository, makeEnvelope } from "./helpers.mjs";
import { runDoctor } from "../packages/cli/src/doctor.mjs";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wrapper = path.join(packageRoot, "skills", "relaypact", "scripts", "relaypact.mjs");
const fakeCodex = path.join(packageRoot, "test", "fixtures", "fake-codex.mjs");

test("Skill-local wrapper exposes sanitized support metadata", async () => {
  const { stdout } = await execFileAsync(process.execPath, [wrapper, "support"], { cwd: os.tmpdir() });
  const support = JSON.parse(stdout);
  assert.equal(support.routes[0].id, "codex-codex");
  assert.equal(support.routes[0].status, "public-preview");
  assert.equal(support.routes[1].status, "experimental");
});

function doctorRunner(scenario = {}) {
  const calls = [];
  const run = async (command, args, options) => {
    calls.push({ command, args, options });
    const key = `${command} ${args.join(" ")}`;
    if (scenario.throwFor?.includes(key)) throw new Error("fixture unavailable at a private path");
    if (scenario.results?.[key]) return scenario.results[key];
    const outputs = {
      "git --version": { stdout: "git version 2.50.0\n" },
      "codex --version": { stdout: "codex-cli 0.147.0\n" },
      "codex exec --help": { stdout: "Run Codex non-interactively\nUsage: codex exec [OPTIONS]\n" },
      "codex plugin marketplace list --json": { stdout: JSON.stringify({ marketplaces: [{ name: "relaypact-local" }] }) },
      "codex plugin list --marketplace relaypact-local --json": { stdout: JSON.stringify({ installed: [{ name: "relaypact" }] }) }
    };
    return {
      exitCode: 0,
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      ...(outputs[key] ?? { exitCode: 1, stdout: "" })
    };
  };
  return { run, calls };
}

test("doctor reports a ready local Codex-to-Codex installation without optional routes", async () => {
  const fixture = doctorRunner();
  const result = await runDoctor({
    runProcess: fixture.run,
    environment: { PATH: "/fixture/bin", HTTPS_PROXY: "http://private.invalid", SECRET_TOKEN: "opaque" },
    nodeVersion: "20.20.2"
  });
  assert.equal(result.state, "ready");
  assert.equal(result.executor.command, "codex exec");
  assert.equal(result.executor.additionalInstallationRequired, false);
  assert.equal(result.checks.every((item) => item.status === "pass"), true);
  assert.equal(fixture.calls.some((item) => /pi|opencode|provider/iu.test(`${item.command} ${item.args.join(" ")}`)), false);
  assert.equal(fixture.calls.every((item) => item.options.env.HTTPS_PROXY === undefined && item.options.env.SECRET_TOKEN === undefined), true);
});

test("doctor distinguishes compatible runtime from missing plugin setup", async () => {
  const fixture = doctorRunner({
    results: {
      "codex plugin marketplace list --json": {
        exitCode: 0,
        stdout: JSON.stringify({ marketplaces: [] }),
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        timedOut: false
      }
    }
  });
  const result = await runDoctor({ runProcess: fixture.run, nodeVersion: "22.1.0" });
  assert.equal(result.state, "needs_setup");
  assert.equal(result.checks.find((item) => item.id === "marketplace").remediation, "add-marketplace");
  assert.equal(result.checks.find((item) => item.id === "plugin").status, "warn");
});

test("doctor accepts identities only from the documented listing collections", async () => {
  for (const stdout of [
    JSON.stringify({ unrelatedDiagnostic: "relaypact-local" }),
    JSON.stringify({ metadata: { name: "relaypact-local" }, marketplaces: [] })
  ]) {
    const fixture = doctorRunner({ results: {
      "codex plugin marketplace list --json": {
        exitCode: 0,
        stdout,
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        timedOut: false
      }
    } });
    const result = await runDoctor({ runProcess: fixture.run, nodeVersion: "22.1.0" });
    assert.equal(result.state, "needs_setup");
    assert.equal(result.checks.find((item) => item.id === "marketplace").status, "warn");
  }

  const pluginFixture = doctorRunner({ results: {
    "codex plugin list --marketplace relaypact-local --json": {
      exitCode: 0,
      stdout: JSON.stringify({ diagnostic: "relaypact", available: [{ name: "relaypact" }], installed: [] }),
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false
    }
  } });
  const pluginResult = await runDoctor({ runProcess: pluginFixture.run, nodeVersion: "22.1.0" });
  assert.equal(pluginResult.state, "needs_setup");
  assert.equal(pluginResult.checks.find((item) => item.id === "plugin").status, "warn");
});

test("doctor blocks missing and unsupported Codex without probing plugin state", async () => {
  for (const scenario of [
    { throwFor: ["codex --version"] },
    { results: {
      "codex --version": {
        exitCode: 0,
        stdout: "codex-cli 0.146.9\n",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        timedOut: false
      }
    } }
  ]) {
    const fixture = doctorRunner(scenario);
    const result = await runDoctor({ runProcess: fixture.run, nodeVersion: "20.20.2" });
    assert.equal(result.state, "blocked");
    assert.equal(result.checks.find((item) => item.id === "codex-cli").status, "fail");
    assert.equal(fixture.calls.some((item) => item.args[0] === "plugin"), false);
  }
});

test("doctor blocks unavailable codex exec and sanitizes malformed, timed-out, and truncated listing probes", async () => {
  const unavailable = doctorRunner({ throwFor: ["codex exec --help"] });
  const unavailableResult = await runDoctor({ runProcess: unavailable.run, nodeVersion: "20.20.2" });
  assert.equal(unavailableResult.state, "blocked");
  assert.equal(unavailableResult.checks.find((item) => item.id === "codex-exec").status, "fail");

  for (const probe of [
    { stdout: "not-json", timedOut: false, stdoutTruncated: false, stderrTruncated: false },
    { stdout: ["", "Users", "private", "secret"].join("/"), timedOut: true, stdoutTruncated: false, stderrTruncated: false },
    { stdout: "token=opaque", timedOut: false, stdoutTruncated: true, stderrTruncated: false }
  ]) {
    const fixture = doctorRunner({ results: {
      "codex plugin marketplace list --json": { exitCode: 0, stderr: "Bearer opaque", ...probe }
    } });
    const result = await runDoctor({ runProcess: fixture.run, nodeVersion: "20.20.2" });
    const serialized = JSON.stringify(result);
    assert.equal(result.state, "needs_setup");
    assert.equal(serialized.includes(["", "Users", "private"].join("/")), false);
    assert.doesNotMatch(serialized, /Bearer opaque|token=opaque/u);
  }
});

test("Skill-local wrapper completes fake Codex execution through pending review", async (context) => {
  const repository = await createGitRepository();
  const privateRoot = await mkdtemp(path.join(os.tmpdir(), "relaypact-cli-codex-"));
  const stateRoot = await mkdtemp(path.join(privateRoot, "state-"));
  const archiveRoot = await mkdtemp(path.join(privateRoot, "archive-"));
  const envelopePath = path.join(privateRoot, "envelope.json");
  const profilesPath = path.join(privateRoot, "profiles.json");
  await writeFile(envelopePath, JSON.stringify(makeEnvelope(repository, {
    executionProfile: "fake-worker",
    scope: {
      readablePaths: ["README.md"],
      allowedPaths: ["allowed.txt"],
      forbiddenPaths: [".env", ".env.*", "private/**"]
    }
  })));
  await writeFile(profilesPath, JSON.stringify({
    schemaVersion: "1.0.0",
    profiles: {
      "fake-worker": {
        codexCommand: fakeCodex,
        model: "fake-model",
        reasoning: "low",
        external: false,
        environmentAllowlist: []
      }
    }
  }));
  try {
    const { stdout } = await execFileAsync(process.execPath, [
      wrapper,
      "run-codex",
      "--envelope", envelopePath,
      "--profiles", profilesPath,
      "--state-root", stateRoot,
      "--host-instance", "fake-host-instance"
    ], { cwd: os.tmpdir(), maxBuffer: 8 * 1024 * 1024 });
    const result = JSON.parse(stdout);
    assert.equal(result.reviewPacket.lifecycleState, "awaiting_review");
    assert.equal(result.reviewPacket.acceptance.status, "pending");
    assert.equal(result.reviewPacket.acceptance.eligible, true);
    assert.deepEqual(result.reviewPacket.hostObserved.changedPaths, ["allowed.txt"]);
    assert.match(await readFile(result.evidence.patchPath, "utf8"), /allowed\.txt/u);
    const decision = JSON.parse((await execFileAsync(process.execPath, [
      wrapper,
      "decide-codex",
      "--task-root", result.taskRoot,
      "--profiles", profilesPath,
      "--action", "accept",
      "--actor", "fake-host-instance",
      "--archive-root", archiveRoot
    ], { cwd: os.tmpdir(), maxBuffer: 8 * 1024 * 1024 })).stdout);
    assert.equal(decision.lifecycleState, "accepted");
    assert.equal(decision.acceptance.status, "accepted");
    assert.match(await readFile(decision.archive.patchPath, "utf8"), /allowed\.txt/u);
    await assert.rejects(access(result.taskRoot), (error) => error.code === "ENOENT");
  } finally {
    await rm(repository, { recursive: true, force: true });
    await rm(privateRoot, { recursive: true, force: true });
  }
  context.diagnostic("Skill-local wrapper used fake Codex without Pi or provider configuration.");
});

test("all execution commands map blocked to 2 and unknown outcomes fail closed", async () => {
  const { exitCodeForResult } = await import("../packages/cli/src/main.mjs");
  for (const command of ["run-pi", "run-workbuddy", "run-cursor", "correct-cursor", "run-codex", "correct-codex"]) {
    for (const [status, expected] of [["completed", 0], ["blocked", 2], ["failed", 1], ["rejected", 1], ["unknown", 1], [undefined, 1]]) {
      const result = command.endsWith("codex")
        ? { reviewPacket: { lifecycleState: "awaiting_review", executorSelfReport: { status }, acceptance: { status: "pending" } } }
        : command.endsWith("cursor")
          ? { review: { executionResult: { status } } }
          : { status };
      assert.equal(exitCodeForResult(command, result), expected, `${command} ${status}`);
      if (command === "run-cursor") assert.equal(exitCodeForResult(command, { status }), expected);
    }
  }
  assert.equal(exitCodeForResult("run-codex", { reviewPacket: { lifecycleState: "failed", executorSelfReport: { status: "completed" } } }), 1);
  for (const command of ["support", "decide-codex", "decide-cursor"]) assert.equal(exitCodeForResult(command, { acceptance: { status: "rejected" } }), 0);
  assert.equal(exitCodeForResult("doctor", { state: "blocked" }), 1);
});

test("CLI subprocess emits blocked JSON with exit 2 for unavailable optional executors", async (context) => {
  const repository = await createGitRepository();
  const inputs = await mkdtemp(path.join(os.tmpdir(), "relaypact-cli-blocked-"));
  context.after(async () => { await rm(repository, { recursive: true, force: true }); await rm(inputs, { recursive: true, force: true }); });
  const envelope = path.join(inputs, "envelope.json");
  await writeFile(envelope, JSON.stringify(makeEnvelope(repository)));
  const pi = path.join(inputs, "blocked-pi.mjs");
  await writeFile(pi, '#!/usr/bin/env node\nconsole.log(JSON.stringify({status: "blocked", summary: "Host clarification required", residualRisks: []}));\n', { mode: 0o755 });
  for (const command of [
    ["run-pi", "--executor", pi],
    ["run-cursor", "--executor", path.join(inputs, "missing-cursor")],
    ["run-workbuddy", "--edition", "mainland", "--app", path.join(inputs, "missing-mainland.app")],
    ["run-workbuddy", "--edition", "international", "--app", path.join(inputs, "missing-international.app")]
  ]) {
    await writeFile(envelope, JSON.stringify(makeEnvelope(repository, command[0] === "run-pi" ? { executionProfile: { provider: "fixture", model: "fixture" } } : {})));
    await assert.rejects(execFileAsync(process.execPath, [wrapper, ...command, "--envelope", envelope]), error => {
      assert.equal(error.code, 2, `${command[0]} ${error.stderr} ${error.stdout}`);
      assert.equal(JSON.parse(error.stdout).status, "blocked");
      return true;
    });
  }
});

test("Codex CLI distinguishes blocked worker report from a reviewable lifecycle", async (context) => {
  const repository = await createGitRepository();
  const inputs = await mkdtemp(path.join(os.tmpdir(), "relaypact-cli-codex-blocked-"));
  context.after(async () => { await rm(repository, { recursive: true, force: true }); await rm(inputs, { recursive: true, force: true }); });
  const worker = path.join(inputs, "blocked-codex.mjs");
  await writeFile(worker, (await readFile(fakeCodex, "utf8")).replace('status: "completed"', 'status: "blocked"').replace('blocking: null', 'blocking: { code: "needs_input", message: "Host clarification" }'), { mode: 0o755 });
  const envelope = path.join(inputs, "envelope.json"), profiles = path.join(inputs, "profiles.json");
  await writeFile(envelope, JSON.stringify(makeEnvelope(repository, { executionProfile: "fixture", scope: { readablePaths: ["README.md"], allowedPaths: ["allowed.txt"], forbiddenPaths: ["private/**"] } })));
  await writeFile(profiles, JSON.stringify({ schemaVersion: "1.0.0", profiles: { fixture: { codexCommand: worker, external: false, environmentAllowlist: [] } } }));
  await mkdir(path.join(inputs, "state"));
  let taskRoot;
  await assert.rejects(execFileAsync(process.execPath, [wrapper, "run-codex", "--envelope", envelope, "--profiles", profiles, "--state-root", path.join(inputs, "state"), "--host-instance", "fixture-host"]), error => {
    assert.equal(error.code, 2, error.stderr || error.stdout);
    const result = JSON.parse(error.stdout);
    taskRoot = result.taskRoot;
    const packet = result.reviewPacket;
    assert.equal(packet.executorSelfReport.status, "blocked");
    assert.equal(packet.acceptance.status, "pending");
    assert.equal(packet.acceptance.eligible, false);
    return true;
  });
  const prompt = path.join(inputs, "correction.txt");
  await writeFile(prompt, "Report the remaining blocker within the original scope.");
  await assert.rejects(execFileAsync(process.execPath, [wrapper, "correct-codex", "--task-root", taskRoot, "--profiles", profiles, "--prompt", prompt]), error => {
    assert.equal(error.code, 2, error.stderr || error.stdout);
    assert.equal(JSON.parse(error.stdout).reviewPacket.executorSelfReport.status, "blocked");
    return true;
  });
});
