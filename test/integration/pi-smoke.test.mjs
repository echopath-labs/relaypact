import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { runDelegation } from "../../packages/adapter-codex-pi/src/run-delegation.mjs";
import { createGitRepository, makeEnvelope } from "../helpers.mjs";

const enabled = process.env.RELAYPACT_PI_SMOKE === "1";

test("opt-in real Pi delegated execution", { skip: !enabled }, async (context) => {
  const root = await createGitRepository();
  const outputFile = "allowed.txt";
  const outputContent = "delegated Pi smoke ok\n";
  const profile = {};
  if (process.env.RELAYPACT_PI_PROVIDER) profile.provider = process.env.RELAYPACT_PI_PROVIDER;
  if (process.env.RELAYPACT_PI_MODEL) profile.model = process.env.RELAYPACT_PI_MODEL;
  if (process.env.RELAYPACT_PI_REASONING) profile.reasoning = process.env.RELAYPACT_PI_REASONING;
  const overrides = {
    taskId: "real-pi-smoke",
    objective: `Create ${outputFile} with the exact requested content.`,
    expectedOutcome: `${outputFile} contains the requested content and validation passes.`,
    scope: {
      allowedPaths: [outputFile],
      forbiddenPaths: [".git/**", ".env", ".env.*"]
    },
    instructions: [
      `Create only ${outputFile}.`,
      `Its full content must be exactly ${JSON.stringify(outputContent)}.`
    ],
    validation: [{
      id: "pi-smoke-content",
      argv: [
        process.execPath,
        "-e",
        `const fs=require('node:fs');process.exit(fs.readFileSync(${JSON.stringify(outputFile)},'utf8')===${JSON.stringify(outputContent)}?0:1)`
      ],
      timeoutMs: 30_000
    }],
    execution: { timeoutMs: 300_000 }
  };
  if (Object.keys(profile).length > 0) overrides.executionProfile = profile;

  try {
    const result = await runDelegation(makeEnvelope(root, overrides), {
      ...(process.env.RELAYPACT_PI_COMMAND ? { executorCommand: process.env.RELAYPACT_PI_COMMAND } : {})
    });
    context.diagnostic(JSON.stringify({
      status: result.status,
      executorStatus: result.executor.reportedStatus,
      changedPathCount: result.changedPaths.length,
      scopeCompliant: result.scope.compliant,
      validationStatuses: result.validations.map((item) => item.status),
      acceptanceStatus: result.hostAcceptance.status,
      acceptanceEligible: result.hostAcceptance.eligible
    }));
    assert.equal(result.status, "completed");
    assert.equal(result.executor.reportedStatus, "completed");
    assert.deepEqual(result.changedPaths, [outputFile]);
    assert.equal(result.scope.compliant, true);
    assert.ok(result.validations.every((item) => item.status === "passed"));
    assert.equal(result.hostAcceptance.status, "pending");
    assert.equal(result.hostAcceptance.eligible, true);
    assert.equal(await readFile(path.join(root, outputFile), "utf8"), outputContent);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
