# Manual configuration and CLI reference

This reference is for automation authors, debugging, and users who intentionally
opt out of the recommended [Agent-first workflow](agent-quickstart.md).

The same scope, credential, evidence, and acceptance rules apply. Manual control
does not authorize broader access or automatic patch application.

The [Host Skill](../skills/relaypact/SKILL.md) defines the shared delegation and
review requirements. Read this manual when using the CLI tools, whose schemas
and lifecycle constraints remain required. Version 0.3.5 includes the shared
Host guidance and the experimental Cursor adapter.

## Execution exit codes since v0.3.1

Since v0.3.1, every `run-*` and `correct-*` command returns
`0` for completed execution, `2` for blocked execution, and `1` for failed,
rejected, malformed or unknown results. A failed persistent lifecycle also
returns `1`. JSON carries details; exit `0` never grants Host acceptance.
These changes follow v0.3.0; see the [changelog](../CHANGELOG.md) for release status.
Wrappers upgrading from v0.3.0 must handle `2` explicitly instead of treating
blocked execution as success. Doctor and decision-operation semantics are
unchanged; see [CLI semantics](../packages/cli/README.md).

## Prerequisites for the published Codex capsule route

- Node.js 20 or later
- Git
- Codex CLI 0.147.0 or later
- a clean target Git repository, unless every pre-existing dirty path is
  explicitly acknowledged in the envelope
- pre-existing real private state and archive directories outside the target
  repository

Pi is required only for the explicitly selected experimental `codex-pi` route.
A compatible authenticated Cursor CLI is required only for the explicitly
selected experimental `codex-cursor` route. RelayPact does not configure Cursor
authentication, provider, or model. Cursor and Pi do not need a Codex profile
registry; Cursor needs lifecycle roots only in persistent mode. Direct execution
can already have modified the workspace when review starts: acceptance does not
apply a separate capsule patch and rejection does not revert those changes.
Use the selected route's [invocation reference](../skills/relaypact/references/invocation.md).
Acknowledgement permits an existing dirty path to remain byte-identical; it does
not grant write authority. A content, type or mode change is still reported as
delegated work and evaluated against the original scope.

For Codex-to-Codex, RelayPact supplies scope controls, execution isolation,
evidence and an acceptance lifecycle. The delegated executor
is `codex exec` from the same Codex CLI installation. A second Codex installation
or separate executor package is not required, but Codex Desktop alone does not
guarantee that `codex` is callable from the shell.

Verify the base commands before installation:

```bash
node --version
git --version
codex --version
codex exec --help
```

## Release state and version verification

The installation target is `v0.3.5`. Package and Plugin version fields
alone are not release identity; verify the official tag's peeled commit.

Before installing, confirm the [v0.3.5 GitHub Release](https://github.com/echopath-labs/relaypact/releases/tag/v0.3.5) is visible.
If unavailable, stop these installation steps and use [v0.3.4](https://github.com/echopath-labs/relaypact/releases/tag/v0.3.4) instead.
These versioned instructions are not a publication announcement.

Install and verify the target release only after confirming its availability:

```bash
set -e
git clone --branch v0.3.5 --depth 1 \
  https://github.com/echopath-labs/relaypact.git relaypact-v0.3.5
checkout_commit="$(git -C relaypact-v0.3.5 rev-parse HEAD)"
release_commit="$(git -C relaypact-v0.3.5 rev-parse 'v0.3.5^{}')"
test "$checkout_commit" = "$release_commit"
cd relaypact-v0.3.5
node -e 'const p=require("./package.json"),q=require("./plugin.json"); if(p.version!=="0.3.5"||q.version!==p.version) process.exit(1)'
codex plugin marketplace add "$PWD" --json
codex plugin add relaypact@relaypact-local --json
codex plugin list --marketplace relaypact-local --json
```

For current-source dogfood, clone the mutable `main` branch, record its exact
commit, and inspect its aligned source metadata. A mutable branch can differ
from the tagged release; do not infer release identity from `main`:

```bash
set -e
git clone --branch main --depth 1 \
  https://github.com/echopath-labs/relaypact.git relaypact-current-source
cd relaypact-current-source
git rev-parse HEAD
node -e 'const p=require("./package.json"),q=require("./plugin.json"); if(!p.version||q.version!==p.version) process.exit(1); console.log(p.version)'
codex plugin marketplace add "$PWD" --json
codex plugin add relaypact@relaypact-local --json
codex plugin list --marketplace relaypact-local --json
```

This mutable source checkout is a development-source installation, not a reproducible
release installation. If an organization supplies a full commit SHA through a separate trusted channel,
compare it exactly with `git rev-parse HEAD` before Plugin registration.

Earlier published releases remain available; this historical example uses `v0.1.0`:

```bash
git clone --branch v0.1.0 --depth 1 \
  https://github.com/echopath-labs/relaypact.git relaypact-v0.1.0
checkout_commit="$(git -C relaypact-v0.1.0 rev-parse HEAD)"
release_commit="$(git -C relaypact-v0.1.0 rev-parse 'v0.1.0^{}')"
test "$checkout_commit" = "$release_commit"
cd relaypact-v0.1.0
codex plugin marketplace add "$PWD" --json
codex plugin add relaypact@relaypact-local --json
codex plugin list --marketplace relaypact-local --json
```

An official repository tag is a version selector, not an independent cryptographic guarantee.
Compare a full commit SHA only when it came through a
separate trusted channel. See [RELEASING.md](../RELEASING.md).

## Install the root plugin

The repository contains one Agent Plugins 1.0 root `plugin.json`. It has no
`.codex-plugin/plugin.json` and no MCP server.

## Inspect support

From a source clone:

```bash
node ./bin/relaypact.mjs support
node ./bin/relaypact.mjs doctor
node ./bin/relaypact.mjs doctor --route codex-pi
node ./bin/relaypact.mjs doctor --route codex-cursor
```

From an installed Skill, resolve
`skills/relaypact/scripts/relaypact.mjs` relative to
the installed Skill directory. Do not assume the current directory is the
plugin checkout.

The support matrix identifies `codex-codex` as `public-preview`, with
`codex-pi`, `codex-cursor`, `codex-workbuddy`, and `codex-workbuddy-ai` as
explicit `experimental` routes. `support` reports that static contract. Default
`doctor` separately
checks the current Node.js, Git, Codex CLI, `codex exec`, packaged Skill,
marketplace, and plugin visibility without reading authentication, contacting a
provider, or starting a worker:

- `ready`: required runtime and installed-plugin checks passed;
- `needs_setup`: runtime works, but marketplace or plugin visibility needs setup;
- `blocked`: a required runtime, packaged Skill, or `codex exec` check failed.

Selected-route Cursor doctor checks only local CLI capability and authentication
status. It does not invoke a model, retain account output, or prove live model
availability. Live execution is evaluated only after the user explicitly
selects and invokes the route.

Selected-route Pi doctor requires Pi 0.84.0 or later, binds the selected
executable identity, and verifies the exact noninteractive flags used by the
adapter. It runs only `--version` and `--help` from disposable HOME, settings,
session and working directories. Native bootstrap writes stay inside that
temporary root and are deleted afterward; global/project Pi settings and
authentication are not read or modified. Missing, unsupported, mutated,
timed-out, truncated or settings-isolation-failing probes return `blocked` with
fixed diagnostics. A `ready` result does not prove authentication, provider or
model availability.

## Prepare private roots

```bash
mkdir -p /absolute/private/relaypact-state
mkdir -p /absolute/private/relaypact-archive
chmod 700 /absolute/private/relaypact-state
chmod 700 /absolute/private/relaypact-archive
```

Do not place these directories inside the target repository or shared public
storage. They contain the sanitized capsule, task-scoped Codex home, pending
review packet, candidate patch, lifecycle state, and terminal archive.

## Prepare a task envelope

Start from [`examples/codex-task-envelope.json`](../examples/codex-task-envelope.json).
Important fields are:

- `taskId`: unique stable identity;
- `objective` and `expectedOutcome`: bounded desired behavior;
- `repository.root`: absolute target repository path;
- `scope.readablePaths`: executor context authority;
- `scope.allowedPaths`: executor write authority;
- `scope.forbiddenPaths`: explicit exclusions;
- `validation`: host-owned argument arrays and timeouts;
- `executionProfile`: name from the private profile registry;
- `execution.timeoutMs` and `execution.exposureMode`.

For a read-only file, include it in `scope.readablePaths`, omit it from
`scope.allowedPaths`, and do not also match it with `scope.forbiddenPaths`.
Use an empty `scope.allowedPaths` array for a task with no output authority;
do not invent a placeholder writable path. Contradictory readable/forbidden
authority is rejected before worker launch.

Never put a credential, authentication path, personal proxy value, or raw
private log in an envelope. Context planning details are in the packaged
Skill's [`context-planning.md`](../skills/relaypact/references/context-planning.md).

## Prepare a worker profile registry

Start from [`examples/codex-worker-profiles.json`](../examples/codex-worker-profiles.json).
The registry is host-owned and private.

### Native Codex profile

A native profile names a selected Codex profile, model, reasoning level, and
empty or explicit environment allowlist. The adapter projects only the selected
safe configuration and authentication fields into a task-scoped Codex home.
The selected profile must already have usable host-managed Codex authentication.
The adapter does not ask for a token in the envelope and does not copy the
complete global configuration.

### Direct Responses provider

A direct profile declares:

- `provider.name`;
- an HTTPS or loopback HTTP `provider.baseUrl` ending at `/v1`;
- `provider.wireApi: "responses"`;
- `provider.credentialEnv`, containing only an environment-variable name;
- an explicit model and optional standard proxy-variable allowlist.

The actual credential remains in the named host environment variable. Provider
URLs with userinfo, query parameters, fragments, unsupported encoding, or an
excessive decode chain are refused before worker launch.

The copy-safe OpenCode Go / GPT-5.6 Luna example is in
[`examples/codex-worker-profiles.opencode-go-luna.json`](../examples/codex-worker-profiles.opencode-go-luna.json).
Read [the provider guide](opencode-go-luna.md) before using it.

### Optional loopback router

A router profile names a selected Codex profile plus a loopback health URL. The
router is optional local infrastructure. Route failure does not fall back to a
direct provider, Pi, OpenCode CLI, or another harness.

## Start a Codex-to-Codex task

```bash
node ./bin/relaypact.mjs run-codex \
  --envelope /absolute/private/task-envelope.json \
  --profiles /absolute/private/worker-profiles.json \
  --state-root /absolute/private/relaypact-state \
  --host-instance coordinating-host-id
```

The command prepares a sanitized Git capsule, launches an independent
`codex exec`, records the delegated thread identity, performs host postflight
and validation, then writes a pending review packet and candidate patch under
the returned task root.

It does not modify the source repository.

An envelope with `allowedPaths: []` selects Codex's native read-only sandbox,
allows report-only completion with `changedFiles: []`, and preserves that sandbox
through same-session correction. Host postflight still rejects any observed mutation.

## Review the pending result

Inspect, at minimum:

- `executorSelfReport.status`, changed files, validations, blocking detail, and
  residual risks;
- `hostObserved.changedPaths`, scope breaches, candidate patch identity,
  private-control status, and credential-evidence safety;
- host validation status and bounded output;
- acceptance eligibility and unresolved risks;
- `metrics.relaypactPromptBytes`, `relaypactResultSchemaBytes`, and
  `relaypactDeclaredInputBytes`, kept separate from selected context bytes and
  provider-reported tokens;
- the actual candidate patch stored beside the review packet.

Do not infer acceptance from `executorSelfReport.status: "completed"`.
`completed` means the executor returned a candidate result; independent host
review is still pending. `accept` is a later terminal decision and still does
not change the source repository. `apply` is a third, separately authorized
source mutation after the accepted archive and current source base are
rechecked: `completed` != `accept` != `apply`.
RelayPact-declared byte metrics cover only the exact worker prompt and generated
result schema supplied by RelayPact. They do not measure hidden Codex/provider
harness input and are not token, quota, cost, or overhead estimates.

## Request a same-session correction

Prepare a private text file containing only the correction and run:

```bash
node ./bin/relaypact.mjs correct-codex \
  --task-root /absolute/private/relaypact-state/relaypact-task-id-uuid \
  --profiles /absolute/private/worker-profiles.json \
  --prompt /absolute/private/correction.txt
```

Correction is permitted only when the task identity, capsule baseline, context
manifest, profile, prior result, and original authority still match. Expanded
context or scope requires a new task.

## Record a terminal decision

```bash
node ./bin/relaypact.mjs decide-codex \
  --task-root /absolute/private/relaypact-state/relaypact-task-id-uuid \
  --profiles /absolute/private/worker-profiles.json \
  --action accept \
  --actor reviewing-host-id \
  --archive-root /absolute/private/relaypact-archive
```

Use `reject` or `abandon` when appropriate. The command rebuilds authoritative
review evidence, refuses stale or ineligible acceptance, records the terminal
state, archives the packet and patch, and removes only task-local state.

Acceptance still does not apply the patch. Applying a reviewed patch and any
later Git or release action require separate authority.

## Apply an accepted candidate separately

After `accept`, use the archive returned by `decide-codex`. Before applying
anything, confirm that the archived patch and review identities are the accepted
ones, inspect every changed path, and ensure the source repository still matches
the expected base. A suitable Agent prompt is:

```text
This delegation was accepted. Re-read the archived candidate patch and verify
that its evidence identity matches the accepted record. Explain every file that
would be applied and confirm the source base has not drifted. Wait for my
separate approval before applying anything. Do not commit or push.
```

Patch application, commit, push, and release remain distinct authorizations.
Never apply an unreviewed or stale archive automatically.

## Upgrade or replace an installation

Do not turn a mutable source checkout into a claimed release by editing version
metadata or substituting a tag name. For another source candidate, clone the
new source into a separate tools directory, record its exact commit, verify
aligned package/Plugin versions, remove and re-add the local Plugin, then start
a new Codex task and rerun `support` plus `doctor`.

For a published release, first confirm the desired tag exists in the official
repository. Clone it into a separate tools directory and require
`git rev-parse HEAD` to equal the peeled tag commit. A shallow annotated-tag
clone can print a warning while peeling; command success and object identity,
not warning text, determine success. If a separately trusted full commit SHA is
available, compare it exactly and stop before installation on mismatch.

The Codex `marketplace upgrade` command refreshes Git-backed marketplaces; it
does not convert a local source or tag checkout automatically.

Do not overwrite an installation while an active task depends on its Skill
files. Existing private task archives are versioned evidence and do not need to
be rewritten for a plugin upgrade.

Version 0.3.0 introduced experimental WorkBuddy and WorkBuddy AI support alongside
Host guidance and the existing Cursor route; it does not
automatically migrate existing task state. Finish active tasks with their
original verified installation where possible, preserve evidence, and prepare
new tasks after upgrading. Never bypass a lifecycle or evidence refusal.
Tasks prepared by v0.1.1 lack the semantic Git index baseline introduced in
v0.1.2 and remain ineligible for migration or terminal decisions under newer
versions. To roll back the installation, remove its Plugin/marketplace
registration and reinstall the verified `v0.1.2` tag in a separate tools
directory. Cursor tasks cannot be resumed by that older release. Rollback
does not rewrite task state.

## Uninstall

Remove the installed plugin first, then remove the local marketplace:

```bash
codex plugin remove relaypact@relaypact-local --json
codex plugin marketplace remove relaypact-local --json
```

Start a new Codex task and confirm that `$relaypact` is no
longer available. Deleting the cloned tools directory is a separate filesystem
action.

Uninstall does not delete private envelopes, profiles, state, or archives.
Review active tasks first. Archives can contain source patches and review
evidence; retain or delete them only under the user's own retention policy.
These private archives remain user-owned data.

## First-run troubleshooting

| Symptom | Check and recovery |
| --- | --- |
| `codex` not found | Ensure a supported Codex CLI is installed and callable on `PATH`; Codex Desktop presence alone is insufficient. |
| Codex version below 0.147.0 | Upgrade Codex CLI, open a new shell/task, and rerun `doctor`. |
| `codex exec` unavailable | Repair or upgrade the Codex CLI installation; no separate executor package exists. |
| `doctor` returns `needs_setup` | Add the intended source or release checkout as `relaypact-local`, install the plugin, start a new task, and rerun doctor from the installed Skill. |
| Plugin installed but Skill absent | Start a new Codex task and verify `codex plugin list --marketplace relaypact-local --json`. |
| WorkBuddy model preflight blocked | Supply one exact native model ID. A model-scoped WorkBuddy `doctor` that does not find the ID stays blocked and returns `modelDiscovery` with only the sanitized canonical IDs parsed from that admitted help. Confirm the ID, then recheck current price or free status in the native product. RelayPact never substitutes a default or fallback. |
| Native authentication unavailable | Repair the selected host Codex profile; never paste credentials into envelope/profile files. |
| Dirty target repository | Record and explicitly acknowledge every pre-existing path, or restore a clean tree before delegation. Acknowledgement permits preservation only; add a path to `allowedPaths` only when the executor may modify it. |
| `git_output_truncated` | Machine-readable Git stdout exceeded its independent 64 MiB bound. Reduce or split the repository/task; `execution.filesystemEvidenceMaxBytes` does not raise this Git limit. |
| No approved worker profile | Let the coordinating Agent prepare credential-free metadata and stop for route/auth availability decisions. |
| State/archive rejected | Use pre-existing real, non-symlink directories outside the target repository; use restrictive permissions where supported. |
| Provider or stream failure | Fail closed; inspect the provider-specific guide and do not silently change provider, model, router, or harness. |
| Correction needs new context or authority | Create a new task; correction is only for defects inside the original identity and boundary. |

## Usage and private storage

The coordinating Agent and independent executor make separate model requests.
An executor run or correction can therefore consume additional tokens, quota,
time, or cost according to the selected route. Doctor and support do not make a
model request. An explicitly model-scoped WorkBuddy doctor starts the native
CLI help path, which can contact native services or update caches without
proving account entitlement or price.

Private task state can contain a sanitized source capsule, task-scoped Codex
home, candidate patch, and review evidence. Terminal decisions archive evidence
and clean task-local state, but archive retention is not automatic. Do not place
these directories in a public repository or publicly synchronized folder.

## Glossary

- **Plugin:** the installable Agent Plugins 1.0 package containing the Skill,
  wrapper, contracts, adapters, tests, and documentation.
- **Coordinating Host:** the Codex instance that frames authority, reviews
  evidence, judges risk, and owns acceptance.
- **Executor:** the distinguishable independent `codex exec` Agent Instance that
  performs the bounded task.
- **Harness:** the Agent loop, tools, context, permissions, and result behavior;
  the public-preview worker keeps the Codex harness.
- **Route:** the selected Coordinating Host to Executor Harness pair, such as
  `codex-codex`, `codex-pi`, `codex-cursor`, `codex-workbuddy`, or
  `codex-workbuddy-ai`.
- **Profile:** host-owned, non-secret metadata selecting the worker command,
  model alias, reasoning effort, and environment names for a harness that
  supports profiles. Cursor model configuration remains Cursor-owned and is not
  part of RelayPact route identity.

## Experimental Codex-to-Cursor command

Cursor remains an explicit experimental route and is not loaded by `run-codex`
or by default diagnostics:

```bash
node ./bin/relaypact.mjs doctor --route codex-cursor
node ./bin/relaypact.mjs run-cursor \
  --envelope /absolute/private/cursor-task-envelope.json
```

Add `--read-only` to use Cursor plan mode without RelayPact granting `--force`.
An envelope with `allowedPaths: []` forces the same read-only mode even when the
flag is omitted; RelayPact does not grant `--force` for zero write authority.
For every direct-workspace read-only invocation, whether selected by the flag or
derived from empty `allowedPaths`, set `validation: []`. RelayPact rejects
repository validation commands before launch because they may create caches or
coverage; run them in an external read-only or disposable environment.

Use `--executor /absolute/path/to/cursor-agent` when discovery should be bound
to one installation. RelayPact verifies version, required non-interactive and
structured-output flags (including read-only `--mode` support), and authentication
before execution. It resolves the executable to an absolute real path and binds
the launcher plus any shebang interpreter and fixed launch prefix before
retaining any resumable session. Shebang launchers run through the resolved
absolute interpreter instead of resolving it again from a mutable `PATH`. It
minimizes the child environment, invokes Cursor without a shell, captures bounded
structured events, independently checks Git/filesystem scope and host
validation, and returns completion with host acceptance still pending.

Cursor chooses its own configured model. RelayPact never supplies a model flag,
changes Cursor settings, or falls back to another harness. `modelObservation`
is `observed/reported` only when Cursor emits a concrete bounded model field.
Cursor's `Auto` value is retained as `harness_managed/selector_alias`, because it
does not prove which underlying LLM handled the request. Missing metadata remains
honestly `unavailable/unknown`.

The one-shot command works directly in the approved target working tree and
returns pending review without creating resumable lifecycle state. To retain a
protected same-session correction handle and later record a terminal decision,
provide both private lifecycle arguments:

```bash
node ./bin/relaypact.mjs run-cursor \
  --envelope /absolute/private/cursor-task-envelope.json \
  --state-root /absolute/private/relaypact-cursor-state \
  --host-instance coordinating-codex-instance

node ./bin/relaypact.mjs correct-cursor \
  --task-root /absolute/private/relaypact-cursor-state/task-... \
  --prompt /absolute/private/cursor-correction.txt

node ./bin/relaypact.mjs decide-cursor \
  --task-root /absolute/private/relaypact-cursor-state/task-... \
  --action accept \
  --actor coordinating-codex-instance \
  --archive-root /absolute/private/relaypact-cursor-archive
```

The state and archive roots must be pre-existing real directories outside the
target repository. Correction refuses changed review evidence, new scope, new
authority, executable path or fingerprint drift, or a missing original Cursor
session. A run started with `--read-only` or an empty `allowedPaths` remains
read-only during every correction. Use the same effective Cursor and validation environment for every
correction. API callers must resupply identical `validationEnv` grants; changed
or omitted grants fail with `execution_context_mismatch` before readiness or
resume. RelayPact retains only a task-keyed fingerprint, so it cannot recover
grants from private state. Legacy tasks without this binding refuse correction
with `execution_context_unavailable` while preserving terminal review and safe
abandonment. Changes to harness-owned credential files are outside this binding.
A terminal action rechecks the current filesystem, Git controls,
index, branch, and HEAD against the signed review basis. Acceptance additionally
requires eligible pending evidence. If execution fails before a current review
exists, or an interrupted owner leaves the task in `prepared` or `running`, use
only `decide-cursor --action abandon` to archive a bounded failure or
interruption receipt and clean task-private state. RelayPact holds a signed
execution lease across active work, so abandonment returns `task_state_busy`
while the owner lives. After Host exit, non-prepared tasks still require signed
execution-completion evidence; otherwise `execution_stop_unverified` preserves
state. There is no automatic recovery for orphaned execution without this proof.
Archiving excludes the raw Cursor session handle and
cleanup deletes only the private task state; source changes remain untouched.
If deletion fails, repeat the same terminal action, actor and archive root.
A signed cleanup receipt outside the task directory supports partial-deletion
recovery and checks the original archive and directory identity. After success,
only the small receipt and its Host integrity key remain for idempotent retries;
the raw session and task directory are removed. A replacement directory at the
old path is refused. Legacy terminal states without a receipt are not upgraded
to cleanup authority.
If cleanup-receipt promotion fails after the terminal review basis was verified,
the signed terminal state binds that completed check to the archived decision.
A retry can then finish cleanup after later repository edits, without repeating
acceptance. A prepared receipt without that proof still requires a current
review-basis check.

Local execution refuses repository symlinks that resolve outside the repository,
are dangling, cyclic, or change during the check. It also refuses regular files
with multiple hard links, including internal aliases, because another name for
the same inode cannot be proven to stay inside the repository. Checks read the
current link count before execution, before each validation, and during
postflight. Resolvable internal symlinks remain
supported, and their real target changes are included in repository evidence.
These checks do not provide an OS sandbox or prevent arbitrary writes by another
process; the Host must coordinate concurrent writers and the execution boundary.

## Experimental Codex-to-Pi command

Pi remains an explicit experimental route and is not loaded by `run-codex`:

```bash
node ./bin/relaypact.mjs doctor --route codex-pi \
  --executor /absolute/path/to/pi

node ./bin/relaypact.mjs run-pi \
  --envelope /absolute/private/pi-task-envelope.json
```

Read [`packages/adapter-codex-pi/README.md`](../packages/adapter-codex-pi/README.md)
before selecting it. Pi configuration must not become an implicit dependency or
fallback for Codex-to-Codex. An envelope with `allowedPaths: []` makes Pi omit
`bash`, `edit`, and `write` before launch and keeps only read-capable tools.
That direct-workspace envelope must use `validation: []`; run any checks in an
external read-only or disposable environment.

## Validation

Offline deterministic checks:

```bash
npm run check
npm run check:codex-codex
npm run check:codex-pi
npm run check:codex-cursor
npm pack --dry-run
```

Plugin discovery uses an isolated home and no ambient credential:

```bash
RELAYPACT_CODEX_PLUGIN_SMOKE=1 npm run smoke:codex-plugin
```

Cursor readiness is opt-in but does not invoke a model:

```bash
RELAYPACT_CURSOR_READINESS=1 npm run smoke:cursor
```

Live Codex, Cursor execution (`RELAYPACT_CURSOR_SMOKE=1`), direct-provider,
router, and Pi smokes are opt-in. They may consume quota and must run only with
explicitly prepared local configuration and model-usage authorization.

## Recovery principles

- Missing credential: fix host configuration; do not put the value in JSON.
- Provider incompatibility: create a newly approved profile; do not fall back.
- Context gap: create a new task with approved context.
- Scope breach or source drift: refuse acceptance and preserve evidence.
- Validation failure: correct within existing authority or create a new task.
- Stale state: reload and rebuild authoritative review; never edit lifecycle
  files manually.

See [SECURITY.md](../SECURITY.md),
[`examples/README.md`](../examples/README.md), and the
[`codex-codex` adapter reference](../packages/adapter-codex-codex/README.md) for
the full threat, lifecycle, and library boundaries.

RelayPact is licensed under the
[Apache License 2.0](../LICENSE) (`Apache-2.0`).
