# @relaypact/executor-cursor

Experimental local Cursor CLI executor for the explicit `codex-cursor` route.

RelayPact selects Cursor as the execution harness, probes local CLI readiness,
passes a bounded task envelope, and normalizes structured execution evidence.
Cursor remains responsible for its own authentication and model configuration.
RelayPact never selects or changes the Cursor model.

Session identity is non-enumerable in ordinary executor results. The persistent
adapter may place the raw handle only in HMAC-bound, mode-0600 task-private state
for an explicit same-task correction. Before retaining that handle, discovery
resolves the selected executable to an absolute real path and binds its content
fingerprint. Correction verifies that identity and preserves the original
read-only or write authority before the handle can be reused. Public review and
terminal archives retain only bounded evidence and never the raw handle.
