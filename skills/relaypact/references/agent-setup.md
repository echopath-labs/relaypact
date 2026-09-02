# Agent-led private setup

Use this reference when the user supplies a goal and repository but has not
prepared a task envelope, worker profile registry, or private state roots.

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

## 3. Propose the delegation before writing it

Show the user or host:

- coordinating-host identity and how the executor will be distinguishable;
- objective and exact expected outcome;
- `readablePaths` and why each is required;
- `allowedPaths` and why each requires write authority;
- `forbiddenPaths`;
- host-owned validation argument arrays and timeouts;
- stop conditions and residual risk;
- selected Codex profile type: native, direct Responses provider, or optional
  loopback router;
- absolute private locations for envelope, profile registry, task state, and
  review archive;
- any decision that cannot be safely inferred.

For every read-only file, keep it in `readablePaths`, omit it from
`allowedPaths`, and ensure it does not match `forbiddenPaths`. Do not start the
executor with contradictory readable and forbidden authority.

Do not start the executor while material scope, validation, route, credential
availability, or reserved terminal authority is ambiguous.

## 4. Create private roots

Use pre-existing real directories outside the target repository. If the user
authorizes their creation, use restrictive permissions such as `0700` where
supported. Suggested logical layout:

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

Read `task-envelope.md` and create a complete envelope. The envelope may name a
worker profile but must not contain:

- API keys, bearer tokens, session cookies, or authentication files;
- personal proxy addresses or proxy credentials;
- raw logs or provider responses;
- private workspace notes;
- authority not shown in the pre-execution proposal.

Keep readable and writable authority separate. Read-only context is readable,
not writable, and not forbidden. Prefer the smallest focused dependency
closure. If context discovery is uncertain, use bounded planned
context and readiness rather than granting the complete repository by default.

## 6. Prepare or select a worker profile

Prefer an existing host-approved named profile. If none is available, prepare
credential-free metadata only:

- native route: selected Codex profile, explicit model, reasoning, and minimal
  environment allowlist;
- direct route: provider name, compatible `/v1` Responses base URL, explicit
  model, and credential environment-variable name;
- router route: selected Codex profile plus a loopback health URL.
- Cursor harness: no RelayPact model profile; use the model already configured
  by the user inside Cursor and report only model metadata Cursor actually emits.

The actual credential remains in host-owned configuration or the named process
environment. Ask whether it is available; do not ask the user to paste its
value into chat or a file. Do not inspect unrelated Pi, OpenCode, MCP, provider,
or global Codex configuration.

Route failure is fail-closed. Never substitute another provider, model, router,
Pi, OpenCode CLI, OpenCodex, or execution harness without a new explicit host
decision.

## 7. Confirm and invoke

Present the final envelope/profile paths and a concise scope summary. After all
material decisions are resolved, follow `invocation.md` and use the Skill-local
wrapper. Retain the returned task root and bounded structured result.

Do not edit task lifecycle state, task controls, or review evidence manually.

## 8. Explain evidence and decision choices

Read the pending host review packet and candidate patch. Explain:

- executor status versus host-observed eligibility;
- actual changed paths and scope breaches;
- host validation results;
- credential-evidence safety and private-control status;
- candidate patch identity and relevant diff;
- unresolved risks;
- whether a same-session correction is still within authority or a new task is
  required.

Present `accept`, `reject`, or `abandon` only when supported by current evidence
and user-granted authority. A terminal decision archives evidence but never
applies the patch or performs Git, release, publication, or deployment actions.
