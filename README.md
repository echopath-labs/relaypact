# RelayPact

[English](README.md) | [简体中文](README.zh-CN.md)

RelayPact lets one Codex Agent Instance delegate bounded engineering work to an
independent Codex executor while the coordinating Codex retains scope, evidence
review, risk judgment, and final acceptance.

The first and only active Public Preview route is **Codex → Codex**. RelayPact
provides the workflow, isolation, evidence, and acceptance controls; execution
comes from an independent `codex exec` process in the user's existing Codex
CLI. No second Codex installation or executor package is required.

**No additional executor installation is required.**

## Release status

- Public source version: **0.1.2 Public Preview**.
- Latest published release: **v0.1.2**.
- Support: `codex-codex` is `public-preview`; `codex-pi` remains
  `experimental` and inactive; `codex-cursor` is source-included,
  `experimental`, and inactive at the root Plugin.

[`support-matrix.json`](support-matrix.json) is authoritative. The Cursor route
must be selected explicitly and requires a compatible authenticated local Cursor
CLI. Cursor owns its authentication and model selection; RelayPact only observes
model metadata when Cursor reports it. Pi, Cursor, OpenCode CLI, OpenCodex, a
third-party provider, and any particular model are not prerequisites or
fallbacks for the Codex-to-Codex path.

Cursor's one-shot command remains pending-only. Its optional private state-root
mode adds signed persistent review, protected same-session correction, and an
explicit archived terminal decision without changing Cursor's model settings or
applying source changes. Persistent correction preserves the original read-only
or write authority and verifies the bound absolute Cursor launcher plus any
resolved shebang interpreter before resuming; a failed task can be explicitly
abandoned and privately cleaned.

This preview is human-reviewed and is not intended for unattended or
production-critical use. Validated prerequisites are Node.js 20 or later, Git,
and Codex CLI 0.147.0 or later with both `codex --version` and
`codex exec --help` available. macOS is locally validated; Ubuntu is claimed
for a release only after its exact candidate passes public CI. Windows support
is not yet claimed.

## Five-minute start with the v0.1.2 release

Use the versioned `v0.1.2` tag for a reproducible release installation.

Give a coordinating Codex instance this prompt:

```text
Clone the versioned v0.1.2 release tag from
https://github.com/echopath-labs/relaypact into a local tools directory outside
my target repository. Record the exact checkout commit, verify it against the
peeled v0.1.2 tag commit, and verify that package.json and plugin.json both
report 0.1.2.
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
git clone --branch v0.1.2 --depth 1 \
  https://github.com/echopath-labs/relaypact.git relaypact-v0.1.2
checkout_commit="$(git -C relaypact-v0.1.2 rev-parse HEAD)"
release_commit="$(git -C relaypact-v0.1.2 rev-parse 'v0.1.2^{}')"
test "$checkout_commit" = "$release_commit"
cd relaypact-v0.1.2
node -e 'const p=require("./package.json"),q=require("./plugin.json"); if(p.version!=="0.1.2"||q.version!==p.version) process.exit(1)'
codex plugin marketplace add "$PWD" --json
codex plugin add relaypact@relaypact-local --json
codex plugin list --marketplace relaypact-local --json
```

Start a new Codex task after installation, then follow the
[5-minute getting started guide](docs/agent-quickstart.md). It includes a real,
bounded first delegation that invokes `$relaypact` and creates one reviewable
documentation file.

## Install the latest published release

The latest published release is `v0.1.2`:

The previous `v0.1.1` and `v0.1.0` releases remain available for exact
historical installs.

```bash
git clone --branch v0.1.2 --depth 1 \
  https://github.com/echopath-labs/relaypact.git relaypact-v0.1.2
checkout_commit="$(git -C relaypact-v0.1.2 rev-parse HEAD)"
release_commit="$(git -C relaypact-v0.1.2 rev-parse 'v0.1.2^{}')"
test "$checkout_commit" = "$release_commit"
cd relaypact-v0.1.2
codex plugin marketplace add "$PWD" --json
codex plugin add relaypact@relaypact-local --json
codex plugin list --marketplace relaypact-local --json
```

An official repository tag is a version selector, **not an independent
cryptographic guarantee**. Compare a full commit SHA only when it came through
a separate trusted channel.

To dogfood mutable current source instead, keep the development-only path
distinct from the released installation and record its exact commit:

```bash
git clone --branch main --depth 1 \
  https://github.com/echopath-labs/relaypact.git relaypact-current-source
git -C relaypact-current-source rev-parse HEAD
```

## The lifecycle in one minute

`completed` != `accept` != `apply`:

1. `completed` is the executor's result plus candidate evidence. It remains
   pending independent host review.
2. `accept` is an explicit host or human terminal decision after reviewing the
   actual patch, scope, validation, credential safety, and residual risk. The
   patch is still unapplied.
3. `apply` is a later, separately authorized source mutation after the accepted
   archive and current source base are rechecked.

Commit, push, tag, GitHub Release, package publication, and deployment are
further separate actions. RelayPact never infers one authority from another.

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

## Development validation

```bash
npm run check:codex-codex
npm run check:codex-cursor
npm run check
```

The default suite is deterministic and offline. Cursor readiness can be probed
without a model request; real Codex, Cursor execution, Pi, router, and provider
smokes are opt-in and may consume local resources or account quota.
