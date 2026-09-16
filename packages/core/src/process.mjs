import { spawn } from "node:child_process";

const MAX_CAPTURE_BYTES = 128 * 1024;
const DEFAULT_TERMINATION_GRACE_MS = 1000;
const DEFAULT_HARD_SETTLE_GRACE_MS = 1000;

function capture(maxBytes, encoding) {
  const chunks = [];
  let bytes = 0;
  let truncated = false;
  return {
    append(chunk) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = maxBytes - bytes;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      if (value.byteLength > remaining) truncated = true;
      const retained = value.subarray(0, Math.max(0, remaining));
      if (retained.byteLength > 0) {
        chunks.push(retained);
        bytes += retained.byteLength;
      }
    },
    result() {
      const value = Buffer.concat(chunks, bytes);
      return { value: encoding === null ? value : value.toString(encoding), truncated };
    }
  };
}

function signalProcess(child, signal, processGroup) {
  if (processGroup && Number.isInteger(child.pid)) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if (error?.code !== "ESRCH") child.kill(signal);
      return;
    }
  }
  child.kill(signal);
}

export function runProcess(command, args, options = {}) {
  const {
    cwd,
    env = process.env,
    timeoutMs = 30_000,
    input = undefined,
    maxCaptureBytes = MAX_CAPTURE_BYTES,
    terminationGraceMs = DEFAULT_TERMINATION_GRACE_MS,
    hardSettleGraceMs = DEFAULT_HARD_SETTLE_GRACE_MS,
    processGroup = process.platform !== "win32",
    outputEncoding = "utf8",
    argv0 = undefined,
    signal: abortSignal = undefined
  } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      detached: processGroup,
      shell: false,
      ...(argv0 === undefined ? {} : { argv0 }),
      stdio: ["pipe", "pipe", "pipe"]
    });

    const stdoutCapture = capture(maxCaptureBytes, outputEncoding);
    const stderrCapture = capture(maxCaptureBytes, outputEncoding);
    let timedOut = false;
    let cancelled = false;
    let hardKilled = false;
    let groupCleanupAttempted = false;
    let settled = false;
    let terminationStarted = false;
    let forceTimer;
    let hardSettleTimer;

    const clearTimers = () => {
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      if (hardSettleTimer) clearTimeout(hardSettleTimer);
      abortSignal?.removeEventListener("abort", abort);
    };
    const finish = (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimers();
      const stdout = stdoutCapture.result();
      const stderr = stderrCapture.result();
      resolve({
        exitCode,
        signal,
        stdout: stdout.value,
        stderr: stderr.value,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        timedOut,
        cancelled,
        hardKilled,
        groupCleanupAttempted
      });
    };

    const terminate = (reason) => {
      if (settled || terminationStarted) return;
      terminationStarted = true;
      if (reason === "timeout") timedOut = true;
      if (reason === "cancel") cancelled = true;
      signalProcess(child, "SIGTERM", processGroup);
      forceTimer = setTimeout(() => {
        hardKilled = true;
        signalProcess(child, "SIGKILL", processGroup);
        hardSettleTimer = setTimeout(() => finish(null, "SIGKILL"), hardSettleGraceMs);
      }, terminationGraceMs);
    };
    const timer = setTimeout(() => terminate("timeout"), timeoutMs);
    const abort = () => terminate("cancel");
    if (abortSignal) {
      if (abortSignal.aborted) abort();
      else abortSignal.addEventListener("abort", abort, { once: true });
    }

    child.stdout.on("data", (chunk) => {
      stdoutCapture.append(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrCapture.append(chunk);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimers();
      reject(error);
    });
    child.on("close", (exitCode, signal) => {
      if (processGroup) {
        groupCleanupAttempted = true;
        signalProcess(child, "SIGKILL", true);
      }
      finish(exitCode, signal);
    });

    if (input === undefined) child.stdin.end();
    else child.stdin.end(input);
  });
}
