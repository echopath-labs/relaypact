# WorkBuddy executor

Experimental macOS single-shot execution through the selected desktop application's
bundled CLI 2.137.1. `mainland` and `international` are mandatory explicit choices;
application metadata, authentication identity and configuration directories are
bound independently. No edition or standalone CodeBuddy fallback exists.

The native harness loads its own desktop configuration. RelayPact does not copy
credentials, set a model, or claim to reproduce a particular open desktop
conversation's model choice. `doctor` checks distribution identity/configuration
presence without starting the harness; authentication remains unverified until a
live invocation. Other CLI versions require fresh compatibility verification.

Only Read is enabled in read-only mode; file tasks enable Read/Write with native
per-invocation path grants. No bare tool-name permission grants are added; native
user/project grants remain additive, so these task grants are not an isolation boundary. Commands, MCP, background tasks and same-session continuation are not
admitted. No global permission bypass is used. Native startup/plugins may still
have side effects; these controls are not an OS sandbox or a credential boundary.
Use a disposable worktree and inspect actual results. Raw native transcripts and
provider diagnostics are not forwarded into RelayPact evidence.

Explicit read scope is preserved; absent `readablePaths` defaults to the writable
paths for this route only. Original forbidden paths deny both Read and Write.
Read-only tasks require a clean repository. Sanitized exposure and context
planning are rejected before native execution.
