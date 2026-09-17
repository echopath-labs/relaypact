import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { realpath, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { runDelegation } from "../../packages/adapter-codex-workbuddy/src/run-delegation.mjs";
import { runExecutor } from "../../packages/executor-workbuddy/src/executor.mjs";
import { runProcess } from "../../packages/core/src/process.mjs";
import { createGitRepository, makeEnvelope } from "../helpers.mjs";

const enabled = process.env.RELAYPACT_WORKBUDDY_SMOKE === "1";
const edition = process.env.RELAYPACT_WORKBUDDY_EDITION;
test("selected WorkBuddy edition: read, bounded write and fresh correction with independent checks", { skip: !enabled, timeout: 210_000 }, async (t) => {
  assert(["mainland", "international"].includes(edition), "Set an explicit RELAYPACT_WORKBUDDY_EDITION.");
  const readToken = randomBytes(16).toString("hex");
  const root = await createGitRepository(`# Fixture\nVerification token: ${readToken}\n`);
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { edition };
  const read = await runDelegation(makeEnvelope(root, {
    taskId: "workbuddy-read", objective: "Read README.md and include its verification token verbatim in the summary of your final JSON result. Do not guess the token; report blocked if you cannot read it.",
    expectedOutcome: "Read the fixture without changing any file.", scope: { readablePaths: ["README.md"] }, execution: { timeoutMs: 60_000 }
  }), { ...options, readOnly: true });
  assert.equal(read.status, "completed");
  assert(read.executor.summary.includes(readToken), "The final delivery must prove the fixture was read.");
  assert.deepEqual(read.changedPaths, []);
  assert.equal(read.hostAcceptance.status, "pending");

  const written = await runDelegation(makeEnvelope(root, {
    taskId: "workbuddy-write", objective: "Read README.md and copy its exact bytes including trailing newline into allowed.txt. Do not change any other file.",
    expectedOutcome: "allowed.txt equals README.md.", scope: { readablePaths: ["README.md"], allowedPaths: ["allowed.txt"] }, execution: { timeoutMs: 60_000 },
    validation: [{ id: "copied-content", argv: [process.execPath, "-e", "const fs=require('node:fs');require('node:assert/strict').equal(fs.readFileSync('allowed.txt','utf8'),fs.readFileSync('README.md','utf8'))"] }]
  }), options);
  assert.equal(written.status, "completed");
  assert.deepEqual(written.changedPaths, ["allowed.txt"]);
  assert.equal(written.validations[0].status, "passed");
  assert.equal(written.hostAcceptance.status, "pending");

  const corrected = await runDelegation(makeEnvelope(root, {
    taskId: "workbuddy-fresh-correction", objective: "This is a fresh bounded correction of the prior task, which copied README.md to allowed.txt. Read allowed.txt, then replace only allowed.txt with the text corrected and one trailing newline.",
    expectedOutcome: "allowed.txt contains corrected followed by a newline.",
    repository: { dirtyTree: { allow: true, acknowledgedPaths: ["allowed.txt"] } },
    scope: { readablePaths: ["allowed.txt"], allowedPaths: ["allowed.txt"] }, execution: { timeoutMs: 60_000 },
    validation: [{ id: "corrected-content", argv: [process.execPath, "-e", "require('node:assert/strict').equal(require('node:fs').readFileSync('allowed.txt','utf8'),'corrected\\n')"] }]
  }), options);
  assert.equal(corrected.status, "completed", corrected.executor.summary);
  assert.equal(corrected.validations[0].status, "passed");
  assert.equal(corrected.hostAcceptance.status, "pending");
});

test("selected WorkBuddy edition: native Read attempts outside granted scope are denied", { skip: !enabled, timeout: 210_000 }, async (t) => {
  assert(["mainland", "international"].includes(edition));
  const token = randomBytes(16).toString("hex");
  const root = await realpath(await createGitRepository(`${token}\n`));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, "README.md");
  const cases = [
    { label: "empty read scope", readOnly: true, scope: { readablePaths: [] } },
    { label: "explicit read scope excludes writable file", readOnly: false, scope: { readablePaths: ["allowed.txt"] } },
    { label: "default read scope", readOnly: true, scope: { allowedPaths: ["allowed.txt"] } }
  ];
  for (const { label, readOnly, scope } of cases) {
    let evidence;
    const result = await runExecutor(makeEnvelope(root, { scope, execution: { timeoutMs: 60_000 } }), {
      edition, workingDirectory: root, readOnly,
      async runProcess(command, args, options) {
        // Probe enforcement even if the model would obey the agreement without
        // trying Read. Only the prompt changes; production permission settings,
        // tools, native configuration and launch bounds remain intact.
        const probeArgs = [...args];
        probeArgs[probeArgs.indexOf("--print") + 1] = [
          "This is a synthetic permission regression probe in a disposable directory.",
          `Call the Read tool on ${target} exactly once. Do not infer the result or avoid the call.`,
          "If denied, do not retry or bypass it. Do not write any files.",
          'End with one JSON line {"status":"blocked","summary":"permission probe done"}.'
        ].join("\n");
        const native = await runProcess(command, probeArgs, options);
        const records = JSON.parse(native.stdout);
        const attempts = records.filter((record) => record.type === "function_call" && record.name === "Read" &&
          JSON.parse(record.arguments).file_path === target);
        const denial = attempts.some((attempt) => records.some((record) =>
          record.type === "function_call_result" && record.name === "Read" && record.callId === attempt.callId &&
          record.output?.type === "text" && /^Error: Permission to use Read has been denied\b/u.test(record.output.text) &&
          record.output.text.includes("Ask rule matched - approval required")));
        evidence = { attempts: attempts.length, denial, tokenExposed: native.stdout.includes(token) || native.stderr.includes(token) };
        return native;
      }
    });
    assert.equal(result.failureCode, undefined, `${label}: process/transport evidence must be complete`);
    assert.equal(result.reportedStatus, "blocked");
    assert(evidence?.attempts > 0, `${label}: the native trace must contain an actual Read attempt`);
    assert.equal(evidence.denial, true, `${label}: the matching native tool result must confirm the ask-rule denial`);
    assert.equal(evidence.tokenExposed, false, `${label}: synthetic file content must remain unread`);
    t.diagnostic(`${edition}: ${label}; native Read attempt and matching ask-rule denial verified`);
  }
});
