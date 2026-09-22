import assert from "node:assert/strict";
import Ajv2020 from "ajv/dist/2020.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateTaskEnvelope } from "../packages/contracts/src/envelope.mjs";
import { makeEnvelope } from "./helpers.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function plannedEnvelope(overrides = {}) {
  const { scope = {}, contextPlanning = {}, ...rest } = overrides;
  return makeEnvelope("/absolute/repository", {
    ...rest,
    scope: { discoverablePaths: ["src/**/*.mjs", "package.json"], ...scope },
    contextPlanning: {
      strategy: "dependency-closure",
      seeds: ["src/index.mjs"],
      analyzers: ["node-esm"],
      budget: { maxFiles: 100, maxBytes: 1_000_000, maxDepth: 20 },
      readiness: [{
        id: "node",
        argv: [process.execPath, "--version"],
        timeoutMs: 10_000,
        acceptableExitCodes: [0]
      }],
      ...contextPlanning
    }
  });
}

function assertInvalid(envelope, expectedCode = null) {
  assert.throws(() => validateTaskEnvelope(envelope), (error) => {
    if (expectedCode) assert.equal(error.code, expectedCode);
    else assert(["invalid_envelope", "invalid_path"].includes(error.code));
    return true;
  });
}

test("valid planned mode requires and accepts bounded context authority", () => {
  const envelope = plannedEnvelope();
  assert.equal(validateTaskEnvelope(envelope), envelope);
});

test("explicit mode remains valid without planning fields", () => {
  const envelope = makeEnvelope("/absolute/repository");
  assert.equal(validateTaskEnvelope(envelope), envelope);
  assert.equal(envelope.scope.discoverablePaths, undefined);
  assert.equal(envelope.contextPlanning, undefined);
});

test("planned mode requires discovery authority", () => {
  const envelope = makeEnvelope("/absolute/repository", {
    contextPlanning: plannedEnvelope().contextPlanning
  });
  assertInvalid(envelope);
});

test("seeds are literal normalized repository-relative paths", () => {
  for (const seeds of [
    ["src/*.mjs"],
    ["../src/index.mjs"],
    ["."],
    ["./src/index.mjs"],
    ["src\\index.mjs"],
    ["src/index.mjs", "src/index.mjs"]
  ]) {
    assertInvalid(plannedEnvelope({ contextPlanning: { seeds } }));
  }
});

test("unknown fields are rejected at every contract boundary", () => {
  const cases = [
    { repository: { extra: true } },
    { repository: { dirtyTree: { extra: true } } },
    { scope: { extra: true } },
    { contextPlanning: { extra: true } },
    { contextPlanning: { budget: { extra: true } } },
    { contextPlanning: { readiness: [{ extra: true }] } },
    { resultFormat: { extra: true } },
    { validation: [{ id: "x", argv: ["node"], extra: true }] }
  ];
  for (const overrides of cases) assertInvalid(plannedEnvelope(overrides));
});

test("analyzers, budgets, and readiness are constrained", () => {
  assertInvalid(plannedEnvelope({ contextPlanning: { analyzers: ["unknown"] } }));
  assertInvalid(plannedEnvelope({ contextPlanning: { budget: { maxFiles: 0 } } }));
  assertInvalid(plannedEnvelope({ contextPlanning: { budget: { maxBytes: 1_073_741_825 } } }));
  assertInvalid(plannedEnvelope({ contextPlanning: { budget: { maxDepth: 1.5 } } }));
  assertInvalid(plannedEnvelope({ contextPlanning: { readiness: [{
    id: "node",
    argv: [process.execPath, "--version"],
    timeoutMs: 10_000,
    acceptableExitCodes: []
  }] } }));
  assertInvalid(plannedEnvelope({ contextPlanning: { readiness: [{
    id: "node",
    argv: [process.execPath, "--version"],
    timeoutMs: 10_000,
    acceptableExitCodes: [0, 0]
  }] } }));
  assertInvalid(plannedEnvelope({ execution: { exposureMode: "trusted-worktree" } }));
});

test("readiness uses non-shell argv and rejects credential-like arguments", () => {
  assertInvalid(plannedEnvelope({ contextPlanning: { readiness: [{
    id: "shell",
    argv: ["sh", "-c", "true"],
    timeoutMs: 10_000,
    acceptableExitCodes: [0]
  }] } }));
  assertInvalid(plannedEnvelope({ contextPlanning: { readiness: [{
    id: "unsafe",
    argv: [process.execPath, "--token=not-a-token"],
    timeoutMs: 10_000,
    acceptableExitCodes: [0]
  }] } }), "credential_in_envelope");
  assertInvalid(plannedEnvelope({ contextPlanning: { readiness: [{
    id: "unsafe-env",
    argv: ["env", "OPENAI_API_KEY=not-a-key", process.execPath, "--version"],
    timeoutMs: 10_000,
    acceptableExitCodes: [0]
  }] } }), "credential_in_envelope");
});

test("public JSON schemas are parseable and expose strict context contracts", async () => {
  const taskSchema = JSON.parse(await readFile(path.join(packageRoot, "packages/contracts/schemas/task-envelope.schema.json"), "utf8"));
  const manifestSchema = JSON.parse(await readFile(path.join(packageRoot, "packages/contracts/schemas/context-manifest.schema.json"), "utf8"));
  const executionSchema = JSON.parse(await readFile(path.join(packageRoot, "packages/contracts/schemas/execution-result.schema.json"), "utf8"));
  const reviewSchema = JSON.parse(await readFile(path.join(packageRoot, "packages/contracts/schemas/host-review-packet.schema.json"), "utf8"));
  assert.equal(taskSchema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(taskSchema.additionalProperties, false);
  assert.equal(taskSchema.properties.contextPlanning.additionalProperties, false);
  assert.equal(taskSchema.properties.contextPlanning.properties.strategy.const, "dependency-closure");
  assert.equal(taskSchema.properties.scope.properties.allowedPaths.minItems, undefined);
  assert.equal(taskSchema.$defs.readiness.properties.argv.items.$ref, "#/$defs/text");
  assert.equal(taskSchema.$defs.readiness.properties.argv.prefixItems.length, 1);
  assert.equal(manifestSchema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(manifestSchema.additionalProperties, false);
  assert.deepEqual(manifestSchema.required, [
    "schemaVersion",
    "strategy",
    "analyzers",
    "selectedFiles",
    "externalReferences",
    "unresolvedReferences",
    "excludedReferences",
    "totals",
    "budget",
    "readiness",
    "fingerprint"
  ]);
  assert.equal(manifestSchema.properties.selectedFiles.minItems, 1);
  assert.deepEqual(manifestSchema.$defs.inclusionReason.properties.kind.enum, [
    "explicit", "seed", "dependency", "instruction"
  ]);
  assert.equal(manifestSchema.$defs.readiness.properties.argv, undefined);
  assert.equal(manifestSchema.$defs.readiness.properties.commandFingerprint.pattern, "^sha256:[a-f0-9]{64}$");
  assert.equal(manifestSchema.properties.fingerprint.pattern, "^sha256:[a-f0-9]{64}$");
  assert.equal(executionSchema.$defs.modelBinding.properties.source.const, "host_argument");
  assert.equal(executionSchema.$defs.modelBinding.properties.fallbackAllowed.const, false);
  assert.equal(executionSchema.properties.executor.properties.modelBinding.$ref, "#/$defs/modelBinding");
  for (const field of ["relaypactPromptBytes", "relaypactResultSchemaBytes", "relaypactDeclaredInputBytes"]) {
    assert.equal(reviewSchema.properties.metrics.properties[field].oneOf[0].type, "integer");
    assert.equal(reviewSchema.properties.metrics.properties[field].oneOf[0].minimum, 0);
    assert.equal(reviewSchema.properties.metrics.properties[field].oneOf[1].const, "unavailable");
  }
});

test("execution result model binding is strict and remains separate from observation", async () => {
  const schema = JSON.parse(await readFile(path.join(packageRoot, "packages/contracts/schemas/execution-result.schema.json"), "utf8"));
  const validate = new Ajv2020({ strict: false, formats: { "date-time": true } }).compile(schema);
  const result = JSON.parse(await readFile(path.join(packageRoot, "examples/execution-result.completed.json"), "utf8"));
  result.executor.modelBinding = {
    value: "deepseek-v4.1-flash",
    source: "host_argument",
    mechanism: "process_argument",
    assurance: "preflight_supported",
    fallbackAllowed: false,
    boundAt: "2026-09-21T00:00:00.000Z"
  };
  result.executor.modelObservation = {
    state: "unavailable", value: null, source: "unavailable", assurance: "unknown",
    observedAt: "2026-09-21T00:00:00.000Z"
  };
  assert.equal(validate(result), true, JSON.stringify(validate.errors));
  for (const mutation of [
    { fallbackAllowed: true },
    { value: "--another-model" },
    { assurance: "reported" },
    { extra: true }
  ]) {
    const invalid = structuredClone(result);
    Object.assign(invalid.executor.modelBinding, mutation);
    assert.equal(validate(invalid), false, JSON.stringify(mutation));
  }
});

// A separate standards implementation validates the published schema; do not
// substitute the runtime validator or a home-grown subset evaluator here.
const taskSchema = JSON.parse(await readFile(new URL("../packages/contracts/schemas/task-envelope.schema.json", import.meta.url), "utf8"));
const schemaAccepts = new Ajv2020({ strict: false, allErrors: true }).compile(taskSchema);
function agreement(envelope, expected, label) {
  const schemaValid = schemaAccepts(envelope);
  let runtimeValid = true;
  try { validateTaskEnvelope(envelope); } catch (error) {
    assert.ok(["invalid_envelope", "invalid_path", "credential_in_envelope"].includes(error.code), `${label}: unexpected ${error}`);
    runtimeValid = false;
  }
  assert.equal(schemaValid, expected, `${label}: schema ${JSON.stringify(schemaAccepts.errors)}`);
  assert.equal(runtimeValid, expected, `${label}: runtime`);
}

test("schema and runtime allow explicit zero write authority", () => {
  agreement(makeEnvelope("/repository", {
    scope: { allowedPaths: [], readablePaths: ["README.md"] }
  }), true, "empty allowedPaths");
});

test("schema/runtime differential paths preserve POSIX and Windows spelling boundaries", () => {
  const paths = [
    [".", true], ["src/a.mjs", true], ["src\\a.mjs", true], ["C:relative", true],
    ["目录/😀.mjs", true], ["line\nname", true], ["src/**", true],
    ["/etc/file", false], ["C:\\file", false], ["\\rooted", false],
    ["../file", false], ["src/../file", false], ["src/./file", false],
    ["src/.", false], ["src//file", false], ["src/", false], ["src\\", false],
    ["src\0file", false], ["./file", false], [" ", false], ["", false],
    ["src/..\n", true], ["src\n/../file", false], ["src\n/.git/file", false],
    [".git/config", false], ["src/.GiT/config", false], [".RelayPact/state", false]
  ];
  for (const key of ["allowedPaths", "readablePaths", "discoverablePaths", "forbiddenPaths", "workingDirectory", "acknowledgedPaths"]) {
    for (const [value, allowed] of paths) {
      const envelope = makeEnvelope("/repository");
      if (key === "workingDirectory") envelope.repository[key] = value;
      else if (key === "acknowledgedPaths") envelope.repository.dirtyTree[key] = [value];
      else envelope.scope[key] = [value];
      const reserved = /(?:^|\/)\.(?:git|relaypact)(?:\/|$)/iu.test(value);
      let expected = allowed || (reserved && ["forbiddenPaths", "workingDirectory", "acknowledgedPaths"].includes(key));
      if (key === "discoverablePaths" && value.includes("\\")) expected = false;
      agreement(envelope, expected, `${key}=${JSON.stringify(value)}`);
    }
  }
  for (const [root, expected] of [["/repo", true], ["C:\\repo", true], ["\\rooted", true], ["\\\\server\\share", true], ["C:relative", false], ["relative", false], ["", false], ["/repo\0", false]]) {
    agreement(makeEnvelope(root), expected, `root=${JSON.stringify(root)}`);
  }
});

test("schema/runtime differential text, duplicates and profile constraints", () => {
  for (const field of ["taskId", "objective", "expectedOutcome"]) {
    const maximum = field === "taskId" ? 128 : 16384;
    for (const [value, valid] of [["", false], ["\n\t ", false], ["a\0b", false], ["a\nb", true], ["😀".repeat(maximum), true], ["a".repeat(maximum + 1), false]]) {
      const e = makeEnvelope("/repo"); e[field] = value;
      agreement(e, valid, `${field} text length ${value.length}`);
    }
  }
  for (const field of ["instructions", "constraints", "stopConditions", "requiredEvidence"]) {
    const e = makeEnvelope("/repo"); e[field] = [e[field][0] ?? "same", e[field][0] ?? "same"];
    agreement(e, false, `${field} duplicate`);
  }
  for (const profile of ["profile", {}, { model: "model", provider: "provider", reasoning: "high" }]) {
    agreement(makeEnvelope("/repo", { executionProfile: profile }), true, "valid profile");
  }
  for (const profile of [null, [], 3, " ", "x".repeat(16385), { provider: " " }, { model: "a\0b" }, { reasoning: "unknown" }, { extra: true }]) {
    agreement(makeEnvelope("/repo", { executionProfile: profile }), false, `invalid profile ${JSON.stringify(profile).slice(0, 60)}`);
  }
  for (const argv of [["node", "--test", "--test"], ["node", " "], ["node", "a\0b"]]) {
    agreement(makeEnvelope("/repo", { validation: [{ id: "check", argv }] }), false, "invalid argv");
  }
});

test("schema/runtime differential planned envelopes and malformed authority arrays", () => {
  agreement(plannedEnvelope(), true, "planned baseline");
  for (const seeds of [null, {}, 3, "src/a.mjs", [], ["."], ["src\\a.mjs"], ["src/*.mjs"], ["src/.git/config"], ["src/a.mjs", "src/a.mjs"]]) {
    agreement(plannedEnvelope({ contextPlanning: { seeds } }), false, `invalid seeds ${JSON.stringify(seeds)}`);
  }
  for (const paths of [null, {}, 3, "src/**", []]) {
    agreement(plannedEnvelope({ scope: { discoverablePaths: paths } }), false, "invalid discovery array");
  }
  for (const executable of ["bash", "/bin/BASH", "bash/", "C:\\Windows\\cmd.exe", "PwSh.EXE"]) {
    agreement(plannedEnvelope({ contextPlanning: { readiness: [{ id: "shell", argv: [executable, "-c", "true"], timeoutMs: 10, acceptableExitCodes: [0] }] } }), false, executable);
  }
  agreement(plannedEnvelope({ execution: { exposureMode: "trusted-worktree", trustedWorktreeAcknowledged: true } }), false, "planned trusted worktree");
});

test("documented runtime-only semantic checks reject credentials and duplicate readiness IDs", () => {
  for (const argv of [["node", "--API_KEY=fixture"], ["node", "Bearer fixture"], ["node", "https://user:pass@example.invalid"], ["node", "sk-abcdefghijklmnop"]]) {
    const e = makeEnvelope("/repo", { validation: [{ id: "check", argv }] });
    assert.equal(schemaAccepts(e), true);
    assert.throws(() => validateTaskEnvelope(e), { code: "credential_in_envelope" });
  }
  const e = plannedEnvelope();
  e.contextPlanning.readiness.push({ ...e.contextPlanning.readiness[0], argv: ["node", "--help"] });
  assert.equal(schemaAccepts(e), true);
  assert.throws(() => validateTaskEnvelope(e), /duplicate ids/);
});

test("schema/runtime accept public task examples and reject field/type mutations", async () => {
  for (const name of ["task-envelope.json", "codex-task-envelope.planned.json", "codex-task-envelope.opencode-go-luna.json"]) {
    const e = JSON.parse(await readFile(new URL(`../examples/${name}`, import.meta.url), "utf8"));
    agreement(e, true, name);
  }
  const base = plannedEnvelope();
  for (const field of taskSchema.required) {
    const e = structuredClone(base); delete e[field]; agreement(e, false, `missing ${field}`);
  }
  // Deterministic generated combinations catch regex edge cases without relying on
  // a random seed or comparing either validator with itself.
  for (const parent of ["src", "目录", "line\nname"]) {
    for (const segment of ["a", ".", "..", ".git", ".RELAYPACT"]) {
      const e = makeEnvelope("/repo"); e.scope.allowedPaths = [`${parent}/${segment}/file`];
      agreement(e, segment === "a", "generated relative authority");
    }
  }
});


test("filesystem evidence byte budget runtime and schema agree at both bounds", async () => {
  const schema = JSON.parse(await readFile(path.join(packageRoot, "packages/contracts/schemas/task-envelope.schema.json"), "utf8"));
  const validate = new Ajv2020({ strict: false }).compile(schema);
  for (const value of [undefined, 1, 536870912, 8589934592, 0, -1, 1.5, 8589934593, Number.MAX_SAFE_INTEGER, null, "1024"]) {
    const envelope = makeEnvelope("/absolute/repository", { execution: value === undefined ? {} : { filesystemEvidenceMaxBytes: value } });
    const expected = value === undefined || (Number.isSafeInteger(value) && value > 0 && value <= 8589934592);
    assert.equal(validate(envelope), expected, `schema budget ${value}: ${JSON.stringify(validate.errors)}`);
    if (expected) assert.doesNotThrow(() => validateTaskEnvelope(envelope));
    else assert.throws(() => validateTaskEnvelope(envelope), { code: "invalid_envelope" });
  }
  for (const value of [NaN, Infinity, -Infinity]) {
    assert.throws(() => validateTaskEnvelope(makeEnvelope("/absolute/repository", { execution: { filesystemEvidenceMaxBytes: value } })), { code: "invalid_envelope" });
  }
});
