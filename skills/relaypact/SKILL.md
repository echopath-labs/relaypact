---
name: relaypact
description: Use when Codex should delegate a bounded engineering task to an independent supported executor harness while retaining scope control, evidence review, risk judgment, and final acceptance responsibility.
---

# RelayPact

Delegate implementation without delegating ownership or acceptance.

1. Resolve the Skill-local wrapper and run `support` plus `doctor` without
   loading an executor or provider. Keep static route support separate from
   local runtime/plugin readiness. Report Codex CLI version, `codex exec`,
   plugin/Skill visibility, aggregate readiness, and remaining setup without
   reading authentication. Probe Cursor only with the explicit
   `doctor --route codex-cursor` selection; this must not invoke a model.
   Confirm the target Git root and read the nearest repository instructions.
2. When the user provides intent but no prepared task files, read
   `references/agent-setup.md`. Propose the material scope, context, validation,
   route, and private locations; then prepare a credential-free envelope and
   profile registry outside the target repository. Ask only for decisions that
   cannot be safely inferred, and do not start execution before those decisions
   are resolved.
3. Construct or verify the complete task envelope using
   `references/task-envelope.md`. Do not include credentials.
4. Choose exact explicit context or bounded planned context using
   `references/context-planning.md`. Keep readable and writable authority
   separate and declare readiness and validation as distinct argument arrays.
5. Refuse a dirty repository by default. Use an override only when every
   pre-existing path is recorded and the user accepts the review burden.
6. Select the Executor Harness explicitly. For Codex, select a host-approved
   named worker profile and default external Codex routes to a sanitized
   capsule. For Cursor, leave authentication and model selection inside Cursor;
   never write Cursor model configuration. Do not substitute Pi, Cursor,
   OpenCode, or another Agent harness when the selected route is unavailable.
7. Before invoking the executor, show the coordinating-host and executor
   identities, readable/writable/forbidden paths, validation commands, selected
   route, private state/archive locations, and any reserved human decision.
8. Read `references/invocation.md`, resolve the Skill-local wrapper relative to
   this file, invoke only the explicit selected-harness command, and retain its
   structured result and available delegated identity. Never guess a
   source-checkout path.
9. Treat any scope breach, failed validation, malformed output, or missing
   evidence as ineligible for acceptance.
10. Inspect the actual Git diff and evidence independently, and explain the
    observed changes, validations, credential-evidence status, and residual
    risks before proposing a terminal decision.
11. Issue an explicit terminal decision only where the selected route supports
   it and only within user-granted authority. Cursor's one-shot direct-worktree
   result remains pending-only; use its private state-root mode before claiming
   correction or terminal-decision support.
   Acceptance archives evidence but never applies, commits, pushes, tags,
   publishes, or deploys the candidate.

Executor completion is never final acceptance. A context change requires a new
task identity, not silent correction-session expansion. See the on-demand
references for Agent-led setup, context planning, result interpretation, scope
breaches, and correction requests.
