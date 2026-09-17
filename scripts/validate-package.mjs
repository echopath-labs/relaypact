#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CANONICAL_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const PROJECT_NAME = "relaypact";
const PROJECT_DISPLAY_NAME = "RelayPact";
const PROJECT_VERSION = "0.3.0";
const PROJECT_RELEASE_STATE = "versioned";
const LATEST_PUBLISHED_VERSION = "0.2.0";
const PROJECT_LICENSE = "Apache-2.0";
const PROJECT_REPOSITORY = "https://github.com/echopath-labs/relaypact";
const PROJECT_MARKETPLACE = "relaypact-local";
const PROJECT_SKILL = "relaypact";
const REVIEWED_LICENSE_SHA256 = "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30";
const REVIEWED_NOTICE_SHA256 = "5b11b2690e855e2c91fd96648a5e3772a2d433c094616ac4397a0b6106f76dd2";
const FORMER_IDENTITY_VALUES = [
  ["agent", "delegation", "kit"].join("-"),
  ["agent", "delegation", "kit"].join("_"),
  ["agent", "delegation", "kit"].join(" "),
  ["codex", "delegated", "execution"].join("-"),
  ["a", "d", "k", "_"].join(""),
  ["a", "d", "k", "-"].join(""),
  `.${["agent", "delegation"].join("-")}`
];
const MANIFEST_FIELDS = new Set([
  "$schema", "name", "version", "description", "author", "homepage",
  "repository", "license", "keywords", "extensions"
]);
const ALLOWED_TOP_LEVEL = new Set([
  ".agents", ".git", ".github", ".gitignore", ".npmignore", "CHANGELOG.md",
  "AGENTS.md", "CONTRIBUTING.md", "LICENSE", "NOTICE", "README.md", "README.zh-CN.md", "RELEASING.md", "SECURITY.md",
  "plugin.json", "package.json", "skills", "packages", "bin", "scripts",
  "test", "examples", "docs", "public-files.json", "support-matrix.json"
]);
const PRIVATE_NAMES = new Set(["openspec", "opendomain", ".pi", "auth.json", ".ds_store", "node_modules"]);
const SENSITIVE_EXTENSIONS = /\.(?:pem|key|p12|pfx|log|patch|diff|har)$/iu;
const ALLOWED_ACTIONS = new Set([
  "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
  "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020"
]);
const REVIEWED_WORKFLOW_SHA256 = "6ef860d3bf95bf059a1dcc5e9569cdc46fb277411ef7bef55447c9d3916d6533";
const SKILL_REFERENCES = [
  "agent-setup.md", "task-envelope.md", "executor-result.md",
  "correction-request.md", "scope-breach.md", "invocation.md", "context-planning.md"
];
const REQUIRED_PREVIEW_FILES = [
  "AGENTS.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "NOTICE",
  "README.md",
  "README.zh-CN.md",
  "RELEASING.md",
  "SECURITY.md",
  "docs/agent-quickstart.md",
  "docs/agent-quickstart.zh-CN.md",
  "docs/manual-configuration.md",
  "skills/relaypact/references/agent-setup.md",
  ".github/workflows/validate.yml"
];

async function pathExists(candidate) {
  try {
    await stat(candidate);
    return true;
  } catch {
    return false;
  }
}

async function walk(root, current = root, output = []) {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (entry.name === ".git" || (current === root && entry.name === "node_modules")) continue;
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute).replaceAll(path.sep, "/");
    output.push({ entry, absolute, relative });
    if (entry.isDirectory()) await walk(root, absolute, output);
  }
  return output;
}

function validateManifest(manifest, errors) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    errors.push("plugin.json must contain an object.");
    return;
  }
  if (manifest.$schema !== CANONICAL_SCHEMA) errors.push("plugin.json must target Agent Plugins 1.0.0.");
  if (manifest.name !== PROJECT_NAME) errors.push(`plugin.json name must remain ${PROJECT_NAME}.`);
  if (manifest.version !== PROJECT_VERSION) errors.push(`plugin.json version must remain ${PROJECT_VERSION}.`);
  if (manifest.homepage !== PROJECT_REPOSITORY || manifest.repository !== PROJECT_REPOSITORY) {
    errors.push(`plugin.json repository identities must remain ${PROJECT_REPOSITORY}.`);
  }
  if (manifest.license !== PROJECT_LICENSE) errors.push(`plugin.json license must be ${PROJECT_LICENSE}.`);
  if (typeof manifest.name !== "string" || !/^[a-z0-9](?!.*(?:--|\.\.))[a-z0-9.-]{0,62}[a-z0-9]$|^[a-z0-9]$/.test(manifest.name)) {
    errors.push("plugin.json name is invalid.");
  }
  const unknown = Object.keys(manifest).filter((key) => !MANIFEST_FIELDS.has(key));
  if (unknown.length > 0) errors.push(`plugin.json has unknown field(s): ${unknown.join(", ")}.`);
  if (manifest.author !== undefined) {
    if (!manifest.author || typeof manifest.author !== "object" || Array.isArray(manifest.author)) errors.push("plugin.json author must be an object.");
    else if (Object.keys(manifest.author).some((key) => !["name", "email", "url"].includes(key))) errors.push("plugin.json author has unknown fields.");
  }
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function readRequiredText(root, relative, errors) {
  try {
    return await readFile(path.join(root, ...relative.split("/")), "utf8");
  } catch {
    errors.push(`${relative} is required for public onboarding.`);
    return null;
  }
}

function requireText(text, fragments, relative, errors) {
  if (text === null) return;
  for (const fragment of fragments) {
    if (!text.includes(fragment)) errors.push(`${relative} must include ${JSON.stringify(fragment)}.`);
  }
}

function forbidText(text, fragments, relative, errors) {
  if (text === null) return;
  for (const fragment of fragments) {
    if (text.includes(fragment)) errors.push(`${relative} must not include ${JSON.stringify(fragment)}.`);
  }
}

async function validateProjectOnboarding(root, errors) {
  const files = Object.fromEntries(await Promise.all([
    "README.md",
    "README.zh-CN.md",
    "docs/agent-quickstart.md",
    "docs/agent-quickstart.zh-CN.md",
    "docs/manual-configuration.md",
    "skills/relaypact/SKILL.md",
    ...SKILL_REFERENCES.map((name) => `skills/relaypact/references/${name}`),
    "CONTRIBUTING.md",
    "RELEASING.md",
    "SECURITY.md",
    "CHANGELOG.md",
    "LICENSE",
    "NOTICE"
  ].map(async (relative) => [relative, await readRequiredText(root, relative, errors)])));

  const sharedReadmeFacts = [
    PROJECT_DISPLAY_NAME, PROJECT_REPOSITORY, PROJECT_MARKETPLACE,
    PROJECT_VERSION, "codex-codex", "public-preview", "Codex CLI 0.147.0",
    "Node.js 20", "Apache License 2.0", "SECURITY.md", "v0.1.2", "v0.1.1",
    "v0.1.0", "docs/manual-configuration.md", "codex exec --help", "doctor",
    "`completed` != `accept` != `apply`"
  ];
  requireText(files["README.md"], [
    ...sharedReadmeFacts,
    "[简体中文](README.zh-CN.md)",
    "docs/agent-quickstart.md",
    "$relaypact",
    "NOTICE",
    "No additional executor installation is required.",
    "not an independent", "cryptographic guarantee",
    "git clone --branch main --depth 1",
    "relaypactDeclaredInputBytes"
  ], "README.md", errors);
  requireText(files["README.zh-CN.md"], [
    ...sharedReadmeFacts,
    "[English](README.md)",
    "docs/agent-quickstart.zh-CN.md",
    "$relaypact",
    "NOTICE",
    "不需要额外安装 executor。",
    "不是独立的密码学保证",
    "git clone --branch main --depth 1",
    "relaypactDeclaredInputBytes"
  ], "README.zh-CN.md", errors);

  const sharedQuickStartFacts = [
    "$relaypact", "manual-configuration.md", "opencode-go-luna.md", "accept",
    "reject", "abandon", "Apache License 2.0", "codex exec", "doctor",
    PROJECT_VERSION, "v0.1.2", "v0.1.1", "patch", "commit SHA",
    "git clone --branch main --depth 1", "docs/relaypact-first-delegation.md",
    "`completed` != `accept` != `apply`", "relaypactDeclaredInputBytes"
  ];
  for (const relative of ["docs/agent-quickstart.md", "docs/agent-quickstart.zh-CN.md"]) {
    requireText(files[relative], sharedQuickStartFacts, relative, errors);
    forbidText(files[relative], ["run-pi"], relative, errors);
  }
  requireText(files["docs/agent-quickstart.md"], [
    "[简体中文](agent-quickstart.zh-CN.md)",
    "5-minute Codex-to-Codex getting started",
    "Pi is experimental and inactive",
    "quota or cost"
  ], "docs/agent-quickstart.md", errors);
  requireText(files["docs/agent-quickstart.zh-CN.md"], [
    "[English](agent-quickstart.md)",
    "5 分钟 Codex-to-Codex 开始指南",
    "Pi 是 experimental、inactive",
    "额度或费用"
  ], "docs/agent-quickstart.zh-CN.md", errors);

  // Check discovery and reference integrity here; Host behavior needs actual trials.
  // CLI prerequisites belong to conditional setup, not the shared Skill entry.
  requireText(files["skills/relaypact/SKILL.md"], [
    `name: ${PROJECT_SKILL}`, "# RelayPact",
    ...SKILL_REFERENCES.map((name) => `references/${name}`)
  ], "skills/relaypact/SKILL.md", errors);
  requireText(files["skills/relaypact/references/agent-setup.md"], [
    "support", "doctor", "codex exec", "readablePaths", "allowedPaths", "credential-free",
    "private", "fail-closed", "accept", "reject", "abandon"
  ], "skills/relaypact/references/agent-setup.md", errors);

  requireText(files["docs/manual-configuration.md"], [
    PROJECT_VERSION, "v0.1.2", "v0.1.1", "doctor", "needs_setup", "codex exec --help",
    "Release state and version verification", "git clone --branch main --depth 1",
    "Apply an accepted candidate separately", "Upgrade or replace an installation",
    "## Uninstall", "private archives", "additional tokens", "## Glossary",
    "not an independent cryptographic guarantee", "separate trusted channel",
    "git -C relaypact-v0.1.0 rev-parse 'v0.1.0^{}'",
    "`completed` != `accept` != `apply`", "relaypactDeclaredInputBytes"
  ], "docs/manual-configuration.md", errors);
  requireText(files["RELEASING.md"], [
    `${PROJECT_VERSION} release-time documentation closeout`, "PROJECT_RELEASE_STATE",
    "chasechou007", "human-approved release date", `v${PROJECT_VERSION}^{}`,
    "reviewed PR before creating the release tag"
  ], "RELEASING.md", errors);

  const candidateOnboardingFiles = [
    "README.md",
    "README.zh-CN.md",
    "docs/agent-quickstart.md",
    "docs/agent-quickstart.zh-CN.md",
    "docs/manual-configuration.md"
  ];
  const installVersion = PROJECT_RELEASE_STATE === "candidate" ? LATEST_PUBLISHED_VERSION : PROJECT_VERSION;
  for (const relative of candidateOnboardingFiles) {
    requireText(files[relative], [
      `git clone --branch v${installVersion}`,
      `git -C relaypact-v${installVersion} rev-parse 'v${installVersion}^{}'`,
      `https://github.com/echopath-labs/relaypact.git relaypact-v${installVersion}`,
      `git -C relaypact-v${installVersion} rev-parse HEAD`,
      `cd relaypact-v${installVersion}`,
      `if(p.version!=="${installVersion}"||q.version!==p.version) process.exit(1)`
    ], relative, errors);
  }
  if (PROJECT_RELEASE_STATE === "candidate") {
    requireText(files["README.md"], [`Latest published release: **v${installVersion}**`], "README.md", errors);
    requireText(files["README.zh-CN.md"], [`最新已发布版本：**v${installVersion}**`], "README.zh-CN.md", errors);
    for (const relative of candidateOnboardingFiles) {
      requireText(files[relative], [`${PROJECT_VERSION} Release source candidate`, `v${LATEST_PUBLISHED_VERSION}`], relative, errors);
      forbidText(files[relative], [
        `git clone --branch v${PROJECT_VERSION}`,
        `Latest published release: **v${PROJECT_VERSION}**`,
        `最新已发布版本：**v${PROJECT_VERSION}**`
      ], relative, errors);
    }
    requireText(files["README.md"], [
      `\`v${PROJECT_VERSION}\` is not released`
    ], "README.md", errors);
    requireText(files["README.zh-CN.md"], [
      `\`v${PROJECT_VERSION}\` 尚未发布`
    ], "README.zh-CN.md", errors);
    requireText(files["CHANGELOG.md"], [`## [${PROJECT_VERSION}] - Unreleased - Release`], "CHANGELOG.md", errors);
  } else if (PROJECT_RELEASE_STATE === "versioned") {
    requireText(files["README.md"], [`Release target: **v${PROJECT_VERSION}**`], "README.md", errors);
    requireText(files["README.zh-CN.md"], [`安装目标版本：**v${PROJECT_VERSION}**`], "README.zh-CN.md", errors);
    for (const relative of candidateOnboardingFiles) {
      const text = files[relative] ?? "";
      const installSections = text.split(/(?=^#{1,6} )/mu)
        .filter((section) => section.includes(`git clone --branch v${PROJECT_VERSION}`));
      if (installSections.length === 0 || installSections.some((section) => {
        const releaseGate = section.indexOf(`releases/tag/v${PROJECT_VERSION}`);
        return releaseGate < 0 || releaseGate > section.indexOf(`git clone --branch v${PROJECT_VERSION}`);
      })) {
        errors.push(`${relative} must put the Release availability precondition before installation commands in each install section.`);
      }
      if (/unreleased|not a published\s+release|does not include these candidate changes|not part of the v0\.3\.0 installation|only in reviewed source|尚未发布|尚未包含|不包含在下文安装|不包含这些候选改动/iu.test(text)) {
        errors.push(`${relative} must not retain candidate-only release status.`);
      }
      if (/latest published release|最新已发布版本/iu.test(files[relative] ?? "")) {
        errors.push(`${relative} must not claim the installation target is the latest published release.`);
      }
      forbidText(files[relative], [
        `Latest published release: **v${PROJECT_VERSION}**`,
        `最新已发布版本：**v${PROJECT_VERSION}**`,
        `latest published release is \`v${PROJECT_VERSION}\``,
        `\`v${PROJECT_VERSION}\` is the latest published release`,
        `\`v${PROJECT_VERSION}\` 是最新已发布版本`,
        `${PROJECT_VERSION} Release source candidate`,
        `\`v${PROJECT_VERSION}\` is not released`,
        `\`v${PROJECT_VERSION}\` 尚未发布`
      ], relative, errors);
    }
    requireText(files["CHANGELOG.md"], [
      `[${PROJECT_VERSION}]: https://github.com/echopath-labs/relaypact/compare/v${LATEST_PUBLISHED_VERSION}...v${PROJECT_VERSION}`
    ], "CHANGELOG.md", errors);
    const currentChangelog = (files["CHANGELOG.md"] ?? "").split(`## [${PROJECT_VERSION}]`)[1]?.split("\n## [")[0] ?? "";
    if (/unreleased|source candidate|latest published release remains|no v0\.3\.0 tag/iu.test(currentChangelog)) {
      errors.push("CHANGELOG.md must not retain candidate-only status in the current release section.");
    }
    requireText((files["SECURITY.md"] ?? "").replace(/\s+/gu, " "), [
      `releases/tag/v${PROJECT_VERSION}) is visible, that supported release remains v${LATEST_PUBLISHED_VERSION}.`,
      `Once v${PROJECT_VERSION} is published, support moves to the latest published \`0.3.x\` release.`
    ], "SECURITY.md", errors);
    const checklist = files["RELEASING.md"] ?? "";
    if (!/The checked-in metadata describes 0\.3\.0 Release, dated \d{4}-\d{2}-\d{2}\./u.test(checklist)
        || /The checked-in state is a 0\.3\.0 source candidate|is intentionally unset/u.test(checklist)) {
      errors.push("RELEASING.md must describe the dated versioned current state.");
    }
    const heading = files["CHANGELOG.md"]?.split("\n").find((line) => line.startsWith(`## [${PROJECT_VERSION}]`));
    if (!heading || !/^## \[[0-9.]+\] - \d{4}-\d{2}-\d{2} - Release$/u.test(heading)) {
      errors.push("CHANGELOG.md must include the dated Release heading.");
    }
    const changelogDate = heading?.match(/ - (\d{4}-\d{2}-\d{2}) - Release$/u)?.[1];
    const checklistDate = checklist.match(/The checked-in metadata describes 0\.3\.0 Release, dated (\d{4}-\d{2}-\d{2})\./u)?.[1];
    if (changelogDate && checklistDate && changelogDate !== checklistDate) {
      errors.push("RELEASING.md and CHANGELOG.md release dates must agree.");
    }
  } else {
    errors.push("scripts/validate-package.mjs PROJECT_RELEASE_STATE must be candidate or versioned.");
  }

  requireText(files["CONTRIBUTING.md"], [PROJECT_LICENSE, "Section 5"], "CONTRIBUTING.md", errors);
  requireText(files["RELEASING.md"], [PROJECT_LICENSE, "NOTICE"], "RELEASING.md", errors);
  if (files.LICENSE !== null && sha256(files.LICENSE) !== REVIEWED_LICENSE_SHA256) {
    errors.push("LICENSE bytes must exactly match the reviewed Apache License 2.0 text.");
  }
  if (files.NOTICE !== null && sha256(files.NOTICE) !== REVIEWED_NOTICE_SHA256) {
    errors.push("NOTICE bytes must exactly match the reviewed EchoPath Labs attribution.");
  }

  try {
    const packageManifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    if (packageManifest.name !== PROJECT_NAME) errors.push(`package.json name must be ${PROJECT_NAME}.`);
    if (packageManifest.version !== PROJECT_VERSION) errors.push(`package.json version must be ${PROJECT_VERSION}.`);
    if (packageManifest.license !== PROJECT_LICENSE) errors.push(`package.json license must be ${PROJECT_LICENSE}.`);
    if (packageManifest.bin?.[PROJECT_NAME] !== "./bin/relaypact.mjs" || Object.keys(packageManifest.bin ?? {}).length !== 1) {
      errors.push("package.json must expose only the canonical relaypact CLI binary.");
    }
  } catch (error) {
    errors.push(`package.json is missing or invalid JSON: ${error.message}`);
  }
}

async function validateMarkdownLinks(root, entries, errors) {
  for (const item of entries.filter((entry) => entry.entry.isFile() && entry.relative.endsWith(".md"))) {
    const text = await readFile(item.absolute, "utf8");
    for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/gu)) {
      let reference = match[1].trim().replace(/^<|>$/gu, "");
      if (/^(?:https?:|mailto:|#)/iu.test(reference)) continue;
      reference = reference.split("#", 1)[0].split("?", 1)[0];
      if (reference.length === 0) continue;
      try {
        reference = decodeURIComponent(reference);
      } catch {
        errors.push(`Malformed relative Markdown link in ${item.relative}: ${match[1]}.`);
        continue;
      }
      const target = path.resolve(path.dirname(item.absolute), reference);
      const relativeTarget = path.relative(root, target);
      if (relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget) || !(await pathExists(target))) {
        errors.push(`Broken or escaping relative Markdown link in ${item.relative}: ${match[1]}.`);
      }
    }
  }
}

async function validatePreviewFiles(root, errors) {
  for (const relative of REQUIRED_PREVIEW_FILES) {
    if (!(await pathExists(path.join(root, ...relative.split("/"))))) {
      errors.push(`${relative} is required for public preview.`);
    }
  }

  const workflowPath = path.join(root, ".github", "workflows", "validate.yml");
  const workflowRoot = path.dirname(workflowPath);
  if (await pathExists(workflowRoot)) {
    const workflows = (await readdir(workflowRoot)).sort();
    if (workflows.length !== 1 || workflows[0] !== "validate.yml") {
      errors.push("Public preview must contain only .github/workflows/validate.yml.");
    }
  }
  if (!(await pathExists(workflowPath))) return;
  const workflow = await readFile(workflowPath, "utf8");
  const workflowSha256 = createHash("sha256").update(workflow).digest("hex");
  if (workflowSha256 !== REVIEWED_WORKFLOW_SHA256) {
    errors.push("CI workflow bytes must exactly match the reviewed public-preview workflow.");
  }
  const requiredPatterns = [
    [/^permissions:\s*\n\s+contents:\s*read\s*$/m, "CI must grant only read access to repository contents."],
    [/uses:\s*actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\b/, "CI must pin the reviewed checkout v7 commit."],
    [/uses:\s*actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020\b/, "CI must pin the reviewed setup-node v7 commit."],
    [/node-version:\s*20\.20\.2\b/, "CI must use the verified Node.js 20 baseline."],
    [/package-manager-cache:\s*false\b/, "CI must disable unused automatic package-manager caching."],
    [/run:\s*npm run check\b/, "CI must run the deterministic package checks."],
    [/run:\s*npm pack --dry-run --json\b/, "CI must inspect the package dry-run."],
  ];
  for (const [pattern, message] of requiredPatterns) {
    if (!pattern.test(workflow)) errors.push(message);
  }
  if (/\bpull_request_target\s*:/u.test(workflow)) {
    errors.push("CI must not run public-preview validation with pull_request_target.");
  }
  if (/\bsecrets\s*\./u.test(workflow)) {
    errors.push("CI validation must not require repository secrets.");
  }
  const actionReferences = [...workflow.matchAll(/\buses:\s*([^\s#]+)/gu)].map((match) => match[1]);
  for (const reference of actionReferences) {
    if (!ALLOWED_ACTIONS.has(reference)) errors.push(`CI action is not on the reviewed exact allowlist: ${reference}.`);
  }
  if (/\bwrite-all\b|^\s*[A-Za-z_-]+:\s*write\s*$/mu.test(workflow)) {
    errors.push("CI validation must not grant write permissions.");
  }
}

export async function validatePackage(root) {
  const errors = [];
  const resolvedRoot = await realpath(root);
  let manifest;
  let publicFiles;
  try {
    manifest = JSON.parse(await readFile(path.join(resolvedRoot, "plugin.json"), "utf8"));
  } catch (error) {
    errors.push(`plugin.json is missing or invalid JSON: ${error.message}`);
  }
  if (manifest) validateManifest(manifest, errors);
  try {
    const publicManifest = JSON.parse(await readFile(path.join(resolvedRoot, "public-files.json"), "utf8"));
    publicFiles = publicManifest?.files;
    if (
      publicManifest?.schemaVersion !== "1.0.0" ||
      !Array.isArray(publicFiles) ||
      publicFiles.some((item) => typeof item !== "string" || item.length === 0 || item.startsWith("/") || item.includes("\\") || item.split("/").includes("..")) ||
      JSON.stringify(publicFiles) !== JSON.stringify([...new Set(publicFiles)].sort())
    ) {
      throw new Error("manifest must contain one sorted unique normalized file list");
    }
  } catch (error) {
    errors.push(`public-files.json is missing or invalid: ${error.message}`);
  }
  await validatePreviewFiles(resolvedRoot, errors);
  await validateProjectOnboarding(resolvedRoot, errors);

  try {
    const marketplace = JSON.parse(await readFile(path.join(resolvedRoot, ".agents", "plugins", "marketplace.json"), "utf8"));
    const entry = Array.isArray(marketplace.plugins)
      ? marketplace.plugins.find((item) => item?.name === manifest?.name)
      : null;
    if (marketplace.name !== PROJECT_MARKETPLACE) {
      errors.push(`Local marketplace name must remain ${PROJECT_MARKETPLACE}.`);
    }
    if (marketplace.interface?.displayName !== PROJECT_DISPLAY_NAME) {
      errors.push(`Local marketplace display name must remain ${PROJECT_DISPLAY_NAME}.`);
    }
    if (!entry || entry.source?.source !== "local" || entry.source?.path !== ".") {
      errors.push("Local marketplace must expose the root plugin by its manifest name.");
    }
  } catch (error) {
    errors.push(`.agents/plugins/marketplace.json is missing or invalid JSON: ${error.message}`);
  }

  const entries = await walk(resolvedRoot);
  await validateMarkdownLinks(resolvedRoot, entries, errors);
  for (const item of entries) {
    const normalizedPath = item.relative.toLowerCase();
    if (FORMER_IDENTITY_VALUES.some((value) => normalizedPath.includes(value))) {
      errors.push(`Former public identity is not allowed in path ${item.relative}.`);
    }
    if (item.entry.isFile() && /\.(?:md|json|mjs|js|txt|ya?ml)$/iu.test(item.relative)) {
      const text = (await readFile(item.absolute, "utf8")).toLowerCase();
      if (FORMER_IDENTITY_VALUES.some((value) => text.includes(value))) {
        errors.push(`Former public identity is not allowed in ${item.relative}.`);
      }
    }
  }
  if (publicFiles) {
    const actualFiles = entries
      .filter((item) => item.entry.isFile())
      .map((item) => item.relative)
      .sort();
    if (JSON.stringify(actualFiles) !== JSON.stringify(publicFiles)) {
      const expected = new Set(publicFiles);
      const actual = new Set(actualFiles);
      const extra = actualFiles.filter((item) => !expected.has(item));
      const missing = publicFiles.filter((item) => !actual.has(item));
      errors.push(`Public file manifest mismatch; extra: ${extra.join(", ") || "none"}; missing: ${missing.join(", ") || "none"}.`);
    }
  }
  const manifests = entries.filter((item) => item.entry.isFile() && item.entry.name === "plugin.json");
  if (manifests.length !== 1 || manifests[0]?.relative !== "plugin.json") {
    errors.push("The package must contain exactly one plugin.json at its root.");
  }
  if (await pathExists(path.join(resolvedRoot, ".codex-plugin", "plugin.json"))) {
    errors.push(".codex-plugin/plugin.json is not allowed.");
  }

  const topLevel = await readdir(resolvedRoot);
  const unexpected = topLevel.filter((name) => !ALLOWED_TOP_LEVEL.has(name));
  if (unexpected.length > 0) errors.push(`Unexpected top-level path(s): ${unexpected.join(", ")}.`);

  const skillsRoot = path.join(resolvedRoot, "skills");
  if (!(await pathExists(skillsRoot))) errors.push("skills/ is missing.");
  else {
    const skills = (await readdir(skillsRoot, { withFileTypes: true })).filter((item) => item.isDirectory());
    if (skills.length === 0) errors.push("skills/ must contain at least one immediate skill directory.");
    for (const skill of skills) {
      const skillFile = path.join(skillsRoot, skill.name, "SKILL.md");
      if (!(await pathExists(skillFile))) errors.push(`skills/${skill.name}/SKILL.md is missing.`);
      if (skill.name === PROJECT_SKILL) {
        const wrapper = path.join(skillsRoot, skill.name, "scripts", "relaypact.mjs");
        if (!(await pathExists(wrapper))) errors.push("The Codex delegation Skill-local wrapper is missing.");
        else if (((await stat(wrapper)).mode & 0o111) === 0) errors.push("The Codex delegation Skill-local wrapper must be executable.");
      }
    }
    if (!skills.some((skill) => skill.name === PROJECT_SKILL)) errors.push("The canonical RelayPact Skill is missing.");
  }

  for (const item of entries) {
    if (item.entry.isSymbolicLink()) {
      errors.push(`Symbolic links are not allowed in the public package: ${item.relative}.`);
    }
    if (item.relative.split("/").some((part) => PRIVATE_NAMES.has(part.toLowerCase()))) {
      errors.push(`Private or generated path is not allowed: ${item.relative}.`);
    }
    if (item.entry.isFile() && SENSITIVE_EXTENSIONS.test(item.relative)) {
      errors.push(`Sensitive artifact type is not allowed: ${item.relative}.`);
    }
    if (item.entry.isFile() && /(^|\/)\.env(?:\.|$)/.test(item.relative)) {
      errors.push(`Environment file is not allowed: ${item.relative}.`);
    }
    if (item.entry.isFile() && /\.(?:md|json|mjs|js|txt|ya?ml)$/i.test(item.relative)) {
      const text = await readFile(item.absolute, "utf8");
      if (/\/Users\/[A-Za-z0-9._-]+\//.test(text) || /[A-Za-z]:\\Users\\[^\\]+\\/.test(text)) {
        errors.push(`User-specific absolute path found in ${item.relative}.`);
      }
    }
  }

  for (const contract of [
    "adapter-support-matrix.schema.json",
    "task-envelope.schema.json",
    "context-manifest.schema.json",
    "execution-result.schema.json",
    "codex-worker-result.schema.json",
    "host-review-packet.schema.json"
  ]) {
    try {
      JSON.parse(await readFile(path.join(resolvedRoot, "packages", "contracts", "schemas", contract), "utf8"));
    } catch (error) {
      errors.push(`packages/contracts/schemas/${contract} is missing or invalid JSON: ${error.message}`);
    }
  }

  return errors;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const errors = await validatePackage(root);
  if (errors.length > 0) {
    process.stderr.write(`${errors.map((item) => `- ${item}`).join("\n")}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write("Package validation passed.\n");
  }
}
