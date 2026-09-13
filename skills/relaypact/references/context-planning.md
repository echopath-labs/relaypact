# Codex capsule context planning

Read this reference only when preparing context for the Codex capsule tooling.
These planner fields are not prerequisites for the shared Host requirements or
for Cursor/Pi direct execution.

For the selected Codex task, choose one mode explicitly:

- **Explicit:** omit `contextPlanning`; only literal `scope.readablePaths` are
  copied.
- **Planned:** keep exact explicit inclusions in `readablePaths`, grant maximum
  additional read authority in `discoverablePaths`, and declare literal seeds,
  analyzers, budgets, and optional readiness commands in `contextPlanning`.

Planned mode is selection within authority, not authority discovery. Every
selected dependency must remain repository-relative, match discovery authority
unless already explicitly readable, avoid forbidden/private paths and symlinks,
and fit the declared file, byte, and depth budgets. Failure must stop before
worker invocation; never widen the boundary, switch route, or select
`trusted-worktree` automatically.

The initial `node-esm` analyzer supports `.js` and `.mjs` static imports, static
re-exports, and literal dynamic imports without module execution. Computed or
ambiguous references fail closed. Add known non-source context such as package
metadata, instructions, schemas, or fixtures explicitly when static imports
cannot identify it.

Readiness commands run without a shell in the provisional sanitized capsule with
a minimized environment, timeout, bounded redacted output, and mutation checks.
They answer whether the context can start the task; postflight validation still
answers whether the implementation works.

Review the manifest fingerprint, aggregate selected files/bytes, budget
utilization, readiness outcome, and any executor `context_gap` separately from
validation and acceptance. Additional context always creates a new planned task
and manifest identity.
