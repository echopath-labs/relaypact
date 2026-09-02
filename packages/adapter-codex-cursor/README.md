# @relaypact/adapter-codex-cursor

Experimental adapter for explicit Codex-hosted delegation to a local Cursor CLI
executor. The adapter composes Cursor transport with RelayPact's independent Git,
filesystem, scope, validation, and pending-acceptance checks.

The one-shot `runDelegation` path remains pending-only. When a private
`stateRoot` and coordinating `hostInstanceId` are supplied together, the
adapter uses RelayPact's harness-neutral signed direct-worktree lifecycle.
That lifecycle retains a protected Cursor session handle for same-task
correction, refuses review drift or scope expansion, and archives an explicit
accept/reject/abandon decision before deleting task-private state. It never
applies, commits, pushes, publishes, or deploys the candidate.
