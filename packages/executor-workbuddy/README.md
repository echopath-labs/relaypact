# WorkBuddy executor

Experimental macOS single-shot execution through the selected desktop application's
bundled CLI 2.137.1. `mainland` and `international` are mandatory explicit choices;
application metadata, authentication identity and configuration directories are
bound independently. No edition or standalone CodeBuddy fallback exists.

The native harness loads its own desktop authentication and configuration.
RelayPact does not copy credentials or change persistent settings. Every task
requires one exact Host-selected model, verifies that ID through the admitted
CLI's bounded `--help` surface, and passes it with one `--model` argument without
a fallback. Model binding does not prove provider use, entitlement, price or free
status. `doctor` without a model checks distribution identity/configuration
presence; `doctor --model` performs the same non-model help preflight used by a
task. When that exact ID is absent from the admitted list, doctor and task
execution both stay blocked, and the doctor result adds `modelDiscovery`: the
bounded, sanitized canonical IDs already parsed from the same help. Raw native
help is never retained or returned, and no normalization, default, fallback or
substitution is applied. Authentication remains unverified until live invocation.
Other CLI versions require fresh compatibility verification.

Only Read is enabled in read-only mode; file tasks enable Read/Write with native
per-invocation path grants. No bare tool-name permission grants are added; native
user/project grants remain additive, so these task grants are not an isolation boundary. Commands, MCP, background tasks and same-session continuation are not
admitted. No global permission bypass is used. Native startup/plugins may still
have side effects; these controls are not an OS sandbox or a credential boundary.
Use a disposable worktree and inspect actual results. Raw native transcripts and
provider diagnostics are not forwarded into RelayPact evidence.

Explicit read scope is preserved; absent `readablePaths` defaults to the writable
paths for this route only. Original forbidden paths deny both Read and Write.
Repository Read ask rules prevent dontAsk's automatic working-directory reads
when no explicit native allow matches. Existing native allow rules still precede
ask rules; this does not intersect all native policy with the task envelope.
Read-only tasks require a clean repository. Sanitized exposure and context
planning are rejected before native execution.
