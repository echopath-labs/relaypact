import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { asDelegationError } from "../../contracts/src/errors.mjs";
import { redact } from "../../core/src/redact.mjs";

const SUPPORT_MATRIX_PATH = fileURLToPath(new URL("../../../support-matrix.json", import.meta.url));

function usage() {
  return [
    "Usage:",
    "  relaypact support",
    "  relaypact doctor [--route <codex-codex|codex-cursor>] [--executor <cursor-path>]",
    "  relaypact run-codex --envelope <file> --profiles <file> --state-root <dir> --host-instance <id>",
    "  relaypact correct-codex --task-root <dir> --profiles <file> --prompt <file>",
    "  relaypact decide-codex --task-root <dir> --profiles <file> --action <accept|reject|abandon> --actor <id> --archive-root <dir>",
    "  relaypact run-pi --envelope <file> [--executor <pi-path>]  # experimental",
    "  relaypact run-cursor --envelope <file> [--executor <cursor-path>] [--read-only] [--state-root <dir> --host-instance <id>]  # experimental",
    "  relaypact correct-cursor --task-root <dir> --prompt <file> [--executor <cursor-path>]  # experimental",
    "  relaypact decide-cursor --task-root <dir> --action <accept|reject|abandon> --actor <id> --archive-root <dir>  # experimental"
  ].join("\n");
}

function parseArgs(argv) {
  if (argv[0] === "run") {
    throw new Error(`The ambiguous 'run' command was removed before 0.1.0. Use 'run-pi' explicitly. ${usage()}`);
  }
  if (!["support", "doctor", "run-pi", "run-cursor", "correct-cursor", "decide-cursor", "run-codex", "correct-codex", "decide-codex"].includes(argv[0])) throw new Error(usage());
  const command = argv[0];
  const options = {};
  for (let index = 1; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === "--read-only") {
      options.readOnly = true;
      continue;
    }
    if (key === "--envelope" && value) options.envelope = value;
    else if (key === "--executor" && value) options.executor = value;
    else if (key === "--route" && value) options.route = value;
    else if (key === "--profiles" && value) options.profiles = value;
    else if (key === "--state-root" && value) options.stateRoot = value;
    else if (key === "--host-instance" && value) options.hostInstanceId = value;
    else if (key === "--task-root" && value) options.taskRoot = value;
    else if (key === "--prompt" && value) options.prompt = value;
    else if (key === "--action" && value) options.action = value;
    else if (key === "--actor" && value) options.actor = value;
    else if (key === "--archive-root" && value) options.archiveRoot = value;
    else throw new Error(`Unknown or incomplete argument: ${key}. ${usage()}`);
    index += 1;
  }
  if (command === "support" && argv.length !== 1) throw new Error(usage());
  if (command === "doctor") {
    options.route ??= "codex-codex";
    if (!["codex-codex", "codex-cursor"].includes(options.route)) throw new Error(usage());
    if (options.executor && options.route !== "codex-cursor") throw new Error(usage());
  }
  if (command === "run-pi" && !options.envelope) throw new Error(usage());
  if (command === "run-cursor" && !options.envelope) throw new Error(usage());
  if (command === "run-cursor" && Boolean(options.stateRoot) !== Boolean(options.hostInstanceId)) throw new Error(usage());
  if (command !== "run-cursor" && options.readOnly) throw new Error(usage());
  if (command === "correct-cursor" && (!options.taskRoot || !options.prompt)) throw new Error(usage());
  if (
    command === "decide-cursor" &&
    (!options.taskRoot || !["accept", "reject", "abandon"].includes(options.action) || !options.actor || !options.archiveRoot)
  ) throw new Error(usage());
  if (command === "run-codex" && (!options.envelope || !options.profiles || !options.stateRoot || !options.hostInstanceId)) throw new Error(usage());
  if (command === "correct-codex" && (!options.taskRoot || !options.profiles || !options.prompt)) throw new Error(usage());
  if (
    command === "decide-codex" &&
    (!options.taskRoot || !options.profiles || !["accept", "reject", "abandon"].includes(options.action) || !options.actor || !options.archiveRoot)
  ) throw new Error(usage());
  return { command, ...options };
}

async function readBoundedText(file, maximumBytes, label) {
  const absolute = resolve(file);
  const info = await lstat(absolute);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximumBytes) {
    throw new Error(`${label} must be a bounded regular file.`);
  }
  return readFile(absolute, "utf8");
}

async function readJson(file) {
  return JSON.parse(await readBoundedText(file, 4 * 1024 * 1024, "JSON input"));
}

async function supportSummary() {
  const matrix = await readJson(SUPPORT_MATRIX_PATH);
  return {
    schemaVersion: matrix.schemaVersion,
    routes: matrix.routes.map((route) => ({
      id: route.id,
      executionHarness: route.executionHarness,
      status: route.status,
      rootPluginActivation: route.rootPluginActivation,
      prerequisites: route.prerequisites,
      deterministicCheck: route.deterministicCheck,
      liveSmoke: route.liveSmoke
    }))
  };
}

async function runCodex(options) {
  const started = performance.now();
  const [{ prepareCodexDelegation, executeCodexDelegation }, { buildHostReviewPacket, persistPendingReview }] = await Promise.all([
    import("../../adapter-codex-codex/src/controller.mjs"),
    import("../../host-codex/src/review.mjs")
  ]);
  const envelope = await readJson(options.envelope);
  const profileRegistry = await readJson(options.profiles);
  const prepared = await prepareCodexDelegation({
    envelope,
    profileRegistry,
    stateRoot: resolve(options.stateRoot),
    hostInstanceId: options.hostInstanceId
  });
  const execution = await executeCodexDelegation(prepared);
  const review = await buildHostReviewPacket(prepared, execution, { durationMs: Math.round(performance.now() - started) });
  const evidence = await persistPendingReview(prepared, review);
  return { taskRoot: prepared.capsule.taskRoot, statePath: prepared.statePath, evidence, reviewPacket: review.packet };
}

async function correctCodex(options) {
  const started = performance.now();
  const [{ correctCodexDelegation, loadCodexDelegation }, { buildHostReviewPacket, persistPendingReview }] = await Promise.all([
    import("../../adapter-codex-codex/src/controller.mjs"),
    import("../../host-codex/src/review.mjs")
  ]);
  const profileRegistry = await readJson(options.profiles);
  const prepared = await loadCodexDelegation(resolve(options.taskRoot), profileRegistry);
  const state = await readJson(prepared.statePath);
  const prompt = await readBoundedText(options.prompt, 64 * 1024, "Correction prompt");
  const execution = await correctCodexDelegation(prepared, {
    taskId: state.taskId,
    profileFingerprint: state.profileFingerprint,
    capsuleBaseline: state.capsuleBaseline,
    contextManifestFingerprint: state.contextManifestFingerprint,
    priorResultIdentity: state.resultIdentity,
    prompt
  });
  const review = await buildHostReviewPacket(prepared, execution, { durationMs: Math.round(performance.now() - started) });
  const evidence = await persistPendingReview(prepared, review);
  return { taskRoot: prepared.capsule.taskRoot, statePath: prepared.statePath, evidence, reviewPacket: review.packet };
}

async function decideCodex(options) {
  const [{ loadCodexDelegation }, { archiveAndCleanupTerminalTask, recordTerminalDecision }] = await Promise.all([
    import("../../adapter-codex-codex/src/controller.mjs"),
    import("../../host-codex/src/actions.mjs")
  ]);
  const profileRegistry = await readJson(options.profiles);
  const prepared = await loadCodexDelegation(resolve(options.taskRoot), profileRegistry);
  const state = await readJson(prepared.statePath);
  const suffix = String(state.correctionSequence);
  const evidenceRoot = resolve(prepared.capsule.taskRoot, "evidence");
  const review = {
    packet: await readJson(resolve(evidenceRoot, `host-review-packet-${suffix}.json`)),
    candidatePatch: await readBoundedText(resolve(evidenceRoot, `candidate-${suffix}.patch`), 64 * 1024 * 1024, "Candidate patch")
  };
  const decided = await recordTerminalDecision(prepared, review, options.action, options.actor);
  const archive = await archiveAndCleanupTerminalTask(prepared, decided, resolve(options.archiveRoot));
  return { action: options.action, lifecycleState: decided.packet.lifecycleState, acceptance: decided.packet.acceptance, archive };
}

async function runPi(options) {
  const { runDelegation } = await import("../../adapter-codex-pi/src/run-delegation.mjs");
  const envelope = await readJson(options.envelope);
  return runDelegation(envelope, { executorCommand: options.executor });
}

async function runCursor(options) {
  const { runDelegation } = await import("../../adapter-codex-cursor/src/run-delegation.mjs");
  const envelope = await readJson(options.envelope);
  return runDelegation(envelope, {
    executorCommand: options.executor,
    readOnly: options.readOnly === true,
    stateRoot: options.stateRoot ? resolve(options.stateRoot) : undefined,
    hostInstanceId: options.hostInstanceId
  });
}

async function correctCursor(options) {
  const { correctDelegation } = await import("../../adapter-codex-cursor/src/run-delegation.mjs");
  const prompt = await readBoundedText(options.prompt, 64 * 1024, "Correction prompt");
  return correctDelegation(resolve(options.taskRoot), prompt, { executorCommand: options.executor });
}

async function decideCursor(options) {
  const { decideDelegation } = await import("../../adapter-codex-cursor/src/run-delegation.mjs");
  return decideDelegation(
    resolve(options.taskRoot),
    options.action,
    options.actor,
    resolve(options.archiveRoot)
  );
}

export async function runCli(argv, io = process, runtime = {}) {
  try {
    const options = parseArgs(argv);
    let result;
    if (options.command === "support") result = await supportSummary();
    else if (options.command === "doctor") {
      const { runCursorDoctor, runDoctor } = await import("./doctor.mjs");
      result = options.route === "codex-cursor"
        ? await runCursorDoctor({ ...runtime.doctor, executorCommand: options.executor })
        : await runDoctor(runtime.doctor);
    }
    else if (options.command === "run-pi") result = await runPi(options);
    else if (options.command === "run-cursor") result = await runCursor(options);
    else if (options.command === "correct-cursor") result = await correctCursor(options);
    else if (options.command === "decide-cursor") result = await decideCursor(options);
    else if (options.command === "run-codex") result = await runCodex(options);
    else if (options.command === "correct-codex") result = await correctCodex(options);
    else result = await decideCodex(options);
    io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (options.command === "doctor") io.exitCode = result.state === "blocked" ? 1 : 0;
    else if (options.command === "run-pi" || (options.command === "run-cursor" && !result.review)) io.exitCode = result.status === "completed" || result.status === "blocked" ? 0 : 1;
    else if (["run-cursor", "correct-cursor"].includes(options.command)) {
      const status = result.review.executionResult.status;
      io.exitCode = status === "completed" || status === "blocked" ? 0 : 1;
    }
    else if (options.command === "run-codex" || options.command === "correct-codex") {
      io.exitCode = result.reviewPacket.lifecycleState === "failed" ? 1 : 0;
    } else if (options.command !== "support") io.exitCode = 0;
  } catch (error) {
    const safe = asDelegationError(error);
    io.stderr.write(`${JSON.stringify({
      schemaVersion: "1.0.0",
      status: "failed",
      error: { code: safe.code, message: redact(safe.message) }
    }, null, 2)}\n`);
    io.exitCode = 1;
  }
}
