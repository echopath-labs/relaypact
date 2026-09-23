import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DelegationError } from "../../contracts/src/errors.mjs";

const SAFE_BASE_NAMES = [
  "PATH", "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "VOLTA_HOME"
];
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function selected(source, names) {
  return Object.fromEntries(names.flatMap((name) => source[name] === undefined ? [] : [[name, source[name]]]));
}

export function minimalEnvironment(source = process.env, options = {}) {
  const grants = options.grants ?? {};
  if (!grants || typeof grants !== "object" || Array.isArray(grants)) {
    throw new DelegationError("invalid_environment_grant", "Environment grants must be a name-value object.");
  }
  const granted = {};
  for (const [name, value] of Object.entries(grants)) {
    if (!ENVIRONMENT_NAME.test(name) || typeof value !== "string" || value.includes("\0")) {
      throw new DelegationError("invalid_environment_grant", `Environment grant is invalid: ${name}.`);
    }
    granted[name] = value;
  }
  const environment = { ...selected(source, SAFE_BASE_NAMES), ...granted };
  if (options.home) environment.HOME = options.home;
  if (options.temporary) {
    environment.TMPDIR = options.temporary;
    environment.TMP = options.temporary;
    environment.TEMP = options.temporary;
  }
  return environment;
}

export async function createIsolatedEnvironment(source = process.env, options = {}) {
  const baseDirectory = options.baseDirectory ?? os.tmpdir();
  if (!path.isAbsolute(baseDirectory)) {
    throw new DelegationError("invalid_environment_root", "Isolated environment roots must use an absolute base directory.");
  }
  let root;
  try {
    root = await mkdtemp(path.join(baseDirectory, options.prefix ?? "relaypact-env-"));
    const home = path.join(root, "home");
    const temporary = path.join(root, "tmp");
    await mkdir(home, { recursive: true, mode: 0o700 });
    await mkdir(temporary, { recursive: true, mode: 0o700 });
    return {
      root,
      home,
      temporary,
      env: minimalEnvironment(source, { grants: options.grants, home, temporary }),
      async cleanup() {
        await rm(root, { recursive: true, force: true });
      }
    };
  } catch (error) {
    if (root) await rm(root, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
