#!/usr/bin/env node
import { readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_PACKAGES = new Map([
  ["adapter-codex-codex", "@relaypact/adapter-codex-codex"],
  ["adapter-codex-cursor", "@relaypact/adapter-codex-cursor"],
  ["adapter-codex-pi", "@relaypact/adapter-codex-pi"],
  ["cli", "@relaypact/cli"],
  ["contracts", "@relaypact/contracts"],
  ["core", "@relaypact/core"],
  ["executor-codex", "@relaypact/executor-codex"],
  ["executor-cursor", "@relaypact/executor-cursor"],
  ["executor-pi", "@relaypact/executor-pi"],
  ["host-codex", "@relaypact/host-codex"]
]);

const SUPPORT_MATRIX_SCHEMA = "./packages/contracts/schemas/adapter-support-matrix.schema.json";
const CONTRACT_SCHEMA_BASE = "https://raw.githubusercontent.com/echopath-labs/relaypact/main/packages/contracts/schemas";
const CONTRACT_SCHEMAS = [
  "adapter-support-matrix.schema.json",
  "codex-worker-result.schema.json",
  "context-manifest.schema.json",
  "execution-result.schema.json",
  "host-review-packet.schema.json",
  "task-envelope.schema.json"
];

const ALLOWED_DEPENDENCIES = new Map([
  ["contracts", new Set()],
  ["core", new Set(["contracts"])],
  ["executor-codex", new Set(["contracts", "core"])],
  ["executor-cursor", new Set(["contracts", "core"])],
  ["executor-pi", new Set(["contracts", "core"])],
  ["host-codex", new Set(["contracts", "core", "executor-codex"])],
  ["adapter-codex-codex", new Set(["contracts", "core", "executor-codex", "host-codex"])],
  ["adapter-codex-cursor", new Set(["contracts", "core", "executor-cursor", "host-codex"])],
  ["adapter-codex-pi", new Set(["contracts", "core", "executor-pi", "host-codex"])],
  ["cli", new Set([...EXPECTED_PACKAGES.keys()].filter((name) => name !== "cli"))]
]);

const ROUTE_EXPECTATIONS = new Map([
  ["codex-codex", {
    hostPackage: "packages/host-codex",
    executorPackage: "packages/executor-codex",
    adapterPackage: "packages/adapter-codex-codex",
    executionHarness: "codex",
    status: "public-preview",
    sourceIncluded: true,
    rootPluginActivation: true,
    prerequisites: [
      "Node.js 20 or later",
      "Codex CLI 0.147.0 or later",
      "a host-approved Codex worker profile"
    ],
    deterministicCheck: "npm run check:codex-codex",
    liveSmoke: "npm run smoke:codex-native"
  }],
  ["codex-pi", {
    hostPackage: "packages/host-codex",
    executorPackage: "packages/executor-pi",
    adapterPackage: "packages/adapter-codex-pi",
    executionHarness: "pi",
    status: "experimental",
    sourceIncluded: true,
    rootPluginActivation: false,
    prerequisites: [
      "Node.js 20 or later",
      "an explicit compatible Pi installation and execution profile"
    ],
    deterministicCheck: "npm run check:codex-pi",
    liveSmoke: "npm run smoke:pi"
  }],
  ["codex-cursor", {
    hostPackage: "packages/host-codex",
    executorPackage: "packages/executor-cursor",
    adapterPackage: "packages/adapter-codex-cursor",
    executionHarness: "cursor",
    status: "experimental",
    sourceIncluded: true,
    rootPluginActivation: false,
    prerequisites: [
      "Node.js 20 or later",
      "an explicit compatible authenticated Cursor CLI installation"
    ],
    deterministicCheck: "npm run check:codex-cursor",
    liveSmoke: "npm run smoke:cursor"
  }]
]);

function sameValue(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

async function walk(directory, output = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(absolute, output);
    else if (entry.isFile()) output.push(absolute);
  }
  return output;
}

function packageNameFor(root, absolute) {
  const relative = path.relative(path.join(root, "packages"), absolute);
  const [name] = relative.split(path.sep);
  return EXPECTED_PACKAGES.has(name) ? name : null;
}

function importedSpecifiers(source) {
  const results = [];
  const patterns = [
    /\bfrom\s+["']([^"']+)["']/gu,
    /\bimport\s+["']([^"']+)["']/gu,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) results.push(match[1]);
  }
  return results;
}

export async function validateArchitecture(rootInput) {
  const root = await realpath(rootInput);
  const errors = [];
  const rootPackage = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  if (rootPackage.private !== true) errors.push("The monorepo root package must remain private.");
  if (JSON.stringify(rootPackage.workspaces) !== JSON.stringify(["packages/*"])) {
    errors.push("The monorepo root must declare exactly the packages/* workspace boundary.");
  }

  const packageEntries = (await readdir(path.join(root, "packages"), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const expectedEntries = [...EXPECTED_PACKAGES.keys()].sort();
  if (JSON.stringify(packageEntries) !== JSON.stringify(expectedEntries)) {
    errors.push(`Package ownership mismatch; expected ${expectedEntries.join(", ")}; found ${packageEntries.join(", ")}.`);
  }

  for (const [directory, expectedName] of EXPECTED_PACKAGES) {
    try {
      const manifest = JSON.parse(await readFile(path.join(root, "packages", directory, "package.json"), "utf8"));
      if (manifest.name !== expectedName) errors.push(`packages/${directory} has unexpected package name.`);
      if (manifest.version !== rootPackage.version) errors.push(`packages/${directory} version must match the monorepo root version.`);
      if (manifest.private !== true || manifest.type !== "module") {
        errors.push(`packages/${directory} must be a private ESM package.`);
      }
    } catch (error) {
      errors.push(`packages/${directory}/package.json is missing or invalid: ${error.message}`);
    }
  }

  for (const schemaFile of CONTRACT_SCHEMAS) {
    try {
      const schema = JSON.parse(await readFile(path.join(root, "packages", "contracts", "schemas", schemaFile), "utf8"));
      const expectedId = `${CONTRACT_SCHEMA_BASE}/${schemaFile}`;
      if (schema.$id !== expectedId) errors.push(`packages/contracts/schemas/${schemaFile} has a non-canonical $id.`);
    } catch (error) {
      errors.push(`packages/contracts/schemas/${schemaFile} is missing or invalid: ${error.message}`);
    }
  }

  let matrix;
  try {
    matrix = JSON.parse(await readFile(path.join(root, "support-matrix.json"), "utf8"));
  } catch (error) {
    errors.push(`support-matrix.json is missing or invalid: ${error.message}`);
  }
  if (matrix) {
    const allowedTop = new Set(["$schema", "schemaVersion", "routes"]);
    const unknownTop = Object.keys(matrix).filter((key) => !allowedTop.has(key));
    if (
      unknownTop.length > 0 || matrix.$schema !== SUPPORT_MATRIX_SCHEMA ||
      matrix.schemaVersion !== "1.0.0" || !Array.isArray(matrix.routes)
    ) {
      errors.push("Support matrix top-level shape is invalid.");
    } else {
      const ids = matrix.routes.map((route) => route?.id);
      if (JSON.stringify(ids) !== JSON.stringify([...ROUTE_EXPECTATIONS.keys()])) {
        errors.push("Support matrix route order or admission set is invalid.");
      }
      const allowedRoute = new Set([
        "id", "hostPackage", "executorPackage", "adapterPackage", "executionHarness",
        "status", "sourceIncluded", "rootPluginActivation", "prerequisites",
        "deterministicCheck", "liveSmoke"
      ]);
      for (const route of matrix.routes) {
        if (!route || typeof route !== "object" || Array.isArray(route)) {
          errors.push("Support matrix routes must be objects.");
          continue;
        }
        const unknown = Object.keys(route).filter((key) => !allowedRoute.has(key));
        if (unknown.length > 0) errors.push(`Route ${route.id ?? "<unknown>"} has unknown fields: ${unknown.join(", ")}.`);
        const expected = ROUTE_EXPECTATIONS.get(route.id);
        if (!expected) continue;
        for (const [key, value] of Object.entries(expected)) {
          if (!sameValue(route[key], value)) errors.push(`Route ${route.id} has unexpected ${key}.`);
        }
        if (
          route.sourceIncluded !== true || !Array.isArray(route.prerequisites) || route.prerequisites.length === 0 ||
          route.prerequisites.some((item) => typeof item !== "string" || item.length === 0) ||
          new Set(route.prerequisites).size !== route.prerequisites.length ||
          typeof route.deterministicCheck !== "string" ||
          (route.liveSmoke !== null && typeof route.liveSmoke !== "string")
        ) {
          errors.push(`Route ${route.id} must declare included source and explicit prerequisites.`);
        }
      }
    }
  }

  const sourceFiles = (await walk(path.join(root, "packages"))).filter((file) => file.endsWith(".mjs"));
  for (const file of sourceFiles) {
    const owner = packageNameFor(root, file);
    if (!owner) continue;
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(/\bimport\s*\(([^)]*)\)/gu)) {
      if (!/^\s*["'][^"']+["']\s*$/u.test(match[1])) {
        errors.push(`${path.relative(root, file)} uses a non-literal dynamic import.`);
      }
    }
    for (const specifier of importedSpecifiers(source)) {
      if (specifier.startsWith("node:")) continue;
      if (!specifier.startsWith(".")) {
        errors.push(`${path.relative(root, file)} imports undeclared external specifier ${specifier}.`);
        continue;
      }
      const target = path.resolve(path.dirname(file), specifier);
      const dependency = packageNameFor(root, target);
      if (!dependency) {
        errors.push(`${path.relative(root, file)} imports outside the package ownership tree: ${specifier}.`);
        continue;
      }
      if (dependency === owner) continue;
      if (!ALLOWED_DEPENDENCIES.get(owner)?.has(dependency)) {
        errors.push(`${path.relative(root, file)} imports forbidden package ${dependency}.`);
      }
      const ownerHarness = owner.startsWith("executor-")
        ? owner.slice("executor-".length)
        : owner.startsWith("adapter-codex-")
          ? owner.slice("adapter-codex-".length)
          : null;
      const dependencyHarness = dependency.startsWith("executor-")
        ? dependency.slice("executor-".length)
        : null;
      if (ownerHarness && dependencyHarness && ownerHarness !== dependencyHarness) {
        const routeLabel = ownerHarness === "codex" ? "Codex" : ownerHarness;
        errors.push(`${path.relative(root, file)} couples the ${routeLabel} route to ${dependency}.`);
      }
    }
  }

  for (const legacy of ["src", "contracts", "hosts", "executors", "adapters"]) {
    try {
      await readdir(path.join(root, legacy));
      errors.push(`Legacy runtime ownership directory remains: ${legacy}/.`);
    } catch {
      // Absence is required.
    }
  }

  return errors;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const errors = await validateArchitecture(root);
  if (errors.length > 0) {
    process.stderr.write(`${errors.map((item) => `- ${item}`).join("\n")}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write("Architecture validation passed.\n");
  }
}
