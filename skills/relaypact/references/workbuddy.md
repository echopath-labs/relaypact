# Codex Host → WorkBuddy executors

Read this reference only after explicitly selecting WorkBuddy. Codex remains
Host. Mainland **WorkBuddy** and international **WorkBuddy AI** share the adapter
but have separate support entries. They are not interchangeable credentials or
fallbacks. These experimental routes are included in v0.3.1.

## Requirements and configuration

The current admission is macOS, Node.js 20+, the selected installed desktop app,
and its bundled CLI 2.137.1. Each edition must already have working native login
and model configuration. Other builds require compatibility verification.

Use `--edition mainland` or `--edition international` on every invocation. The
default app path is the matching application in `/Applications`; `--app` selects
an explicit installation whose product identity must still match. Directory
binding follows the selected product's native data folder. RelayPact does not
copy credentials, force a model, or reuse another edition's login. Model selection
belongs to the native configuration; an open desktop conversation may have a
separate per-session choice that this route does not reproduce.

Inspect installation/configuration presence without starting the harness:

```text
node <skill-directory>/scripts/relaypact.mjs doctor
  --route codex-workbuddy --edition mainland

node <skill-directory>/scripts/relaypact.mjs doctor
  --route codex-workbuddy-ai --edition international
```

`available` is not an authentication or model-health claim. A login/provider
failure in a live task stays blocked/failed and must be resolved in that edition.
Both doctor routes require the matching explicit edition; conflicting selections
are rejected before inspecting an installation.

## Bounded file tasks

Prepare the standard task envelope with explicit objective, readable context,
writable paths, constraints, stop conditions, required evidence and independent
Host validation. Prefer a disposable worktree. Read-only tasks require a clean
tree and reject existing dirty paths before launching, even when acknowledged.
Select the edition explicitly:

```text
node <skill-directory>/scripts/relaypact.mjs run-workbuddy
  --edition international --envelope <task-envelope.json> --read-only

node <skill-directory>/scripts/relaypact.mjs run-workbuddy
  --edition mainland --envelope <task-envelope.json>
```

Read-only mode offers only Read and rejects observed repository mutations. Write
mode offers Read/Write under native scoped `--settings` permission grants and
`dontAsk`. These grants affect only this invocation and do not edit desktop
settings. Native permission rules are additive: pre-existing user/project grants
may authorize more than these task-specific grants. The adapter does not add
bare tool-name permission grants or claim to intersect all native policy with
the envelope. Paths are canonicalized before constructing absolute native rules;
unsupported native pattern syntax is rejected. The executor cannot run shell
checks through this route; put required checks in the envelope for the Host to
run independently. MCP tools and background tasks are excluded. Do not add a
permission-bypass flag to make a blocked task appear successful.

Explicit `readablePaths` defines the added Read grants, including an empty list.
When omitted, this route defaults Read grants to `allowedPaths`. Writable paths
do not expand an explicit read scope. Original `forbiddenPaths` deny both Read
and Write; repository control directories are also denied. If native Write
requires reading an existing file outside the read scope, report blocked and
request the missing authority instead of adding it implicitly.

Native `dontAsk` otherwise permits reads inside its working directory without an
allow rule. This route adds a repository-wide Read `ask` rule after explicit
allows; noninteractive execution rejects those unmatched reads. Pre-existing
native allow rules still take priority over ask rules, as described above.

These tool restrictions are not an OS sandbox. Native settings, hooks, plugins
and startup services remain harness-owned and may perform their own operations.
Filesystem evidence covers the target repository, not every external effect.
The route does not inventory native stored credentials. Review resulting content
before sharing it. Requested sanitized capsules and `contextPlanning` are
rejected by this native worktree route. Do not pass untrusted work requiring
stronger isolation.

## Delivery and correction

The JSON transport's `success` only describes the turn. A task may report blocked
inside that successful turn, even with an empty `permission_denials` field. The
adapter requires a terminal task result and independently checks actual scope and
validation. Raw transcripts, session handles and provider diagnostics are omitted
from returned evidence. Model observation remains unavailable unless a future
verified protocol provides it.

Execution leaves acceptance pending. Host inspects the diff and checks before
accepting delivery. Acceptance does not commit, publish, apply or revert changes.

Same-session resume and persistent terminal decisions are not admitted for this
route. For correction, create a fresh envelope containing the previous delivery,
required change and unchanged authority. Explicitly acknowledge any existing dirty
paths; never clear the tree to hide an earlier attempt.
