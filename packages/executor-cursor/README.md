# @relaypact/executor-cursor

Experimental local Cursor CLI executor for the explicit `codex-cursor` route.

RelayPact selects Cursor as the execution harness, probes local CLI readiness,
passes a bounded task envelope, and normalizes structured execution evidence.
Cursor remains responsible for its own authentication and model configuration.
RelayPact never selects or changes the Cursor model.
