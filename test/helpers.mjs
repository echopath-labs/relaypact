import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function createGitRepository(readme = "# Fixture\n") {
  const root = await mkdtemp(path.join(os.tmpdir(), "relaypact-test-"));
  await execFileAsync("git", ["init", "-b", "main"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "tests@example.invalid"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "RelayPact Tests"], { cwd: root });
  await writeFile(path.join(root, "README.md"), readme, "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "test: baseline"], { cwd: root });
  return root;
}

export async function createDirectory() {
  return mkdtemp(path.join(os.tmpdir(), "relaypact-dir-"));
}

export async function makeMinimalPlugin(root, manifest) {
  await mkdir(path.join(root, ".agents", "plugins"), { recursive: true });
  await mkdir(path.join(root, ".github", "workflows"), { recursive: true });
  await mkdir(path.join(root, "skills", "demo"), { recursive: true });
  await mkdir(path.join(root, "packages", "contracts", "schemas"), { recursive: true });
  await writeFile(path.join(root, "plugin.json"), JSON.stringify(manifest, null, 2));
  await writeFile(path.join(root, ".agents", "plugins", "marketplace.json"), JSON.stringify({
    name: "fixture-marketplace",
    plugins: [{ name: manifest.name, source: { source: "local", path: "." } }]
  }, null, 2));
  await writeFile(path.join(root, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: Demo skill.\n---\n");
  await writeFile(path.join(root, "CHANGELOG.md"), "# Changelog\n\n## [0.1.0] - Unreleased Public Preview\n");
  await writeFile(path.join(root, "AGENTS.md"), "# Public repository instructions\n");
  await writeFile(path.join(root, "RELEASING.md"), "# Public Preview Release Checklist\n");
  await writeFile(path.join(root, "SECURITY.md"), "# Security Policy\n");
  await writeFile(path.join(root, ".github", "workflows", "validate.yml"), [
    "name: Validate",
    "",
    "on:",
    "  push:",
    "  pull_request:",
    "",
    "permissions:",
    "  contents: read",
    "",
    "concurrency:",
    "  group: validate-${{ github.workflow }}-${{ github.ref }}",
    "  cancel-in-progress: true",
    "",
    "jobs:",
    "  package:",
    "    runs-on: ubuntu-latest",
    "    timeout-minutes: 10",
    "    steps:",
    "      - name: Check out repository",
    "        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7",
    "      - name: Use Node.js 20",
    "        uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7",
    "        with:",
    "          node-version: 20.20.2",
    "          package-manager-cache: false",
    "      - name: Install locked development dependencies",
    "        run: npm ci --ignore-scripts --no-audit --no-fund",
    "      - name: Validate package and run deterministic tests",
    "        run: npm run check",
    "      - name: Inspect package contents",
    "        run: npm pack --dry-run --json",
    ""
  ].join("\n"));
  for (const contract of [
    "adapter-support-matrix.schema.json",
    "task-envelope.schema.json",
    "context-manifest.schema.json",
    "execution-result.schema.json",
    "codex-worker-result.schema.json",
    "host-review-packet.schema.json"
  ]) {
    await writeFile(path.join(root, "packages", "contracts", "schemas", contract), "{}\n");
  }
  const files = [
    ".agents/plugins/marketplace.json",
    ".github/workflows/validate.yml",
    "AGENTS.md",
    "CHANGELOG.md",
    "RELEASING.md",
    "SECURITY.md",
    "packages/contracts/schemas/adapter-support-matrix.schema.json",
    "packages/contracts/schemas/codex-worker-result.schema.json",
    "packages/contracts/schemas/context-manifest.schema.json",
    "packages/contracts/schemas/execution-result.schema.json",
    "packages/contracts/schemas/host-review-packet.schema.json",
    "packages/contracts/schemas/task-envelope.schema.json",
    "plugin.json",
    "public-files.json",
    "skills/demo/SKILL.md"
  ];
  await writeFile(path.join(root, "public-files.json"), JSON.stringify({ schemaVersion: "1.0.0", files }, null, 2));
}

export function makeEnvelope(root, overrides = {}) {
  const envelope = {
    schemaVersion: "1.0.0",
    taskId: "test-task",
    objective: "Make one bounded fixture edit.",
    expectedOutcome: "The allowed file is updated.",
    repository: {
      root,
      workingDirectory: ".",
      dirtyTree: { allow: false, acknowledgedPaths: [] }
    },
    scope: {
      allowedPaths: ["allowed.txt", "README.md"],
      forbiddenPaths: ["private.txt", ".env", ".env.*"]
    },
    instructions: ["Stay inside the envelope."],
    constraints: ["Do not commit or push."],
    validation: [
      { id: "pass", argv: [process.execPath, "-e", "process.exit(0)"], timeoutMs: 10_000 }
    ],
    requiredEvidence: ["git_preflight", "changed_paths", "validation_results", "executor_report"],
    stopConditions: ["Stop if authority is missing."],
    resultFormat: { schemaVersion: "1.0.0" },
    execution: { timeoutMs: 10_000 }
  };
  return deepMerge(envelope, overrides);
}

function deepMerge(base, overrides) {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) return overrides ?? base;
  const output = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    output[key] = value && typeof value === "object" && !Array.isArray(value)
      ? deepMerge(base?.[key] ?? {}, value)
      : value;
  }
  return output;
}
