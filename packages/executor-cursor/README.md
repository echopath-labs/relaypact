# @relaypact/executor-cursor

Experimental local Cursor CLI executor for the explicit `codex-cursor` route.

RelayPact selects Cursor as the execution harness, probes local CLI readiness,
passes a bounded task envelope, and normalizes structured execution evidence.
Cursor remains responsible for its own authentication and model configuration.
RelayPact never selects or changes the Cursor model.

Session identity is non-enumerable in ordinary executor results. The persistent
adapter may place the raw handle only in HMAC-bound, mode-0600 task-private state
for an explicit same-task correction. Before retaining that handle, discovery
resolves the selected executable to an absolute real path. Native launchers run
from a private content-verified snapshot. Shell launchers must belong to a
recognized, bounded `@anysphere/agent-cli-runtime` installation bundle. RelayPact
fingerprints and snapshots that complete static bundle—including launcher-relative
companions—before execution, while excluding the runtime-only `.running`
directory. The snapshot runs through a root-owned, non-writable system shell
whose path and content are fingerprinted immediately before launch;
user-mutable shebang interpreters are refused. The signed fingerprint binds the
bundle, launcher, interpreter, and fixed argument prefix. Correction verifies
that complete launch identity and preserves the original read-only or write
authority before the handle can be reused. Public review and terminal archives
retain only bounded evidence and never the raw handle.
