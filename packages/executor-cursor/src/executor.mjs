import { createHash } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { DelegationError } from "../../contracts/src/errors.mjs";
import { runProcess } from "../../core/src/process.mjs";
import { conciseOutput } from "../../core/src/redact.mjs";

const CURSOR_SESSION = Symbol("cursorSession");
const EXECUTOR_STATUSES = new Set(["completed", "blocked", "failed"]);
const PROBE_TIMEOUT_MS = 5_000;
const PROBE_CAPTURE_BYTES = 256 * 1024;
const EXECUTION_CAPTURE_BYTES = 8 * 1024 * 1024;
const HARNESS_OWNED_AUTH_RISK = "Cursor authentication and model configuration remain harness-owned; RelayPact cannot inventory their credential values for exact-value evidence scanning.";
const SAFE_ENVIRONMENT_NAMES = [
  "PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "SHELL",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "XDG_CONFIG_HOME", "PATHEXT"
];

function safeEnvironment(source) {
  return Object.fromEntries(SAFE_ENVIRONMENT_NAMES.flatMap((name) => (
    source[name] === undefined ? [] : [[name, source[name]]]
  )));
}

function processMetadata(result = {}) {
  return {
    exitCode: result.exitCode ?? null,
    signal: result.signal ?? null,
    timedOut: result.timedOut === true,
    cancelled: result.cancelled === true,
    hardKilled: result.hardKilled === true,
    groupCleanupAttempted: result.groupCleanupAttempted === true,
    stdoutTruncated: result.stdoutTruncated === true,
    stderrTruncated: result.stderrTruncated === true
  };
}

function residualRisks(values = []) {
  return [...new Set([
    ...values.filter((value) => typeof value === "string" && value.length > 0),
    HARNESS_OWNED_AUTH_RISK
  ])];
}

async function probe(run, command, args, environment) {
  try {
    const result = await run(command, args, {
      env: environment,
      timeoutMs: PROBE_TIMEOUT_MS,
      maxCaptureBytes: PROBE_CAPTURE_BYTES
    });
    if (result.timedOut || result.cancelled) return { state: "interrupted" };
    if (result.stdoutTruncated || result.stderrTruncated) return { state: "truncated" };
    return {
      state: "complete",
      exitCode: result.exitCode,
      signal: result.signal,
      output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`
    };
  } catch {
    return { state: "unavailable" };
  }
}

function parseVersion(output) {
  const match = output.match(/(?:cursor-agent|agent|cursor)\s+(\d{4}\.\d{2}\.\d{2}(?:-[A-Za-z0-9._-]+)?)/iu)
    ?? output.match(/\b(\d+\.\d+\.\d+(?:-[A-Za-z0-9._-]+)?)\b/u);
  return match?.[1] ?? null;
}

function supportsRequiredFlags(output) {
  return ["--print", "--output-format", "--workspace", "--sandbox", "--resume", "--force", "--mode"]
    .every((flag) => output.includes(flag));
}

function commandCandidates(command, environment, baseDirectory) {
  if (path.isAbsolute(command)) return [command];
  if (command.includes("/") || command.includes("\\")) return [path.resolve(baseDirectory, command)];
  const directories = String(environment.PATH ?? "").split(path.delimiter).filter(Boolean);
  const extensions = process.platform === "win32"
    ? String(environment.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
    : [""];
  return directories.flatMap((directory) => extensions.map((extension) => path.join(directory, `${command}${extension}`)));
}

async function fileFingerprint(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(`sha256:${hash.digest("hex")}`));
  });
}

export async function resolveCursorExecutable(command, options = {}) {
  if (typeof command !== "string" || command.trim().length === 0 || command.includes("\0")) return null;
  const environment = safeEnvironment(options.environment ?? process.env);
  const baseDirectory = path.resolve(options.commandBaseDirectory ?? process.cwd());
  for (const candidate of commandCandidates(command, environment, baseDirectory)) {
    try {
      await access(candidate, fsConstants.X_OK);
      const resolved = await realpath(candidate);
      const info = await stat(resolved);
      if (!info.isFile()) continue;
      await access(resolved, fsConstants.X_OK);
      return { command: resolved, fingerprint: await fileFingerprint(resolved) };
    } catch {
      // Try the next explicit PATH candidate without exposing filesystem details.
    }
  }
  return null;
}

export async function discoverCursorCli(options = {}) {
  const run = options.runProcess ?? runProcess;
  const resolveExecutable = options.resolveExecutable ?? resolveCursorExecutable;
  const environment = safeEnvironment(options.environment ?? process.env);
  const candidates = options.executorIdentity
    ? [options.executorIdentity]
    : (options.executorCommand
    ? [options.executorCommand]
    : ["cursor-agent", "agent"]);

  for (const candidate of candidates) {
    const identity = typeof candidate === "string"
      ? await resolveExecutable(candidate, {
        environment,
        commandBaseDirectory: options.commandBaseDirectory
      })
      : candidate;
    if (
      !identity || typeof identity.command !== "string" || !path.isAbsolute(identity.command) ||
      !/^sha256:[a-f0-9]{64}$/u.test(identity.fingerprint)
    ) continue;
    const command = identity.command;
    const versionProbe = await probe(run, command, ["--version"], environment);
    if (versionProbe.state !== "complete" || versionProbe.exitCode !== 0 || versionProbe.signal) continue;
    const version = parseVersion(versionProbe.output);
    if (!version) continue;

    const helpProbe = await probe(run, command, ["--help"], environment);
    if (
      helpProbe.state !== "complete" || helpProbe.exitCode !== 0 || helpProbe.signal ||
      !supportsRequiredFlags(helpProbe.output)
    ) continue;

    const authProbe = await probe(run, command, ["status"], environment);
    const authenticated = authProbe.state === "complete" && authProbe.exitCode === 0 && !authProbe.signal;
    const verifiedIdentity = await resolveExecutable(command, {
      environment,
      commandBaseDirectory: options.commandBaseDirectory
    });
    if (
      !verifiedIdentity || verifiedIdentity.command !== identity.command ||
      verifiedIdentity.fingerprint !== identity.fingerprint
    ) continue;
    return {
      state: authenticated ? "ready" : "blocked",
      command,
      executableFingerprint: verifiedIdentity.fingerprint,
      version,
      authenticated,
      structuredOutput: true,
      capabilities: {
        boundedWorkspace: true,
        sandbox: true,
        force: true,
        resume: true
      }
    };
  }

  return {
    state: "blocked",
    command: null,
    version: null,
    authenticated: false,
    structuredOutput: false,
    capabilities: {
      boundedWorkspace: false,
      sandbox: false,
      force: false,
      resume: false
    }
  };
}

function findPayload(value, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return null;
  if (typeof value === "string") {
    try {
      return findPayload(JSON.parse(value), depth + 1);
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const found = findPayload(value[index], depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === "object") {
    if (EXECUTOR_STATUSES.has(value.status) && typeof value.summary === "string") return value;
    for (const key of ["result", "message", "content", "text", "data"]) {
      const found = findPayload(value[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function parseTerminalPayload(value) {
  const direct = findPayload(value);
  if (direct || typeof value !== "string") return direct;
  const candidates = [];
  for (const line of value.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;
    try {
      const payload = findPayload(JSON.parse(trimmed));
      if (payload) candidates.push(payload);
    } catch {
      // A terminal line is eligible only when the complete line is valid JSON.
    }
  }
  return candidates.length === 1 ? candidates[0] : null;
}

function parseCursorEvents(stdout) {
  const lines = stdout.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  const events = [];
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (!event || typeof event !== "object" || Array.isArray(event)) return null;
      events.push(event);
    } catch {
      return null;
    }
  }
  const terminals = events.filter((event) => event.type === "result");
  if (terminals.length !== 1) return null;
  return { events, terminal: terminals[0] };
}

function modelObservation(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const value = typeof event.model === "string" && event.model.trim()
      ? event.model.trim()
      : typeof event.model_name === "string" && event.model_name.trim()
        ? event.model_name.trim()
        : null;
    if (value) {
      if (value.toLowerCase() === "auto") {
        return {
          state: "harness_managed",
          value: conciseOutput(value, 200),
          source: "executor_event",
          assurance: "selector_alias",
          observedAt: new Date().toISOString()
        };
      }
      return {
        state: "observed",
        value: conciseOutput(value, 200),
        source: "executor_event",
        assurance: "reported",
        observedAt: new Date().toISOString()
      };
    }
  }
  return {
    state: "unavailable",
    value: null,
    source: "unavailable",
    assurance: "unknown",
    observedAt: new Date().toISOString()
  };
}

function buildPrompt(envelope, correctionPrompt = null) {
  const sections = [
    "You are a bounded Delegated Executor operating through Cursor CLI.",
    "Execute only within the following task envelope.",
    "Stop with status blocked if information or authority is missing.",
    "Do not commit, push, widen scope, change Git control state, or expose credentials.",
    "The final line of your response must be exactly one compact JSON object with status (completed|blocked|failed), summary, and optional residualRisks. Do not put other JSON objects on separate lines.",
    JSON.stringify(envelope, null, 2)
  ];
  if (correctionPrompt) {
    sections.push(
      "This is an authorized correction on the same bounded task and session. Preserve the original envelope and address only this correction request:",
      correctionPrompt
    );
  }
  return sections.join("\n\n");
}

function buildCursorArgs(envelope, workingDirectory, options) {
  const args = [
    "-p",
    "--output-format", "stream-json",
    "--trust",
    "--sandbox", "enabled",
    "--workspace", workingDirectory
  ];
  if (options.readOnly === true) args.push("--mode", "plan");
  else args.push("--force");
  if (options.resumeSessionId) args.push(`--resume=${options.resumeSessionId}`);
  args.push(buildPrompt(envelope, options.correctionPrompt));
  return args;
}

function sessionIdFrom(events, terminal) {
  const direct = [terminal.session_id, terminal.sessionId].find((value) => typeof value === "string" && value.length > 0);
  if (direct) return direct;
  for (const event of events) {
    const value = [event.session_id, event.sessionId].find((item) => typeof item === "string" && item.length > 0);
    if (value) return value;
  }
  return null;
}

function attachSession(result, sessionId, executorCommand, executorFingerprint) {
  if (!sessionId) return result;
  Object.defineProperty(result, CURSOR_SESSION, {
    enumerable: false,
    value: {
      sessionId,
      digest: `sha256:${createHash("sha256").update(sessionId).digest("hex")}`,
      executorCommand,
      executorFingerprint
    }
  });
  return result;
}

export function cursorSessionEvidence(result) {
  const evidence = result?.[CURSOR_SESSION];
  return evidence ? { digest: evidence.digest, resumable: true } : { digest: null, resumable: false };
}

export async function runExecutor(envelope, options = {}) {
  const readiness = options.readiness ?? await discoverCursorCli(options);
  if (readiness.state !== "ready") {
    return {
      reportedStatus: "blocked",
      summary: readiness.command
        ? "Cursor CLI authentication is unavailable or could not be verified."
        : "A compatible Cursor CLI installation could not be verified.",
      residualRisks: residualRisks(),
      exitCode: null,
      signal: null,
      modelObservation: modelObservation([])
    };
  }

  const run = options.runProcess ?? runProcess;
  let processResult;
  try {
    processResult = await run(
      readiness.command,
      buildCursorArgs(envelope, options.workingDirectory, options),
      {
        cwd: options.workingDirectory,
        env: safeEnvironment(options.environment ?? process.env),
        timeoutMs: envelope.execution?.timeoutMs ?? 900_000,
        maxCaptureBytes: options.maxCaptureBytes ?? EXECUTION_CAPTURE_BYTES,
        signal: options.signal
      }
    );
  } catch {
    return {
      reportedStatus: "failed",
      summary: "Cursor executor could not start.",
      residualRisks: residualRisks(),
      exitCode: null,
      signal: null,
      modelObservation: modelObservation([])
    };
  }

  const metadata = processMetadata(processResult);
  if (processResult.stdoutTruncated || processResult.stderrTruncated) {
    return { reportedStatus: "failed", summary: "Cursor executor output exceeded the evidence capture bound.", residualRisks: residualRisks(), ...metadata, modelObservation: modelObservation([]) };
  }
  if (processResult.cancelled) {
    return { reportedStatus: "failed", summary: "Cursor executor was cancelled.", residualRisks: residualRisks(), ...metadata, modelObservation: modelObservation([]) };
  }
  if (processResult.timedOut) {
    return { reportedStatus: "failed", summary: "Cursor executor timed out.", residualRisks: residualRisks(), ...metadata, modelObservation: modelObservation([]) };
  }
  if (processResult.exitCode !== 0 || processResult.signal) {
    return { reportedStatus: "failed", summary: "Cursor executor process failed.", residualRisks: residualRisks(), ...metadata, modelObservation: modelObservation([]) };
  }

  const parsed = parseCursorEvents(processResult.stdout);
  if (!parsed) {
    return { reportedStatus: "malformed", summary: "Cursor output did not contain exactly one supported terminal result event.", residualRisks: residualRisks(), ...metadata, modelObservation: modelObservation([]) };
  }

  const observation = modelObservation(parsed.events);
  const terminalSucceeded = parsed.terminal.subtype === "success" && parsed.terminal.is_error !== true;
  if (!terminalSucceeded) {
    return attachSession({
      reportedStatus: "failed",
      summary: "Cursor reported an unsuccessful terminal result.",
      residualRisks: residualRisks(),
      ...metadata,
      modelObservation: observation
    }, sessionIdFrom(parsed.events, parsed.terminal), readiness.command, readiness.executableFingerprint);
  }

  const payload = parseTerminalPayload(parsed.terminal.result);
  if (!payload) {
    return attachSession({
      reportedStatus: "malformed",
      summary: "Cursor terminal output did not contain the required structured executor result.",
      residualRisks: residualRisks(),
      ...metadata,
      modelObservation: observation
    }, sessionIdFrom(parsed.events, parsed.terminal), readiness.command, readiness.executableFingerprint);
  }

  return attachSession({
    reportedStatus: payload.status,
    summary: conciseOutput(payload.summary, 4000),
    residualRisks: residualRisks(Array.isArray(payload.residualRisks)
      ? payload.residualRisks.map((item) => conciseOutput(item, 4000))
      : []),
    ...metadata,
    modelObservation: observation
  }, sessionIdFrom(parsed.events, parsed.terminal), readiness.command, readiness.executableFingerprint);
}

export function assertCursorResumeSession(result) {
  const evidence = result?.[CURSOR_SESSION];
  if (!evidence) throw new DelegationError("cursor_session_unavailable", "Cursor execution did not yield a resumable session.");
  return evidence.sessionId;
}

export function cursorPrivateSession(result) {
  const evidence = result?.[CURSOR_SESSION];
  return evidence
    ? {
      handle: evidence.sessionId,
      digest: evidence.digest,
      executorCommand: evidence.executorCommand,
      executorFingerprint: evidence.executorFingerprint
    }
    : { handle: null, digest: null, executorCommand: null, executorFingerprint: null };
}
