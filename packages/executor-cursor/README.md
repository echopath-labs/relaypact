# @relaypact/executor-cursor

Experimental local Cursor CLI executor for the explicit `codex-cursor` route.

RelayPact selects Cursor as the execution harness, probes local CLI readiness,
passes a bounded task envelope, and normalizes structured execution evidence.
Cursor remains responsible for its own authentication and model configuration.
RelayPact never selects or changes the Cursor model.

Readiness probes share the Host cancellation signal across version, capability,
authentication-status, and final executable-identity checks. Cancellation stops
later probes and candidate fallback before any Agent request starts.

Session identity is non-enumerable in ordinary executor results. The persistent
adapter may place the raw handle only in HMAC-bound, mode-0600 task-private state
for an explicit same-task correction. Before retaining that handle, discovery
resolves the selected executable to an absolute real path. Native launchers run
from a private content-verified snapshot. Shell launchers must belong to a
recognized, bounded `@anysphere/agent-cli-runtime` installation bundle. RelayPact
fingerprints and snapshots that complete static bundle—including launcher-relative
companions—before execution, while excluding the runtime-only `.running`
directory. The complete static bundle is bounded to 768 MiB, 1,024 files and
16 directory levels. Standalone binaries shipped alongside the Node entrypoint
remain part of the fingerprint and private snapshot; they are not omitted to
fit the budget. Larger or otherwise unsupported installations remain blocked.
RelayPact validates the launcher's system-Bash form but does not execute
its shell logic for protected work. It uses a fixed `shell: false` launch profile
to invoke the verified snapshot `node` and `index.js` by absolute path, with a
trusted `CURSOR_INVOKED_AS` value. Any launcher-declared `--use-system-ca` path
is selected only after the fingerprint-matched runtime accepts the same bounded
version probe. A conclusive unsupported-option result selects the no-flag path;
inconclusive probes block readiness without caching an alternative identity.
Inherited `PATH` is therefore not consulted before protected task or session data
reaches Cursor, while Cursor retains the bounded Host PATH for delegated tool
execution. The signed fingerprint binds the bundle, launcher, validated
interpreter, runtime, selected runtime flags, and direct-launch profile.
An empty `allowedPaths` array forces Cursor plan mode and never grants `--force`.
Correction verifies that complete launch identity and preserves the original
read-only or write authority before the handle can be reused. Identity mismatch
is retained as a bounded machine-readable failure code through Host review.
Public review and terminal archives retain only bounded evidence and never the
raw handle.

Cursor terminal evidence is accepted only when one unambiguous supported
structured payload is present. RelayPact recognizes a complete result, one
complete JSON line, a JSON Markdown fence, or a trailing multiline JSON object;
multiple distinct candidates remain malformed and ineligible for Host
acceptance.
