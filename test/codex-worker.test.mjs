import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkRouterHealth } from "../packages/executor-codex/src/router.mjs";
import {
  authorizeCorrection,
  createTaskState,
  recordWorkerResult,
  transitionTaskState
} from "../packages/executor-codex/src/state.mjs";
import { resolveWorkerProfile } from "../packages/executor-codex/src/profile.mjs";
import { sensitiveUrlValues } from "../packages/core/src/redact.mjs";
import { buildCodexExecInvocation, directProviderConfig, parseCodexEventStream, prepareTaskCodexHome, runCodexWorker } from "../packages/executor-codex/src/worker.mjs";
import { makeEnvelope } from "./helpers.mjs";

const profile = {
  name: "local-worker",
  codexCommand: "codex-custom",
  codexProfile: "router-worker",
  model: "worker-model",
  reasoning: "high",
  external: true,
  environmentAllowlist: ["HTTPS_PROXY"],
  fingerprint: "sha256:profile"
};

function directProfile(baseUrl = "https://provider.example/v1") {
  return resolveWorkerProfile({
    schemaVersion: "1.0.0",
    profiles: {
      direct: {
        codexCommand: "codex-custom",
        model: "worker-model",
        reasoning: "high",
        external: true,
        environmentAllowlist: ["HTTPS_PROXY"],
        provider: {
          name: "compatible-provider",
          baseUrl,
          wireApi: "responses",
          credentialEnv: "PROVIDER_API_KEY"
        }
      }
    }
  }, "direct");
}

async function fixture() {
  const taskRoot = await mkdtemp(path.join(os.tmpdir(), "relaypact-worker-"));
  const capsuleRoot = path.join(taskRoot, "capsule");
  const controlRoot = path.join(taskRoot, "control");
  const capsule = {
    taskId: "test-task",
    taskRoot,
    capsuleRoot,
    controlRoot,
    resultSchemaPath: path.join(controlRoot, "result.schema.json"),
    baseline: "baseline-1",
    privateControlBaseline: { fingerprint: "sha256:private-control" }
  };
  await mkdir(controlRoot, { recursive: true });
  await writeFile(capsule.resultSchemaPath, '{"type":"object"}\n');
  const envelope = makeEnvelope(taskRoot, { executionProfile: profile.name });
  return { taskRoot, capsule, envelope };
}

function completedResult() {
  return {
    schemaVersion: "1.0.0",
    taskId: "test-task",
    status: "completed",
    summary: "Implemented the bounded change.",
    changedFiles: ["allowed.txt"],
    validations: [{ id: "pass", status: "passed", summary: "Passed." }],
    residualRisks: [],
    blocking: null
  };
}

test("Codex worker starts without a shell and captures structured completion", async () => {
  const { capsule, envelope } = await fixture();
  let observed;
  const runProcess = async (command, args, options) => {
    observed = { command, args, options };
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      stderr: "",
      stdout: [
        JSON.stringify({ type: "thread.started", thread_id: "worker-thread-1" }),
        JSON.stringify({ type: "turn.completed", usage: { input_tokens: 12, output_tokens: 4 } })
      ].join("\n")
    };
  };
  const result = await runCodexWorker({ envelope, profile, capsule }, {
    runProcess,
    codexHome: path.join(capsule.taskRoot, "codex-home"),
    environment: { PATH: "/usr/bin", HTTPS_PROXY: "http://proxy.invalid:8080", PRIVATE_TOKEN: "must-not-pass" },
    readResultFile: async () => JSON.stringify(completedResult())
  });
  assert.equal(observed.command, "codex-custom");
  assert.deepEqual(observed.args.slice(0, 2), ["exec", "--json"]);
  assert.ok(observed.args.includes("--output-schema"));
  assert.ok(observed.args.includes("workspace-write"));
  assert.equal(observed.options.env.HTTPS_PROXY, "http://proxy.invalid:8080");
  assert.equal(observed.options.env.PRIVATE_TOKEN, undefined);
  assert.equal(result.threadId, "worker-thread-1");
  assert.equal(result.workerResult.status, "completed");
  assert.deepEqual(result.usage, { input_tokens: 12, output_tokens: 4 });
  assert.equal(result.relaypactInput.relaypactPromptBytes, Buffer.byteLength(observed.options.input, "utf8"));
  assert.equal(result.relaypactInput.relaypactResultSchemaBytes, Buffer.byteLength('{"type":"object"}\n', "utf8"));
  assert.equal(
    result.relaypactInput.relaypactDeclaredInputBytes,
    result.relaypactInput.relaypactPromptBytes + result.relaypactInput.relaypactResultSchemaBytes
  );
});

test("direct provider home is private, deterministic, and does not inherit global auth", async () => {
  const { capsule } = await fixture();
  const selected = directProfile();
  const sourceCodexHome = await mkdtemp(path.join(os.tmpdir(), "relaypact-global-codex-"));
  await writeFile(path.join(sourceCodexHome, "config.toml"), 'model_provider = "unexpected-global"\n');
  await writeFile(path.join(sourceCodexHome, "auth.json"), '{"token":"global-secret"}\n');
  const codexHome = await prepareTaskCodexHome(capsule, selected, { sourceCodexHome });
  const configPath = path.join(codexHome, "config.toml");
  const config = await readFile(configPath, "utf8");
  assert.equal(config, directProviderConfig(selected, capsule.capsuleRoot));
  assert.match(config, /model_provider = "compatible-provider"/);
  assert.match(config, /env_key = "PROVIDER_API_KEY"/);
  assert.match(config, /trust_level = "trusted"/);
  assert.ok(config.includes(`[projects.${JSON.stringify(capsule.capsuleRoot)}]`));
  assert.doesNotMatch(config, /global-secret|unexpected-global|credential-value/);
  assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  await assert.rejects(lstat(path.join(codexHome, "auth.json")), (error) => error.code === "ENOENT");
});

test("direct provider worker injects only the selected credential and approved environment", async () => {
  const { capsule, envelope } = await fixture();
  const selected = directProfile();
  let observed;
  const execution = await runCodexWorker({ envelope, profile: selected, capsule }, {
    environment: {
      PATH: "/usr/bin",
      PROVIDER_API_KEY: "credential-value",
      HTTPS_PROXY: "http://proxy.invalid",
      UNRELATED_SECRET: "must-not-pass"
    },
    runProcess: async (_command, _args, options) => {
      observed = options;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stderr: "",
        stdout: `${JSON.stringify({ type: "thread.started", thread_id: "direct-thread-1" })}\n${JSON.stringify({ type: "turn.completed", usage: {} })}\n`
      };
    },
    readResultFile: async () => JSON.stringify(completedResult())
  });
  assert.equal(execution.workerResult.status, "completed");
  assert.equal(observed.env.PROVIDER_API_KEY, "credential-value");
  assert.equal(observed.env.HTTPS_PROXY, "http://proxy.invalid");
  assert.equal(observed.env.UNRELATED_SECRET, undefined);
  assert.doesNotMatch(JSON.stringify(execution), /credential-value/);
});

test("Codex worker redacts exact injected credentials from every result narrative", async () => {
  const { capsule, envelope } = await fixture();
  const selected = directProfile();
  const secret = "opaque-provider-credential-value";
  const execution = await runCodexWorker({ envelope, profile: selected, capsule }, {
    environment: { PROVIDER_API_KEY: secret },
    runProcess: async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stderr: "",
      stdout: `${JSON.stringify({ type: "thread.started", thread_id: "direct-thread-secret" })}\n${JSON.stringify({ type: "turn.completed", usage: {} })}\n`
    }),
    readResultFile: async () => JSON.stringify({
      schemaVersion: "1.0.0",
      taskId: "test-task",
      status: "failed",
      summary: `summary ${secret}`,
      changedFiles: [],
      validations: [{ id: `check-${secret}`, status: "failed", summary: `validation ${secret}` }],
      residualRisks: [`risk ${secret}`],
      blocking: { code: `blocked-${secret}`, message: `message ${secret}` }
    })
  });
  const serialized = JSON.stringify(execution.workerResult);
  assert.doesNotMatch(serialized, new RegExp(secret));
  assert.match(serialized, /REDACTED_EXACT_VALUE/);
});

test("Codex provider URL path components join the exact sensitive-value inventory", async () => {
  const { capsule, envelope } = await fixture();
  const secret = "opaque-codex-provider-path-secret";
  const selected = directProfile(`https://provider.example/v1/${secret}`);
  const execution = await runCodexWorker({ envelope, profile: selected, capsule }, {
    environment: { PROVIDER_API_KEY: "ordinary-provider-key" },
    runProcess: async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stderr: "",
      stdout: `${JSON.stringify({ type: "thread.started", thread_id: "direct-url-secret" })}\n${JSON.stringify({ type: "turn.completed", usage: {} })}\n`
    }),
    readResultFile: async () => JSON.stringify({
      ...completedResult(),
      summary: `Provider endpoint included ${secret}.`
    })
  });
  assert.equal(execution.workerResult.status, "completed");
  assert.match(execution.workerResult.summary, /REDACTED_EXACT_VALUE/);
  assert.doesNotMatch(JSON.stringify(execution), new RegExp(secret));
});

test("provider URL inventory preserves raw authority, hostname labels, and dot-segment carriers", () => {
  const values = sensitiveUrlValues("https://PrivateTenant.Example:8443/PrivateCarrier/../carrier%252Fopaque-secret");
  assert.ok(values.includes("PrivateTenant.Example:8443"));
  assert.ok(values.includes("PrivateTenant.Example"));
  assert.ok(values.includes("PrivateTenant"));
  assert.ok(values.includes("PrivateCarrier"));
  assert.ok(values.includes("privatetenant.example"));
  assert.ok(values.includes("https://privatetenant.example:8443/carrier%252Fopaque-secret"));
  assert.ok(values.includes("opaque-secret"));
});

test("provider URL inventory rejects paths that remain decodable beyond its bound", () => {
  assert.throws(
    () => sensitiveUrlValues("https://provider.example/v1/carrier%25252Fopaque-value"),
    (error) => error.name === "SensitiveUrlDecodeBudgetError" && !error.message.includes("opaque-value")
  );
});

test("provider URL inventory rejects malformed percent encoding without skipping sibling paths", () => {
  assert.throws(
    () => sensitiveUrlValues("https://provider.example/bad%ZZ/carrier%252Fopaque-value"),
    (error) => error.name === "SensitiveUrlEncodingError" && !error.message.includes("opaque-value")
  );
});

test("native Codex rejects malformed provider URL encoding before runner invocation", async () => {
  const { capsule, envelope } = await fixture();
  const codexHome = path.join(capsule.taskRoot, "codex-home");
  await mkdir(codexHome, { recursive: true });
  await writeFile(
    path.join(codexHome, "config.toml"),
    'base_url = "https://provider.example/bad%ZZ/carrier%252Fopaque-value"\n',
    { mode: 0o600 }
  );
  let runnerCalls = 0;
  const execution = await runCodexWorker({ envelope, profile, capsule }, {
    codexHome,
    runProcess: async () => {
      runnerCalls += 1;
      throw new Error("runner must not start");
    }
  });
  assert.equal(runnerCalls, 0);
  assert.equal(execution.workerResult.status, "failed");
  assert.equal(execution.workerResult.blocking.code, "provider_url_encoding_unsupported");
  assert.doesNotMatch(JSON.stringify(execution), /opaque-value|bad%ZZ/);
});

test("Codex worker redacts exact credentials from failed event messages", async () => {
  const { capsule, envelope } = await fixture();
  const selected = directProfile();
  const secret = "opaque-event-credential-value";
  const execution = await runCodexWorker({ envelope, profile: selected, capsule }, {
    environment: { PROVIDER_API_KEY: secret },
    runProcess: async () => ({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stderr: "",
      stdout: `${JSON.stringify({ type: "thread.started", thread_id: "direct-thread-event" })}\n${JSON.stringify({ type: "turn.failed", error: { code: "upstream", message: `failed with ${secret}` } })}\n`
    })
  });
  assert.doesNotMatch(JSON.stringify(execution), new RegExp(secret));
  assert.match(execution.workerResult.blocking.message, /REDACTED_EXACT_VALUE/);
});

test("Codex worker redacts authenticated proxy grants from failed event codes", async () => {
  const { capsule, envelope } = await fixture();
  const proxy = "http://proxy-user:proxy-pass@127.0.0.1:7890";
  const execution = await runCodexWorker({ envelope, profile, capsule }, {
    codexHome: path.join(capsule.taskRoot, "codex-home"),
    environment: { HTTPS_PROXY: proxy },
    runProcess: async () => ({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stderr: "",
      stdout: `${JSON.stringify({ type: "thread.started", thread_id: "proxy-event-thread" })}\n${JSON.stringify({ type: "turn.failed", error: { code: `proxy:${proxy}`, message: "route failed" } })}\n`
    })
  });
  assert.doesNotMatch(JSON.stringify(execution), /proxy-pass/);
  assert.match(execution.workerResult.blocking.code, /REDACTED_EXACT_VALUE/);
});

test("Codex worker rejects sensitive values disguised as changed paths", async () => {
  const { capsule, envelope } = await fixture();
  const selected = directProfile();
  const secret = "opaque-path-credential-value";
  const result = { ...completedResult(), changedFiles: [`allowed-${secret}.txt`] };
  const execution = await runCodexWorker({ envelope, profile: selected, capsule }, {
    environment: { PROVIDER_API_KEY: secret },
    runProcess: async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stderr: "",
      stdout: `${JSON.stringify({ type: "thread.started", thread_id: "direct-thread-path" })}\n${JSON.stringify({ type: "turn.completed", usage: {} })}\n`
    }),
    readResultFile: async () => JSON.stringify(result)
  });
  assert.equal(execution.workerResult.status, "failed");
  assert.equal(execution.workerResult.blocking.code, "credential_in_worker_result");
  assert.doesNotMatch(JSON.stringify(execution), new RegExp(secret));
});

test("Codex worker replaces raw structured output with the sanitized result", async () => {
  const { capsule, envelope } = await fixture();
  const selected = directProfile();
  const secret = "opaque-persisted-credential-value";
  await mkdir(capsule.controlRoot, { recursive: true });
  const resultPath = path.join(capsule.controlRoot, "worker-result-0.json");
  const execution = await runCodexWorker({ envelope, profile: selected, capsule }, {
    environment: { PROVIDER_API_KEY: secret },
    runProcess: async () => {
      await writeFile(resultPath, JSON.stringify({ ...completedResult(), summary: `done ${secret}` }));
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stderr: "",
        stdout: `${JSON.stringify({ type: "thread.started", thread_id: "direct-thread-persisted" })}\n${JSON.stringify({ type: "turn.completed", usage: {} })}\n`
      };
    }
  });
  assert.equal(execution.workerResult.status, "completed");
  const persisted = await readFile(resultPath, "utf8");
  assert.doesNotMatch(persisted, new RegExp(secret));
  assert.match(persisted, /REDACTED_EXACT_VALUE/);
  assert.equal((await stat(resultPath)).mode & 0o777, 0o600);
});

test("direct provider correction accepts the exact task-scoped project trust configuration", async () => {
  const { capsule, envelope } = await fixture();
  const selected = directProfile();
  await prepareTaskCodexHome(capsule, selected);
  let invoked = false;
  const execution = await runCodexWorker({
    envelope,
    profile: selected,
    capsule,
    correction: { threadId: "direct-thread-1", sequence: 1, prompt: "Correct the task." }
  }, {
    environment: { PROVIDER_API_KEY: "credential-value" },
    runProcess: async () => {
      invoked = true;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stderr: "",
        stdout: `${JSON.stringify({ type: "turn.completed", usage: {} })}\n`
      };
    },
    readResultFile: async () => JSON.stringify(completedResult())
  });
  assert.equal(invoked, true);
  assert.equal(execution.workerResult.status, "completed");
});

test("direct provider correction refuses task configuration drift without invoking Codex", async () => {
  const { capsule, envelope } = await fixture();
  const selected = directProfile();
  const codexHome = await prepareTaskCodexHome(capsule, selected);
  await writeFile(path.join(codexHome, "config.toml"), 'model_provider = "fallback"\n', { mode: 0o600 });
  let invoked = false;
  const execution = await runCodexWorker({
    envelope,
    profile: selected,
    capsule,
    correction: { threadId: "direct-thread-1", sequence: 1, prompt: "Correct the task." }
  }, {
    environment: { PROVIDER_API_KEY: "credential-value" },
    runProcess: async () => {
      invoked = true;
      throw new Error("must not run");
    }
  });
  assert.equal(invoked, false);
  assert.equal(execution.threadId, "direct-thread-1");
  assert.equal(execution.workerResult.blocking.code, "provider_config_drift");
  assert.match(await readFile(path.join(codexHome, "config.toml"), "utf8"), /fallback/);
});

test("direct provider correction refuses permission drift without invoking Codex", async () => {
  const { capsule, envelope } = await fixture();
  const selected = directProfile();
  const codexHome = await prepareTaskCodexHome(capsule, selected);
  const configPath = path.join(codexHome, "config.toml");
  await chmod(configPath, 0o644);
  let invoked = false;
  const execution = await runCodexWorker({
    envelope,
    profile: selected,
    capsule,
    correction: { threadId: "direct-thread-1", sequence: 1, prompt: "Correct the task." }
  }, {
    environment: { PROVIDER_API_KEY: "credential-value" },
    runProcess: async () => {
      invoked = true;
      throw new Error("must not run");
    }
  });
  assert.equal(invoked, false);
  assert.equal(execution.threadId, "direct-thread-1");
  assert.equal(execution.workerResult.blocking.code, "provider_config_drift");
  assert.equal((await stat(configPath)).mode & 0o777, 0o644);
});

for (const scenario of ["missing", "symlink"]) {
  test(`direct provider correction refuses a ${scenario} task configuration`, async () => {
    const { capsule, envelope } = await fixture();
    const selected = directProfile();
    const codexHome = await prepareTaskCodexHome(capsule, selected);
    const configPath = path.join(codexHome, "config.toml");
    await rm(configPath);
    if (scenario === "symlink") {
      const replacement = path.join(capsule.taskRoot, "replacement.toml");
      await writeFile(replacement, directProviderConfig(selected), { mode: 0o600 });
      await symlink(replacement, configPath);
    }
    let invoked = false;
    const execution = await runCodexWorker({
      envelope,
      profile: selected,
      capsule,
      correction: { threadId: "direct-thread-1", sequence: 1, prompt: "Correct the task." }
    }, {
      environment: { PROVIDER_API_KEY: "credential-value" },
      runProcess: async () => {
        invoked = true;
        throw new Error("must not run");
      }
    });
    assert.equal(invoked, false);
    assert.equal(execution.workerResult.blocking.code, "provider_config_drift");
  });
}

test("correction invocation resumes the exact delegated thread", async () => {
  const { capsule, envelope } = await fixture();
  const invocation = buildCodexExecInvocation({
    envelope,
    profile,
    capsule,
    resultPath: path.join(capsule.controlRoot, "correction.json"),
    correction: { threadId: "worker-thread-1", sequence: 1, prompt: "Fix the failing test." }
  });
  assert.deepEqual(invocation.args.slice(0, 3), ["exec", "resume", "--json"]);
  assert.ok(invocation.args.includes("worker-thread-1"));
  assert.equal(invocation.args.includes("--profile"), false);
  assert.match(invocation.input, /Correction request 1/);
});

test("correction execution measures the exact resumed prompt without retaining it in metrics", async () => {
  const { capsule, envelope } = await fixture();
  let input;
  const result = await runCodexWorker({
    envelope,
    profile,
    capsule,
    correction: { threadId: "worker-thread-1", sequence: 1, prompt: "Fix the failing test." }
  }, {
    codexHome: path.join(capsule.taskRoot, "codex-home"),
    runProcess: async (_command, _args, options) => {
      input = options.input;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stderr: "",
        stdout: `${JSON.stringify({ type: "turn.completed", usage: {} })}\n`
      };
    },
    readResultFile: async () => JSON.stringify(completedResult())
  });
  assert.match(input, /Correction request 1: Fix the failing test\./u);
  assert.equal(result.relaypactInput.relaypactPromptBytes, Buffer.byteLength(input, "utf8"));
  assert.doesNotMatch(JSON.stringify(result.relaypactInput), /Fix the failing test/u);
});

test("worker does not start when the generated result schema cannot be measured safely", async () => {
  const { capsule, envelope } = await fixture();
  let invoked = false;
  await rm(capsule.resultSchemaPath);
  const missing = await runCodexWorker({ envelope, profile, capsule }, {
    codexHome: path.join(capsule.taskRoot, "codex-home"),
    runProcess: async () => {
      invoked = true;
      throw new Error("must not run");
    }
  });
  assert.equal(invoked, false);
  assert.equal(missing.workerResult.blocking.code, "relaypact_input_unavailable");

  await writeFile(capsule.resultSchemaPath, "x".repeat(4 * 1024 * 1024 + 1));
  const oversized = await runCodexWorker({ envelope, profile, capsule }, {
    codexHome: path.join(capsule.taskRoot, "codex-home"),
    runProcess: async () => {
      invoked = true;
      throw new Error("must not run");
    }
  });
  assert.equal(invoked, false);
  assert.equal(oversized.workerResult.blocking.code, "relaypact_input_too_large");
});

test("worker does not start when the exact RelayPact prompt exceeds its byte bound", async () => {
  const { capsule, envelope } = await fixture();
  envelope.instructions = ["x".repeat(4 * 1024 * 1024)];
  let invoked = false;
  const result = await runCodexWorker({ envelope, profile, capsule }, {
    codexHome: path.join(capsule.taskRoot, "codex-home"),
    runProcess: async () => {
      invoked = true;
      throw new Error("must not run");
    }
  });
  assert.equal(invoked, false);
  assert.equal(result.workerResult.blocking.code, "relaypact_input_too_large");
  assert.doesNotMatch(JSON.stringify(result), /x{100}/u);
});

test("event parsing rejects non-JSON output and worker failures remain structured", async () => {
  assert.throws(() => parseCodexEventStream("not-json\n"), (error) => error.code === "malformed_codex_event");
  const { capsule, envelope } = await fixture();
  const result = await runCodexWorker({ envelope, profile, capsule }, {
    codexHome: path.join(capsule.taskRoot, "codex-home"),
    runProcess: async () => ({ exitCode: 1, signal: null, timedOut: false, stdout: "", stderr: "provider details" })
  });
  assert.equal(result.workerResult.status, "failed");
  assert.equal(result.workerResult.blocking.code, "executor_identity_unavailable");
  assert.doesNotMatch(JSON.stringify(result), /provider details/);
});

for (const scenario of [
  { name: "timeout", process: { exitCode: null, signal: "SIGTERM", timedOut: true }, code: "codex_timeout" },
  { name: "interruption", process: { exitCode: null, signal: "SIGINT", timedOut: false }, code: "codex_interrupted" },
  { name: "non-zero exit", process: { exitCode: 7, signal: null, timedOut: false }, code: "codex_process_failed" }
]) {
  test(`Codex ${scenario.name} is normalized without raw process output`, async () => {
    const { capsule, envelope } = await fixture();
    const result = await runCodexWorker({ envelope, profile, capsule }, {
      codexHome: path.join(capsule.taskRoot, "codex-home"),
      runProcess: async () => ({
        ...scenario.process,
        stderr: "API_KEY=must-not-leak",
        stdout: `${JSON.stringify({ type: "thread.started", thread_id: "worker-thread-1" })}\n`
      })
    });
    assert.equal(result.workerResult.blocking.code, scenario.code);
    assert.doesNotMatch(JSON.stringify(result), /must-not-leak/);
  });
}

test("malformed structured output cannot be inferred as completion", async () => {
  const { capsule, envelope } = await fixture();
  const result = await runCodexWorker({ envelope, profile, capsule }, {
    codexHome: path.join(capsule.taskRoot, "codex-home"),
    runProcess: async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stderr: "",
      stdout: `${JSON.stringify({ type: "thread.started", thread_id: "worker-thread-1" })}\n${JSON.stringify({ type: "turn.completed" })}\n`
    }),
    readResultFile: async () => "{not valid json"
  });
  assert.equal(result.workerResult.status, "failed");
  assert.equal(result.workerResult.blocking.code, "malformed_worker_result");
});

test("worker result files over the input bound are rejected before parsing", async () => {
  const { capsule, envelope } = await fixture();
  await mkdir(capsule.controlRoot, { recursive: true });
  const resultPath = path.join(capsule.controlRoot, "worker-result-0.json");
  const result = await runCodexWorker({ envelope, profile, capsule }, {
    codexHome: path.join(capsule.taskRoot, "codex-home"),
    runProcess: async () => {
      await writeFile(resultPath, "x".repeat(4 * 1024 * 1024 + 1));
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stderr: "",
        stdout: `${JSON.stringify({ type: "thread.started", thread_id: "oversized-result-thread" })}\n${JSON.stringify({ type: "turn.completed" })}\n`
      };
    }
  });
  assert.equal(result.workerResult.status, "failed");
  assert.equal(result.workerResult.blocking.code, "malformed_worker_result");
});

test("router health fails closed and does not select a fallback", async () => {
  const routedProfile = { ...profile, router: { healthUrl: "http://127.0.0.1:10100/health", timeoutMs: 500 } };
  await assert.rejects(
    checkRouterHealth(routedProfile, { fetch: async () => ({ ok: false, status: 503 }) }),
    (error) => error.code === "router_unavailable" && /local-worker/.test(error.message)
  );
  assert.deepEqual(await checkRouterHealth(profile), { checked: false, healthy: true });
});

test("task lifecycle persists identity and authorizes only matching correction", async () => {
  const { capsule } = await fixture();
  const created = await createTaskState({ capsule, profile, hostInstanceId: "desktop-host-1" });
  await transitionTaskState(created.statePath, "running");
  const reviewed = await recordWorkerResult(created.statePath, { threadId: "worker-thread-1", result: completedResult() });
  assert.equal(reviewed.lifecycleState, "awaiting_review");
  const correction = await authorizeCorrection(created.statePath, {
    taskId: capsule.taskId,
    profileFingerprint: profile.fingerprint,
    capsuleBaseline: capsule.baseline,
    priorResultIdentity: reviewed.resultIdentity
  });
  assert.equal(correction.lifecycleState, "correction_requested");
  assert.equal(correction.correctionSequence, 1);
});

test("correction resume refuses every mismatched identity dimension", async () => {
  const { capsule } = await fixture();
  const created = await createTaskState({ capsule, profile, hostInstanceId: "desktop-host-1" });
  await transitionTaskState(created.statePath, "running");
  const reviewed = await recordWorkerResult(created.statePath, { threadId: "worker-thread-1", result: completedResult() });
  const identity = {
    taskId: capsule.taskId,
    profileFingerprint: profile.fingerprint,
    capsuleBaseline: capsule.baseline,
    priorResultIdentity: reviewed.resultIdentity
  };
  for (const field of Object.keys(identity)) {
    await assert.rejects(
      authorizeCorrection(created.statePath, { ...identity, [field]: `different-${field}` }),
      (error) => error.code === "resume_identity_mismatch" && error.message.includes(field === "priorResultIdentity" ? "resultIdentity" : field)
    );
  }
});


test("Codex results preserve TaskEnvelope Unicode task ID length semantics", async () => {
  const { validateTaskEnvelope } = await import("../packages/contracts/src/envelope.mjs");
  const { validateCodexWorkerResult } = await import("../packages/executor-codex/src/result.mjs");
  const taskId = "😀".repeat(128);
  const envelope = makeEnvelope("/repository", { taskId });
  assert.equal(validateTaskEnvelope(envelope).taskId, taskId);
  const result = { schemaVersion: "1.0.0", taskId, status: "completed", summary: "fixture", changedFiles: [], validations: [], residualRisks: [], blocking: null };
  assert.equal(validateCodexWorkerResult(result, taskId).taskId, taskId);
  assert.throws(() => validateCodexWorkerResult({ ...result, taskId: taskId + "a" }, taskId + "a"), { code: "malformed_worker_result" });
});
