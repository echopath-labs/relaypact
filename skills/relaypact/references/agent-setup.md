# RelayPact CLI setup

Read this reference after selecting a RelayPact CLI route and only prepare the
artifacts that route requires. The shared Host requirements do not require CLI
setup. Codex uses an envelope, worker profile registry and private lifecycle
roots; Cursor uses an envelope and optional persistent lifecycle roots; Pi and
WorkBuddy use an envelope. WorkBuddy also requires an explicit mainland or
international edition. These direct executors do not require a Codex profile registry.

The Agent prepares configuration; the human or coordinating host owns material
authority and final acceptance.

## 1. Discover support first

Resolve `scripts/relaypact.mjs` relative to the installed Skill
directory and run:

```text
node <skill-directory>/scripts/relaypact.mjs support
node <skill-directory>/scripts/relaypact.mjs doctor
```

Do not load Pi, Cursor, a provider, a router, or credentials during default
support discovery. Probe Cursor only after explicit route selection with
`doctor --route codex-cursor`; that diagnostic must not invoke a model.
For WorkBuddy, explicitly select `doctor --route codex-workbuddy --edition mainland`
or `doctor --route codex-workbuddy-ai --edition international`;
it checks distribution identity and configuration presence,
not authentication. See [workbuddy.md](workbuddy.md) for native configuration and
bounded file-task limits.
Use `support-matrix.json` as the route-status authority. Treat doctor as local
readiness only: report the Codex CLI version, `codex exec`, packaged Skill,
marketplace/plugin visibility, aggregate state, and remediation. `needs_setup`
does not mean the runtime is incompatible, and a `ready` doctor does not prove
live provider availability. Do not claim plugin discovery from source-file
presence alone.

## 2. Inspect the target repository

Resolve the Git root and nearest repository instructions. Inspect status,
relevant files, focused tests, and dependency closure using read-only checks.
Refuse a dirty tree unless the user explicitly acknowledges every pre-existing
path and accepts the additional review burden.

Do not search for credentials or read private authentication merely to prepare
the task.

Before a sanitized delegation, check the dependency closure of the actual
validation commands, including subprocess entrypoints, templates, fixtures and
other files loaded dynamically. A selected-file count or zero static unresolved
imports does not prove that the tests can run. Use a bounded, non-mutating
readiness check when supported and useful; otherwise inspect the needed inputs
before launch. A `context_gap` is missing context evidence, not successful
validation. Add only the missing read authority and start a new task when the
selected route requires a new context identity.

## 3. Propose the delegation before writing it

Show the user or host:

- coordinating-host identity and how the executor will be distinguishable;
- objective and exact expected outcome;
- `readablePaths` and why each is required;
- `allowedPaths` and why each requires write authority;
- `forbiddenPaths`;
- host-owned validation argument arrays and timeouts;
- stop conditions and residual risk;
- for Codex, selected profile type: native, direct Responses provider, or optional
  loopback router;
- absolute private locations for the envelope and, where the route uses them,
  profile registry, task state and review archive;
- any decision that cannot be safely inferred.

For every read-only file, keep it in `readablePaths`, omit it from
`allowedPaths`, and ensure it does not match `forbiddenPaths`. Do not start the
executor with contradictory readable and forbidden authority.

Do not start the executor while material scope, validation, route, credential
availability, or reserved terminal authority is ambiguous.

## 4. Create private roots

Use pre-existing real directories outside the target repository. Where their
creation is covered by existing user authority, use restrictive permissions such
as `0700` where supported. Resolve missing authority only when needed. Create only the
directories required by the selected route; a Codex lifecycle layout is:

```text
<private-root>/
  envelopes/
  profiles/
  state/
  archive/
```

Never place these files under the public plugin checkout, target repository,
cloud-synchronized public directory, or a path intended for commit.

## 5. Prepare a credential-free envelope

Read [task-envelope.md](task-envelope.md) and create a complete envelope. It may
name a worker profile but must not contain:

- API keys, bearer tokens, session cookies, or authentication files;
- personal proxy addresses or proxy credentials;
- raw logs or provider responses;
- private workspace notes;
- authority not shown in the pre-execution proposal.

Keep readable and writable authority separate. Read-only context is readable,
not writable, and not forbidden. Prefer the smallest focused dependency
closure. For Codex, uncertain context discovery can use bounded planned context
and readiness. For direct routes, resolve missing context before delegation; never
grant the complete repository merely to avoid framing the task.

## 6. Configure only the selected route

For Codex, default external routes to a sanitized capsule; never switch to
`trusted-worktree` automatically. Prefer an existing host-approved named
profile. If none is available, prepare credential-free metadata only:

- native route: selected Codex profile, explicit model, reasoning, and minimal
  environment allowlist;
- direct route: provider name, compatible `/v1` Responses base URL, explicit
  model, and credential environment-variable name;
- router route: selected Codex profile plus a loopback health URL.

For Cursor, use the model and authentication already configured by the user
inside Cursor; never write Cursor model configuration or add a model flag.
Report only model metadata Cursor actually emits. For Pi, use its existing
adapter [configuration rules](../../../packages/adapter-codex-pi/README.md);
no Codex profile registry is required.

The actual credential remains in host-owned configuration or the named process
environment. Resolve availability only when it is unknown; do not ask the user
to paste its value into chat or a file. Do not inspect unrelated Pi, OpenCode, MCP, provider,
or global Codex configuration.

Route failure is fail-closed. Never substitute another provider, model, router,
Pi, OpenCode CLI, OpenCodex, or execution harness without a new explicit host
decision.

## 7. Confirm and invoke

Present the final envelope/profile paths and a concise scope summary. After all
material decisions are resolved, follow [invocation.md](invocation.md) and use
the Skill-local wrapper. Retain the bounded structured result and task root when the
selected mode creates one. Reuse already resolved authority without a second
confirmation.

Do not edit task lifecycle state, task controls, or review evidence manually.

## 8. Explain evidence and decision choices

Read the available review evidence and actual artifact: the Codex capsule
candidate patch or the direct workspace changes for Cursor/Pi/WorkBuddy. Explain:

- executor status versus host-observed eligibility;
- actual changed paths and scope breaches;
- host validation results;
- credential-evidence safety and private-control status;
- artifact identity and relevant diff;
- unresolved risks;
- whether a same-session correction is still within authority or a new task is
  required.

Present `accept`, `reject`, or `abandon` only when supported by current evidence
and user-granted authority. For Codex and persistent Cursor, a supported terminal
decision archives evidence but never applies a patch or performs Git, release,
publication or
deployment actions. Cursor/Pi/WorkBuddy execution can already have changed the workspace;
rejection does not revert it. One-shot results remain pending at the tool level.
For unsupported terminal commands, explain the Host review separately instead
of fabricating a lifecycle decision.
