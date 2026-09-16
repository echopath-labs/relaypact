# RelayPact: 5-minute Codex-to-Codex getting started

[English](agent-quickstart.md) | [简体中文](agent-quickstart.zh-CN.md)

This guide takes a clean Git repository from installation to one bounded,
reviewable Codex-to-Codex candidate. RelayPact uses an independent `codex exec`
from the existing Codex CLI; there is no second executor package.

RelayPact's shared purpose is to guide the Host's delegation and acceptance.
This tutorial covers the v0.2.0 Codex capsule tooling. Its
[Host guidance](../skills/relaypact/SKILL.md) separates common responsibilities
from CLI setup.
The candidate in this tutorial remains unapplied until a later authorized action.

Current release truth:

- `v0.2.0` is the latest published release; `v0.1.2` and `v0.1.1` remain available.
- This guide installs the versioned tag and verifies its peeled commit SHA.
- Pi is experimental and inactive; it is not installed, loaded, or used here.

For exact CLI and JSON fields, use the
[manual configuration reference](manual-configuration.md).

## Minute 0: check prerequisites

You need Node.js 20 or later, Git, and Codex CLI 0.147.0 or later:

```bash
node --version
git --version
codex --version
codex exec --help
```

Codex Desktop alone does not prove that the CLI or `codex exec` is available.
The independent worker makes a separate model request and may consume additional
quota or cost.

## Minute 1: install and verify the v0.2.0 release

Give the coordinating Codex instance this prompt:

```text
Clone the versioned v0.2.0 release tag from
https://github.com/echopath-labs/relaypact into a local tools directory outside
my target repository. Record the exact checkout commit SHA and verify it against
the peeled v0.2.0 tag commit. Verify package.json and plugin.json both report 0.2.0; read README.md
and the nearest AGENTS.md; verify Node.js 20+, Git, Codex CLI 0.147.0+, and
`codex exec --help`. Install the root Plugin through its local marketplace.
Without reading credentials, contacting a provider, or starting a worker, run
the installed Skill-local `support` and `doctor` commands. Report the exact
commit, versions, Plugin and Skill discovery, Codex-to-Codex readiness, and any
remaining setup. Do not accept, apply, commit, push, tag, publish, release, or
deploy anything.
```

The equivalent release commands are:

```bash
git clone --branch v0.2.0 --depth 1 \
  https://github.com/echopath-labs/relaypact.git relaypact-v0.2.0
checkout_commit="$(git -C relaypact-v0.2.0 rev-parse HEAD)"
release_commit="$(git -C relaypact-v0.2.0 rev-parse 'v0.2.0^{}')"
test "$checkout_commit" = "$release_commit"
cd relaypact-v0.2.0
node -e 'const p=require("./package.json"),q=require("./plugin.json"); if(p.version!=="0.2.0"||q.version!==p.version) process.exit(1)'
codex plugin marketplace add "$PWD" --json
codex plugin add relaypact@relaypact-local --json
codex plugin list --marketplace relaypact-local --json
```

An official tag is a version selector, not an independent cryptographic
guarantee. For current-source dogfood, use a separate development-only checkout,
record its exact commit, and never present it as the release installation:

```bash
git clone --branch main --depth 1 \
  https://github.com/echopath-labs/relaypact.git relaypact-current-source
git -C relaypact-current-source rev-parse HEAD
```

## Minute 2: start a fresh Codex task

Start a new Codex task so `$relaypact` appears in the Skill catalog. Ask the
Agent to run the installed Skill-local `support` and `doctor` commands
again. They do not load Pi, inspect credentials, contact a provider, or start a
worker.

Expected readiness report:

- Codex CLI and `codex exec` versions/capability;
- Plugin, marketplace `relaypact-local`, and Skill discovery;
- static `codex-codex: public-preview` support;
- local `ready`, `needs_setup`, or `blocked` state with remediation.

## Minute 3: run a real first delegation

Choose a clean Git repository where adding one documentation file is safe.
Replace `<absolute target repository>` below, then send:

```text
Use $relaypact for this bounded Codex-to-Codex delegation.

Target repository: <absolute target repository>
Goal: create docs/relaypact-first-delegation.md containing a concise onboarding
checklist: how to find the nearest agent instructions, how to run the project's
documented validation, and when to stop for human authority.

Before execution, read only README.md and the nearest AGENTS.md if they exist.
Allow writing only docs/relaypact-first-delegation.md. Keep .git, credentials,
environment files, existing source files, and all other paths forbidden from
mutation. Use only the Codex-to-Codex public-preview route with a host-approved
Codex profile; never fall back to Pi, another harness, provider, or model.

Use host validations equivalent to:
- ["git", "diff", "--check"]
- ["test", "-s", "docs/relaypact-first-delegation.md"]

Keep envelope, profile, state, and archive data in a private directory outside
the target repository. Show me host/executor identities, exact readable and
writable paths, validations, route, private locations, and unresolved authority
before starting the worker. After the worker returns, inspect the actual patch,
scope and validation evidence, credential safety, and residual risk.

Stop after reporting whether the executor returned completed and whether the
candidate is eligible for acceptance. Do not accept, apply, commit, push, tag,
publish, release, or deploy.
```

The Agent should refuse a dirty target unless every pre-existing path is
explicitly acknowledged. Read-only paths belong in `readablePaths`, are
omitted from `allowedPaths`, and must not match `forbiddenPaths`.

## Minute 4: review the candidate

The executor's `completed` status is self-report, not acceptance. The
coordinating host must independently explain:

- actual changed paths and candidate patch;
- source/capsule baseline and scope evidence;
- host-run validation results;
- credential-evidence safety;
- unresolved risks and acceptance eligibility.

Review metrics keep `relaypactPromptBytes`,
`relaypactResultSchemaBytes`, `relaypactDeclaredInputBytes`, copied context
bytes, and provider-reported tokens separate. The RelayPact byte counts are not
token, quota, cost, hidden-harness, or overhead estimates.

If scope, context, or route authority must change, create a new task. Use a
same-session correction only for defects inside the original identity and
authority.

## Minute 5: decide, then apply separately

`completed` != `accept` != `apply`:

- `completed`: executor result; review is still pending.
- `accept`: explicit host/human decision after independent evidence review;
  the candidate patch remains unapplied.
- `apply`: later source mutation after the accepted archive identity and
  current source base are rechecked, with separate approval.

The other terminal choices are `reject` and `abandon`. If the candidate is
accepted, use a separate prompt:

```text
This delegation was accepted. Re-read the archived candidate patch and verify
that its evidence identity matches the accepted record. Explain every file that
would be applied and confirm that the source base has not drifted. Wait for my
separate approval. Do not apply, commit, or push yet.
```

Commit, push, tag, GitHub Release, package publication, and deployment each need
further separate authority.

## First-run troubleshooting

| Symptom | Recovery |
| --- | --- |
| `codex` or `codex exec` unavailable | Install or upgrade the supported CLI; no separate executor package exists. |
| `doctor` says `needs_setup` | Re-add the source checkout as `relaypact-local`, install the Plugin, start a new task, and rerun doctor. |
| Plugin installed but `$relaypact` is absent | Start a new Codex task and inspect `codex plugin list --marketplace relaypact-local --json`. |
| Target repository is dirty | Use a clean repository or explicitly acknowledge every pre-existing path and review burden. |
| Native Codex authentication is unavailable | Repair the selected host-owned Codex profile; never paste credentials into task files. |
| Context or scope is insufficient | Stop and request a new bounded task; do not expand a correction silently. |
| Validation or scope evidence fails | Do not accept; preserve evidence and correct within the existing boundary or start a new task. |
| Provider or stream fails | Fail closed; do not change harness, provider, model, or route without new approval. |

Install/version verification, published `v0.1.0` installation, upgrade,
uninstall, private archive retention, and complete troubleshooting are in the
[manual](manual-configuration.md). Optional provider-specific configuration is
separate from this first path; see [OpenCode Go / Luna](opencode-go-luna.md)
only when explicitly selected.

RelayPact is licensed under the
[Apache License 2.0](../LICENSE) (`Apache-2.0`).
