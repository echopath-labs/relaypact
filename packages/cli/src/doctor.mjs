import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runProcess } from "../../core/src/process.mjs";
import { MINIMUM_CODEX_VERSION, parseCodexVersion } from "../../executor-codex/src/compatibility.mjs";

const MINIMUM_NODE_MAJOR = 20;
const EXPECTED_MARKETPLACE = "relaypact-local";
const EXPECTED_PLUGIN = "relaypact";
const EXPECTED_SKILL = "relaypact";
const PROBE_TIMEOUT_MS = 5_000;
const PROBE_CAPTURE_BYTES = 256 * 1024;
const SAFE_ENVIRONMENT_NAMES = [
  "PATH", "HOME", "CODEX_HOME", "USER", "LOGNAME", "LANG", "LC_ALL",
  "TMPDIR", "SHELL", "SSL_CERT_FILE", "SSL_CERT_DIR"
];
const PLUGIN_MANIFEST_PATH = fileURLToPath(new URL("../../../plugin.json", import.meta.url));
const SKILL_PATH = fileURLToPath(new URL("../../../skills/relaypact/SKILL.md", import.meta.url));

function safeEnvironment(source) {
  return Object.fromEntries(SAFE_ENVIRONMENT_NAMES.flatMap((name) => (
    source[name] === undefined ? [] : [[name, source[name]]]
  )));
}

function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function entryHasName(value, expected) {
  if (typeof value === "string") return value === expected || value.startsWith(`${expected}@`);
  return Boolean(value && typeof value === "object"
    && (value.name === expected || value.name?.startsWith?.(`${expected}@`)));
}

function marketplaceListHasIdentity(value, expected) {
  return Boolean(value && typeof value === "object"
    && Array.isArray(value.marketplaces)
    && value.marketplaces.some((item) => entryHasName(item, expected)));
}

function pluginListHasIdentity(value, expected) {
  return Boolean(value && typeof value === "object"
    && Array.isArray(value.installed)
    && value.installed.some((item) => entryHasName(item, expected)));
}

function check(id, status, detail, remediation = null) {
  return { id, status, detail, ...(remediation ? { remediation } : {}) };
}

async function probe(run, command, args, environment) {
  try {
    const result = await run(command, args, {
      env: environment,
      timeoutMs: PROBE_TIMEOUT_MS,
      maxCaptureBytes: PROBE_CAPTURE_BYTES
    });
    if (result.timedOut) return { status: "timeout" };
    if (result.stdoutTruncated || result.stderrTruncated) return { status: "truncated" };
    return { status: "complete", exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  } catch {
    return { status: "unavailable" };
  }
}

async function packagedSkillCheck(readText) {
  try {
    const [manifestText, skillText] = await Promise.all([
      readText(PLUGIN_MANIFEST_PATH, "utf8"),
      readText(SKILL_PATH, "utf8")
    ]);
    const manifest = JSON.parse(manifestText);
    if (manifest.name === EXPECTED_PLUGIN && new RegExp(`^name:\\s*${EXPECTED_SKILL}$`, "mu").test(skillText)) {
      return check("packaged-skill", "pass", "Packaged Skill identity verified.");
    }
  } catch {
    // Return a fixed failure below; never retain path or parser details.
  }
  return check("packaged-skill", "fail", "Packaged Skill identity could not be verified.", "reinstall-plugin");
}

function jsonProbeCheck(result, id, expected, matches, successDetail, missingDetail, remediation) {
  if (result.status === "timeout") return check(id, "warn", "Plugin listing timed out.", remediation);
  if (result.status === "truncated") return check(id, "warn", "Plugin listing exceeded the diagnostic output bound.", remediation);
  if (result.status !== "complete" || result.exitCode !== 0) return check(id, "warn", missingDetail, remediation);
  try {
    if (matches(JSON.parse(result.stdout), expected)) return check(id, "pass", successDetail);
  } catch {
    return check(id, "warn", "Plugin listing returned unsupported JSON.", remediation);
  }
  return check(id, "warn", missingDetail, remediation);
}

export async function runDoctor(options = {}) {
  const run = options.runProcess ?? runProcess;
  const readText = options.readFile ?? readFile;
  const environment = safeEnvironment(options.environment ?? process.env);
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const nodeMajor = Number.parseInt(nodeVersion.split(".")[0], 10);
  const checks = [];

  checks.push(Number.isInteger(nodeMajor) && nodeMajor >= MINIMUM_NODE_MAJOR
    ? check("node", "pass", `Node.js ${nodeVersion} is supported.`)
    : check("node", "fail", `Node.js ${MINIMUM_NODE_MAJOR} or later is required.`, "upgrade-node"));

  const packaged = await packagedSkillCheck(readText);
  checks.push(packaged);

  const gitResult = await probe(run, "git", ["--version"], environment);
  checks.push(gitResult.status === "complete" && gitResult.exitCode === 0 && /^git version \d+/u.test(gitResult.stdout.trim())
    ? check("git", "pass", "Git is available.")
    : check("git", "fail", "Git is unavailable or could not be verified.", "install-git"));

  const codexVersionResult = await probe(run, "codex", ["--version"], environment);
  const codexVersion = codexVersionResult.status === "complete"
    ? parseCodexVersion(`${codexVersionResult.stdout}\n${codexVersionResult.stderr}`)
    : null;
  const codexCompatible = codexVersionResult.status === "complete"
    && codexVersionResult.exitCode === 0
    && codexVersion !== null
    && compareVersions(codexVersion, MINIMUM_CODEX_VERSION) >= 0;
  checks.push(codexCompatible
    ? check("codex-cli", "pass", `Codex CLI ${codexVersion} is supported.`)
    : check(
      "codex-cli",
      "fail",
      codexVersion ? `Codex CLI ${MINIMUM_CODEX_VERSION} or later is required.` : "Codex CLI is unavailable or its version could not be verified.",
      "install-or-upgrade-codex-cli"
    ));

  let execAvailable = false;
  if (codexCompatible) {
    const execResult = await probe(run, "codex", ["exec", "--help"], environment);
    execAvailable = execResult.status === "complete"
      && execResult.exitCode === 0
      && /Run Codex non-interactively|Usage:\s*codex exec/iu.test(`${execResult.stdout}\n${execResult.stderr}`);
    checks.push(execAvailable
      ? check("codex-exec", "pass", "Independent codex exec is available from the installed Codex CLI.")
      : check("codex-exec", "fail", "codex exec is unavailable or missing required help output.", "repair-codex-cli"));
  } else {
    checks.push(check("codex-exec", "fail", "codex exec was not probed because Codex CLI compatibility failed.", "install-or-upgrade-codex-cli"));
  }

  if (codexCompatible && execAvailable) {
    const marketplaceResult = await probe(run, "codex", ["plugin", "marketplace", "list", "--json"], environment);
    const marketplaceCheck = jsonProbeCheck(
      marketplaceResult,
      "marketplace",
      EXPECTED_MARKETPLACE,
      marketplaceListHasIdentity,
      "RelayPact marketplace is visible.",
      "RelayPact marketplace is not visible.",
      "add-marketplace"
    );
    checks.push(marketplaceCheck);

    if (marketplaceCheck.status === "pass") {
      const pluginResult = await probe(run, "codex", ["plugin", "list", "--marketplace", EXPECTED_MARKETPLACE, "--json"], environment);
      checks.push(jsonProbeCheck(
        pluginResult,
        "plugin",
        EXPECTED_PLUGIN,
        pluginListHasIdentity,
        "RelayPact plugin is installed and visible.",
        "RelayPact plugin is not installed or visible.",
        "install-plugin"
      ));
    } else {
      checks.push(check("plugin", "warn", "Plugin visibility was not probed because the marketplace is not visible.", "add-marketplace"));
    }
  } else {
    checks.push(check("marketplace", "warn", "Marketplace visibility was not probed because Codex CLI readiness failed.", "repair-codex-cli"));
    checks.push(check("plugin", "warn", "Plugin visibility was not probed because Codex CLI readiness failed.", "repair-codex-cli"));
  }

  const requiredIds = new Set(["node", "packaged-skill", "git", "codex-cli", "codex-exec"]);
  const blocked = checks.some((item) => requiredIds.has(item.id) && item.status !== "pass");
  const needsSetup = checks.some((item) => ["marketplace", "plugin"].includes(item.id) && item.status !== "pass");
  const state = blocked ? "blocked" : needsSetup ? "needs_setup" : "ready";

  return {
    schemaVersion: "1.0.0",
    command: "doctor",
    state,
    route: "codex-codex",
    executor: {
      source: "installed-codex-cli",
      command: "codex exec",
      additionalInstallationRequired: false
    },
    checks,
    limitations: [
      "Doctor does not read authentication or contact a model provider.",
      "Live route availability is evaluated only when an explicitly selected task runs."
    ]
  };
}

export async function runCursorDoctor(options = {}) {
  const { discoverCursorCli } = await import("../../executor-cursor/src/executor.mjs");
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const nodeMajor = Number.parseInt(nodeVersion.split(".")[0], 10);
  const checks = [];
  checks.push(Number.isInteger(nodeMajor) && nodeMajor >= MINIMUM_NODE_MAJOR
    ? check("node", "pass", `Node.js ${nodeVersion} is supported.`)
    : check("node", "fail", `Node.js ${MINIMUM_NODE_MAJOR} or later is required.`, "upgrade-node"));

  checks.push(await packagedSkillCheck(options.readFile ?? readFile));
  const gitResult = await probe(
    options.runProcess ?? runProcess,
    "git",
    ["--version"],
    safeEnvironment(options.environment ?? process.env)
  );
  checks.push(gitResult.status === "complete" && gitResult.exitCode === 0 && /^git version \d+/u.test(gitResult.stdout.trim())
    ? check("git", "pass", "Git is available.")
    : check("git", "fail", "Git is unavailable or could not be verified.", "install-git"));

  const readiness = await discoverCursorCli(options);
  checks.push(readiness.command
    ? check("cursor-cli", "pass", `Cursor CLI ${readiness.version} exposes the required local execution flags.`)
    : check("cursor-cli", "fail", "A compatible Cursor CLI could not be verified.", "install-or-upgrade-cursor-cli"));
  checks.push(readiness.authenticated
    ? check("cursor-auth", "pass", "Cursor CLI reports an authenticated local session.")
    : check("cursor-auth", "fail", "Cursor CLI authentication could not be verified.", "authenticate-cursor-cli"));

  const requiredIds = new Set(["node", "packaged-skill", "git", "cursor-cli", "cursor-auth"]);
  const blocked = checks.some((item) => requiredIds.has(item.id) && item.status !== "pass");
  return {
    schemaVersion: "1.0.0",
    command: "doctor",
    state: blocked ? "blocked" : "ready",
    route: "codex-cursor",
    executor: {
      source: options.executorCommand ? "explicit-cursor-cli" : "discovered-cursor-cli",
      command: "cursor CLI",
      version: readiness.version,
      additionalInstallationRequired: !readiness.command
    },
    checks,
    limitations: [
      "RelayPact observes Cursor readiness but does not select or configure its model.",
      "Doctor does not invoke a model or retain Cursor account output."
    ]
  };
}
