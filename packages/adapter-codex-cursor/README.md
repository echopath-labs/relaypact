# @relaypact/adapter-codex-cursor

Experimental adapter for explicit Codex-hosted delegation to a local Cursor CLI
executor. The adapter composes Cursor transport with RelayPact's independent Git,
filesystem, scope, validation, and pending-acceptance checks.

The one-shot `runDelegation` path remains pending-only. When a private
`stateRoot` and coordinating `hostInstanceId` are supplied together, the
adapter uses RelayPact's harness-neutral signed direct-worktree lifecycle.
That lifecycle retains a protected Cursor session handle, original execution
authority, and resolved executable identity for same-task correction. It
refuses review, permission, executable, or scope drift and archives an explicit
accept/reject/abandon decision before deleting task-private state. A task that
fails before a current review exists, or is left `prepared` or `running` by an
interrupted owner, can only be explicitly abandoned. RelayPact archives a
bounded failure or interruption receipt only when cleanup is safe. A live Host
returns `task_state_busy`; a non-prepared task without signed execution-completion
evidence returns `execution_stop_unverified` and keeps all recovery state. It never applies, commits,
pushes, publishes, or deploys the candidate.

Terminal decisions enter through the declared `host-codex` package. The adapter
does not independently authorize acceptance, rejection, abandonment, or archive
cleanup. Host finalization prepares and verifies the archive, checks the
candidate basis before and after the terminal state commit, and rolls back to the
recoverable pending state if the post-commit basis changed. Failed- or
interrupted-task abandon receipt creation and its terminal transition share the
same signed-state lock.
