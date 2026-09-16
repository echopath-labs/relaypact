import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import test from "node:test";
import { runDelegation } from "../../packages/adapter-codex-workbuddy/src/run-delegation.mjs";
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
