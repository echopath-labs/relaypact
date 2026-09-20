# RelayPact

[English](README.md) | [简体中文](README.zh-CN.md)

RelayPact gives the Host Agent a stable reference for delegating bounded work
and judging delivery. The Host defines the agreement, keeps authority explicit,
checks actual evidence, handles deviations, and makes the acceptance decision
within the user's authority. Executor integrations supply the compatible
invocation and evidence tools for that work.

The [Host Skill](skills/relaypact/SKILL.md) states those shared requirements;
its references explain the selected tools only when needed. See
[eight review cases](examples/host-delegation-cases.md) for concrete expectations.
Version 0.3.3 includes this guidance and experimental Cursor and WorkBuddy routes.
General Host wording does not add support for
other Host products; Codex remains the admitted Host in the support matrix.

The default root Plugin route is **Codex → Codex**. RelayPact
provides the workflow, isolation, evidence, and acceptance controls; execution
comes from an independent `codex exec` process in the user's existing Codex
CLI. No second Codex installation or executor package is required.

For this Codex-to-Codex route: **No additional executor installation is required.**

## WorkBuddy executors

Version 0.3.0 introduced experimental **Codex → WorkBuddy** (mainland) and
**Codex → WorkBuddy AI** (international) executor routes. Select the edition explicitly; each uses its own native desktop
configuration. The initial macOS route admits bundled CLI 2.137.1 and bounded
Read/Write tasks, with independent Host checks and fresh-task correction.
Shell execution and same-session continuation are not admitted. See the
[WorkBuddy invocation reference](skills/relaypact/references/workbuddy.md).

## Release status

The v0.3.3 target is an ordinary GitHub Release for practical, Host-supervised delegation.
Delegation mechanisms and constraints continue to evolve through review and use.
Product release status is separate from each adapter's maturity in the support matrix.

- Source package metadata: **0.3.3**.
- Release target: **v0.3.3**.
- Support: `codex-codex` is `public-preview`; `codex-pi` remains
  `experimental` and inactive; `codex-cursor` is source-included,
  `experimental`, and inactive at the root Plugin. WorkBuddy and WorkBuddy AI
  are also explicit, experimental executors.

[`support-matrix.json`](support-matrix.json) is authoritative. The Cursor route
must be selected explicitly and requires a compatible authenticated local Cursor
CLI. Cursor owns its authentication and model selection; RelayPact only observes
model metadata when Cursor reports it. Pi, Cursor, OpenCode CLI, OpenCodex, a
third-party provider, and any particular model are not prerequisites or
fallbacks for the Codex-to-Codex path.

Cursor's one-shot command remains pending-only. Its optional private state-root
mode adds signed persistent review, protected same-session correction, and an
explicit archived terminal decision without changing Cursor's model settings or
applying or reverting changes at the decision step. Direct execution can already
have modified the workspace. Persistent correction preserves the original read-only
or write authority and verifies the bound absolute Cursor launcher plus any
resolved shebang interpreter before resuming. A prepared task or a failed task with signed execution-completion evidence can
be explicitly abandoned and privately cleaned. Cleanup refuses a live execution
owner. An interrupted `running` task, or a legacy failed task without completion
evidence, returns `execution_stop_unverified` and retains private state. Host
exit alone does not prove that detached processes have stopped; automatic
recovery of such orphaned execution is not supported.

This preview is human-reviewed and is not intended for unattended or
production-critical use. Validated prerequisites are Node.js 20 or later, Git,
and Codex CLI 0.147.0 or later with both `codex --version` and
`codex exec --help` available. macOS is locally validated; Ubuntu is claimed
for a release only after its exact candidate passes public CI. Windows support
is not yet claimed.

## Five-minute start with the v0.3.3 release

Use the versioned `v0.3.3` tag for a reproducible release installation.
Confirm the [GitHub Release](https://github.com/echopath-labs/relaypact/releases/tag/v0.3.3)
is available before installing; package metadata or a PR alone is not publication.

Before installing, confirm the [v0.3.3 GitHub Release](https://github.com/echopath-labs/relaypact/releases/tag/v0.3.3) is visible.
If unavailable, stop these installation steps and use [v0.3.2](https://github.com/echopath-labs/relaypact/releases/tag/v0.3.2) instead.
These versioned instructions are not a publication announcement.

Give a coordinating Codex instance this prompt:

```text
Clone the versioned v0.3.3 release tag from
https://github.com/echopath-labs/relaypact into a local tools directory outside
my target repository. Record the exact checkout commit, verify it against the
peeled v0.3.3 tag commit, and verify that package.json and plugin.json both
report 0.3.3.
Read README.md and the nearest AGENTS.md. Verify Node.js 20 or later, Git,
Codex CLI 0.147.0 or later, and `codex exec --help`. Install the root Agent
Plugin through its local marketplace, start no worker, then run the installed
Skill-local `support` and `doctor` commands. Report the exact checkout commit,
versions, Plugin and Skill discovery, Codex-to-Codex readiness, and remaining
setup. Do not read credentials or configure, invoke, accept, apply, commit,
push, tag, publish, release, or deploy anything.
```

The equivalent release commands are:

```bash
set -e
git clone --branch v0.3.3 --depth 1 \
  https://github.com/echopath-labs/relaypact.git relaypact-v0.3.3
checkout_commit="$(git -C relaypact-v0.3.3 rev-parse HEAD)"
release_commit="$(git -C relaypact-v0.3.3 rev-parse 'v0.3.3^{}')"
test "$checkout_commit" = "$release_commit"
cd relaypact-v0.3.3
node -e 'const p=require("./package.json"),q=require("./plugin.json"); if(p.version!=="0.3.3"||q.version!==p.version) process.exit(1)'
codex plugin marketplace add "$PWD" --json
codex plugin add relaypact@relaypact-local --json
codex plugin list --marketplace relaypact-local --json
```

Start a new Codex task after installation, then follow the
[5-minute getting started guide](docs/agent-quickstart.md). It includes a real,
bounded first delegation that invokes `$relaypact` and creates one reviewable
documentation file.

## Install the versioned release

Before running this block, confirm the official [v0.3.3 GitHub Release](https://github.com/echopath-labs/relaypact/releases/tag/v0.3.3) is visible. If it is unavailable, stop and use [v0.3.2](https://github.com/echopath-labs/relaypact/tree/v0.3.2). A tag alone does not satisfy this precondition.

The installation target is `v0.3.3`:

The previous `v0.1.2`, `v0.1.1` and `v0.1.0` releases remain available for exact
historical installs.

```bash
set -e
git clone --branch v0.3.3 --depth 1 \
  https://github.com/echopath-labs/relaypact.git relaypact-v0.3.3
checkout_commit="$(git -C relaypact-v0.3.3 rev-parse HEAD)"
release_commit="$(git -C relaypact-v0.3.3 rev-parse 'v0.3.3^{}')"
test "$checkout_commit" = "$release_commit"
cd relaypact-v0.3.3
node -e 'const p=require("./package.json"),q=require("./plugin.json"); if(p.version!=="0.3.3"||q.version!==p.version) process.exit(1)'
codex plugin marketplace add "$PWD" --json
codex plugin add relaypact@relaypact-local --json
codex plugin list --marketplace relaypact-local --json
```

An official repository tag is a version selector, **not an independent
cryptographic guarantee**. Compare a full commit SHA only when it came through
a separate trusted channel.

To dogfood mutable current source instead, keep the development-only path
distinct from the released installation and record its exact commit. A `main`
checkout includes only merged work, not every revision described by a candidate
branch or uncommitted working tree:

```bash
git clone --branch main --depth 1 \
  https://github.com/echopath-labs/relaypact.git relaypact-current-source
git -C relaypact-current-source rev-parse HEAD
```

## The lifecycle in one minute

For the Codex capsule route, the candidate stays separate from the source:

`completed` != `accept` != `apply`:

1. `completed` is the executor's result plus candidate evidence. It remains
   pending independent host review.
2. `accept` is an explicit host or human terminal decision after reviewing the
   actual patch, scope, validation, credential safety, and residual risk. The
   patch is still unapplied.
3. `apply` is a later, separately authorized source mutation after the accepted
   archive and current source base are rechecked.

Commit, push, tag, GitHub Release, package publication, and deployment are
further separate actions. Acceptance grants none of these permissions; existing
applicable user authorization can be reused without asking again.

Cursor and Pi use direct workspace execution: changes may already exist before
review. Acceptance does not apply a separate capsule patch and rejection does
not revert the workspace. One-shot results remain pending at the tool level;
only supported persistent modes can record a tool terminal decision.

## Safety and observability

- Credentials stay in host-managed configuration or environment grants, never
  in task envelopes, examples, or public documentation.
- The executor receives only declared context and write authority. A read-only
  path is readable, omitted from writable paths, and not forbidden.
- Route or context failure is fail-closed; RelayPact never silently falls back
  to Pi, Cursor, another harness, provider, or model.
- Host review keeps `relaypactPromptBytes`, `relaypactResultSchemaBytes`, and
  `relaypactDeclaredInputBytes` separate from selected context bytes and
  provider-reported tokens. They are not token, quota, cost, or hidden-harness
  estimates.
- An independent executor makes a separate model request and may consume
  additional quota or cost.
- This is not an operating-system security sandbox. Read
  [SECURITY.md](SECURITY.md) before using untrusted code or credentials.

## Install lifecycle and documentation

- [5-minute getting started](docs/agent-quickstart.md)
- [5 分钟开始使用](docs/agent-quickstart.zh-CN.md)
- [Install, version verification, upgrade, uninstall, troubleshooting, and CLI reference](docs/manual-configuration.md)
- [Codex-to-Codex adapter reference](packages/adapter-codex-codex/README.md)
- [Experimental Codex-to-Cursor adapter reference](packages/adapter-codex-cursor/README.md)
- [Examples](examples/README.md)
- [Release checklist](RELEASING.md)
- [Contribution guide](CONTRIBUTING.md)
- [NOTICE](NOTICE) and [Apache License 2.0](LICENSE) (`Apache-2.0`)

## Changes in v0.3.3

- Return safe, actionable permission-denial diagnostics for recognized Cursor filesystem failures.
- Cover Node error wrappers, additional filesystem operations and paths containing apostrophes.
- Keep raw diagnostics private and preserve failure, scope, timeout and cancellation checks.

See the [changelog](CHANGELOG.md) for details and compatibility notes.

## Development validation

```bash
npm ci --ignore-scripts
npm run check:codex-codex
npm run check:codex-cursor
npm run check
```

The default suite is deterministic and offline. Cursor readiness can be probed
without a model request; real Codex, Cursor execution, Pi, router, and provider
smokes are opt-in and may consume local resources or account quota.

## Large repository evidence

Adapters inspect ignored and untracked content as well as Git changes. The default
filesystem evidence budget is 512 MiB; installed monorepos can exceed it even
with clean Git status. Version 0.3.2 adds explicit Host configuration through
`execution.filesystemEvidenceMaxBytes` (up to 8 GiB), retained throughout the task.
See [the budget reference](skills/relaypact/references/task-envelope.md#filesystem-evidence-budget)
for configuration, costs and remaining limits. Version 0.3.1 keeps the fixed limit.
