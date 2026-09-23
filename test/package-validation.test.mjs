import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validatePackage } from "../scripts/validate-package.mjs";
import { validateArchitecture } from "../scripts/validate-architecture.mjs";
import { makeMinimalPlugin } from "./helpers.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const validManifest = {
  $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  name: "fixture-plugin"
};

async function copyCurrentPublicPackage() {
  const root = await mkdtemp(path.join(os.tmpdir(), "relaypact-public-package-"));
  const manifest = JSON.parse(await readFile(path.join(packageRoot, "public-files.json"), "utf8"));
  for (const relative of manifest.files) {
    const source = path.join(packageRoot, ...relative.split("/"));
    const destination = path.join(root, ...relative.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(source, destination);
  }
  return root;
}

test("current package layout is valid", async () => {
  assert.deepEqual(await validatePackage(packageRoot), []);
});

test("current monorepo ownership and support matrix are valid", async () => {
  assert.deepEqual(await validateArchitecture(packageRoot), []);
});

test("Skill package integrity allows a shared entry and requires its operational references", async (t) => {
  const root = await copyCurrentPublicPackage();
  t.after(() => rm(root, { recursive: true, force: true }));
  const referenceDirectory = path.join(root, "skills", "relaypact", "references");
  const inventory = JSON.parse(await readFile(path.join(root, "public-files.json"), "utf8"));
  const references = inventory.files
    .filter((relative) => relative.startsWith("skills/relaypact/references/"))
    .map((relative) => path.basename(relative));
  // A structural validator must not grade prose or require CLI vocabulary in
  // the shared entry. The actual Host guidance is evaluated separately.
  await writeFile(path.join(root, "skills", "relaypact", "SKILL.md"), [
    "---", "name: relaypact", "description: Shared delegation guidance.", "---",
    "# RelayPact", "",
    ...references.map((name) => `[${name}](references/${name})`), ""
  ].join("\n"));
  assert.deepEqual(await validatePackage(root), []);

  await rm(path.join(referenceDirectory, "invocation.md"));
  // Removing it from the inventory must not hide a missing operational guide.
  inventory.files = inventory.files.filter((relative) => !relative.endsWith("references/invocation.md"));
  await writeFile(path.join(root, "public-files.json"), `${JSON.stringify(inventory, null, 2)}\n`);
  const errors = await validatePackage(root);
  assert(errors.some((item) => item.includes("references/invocation.md is required")));
  assert(errors.some((item) => item.includes("invocation.md") && item.includes("link")));
});

test("public package rejects Apache-2.0 license drift", async () => {
  const root = await copyCurrentPublicPackage();
  const packageManifestPath = path.join(root, "package.json");
  const packageManifest = JSON.parse(await readFile(packageManifestPath, "utf8"));
  packageManifest.license = "MIT";
  await writeFile(packageManifestPath, `${JSON.stringify(packageManifest, null, 2)}\n`);
  const pluginManifestPath = path.join(root, "plugin.json");
  const pluginManifest = JSON.parse(await readFile(pluginManifestPath, "utf8"));
  pluginManifest.license = "MIT";
  await writeFile(pluginManifestPath, `${JSON.stringify(pluginManifest, null, 2)}\n`);
  await writeFile(path.join(root, "LICENSE"), `${await readFile(path.join(root, "LICENSE"), "utf8")}altered\n`);
  const errors = await validatePackage(root);
  assert(errors.some((item) => item.includes("plugin.json license must be Apache-2.0")));
  assert(errors.some((item) => item.includes("package.json license must be Apache-2.0")));
  assert(errors.some((item) => item.includes("LICENSE bytes must exactly match")));
  await rm(root, { recursive: true });
});

test("public package rejects bilingual onboarding and relative-link drift", async () => {
  const root = await copyCurrentPublicPackage();
  const englishPath = path.join(root, "README.md");
  const english = (await readFile(englishPath, "utf8"))
    .replace("[简体中文](README.zh-CN.md)", "简体中文")
    .concat("\n[missing guide](docs/missing-guide.md)\n");
  await writeFile(englishPath, english);
  const chinesePath = path.join(root, "README.zh-CN.md");
  await writeFile(
    chinesePath,
    (await readFile(chinesePath, "utf8")).replace("Apache License 2.0", "Apache license")
  );
  const errors = await validatePackage(root);
  assert(errors.some((item) => item.includes("README.md must include \"[简体中文](README.zh-CN.md)\"")));
  assert(errors.some((item) => item.includes("README.zh-CN.md must include \"Apache License 2.0\"")));
  assert(errors.some((item) => item.includes("Broken or escaping relative Markdown link in README.md")));
  await rm(root, { recursive: true });
});

test("public package rejects first-use readiness and lifecycle guidance drift", async () => {
  const root = await copyCurrentPublicPackage();
  const englishPath = path.join(root, "README.md");
  await writeFile(
    englishPath,
    (await readFile(englishPath, "utf8"))
      .replaceAll("codex exec --help", "executor help")
      .replaceAll("No additional executor installation is required.", "No other worker setup is required.")
      .replaceAll("not an independent", "an immutable")
      .replaceAll("`completed` != `accept` != `apply`", "completion includes acceptance and apply")
  );
  const quickStartPath = path.join(root, "docs", "agent-quickstart.md");
  await writeFile(
    quickStartPath,
    (await readFile(quickStartPath, "utf8")).replaceAll("v0.1.1", "the latest branch")
  );
  const manualPath = path.join(root, "docs", "manual-configuration.md");
  await writeFile(
    manualPath,
    (await readFile(manualPath, "utf8"))
      .replace("## Uninstall", "## Remove locally")
      .replace("## Glossary", "## Terms")
  );
  const errors = await validatePackage(root);
  assert(errors.some((item) => item.includes("README.md must include \"codex exec --help\"")));
  assert(errors.some((item) => item.includes("README.md must include \"No additional executor installation is required.\"")));
  assert(errors.some((item) => item.includes("README.md must include \"not an independent\"")));
  assert(errors.some((item) => item.includes("README.md must include \"\`completed\` != \`accept\` != \`apply\`\"")));
  assert(errors.some((item) => item.includes("docs/agent-quickstart.md must include \"v0.1.1\"")));
  assert(errors.some((item) => item.includes("docs/manual-configuration.md must include \"## Uninstall\"")));
  assert(errors.some((item) => item.includes("docs/manual-configuration.md must include \"## Glossary\"")));
  await rm(root, { recursive: true });
});

test("public package rejects published-install tag verification and metric guidance drift", async () => {
  const root = await copyCurrentPublicPackage();
  for (const relative of [
    "README.md",
    "README.zh-CN.md",
    "docs/agent-quickstart.md",
    "docs/agent-quickstart.zh-CN.md",
    "docs/manual-configuration.md"
  ]) {
    const target = path.join(root, ...relative.split("/"));
    await writeFile(
      target,
      (await readFile(target, "utf8"))
        .replaceAll("git clone --branch v0.3.5", "git clone --branch release")
        .replaceAll("v0.3.5^{}", "v0.3.5")
        .replaceAll("relaypactDeclaredInputBytes", "declared bytes")
    );
  }
  const readme = path.join(root, "README.md");
  await writeFile(
    readme,
    (await readFile(readme, "utf8")).replace("Release target: **v0.3.5**", "Latest published release: **v0.1.1**")
  );
  const errors = await validatePackage(root);
  assert(errors.some((item) => item.includes("README.md must include \"git clone --branch v0.3.5\"")));
  assert(errors.some((item) => item.startsWith("README.md must include") && item.includes("git -C relaypact-v0.3.5 rev-parse") && item.includes("v0.3.5^{}")));
  assert(errors.some((item) => item.includes("README.md must include \"Release target: **v0.3.5**\"")));
  assert(errors.some((item) => item.includes("README.zh-CN.md must include \"relaypactDeclaredInputBytes\"")));
  assert(errors.some((item) => item.includes("docs/manual-configuration.md must include \"relaypactDeclaredInputBytes\"")));
  await rm(root, { recursive: true });
});

// Retain candidate-state coverage after the public source becomes released.
async function copyCandidatePackage(t) {
  const root = await copyCurrentPublicPackage();
  t.after(() => rm(root, { recursive: true, force: true }));
  const validator = path.join(root, "scripts/validate-package.mjs");
  await writeFile(validator, (await readFile(validator, "utf8")).replace('const PROJECT_RELEASE_STATE = "versioned";', 'const PROJECT_RELEASE_STATE = "candidate";'));
  for (const file of ["README.md", "README.zh-CN.md", "docs/agent-quickstart.md", "docs/agent-quickstart.zh-CN.md", "docs/manual-configuration.md"]) {
    const target = path.join(root, file);
    const text = (await readFile(target, "utf8"))
      .replaceAll("0.3.5", "0.3.4")
      .replace("Release target: **v0.3.4**", "Latest published release: **v0.3.4**")
      .replace("安装目标版本：**v0.3.4**", "最新已发布版本：**v0.3.4**");
    await writeFile(target, text + '\n0.3.5 Release source candidate\n`v0.3.5` is not released\n`v0.3.5` 尚未发布\n');
  }
  const changelog = path.join(root, "CHANGELOG.md");
  await writeFile(changelog, (await readFile(changelog, "utf8")).replace("## [0.3.5] - 2026-09-22 - Release", "## [0.3.5] - Unreleased - Release"));
  const { validatePackage: validateCandidate } = await import(pathToFileURL(validator).href);
  assert.deepEqual(await validateCandidate(root), []);
  return { root, validateCandidate };
}

test("candidate rejects premature release claims and installation in either language", async (t) => {
  const { root, validateCandidate } = await copyCandidatePackage(t);
  for (const [file, claim] of [
    ["README.md", "Latest published release: **v0.3.5**"],
    ["README.zh-CN.md", "最新已发布版本：**v0.3.5**"]
  ]) {
    const target = path.join(root, file);
    await writeFile(target, `${await readFile(target, "utf8")}\n${claim}\ngit clone --branch v0.3.5\n`);
  }
  const errors = await validateCandidate(root);
  for (const file of ["README.md", "README.zh-CN.md"]) {
    assert(errors.some((item) => item.startsWith(`${file} must not include`) && item.includes("v0.3.5")));
    assert(errors.some((item) => item.startsWith(`${file} must not include`) && item.includes("git clone --branch")));
  }
});

test("candidate rejects stale versioned status and missing unreleased changelog", async (t) => {
  const { root, validateCandidate } = await copyCandidatePackage(t);
  const guide = path.join(root, "docs/agent-quickstart.zh-CN.md");
  await writeFile(guide, (await readFile(guide, "utf8")).replace("0.3.5 Release source candidate", "0.3.4 Release source candidate"));
  const changelog = path.join(root, "CHANGELOG.md");
  await writeFile(changelog, (await readFile(changelog, "utf8")).replace("## [0.3.5] - Unreleased - Release", "## [0.3.5] - 2026-01-01 - Release"));
  const errors = await validateCandidate(root);
  assert(errors.some((item) => item.startsWith("docs/agent-quickstart.zh-CN.md must include") && item.includes("0.3.5 Release source candidate")));
  assert(errors.some((item) => item.startsWith("CHANGELOG.md must include") && item.includes("Unreleased")));
});

test("versioned documentation requires complete install identity without publication claims", async (t) => {
  const root = await copyCurrentPublicPackage();
  t.after(() => rm(root, { recursive: true, force: true }));
  const comparisonLink = "[0.3.5]: https://github.com/echopath-labs/relaypact/compare/v0.3.4...v0.3.5";
  const linkChangelog = path.join(root, "CHANGELOG.md");
  const datedChangelog = (await readFile(linkChangelog, "utf8")).replace(comparisonLink, "");
  await writeFile(linkChangelog, `${datedChangelog}\n${comparisonLink}\n`);
  assert.deepEqual(await validatePackage(root), []);
  for (const invalidLink of ["", comparisonLink.replace("v0.3.4...", "v0.1.1...")]) {
    await writeFile(linkChangelog, `${datedChangelog}\n${invalidLink}\n`);
    assert((await validatePackage(root)).some((item) => item.startsWith("CHANGELOG.md must include") && item.includes("compare/v0.3.4...v0.3.5")));
  }
  await writeFile(linkChangelog, `${datedChangelog}\n${comparisonLink}\n`);
  for (const [file, claim] of [
    ["README.md", "Install the latest published release"],
    ["docs/manual-configuration.md", "Install and verify the latest published release:"],
    ["README.zh-CN.md", "安装最新已发布版本"]
  ]) {
    const target = path.join(root, file);
    const valid = await readFile(target, "utf8");
    await writeFile(target, `${valid}\n${claim}\n`);
    assert((await validatePackage(root)).some((item) => item === `${file} must not claim the installation target is the latest published release.`));
    await writeFile(target, valid);
  }
  for (const file of ["README.md", "README.zh-CN.md", "docs/agent-quickstart.md", "docs/agent-quickstart.zh-CN.md", "docs/manual-configuration.md"]) {
    const target = path.join(root, file);
    const valid = await readFile(target, "utf8");
    const releaseUrl = "https://github.com/echopath-labs/relaypact/releases/tag/v0.3.5";
    const sections = valid.split(/(?=^#{1,6} )/mu);
    for (let index = 0; index < sections.length; index += 1) {
      if (!sections[index].includes("git clone --branch v0.3.5")) continue;
      const altered = [...sections];
      altered[index] = altered[index].replaceAll(releaseUrl, "(release link moved)") + `\nCheck ${releaseUrl} before installation.\n`;
      await writeFile(target, altered.join(""));
      assert((await validatePackage(root)).some((item) => item === `${file} must put the Release availability precondition before installation commands in each install section.`));
    }
    await writeFile(target, valid + "\nThis checkout is not a published release.\n");
    assert((await validatePackage(root)).some((item) => item === `${file} must not retain candidate-only release status.`));
    await writeFile(target, valid);
  }
  for (const [file, from, to, expected] of [
    ["CHANGELOG.md", "## [0.3.5] - 2026-09-22 - Release", "## [0.3.5] - 2026-09-22 - Release\n\nThis is an unreleased source candidate.", "CHANGELOG.md must not retain candidate-only status"],
    ["RELEASING.md", "The checked-in metadata describes 0.3.5 Release, dated 2026-09-22.", "The checked-in state is a 0.3.5 source candidate. The release date is intentionally unset.", "RELEASING.md must describe the dated versioned current state."]
  ]) {
    const target = path.join(root, file);
    const valid = await readFile(target, "utf8");
    await writeFile(target, valid.replace(from, to));
    assert((await validatePackage(root)).some((item) => item.startsWith(expected)));
    await writeFile(target, valid);
  }
  const checklist = path.join(root, "RELEASING.md");
  const validChecklist = await readFile(checklist, "utf8");
  await writeFile(checklist, validChecklist.replace("dated 2026-09-22.", "dated 2026-09-15."));
  assert((await validatePackage(root)).includes("RELEASING.md and CHANGELOG.md release dates must agree."));
  await writeFile(checklist, validChecklist);
  const security = path.join(root, "SECURITY.md");
  const validSecurity = await readFile(security, "utf8");
  for (const policy of [
    "Security fixes apply only to the latest published `0.1.x` release.",
    "Security fixes apply only to the latest published `0.2.x` release. Older previews are unsupported."
  ]) {
    await writeFile(security, validSecurity.replace(/## Supported Versions[\s\S]*?(?=## Reporting)/u, `## Supported Versions\n\n${policy}\n\n`));
    assert((await validatePackage(root)).some((item) => item.startsWith("SECURITY.md must include")));
  }
  await writeFile(security, validSecurity);
  const manual = path.join(root, "docs/manual-configuration.md");
  const validManual = await readFile(manual, "utf8");
  for (const [from, to, expected] of [
    ['p.version!=="0.3.5"', 'p.version!=="0.3.4"', 'if(p.version'],
    ['cd relaypact-v0.3.5', 'cd relaypact-v0.3.4', 'cd relaypact-v0.3.5'],
    ["git -C relaypact-v0.3.5 rev-parse 'v0.3.5^{}'", "git -C relaypact-v0.3.4 rev-parse 'v0.3.5^{}'", "git -C relaypact-v0.3.5 rev-parse 'v0.3.5^{}'"]
  ]) {
    await writeFile(manual, validManual.replaceAll(from, to));
    const errors = await validatePackage(root);
    assert(errors.some((item) => item.startsWith("docs/manual-configuration.md must include") && item.includes(expected)));
  }
  await writeFile(manual, validManual);
  const changelog = path.join(root, "CHANGELOG.md");
  await writeFile(changelog, (await readFile(changelog, "utf8")).replace("## [0.3.5] - 2026-09-22 - Release", "## [0.3.5] - Unreleased - Release"));
  const chinese = path.join(root, "README.zh-CN.md");
  await writeFile(chinese, (await readFile(chinese, "utf8")).replace("安装目标版本：**v0.3.5**", "最新已发布版本：**v0.3.5**"));
  const errors = await validatePackage(root);
  assert(errors.some((item) => item.includes("dated Release heading")));
  assert(errors.some((item) => item.startsWith("README.zh-CN.md must not include") && item.includes("v0.3.5")));
});

test("public package rejects Pi promotion into the Codex-only first path", async () => {
  const root = await copyCurrentPublicPackage();
  const quickStartPath = path.join(root, "docs", "agent-quickstart.md");
  await writeFile(
    quickStartPath,
    (await readFile(quickStartPath, "utf8"))
      .replace("Pi is experimental and inactive", "Pi is required for first use")
      .concat("\nRun \`run-pi\` as a fallback.\n")
  );
  const errors = await validatePackage(root);
  assert(errors.some((item) => item.includes("docs/agent-quickstart.md must include \"Pi is experimental and inactive\"")));
  assert(errors.some((item) => item.includes("docs/agent-quickstart.md must not include \"run-pi\"")));
  await rm(root, { recursive: true });
});

test("public package rejects every former public identity family", async () => {
  const root = await copyCurrentPublicPackage();
  const formerIdentities = [
    ["agent", "delegation", "kit"].join("-"),
    ["agent", "delegation", "kit"].join("_"),
    ["agent", "delegation", "kit"].join(" "),
    ["codex", "delegated", "execution"].join("-"),
    ["A", "D", "K", "_"].join(""),
    ["a", "d", "k", "-"].join(""),
    `.${["agent", "delegation"].join("-")}`
  ];
  const readme = path.join(root, "README.md");
  await writeFile(readme, `${await readFile(readme, "utf8")}\n${formerIdentities.join("\n")}\n`);
  const errors = await validatePackage(root);
  assert(errors.some((item) => item.includes("Former public identity is not allowed in README.md")));
  await rm(root, { recursive: true });
});

test("public package rejects local diagnostic and private process leakage", async () => {
  const root = await copyCurrentPublicPackage();
  await writeFile(path.join(root, "docs", "local-doctor-output.md"), [
    "# Local output",
    `Executable: ${["", "Users", "example", "private-tools", "codex"].join("/")}`,
    `${["PRIVATE", "NOTE"].join(" ")}: copied from acceptance evidence`,
    ""
  ].join("\n"));
  const errors = await validatePackage(root);
  assert(errors.some((item) => item.includes("Public file manifest mismatch")));
  assert(errors.some((item) => item.includes("User-specific absolute path")));
  await rm(root, { recursive: true });
});

test("architecture validation rejects Codex-to-Pi coupling", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "relaypact-architecture-"));
  await cp(path.join(packageRoot, "packages"), path.join(root, "packages"), { recursive: true });
  await cp(path.join(packageRoot, "package.json"), path.join(root, "package.json"));
  await cp(path.join(packageRoot, "support-matrix.json"), path.join(root, "support-matrix.json"));
  const target = path.join(root, "packages", "executor-codex", "src", "forbidden.mjs");
  await writeFile(target, "import '../../executor-pi/src/executor.mjs';\n");
  const errors = await validateArchitecture(root);
  assert(errors.some((item) => item.includes("couples the Codex route")));
  await rm(root, { recursive: true });
});

test("architecture validation rejects workspace package version drift", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "relaypact-architecture-"));
  await cp(path.join(packageRoot, "packages"), path.join(root, "packages"), { recursive: true });
  await cp(path.join(packageRoot, "package.json"), path.join(root, "package.json"));
  await cp(path.join(packageRoot, "support-matrix.json"), path.join(root, "support-matrix.json"));
  const manifestPath = path.join(root, "packages", "executor-pi", "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.version = "0.1.0";
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const errors = await validateArchitecture(root);
  assert(errors.some((item) => item.includes("packages/executor-pi version must match the monorepo root version")));
  await rm(root, { recursive: true });
});

test("architecture validation rejects unowned and computed imports", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "relaypact-architecture-"));
  await cp(path.join(packageRoot, "packages"), path.join(root, "packages"), { recursive: true });
  await cp(path.join(packageRoot, "package.json"), path.join(root, "package.json"));
  await cp(path.join(packageRoot, "support-matrix.json"), path.join(root, "support-matrix.json"));
  const sourceRoot = path.join(root, "packages", "executor-codex", "src");
  await writeFile(path.join(sourceRoot, "computed.mjs"), "const target='./worker.mjs'; import(target);\n");
  await writeFile(path.join(sourceRoot, "external.mjs"), "import 'third-party-package';\n");
  await writeFile(path.join(sourceRoot, "escaped.mjs"), "import '../../../outside.mjs';\n");
  const errors = await validateArchitecture(root);
  assert(errors.some((item) => item.includes("non-literal dynamic import")));
  assert(errors.some((item) => item.includes("undeclared external specifier")));
  assert(errors.some((item) => item.includes("outside the package ownership tree")));
  await rm(root, { recursive: true });
});

test("architecture validation rejects support status drift", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "relaypact-architecture-"));
  await cp(path.join(packageRoot, "packages"), path.join(root, "packages"), { recursive: true });
  await cp(path.join(packageRoot, "package.json"), path.join(root, "package.json"));
  const matrix = JSON.parse(await readFile(path.join(packageRoot, "support-matrix.json"), "utf8"));
  matrix.routes[1].status = "public-preview";
  await writeFile(path.join(root, "support-matrix.json"), JSON.stringify(matrix));
  const errors = await validateArchitecture(root);
  assert(errors.some((item) => item.includes("codex-pi has unexpected status")));
  await rm(root, { recursive: true });
});

test("architecture validation rejects cross-harness Cursor executor imports", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "relaypact-architecture-"));
  await cp(path.join(packageRoot, "packages"), path.join(root, "packages"), { recursive: true });
  await cp(path.join(packageRoot, "package.json"), path.join(root, "package.json"));
  await cp(path.join(packageRoot, "support-matrix.json"), path.join(root, "support-matrix.json"));
  await writeFile(
    path.join(root, "packages", "adapter-codex-cursor", "src", "coupled.mjs"),
    "import '../../executor-pi/src/executor.mjs';\n"
  );
  const errors = await validateArchitecture(root);
  assert(errors.some((item) => item.includes("couples the cursor route to executor-pi")));
  await rm(root, { recursive: true });
});

test("architecture validation rejects Cursor terminal governance outside host-codex", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "relaypact-architecture-"));
  await cp(path.join(packageRoot, "packages"), path.join(root, "packages"), { recursive: true });
  await cp(path.join(packageRoot, "package.json"), path.join(root, "package.json"));
  await cp(path.join(packageRoot, "support-matrix.json"), path.join(root, "support-matrix.json"));
  const adapterPath = path.join(root, "packages", "adapter-codex-cursor", "src", "run-delegation.mjs");
  const adapter = (await readFile(adapterPath, "utf8"))
    .replace('from "../../host-codex/src/direct-actions.mjs"', 'from "../../core/src/direct-lifecycle.mjs"');
  await writeFile(adapterPath, adapter);
  const errors = await validateArchitecture(root);
  assert(errors.some((item) => item.includes("must route terminal governance through host-codex")));
  await rm(root, { recursive: true });
});

test("architecture validation rejects eager Cursor loading in default doctor", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "relaypact-architecture-"));
  await cp(path.join(packageRoot, "packages"), path.join(root, "packages"), { recursive: true });
  await cp(path.join(packageRoot, "package.json"), path.join(root, "package.json"));
  await cp(path.join(packageRoot, "support-matrix.json"), path.join(root, "support-matrix.json"));
  const doctorPath = path.join(root, "packages", "cli", "src", "doctor.mjs");
  const doctor = (await readFile(doctorPath, "utf8"))
    .replace('const { discoverCursorCli } = await import("../../executor-cursor/src/executor.mjs");', "")
    .replace(
      'import { MINIMUM_CODEX_VERSION, parseCodexVersion } from "../../executor-codex/src/compatibility.mjs";',
      'import { MINIMUM_CODEX_VERSION, parseCodexVersion } from "../../executor-codex/src/compatibility.mjs";\nimport { discoverCursorCli } from "../../executor-cursor/src/executor.mjs";'
    );
  await writeFile(doctorPath, doctor);
  const errors = await validateArchitecture(root);
  assert(errors.some((item) => item.includes("must not statically load the optional Cursor executor")));
  await rm(root, { recursive: true });
});

test("architecture validation rejects eager Pi loading in default doctor", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "relaypact-architecture-"));
  await cp(path.join(packageRoot, "packages"), path.join(root, "packages"), { recursive: true });
  await cp(path.join(packageRoot, "package.json"), path.join(root, "package.json"));
  await cp(path.join(packageRoot, "support-matrix.json"), path.join(root, "support-matrix.json"));
  const doctorPath = path.join(root, "packages", "cli", "src", "doctor.mjs");
  const doctor = (await readFile(doctorPath, "utf8"))
    .replace('const { discoverPiCli, MINIMUM_PI_VERSION } = await import("../../executor-pi/src/executor.mjs");', "")
    .replace(
      'import { MINIMUM_CODEX_VERSION, parseCodexVersion } from "../../executor-codex/src/compatibility.mjs";',
      'import { MINIMUM_CODEX_VERSION, parseCodexVersion } from "../../executor-codex/src/compatibility.mjs";\nimport {\n  discoverPiCli,\n  MINIMUM_PI_VERSION\n} from "../../executor-pi/src/executor.mjs";'
    )
    .replace(
      'from "../../executor-pi/src/executor.mjs";',
      'from "../../executor-pi/src/executor.mjs?eager";'
    );
  await writeFile(doctorPath, doctor);
  const errors = await validateArchitecture(root);
  assert(errors.some((item) => item.includes("must not statically load the optional Pi executor")));
  await rm(root, { recursive: true });
});

test("architecture validation rejects commented eager Pi imports", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "relaypact-architecture-"));
  await cp(path.join(packageRoot, "packages"), path.join(root, "packages"), { recursive: true });
  await cp(path.join(packageRoot, "package.json"), path.join(root, "package.json"));
  await cp(path.join(packageRoot, "support-matrix.json"), path.join(root, "support-matrix.json"));
  const doctorPath = path.join(root, "packages", "cli", "src", "doctor.mjs");
  const doctor = `${await readFile(doctorPath, "utf8")}\nimport /* eager */ "../../executor-pi/src/executor.mjs";\n`;
  await writeFile(doctorPath, doctor);
  const errors = await validateArchitecture(root);
  assert(errors.some((item) => item.includes("must not statically load the optional Pi executor")));
  await rm(root, { recursive: true });
});

test("architecture validation rejects token-adjacent eager Pi imports", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "relaypact-architecture-"));
  await cp(path.join(packageRoot, "packages"), path.join(root, "packages"), { recursive: true });
  await cp(path.join(packageRoot, "package.json"), path.join(root, "package.json"));
  await cp(path.join(packageRoot, "support-matrix.json"), path.join(root, "support-matrix.json"));
  const doctorPath = path.join(root, "packages", "cli", "src", "doctor.mjs");
  const doctor = `${await readFile(doctorPath, "utf8")}\nimport{discoverPiCli as eagerPi}from"../../executor-pi/src/executor.mjs";\n`;
  await writeFile(doctorPath, doctor);
  const errors = await validateArchitecture(root);
  assert(errors.some((item) => item.includes("must not statically load the optional Pi executor")));
  await rm(root, { recursive: true });
});

test("architecture validation rejects transitive eager Pi imports from default doctor", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "relaypact-architecture-"));
  await cp(path.join(packageRoot, "packages"), path.join(root, "packages"), { recursive: true });
  await cp(path.join(packageRoot, "package.json"), path.join(root, "package.json"));
  await cp(path.join(packageRoot, "support-matrix.json"), path.join(root, "support-matrix.json"));
  const doctorPath = path.join(root, "packages", "cli", "src", "doctor.mjs");
  const helperPath = path.join(root, "packages", "cli", "src", "eager-pi-helper.mjs");
  await writeFile(helperPath, 'export { discoverPiCli } from "../../executor-pi/src/executor.mjs";\n');
  await writeFile(doctorPath, `${await readFile(doctorPath, "utf8")}\nimport "./eager-pi-helper.mjs";\n`);
  const errors = await validateArchitecture(root);
  assert(errors.some((item) => item.includes("must not statically load the optional Pi executor")));
  await rm(root, { recursive: true });
});

test("architecture validation decodes escaped transitive import specifiers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "relaypact-architecture-"));
  await cp(path.join(packageRoot, "packages"), path.join(root, "packages"), { recursive: true });
  await cp(path.join(packageRoot, "package.json"), path.join(root, "package.json"));
  await cp(path.join(packageRoot, "support-matrix.json"), path.join(root, "support-matrix.json"));
  const doctorPath = path.join(root, "packages", "cli", "src", "doctor.mjs");
  const helperPath = path.join(root, "packages", "cli", "src", "eager-pi-helper.mjs");
  await writeFile(helperPath, 'export { discoverPiCli } from "../../executor\\u002dpi/src/executor.mjs";\n');
  await writeFile(doctorPath, `${await readFile(doctorPath, "utf8")}\nimport "./eager-pi-helper.mjs";\n`);
  const errors = await validateArchitecture(root);
  assert(errors.some((item) => item.includes("must not statically load the optional Pi executor")));
  await rm(root, { recursive: true });
});

test("architecture validation ignores regex braces before transitive imports", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "relaypact-architecture-"));
  await cp(path.join(packageRoot, "packages"), path.join(root, "packages"), { recursive: true });
  await cp(path.join(packageRoot, "package.json"), path.join(root, "package.json"));
  await cp(path.join(packageRoot, "support-matrix.json"), path.join(root, "support-matrix.json"));
  const doctorPath = path.join(root, "packages", "cli", "src", "doctor.mjs");
  const helperPath = path.join(root, "packages", "cli", "src", "eager-pi-helper.mjs");
  await writeFile(helperPath, 'const pattern = /{/;\nexport { discoverPiCli } from "../../executor-pi/src/executor.mjs";\n');
  await writeFile(doctorPath, `${await readFile(doctorPath, "utf8")}\nimport "./eager-pi-helper.mjs";\n`);
  const errors = await validateArchitecture(root);
  assert(errors.some((item) => item.includes("must not statically load the optional Pi executor")));
  await rm(root, { recursive: true });
});

test("architecture validation rejects prerequisite and live-smoke drift", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "relaypact-architecture-"));
  await cp(path.join(packageRoot, "packages"), path.join(root, "packages"), { recursive: true });
  await cp(path.join(packageRoot, "package.json"), path.join(root, "package.json"));
  const matrix = JSON.parse(await readFile(path.join(packageRoot, "support-matrix.json"), "utf8"));
  matrix.routes[0].prerequisites = ["Pi must be installed"];
  matrix.routes[0].liveSmoke = "npm run smoke:pi";
  await writeFile(path.join(root, "support-matrix.json"), JSON.stringify(matrix));
  const errors = await validateArchitecture(root);
  assert(errors.some((item) => item.includes("codex-codex has unexpected prerequisites")));
  assert(errors.some((item) => item.includes("codex-codex has unexpected liveSmoke")));
  await rm(root, { recursive: true });
});

test("architecture validation rejects retired contract schema identifiers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "relaypact-architecture-"));
  await cp(path.join(packageRoot, "packages"), path.join(root, "packages"), { recursive: true });
  await cp(path.join(packageRoot, "package.json"), path.join(root, "package.json"));
  await cp(path.join(packageRoot, "support-matrix.json"), path.join(root, "support-matrix.json"));
  const schemaPath = path.join(root, "packages", "contracts", "schemas", "task-envelope.schema.json");
  const schema = JSON.parse(await readFile(schemaPath, "utf8"));
  const retiredRepository = ["agent", "delegation", "kit"].join("-");
  schema.$id = `https://github.com/echopath-labs/${retiredRepository}/contracts/task-envelope.schema.json`;
  await writeFile(schemaPath, JSON.stringify(schema));
  const errors = await validateArchitecture(root);
  assert(errors.some((item) => item.includes("task-envelope.schema.json has a non-canonical $id")));
  await rm(root, { recursive: true });
});

test("invalid manifest schema is rejected", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "relaypact-package-"));
  await makeMinimalPlugin(root, { ...validManifest, $schema: "https://example.invalid/schema.json" });
  const errors = await validatePackage(root);
  assert(errors.some((item) => item.includes("Agent Plugins 1.0.0")));
  await rm(root, { recursive: true });
});

test("missing immediate skill is rejected", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "relaypact-package-"));
  await makeMinimalPlugin(root, validManifest);
  await rm(path.join(root, "skills", "demo", "SKILL.md"));
  const errors = await validatePackage(root);
  assert(errors.some((item) => item.includes("SKILL.md is missing")));
  await rm(root, { recursive: true });
});

test("invalid local marketplace metadata is rejected", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "relaypact-package-"));
  await makeMinimalPlugin(root, validManifest);
  await writeFile(path.join(root, ".agents", "plugins", "marketplace.json"), JSON.stringify({
    name: "fixture-marketplace",
    plugins: [{ name: "different-plugin", source: { source: "local", path: "./nested" } }]
  }));
  const errors = await validatePackage(root);
  assert(errors.some((item) => item.includes("must expose the root plugin")));
  await rm(root, { recursive: true });
});

test("unexpected private workspace files are rejected", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "relaypact-package-"));
  await makeMinimalPlugin(root, validManifest);
  await mkdir(path.join(root, "openspec"));
  await writeFile(path.join(root, "openspec", "private.md"), "private\n");
  const errors = await validatePackage(root);
  assert(errors.some((item) => item.includes("Unexpected top-level")));
  assert(errors.some((item) => item.includes("Private or generated path")));
  await rm(root, { recursive: true });
});

test("public preview policy and credential-free CI are required", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "relaypact-package-"));
  await makeMinimalPlugin(root, validManifest);
  await rm(path.join(root, "SECURITY.md"));
  await writeFile(path.join(root, ".github", "workflows", "validate.yml"), [
    "name: Unsafe",
    "on:",
    "  pull_request_target:",
    "jobs:",
    "  test:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: echo ${{ secrets.DEPLOY_TOKEN }}",
    ""
  ].join("\n"));

  const errors = await validatePackage(root);

  assert(errors.some((item) => item.includes("SECURITY.md is required")));
  assert(errors.some((item) => item.includes("pull_request_target")));
  assert(errors.some((item) => item.includes("must not require repository secrets")));
  await rm(root, { recursive: true });
});

test("public preview CI rejects mutable action tags", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "relaypact-package-"));
  await makeMinimalPlugin(root, validManifest);
  const workflowPath = path.join(root, ".github", "workflows", "validate.yml");
  const workflow = (await readFile(workflowPath, "utf8"))
    .replace("actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1", "actions/checkout@v7")
    .replace("actions/setup-node@820762786026740c76f36085b0efc47a31fe5020", "actions/setup-node@v7");
  await writeFile(workflowPath, workflow);
  const errors = await validatePackage(root);
  assert(errors.some((item) => item.includes("pin the reviewed checkout")));
  assert(errors.some((item) => item.includes("pin the reviewed setup-node")));
  await rm(root, { recursive: true });
});

test("public preview rejects symlinks and additional workflows", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "relaypact-package-"));
  await makeMinimalPlugin(root, validManifest);
  await writeFile(path.join(root, "README-target.md"), "target\n");
  await symlink("README-target.md", path.join(root, "skills", "demo", "linked.md"));
  await writeFile(path.join(root, ".github", "workflows", "extra.yml"), "jobs: {}\n");
  const errors = await validatePackage(root);
  assert(errors.some((item) => item.includes("Symbolic links are not allowed")));
  assert(errors.some((item) => item.includes("only .github/workflows/validate.yml")));
  await rm(root, { recursive: true });
});

test("public preview rejects unmanifested files under nested node_modules", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "relaypact-package-"));
  await makeMinimalPlugin(root, validManifest);
  await mkdir(path.join(root, "skills", "node_modules"));
  await writeFile(path.join(root, "skills", "node_modules", "SKILL.md"), "unreviewed instructions\n");
  const errors = await validatePackage(root);
  assert(errors.some((item) => item.includes("Public file manifest mismatch")));
  await rm(root, { recursive: true });
});

test("public preview rejects manifest-listed files under nested node_modules", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "relaypact-package-"));
  await makeMinimalPlugin(root, validManifest);
  const relative = "skills/node_modules/SKILL.md";
  await mkdir(path.join(root, "skills", "node_modules"));
  await writeFile(path.join(root, ...relative.split("/")), "unreviewed instructions\n");
  const manifestPath = path.join(root, "public-files.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.files.push(relative);
  manifest.files.sort();
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  const errors = await validatePackage(root);
  assert(errors.some((item) => item.includes("Private or generated path")));
  await rm(root, { recursive: true });
});

test("public preview rejects unreviewed workflow actions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "relaypact-package-"));
  await makeMinimalPlugin(root, validManifest);
  const workflowPath = path.join(root, ".github", "workflows", "validate.yml");
  await writeFile(workflowPath, `${await readFile(workflowPath, "utf8")}      - uses: vendor/unreviewed@0123456789012345678901234567890123456789\n`);
  const errors = await validatePackage(root);
  assert(errors.some((item) => item.includes("not on the reviewed exact allowlist")));
  await rm(root, { recursive: true });
});

test("public preview rejects alternate YAML spellings even when safe fragments remain", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "relaypact-package-"));
  await makeMinimalPlugin(root, validManifest);
  const workflowPath = path.join(root, ".github", "workflows", "validate.yml");
  const workflow = await readFile(workflowPath, "utf8");
  await writeFile(workflowPath, `${workflow}\n# permissions:\n#   contents: read\njobs:\n  bypass:\n    permissions: { "contents": write }\n    steps:\n      - "uses": vendor/action@main\n`);
  const errors = await validatePackage(root);
  assert(errors.some((item) => item.includes("exactly match the reviewed")));
  assert(errors.some((item) => item.includes("Public file manifest mismatch")) === false);
  await rm(root, { recursive: true });
});
