# CLI Composition

This package owns argument parsing, support discovery, local readiness
diagnostics, and lazy adapter loading. `support` is the static route contract;
default `doctor` checks the local Node.js, Git, Codex CLI, `codex exec`, packaged
Skill, marketplace, and plugin surface without reading credentials, contacting
a provider, or starting a worker. `doctor --route codex-cursor` explicitly
checks Cursor CLI version, required flags, and local authentication without
invoking a model or retaining account output. The optional Cursor executor is
dynamically loaded only for that selected diagnostic route; default `doctor`
does not load it.
`doctor --route codex-pi [--executor <absolute-pi-path>]` dynamically loads the
experimental Pi executor, binds and snapshots its complete launch identity,
including its resolved runtime dependency closure, and verifies Pi 0.84.0 or
later under semantic-version precedence plus the exact noninteractive option
tokens and associated mode values used by the adapter, including conditional
`--thinking`. The Node runtime comes from the selected entry shebang and
toolchain. Relative path executors are
rejected. Its
version/help probes run with disposable HOME, settings, session and working
directories, make no model request, and return only sanitized readiness
evidence. Default `doctor` does not load Pi.
`run-codex`, `correct-codex`, and `decide-codex` load the public-preview
Codex-to-Codex route. The terminal decision archives evidence but never applies
the candidate patch to the source repository.
`run-pi` loads the experimental Codex-to-Pi route explicitly. `support` reads
sanitized metadata without loading an executor.
`run-cursor` similarly loads only the experimental Codex-to-Cursor route. Its
one-shot form remains pending-only. Supplying `--state-root` and
`--host-instance` together enables harness-neutral persistent review;
`correct-cursor` resumes only the protected original Cursor session through the
same signed absolute executable identity and original read/write authority, and
`decide-cursor` records and archives one explicit terminal decision. None of
these commands selects or configures Cursor's model.

If persistent execution enters `failed` before it has a current review, or an
interrupted owner leaves it in `prepared` or `running`, only
`decide-cursor --action abandon` is permitted. It archives a bounded failure or
interruption receipt only for a prepared task or when signed execution completion
is available. Otherwise `execution_stop_unverified` preserves task-private state.
Host exit is insufficient proof; orphaned execution has no automatic cleanup.
Candidate source files are never changed. Abandonment returns `task_state_busy` while the signed execution
lease still has a live owner.

For every `run-*` and `correct-*` command, completed execution returns exit
code `0`, blocked execution returns `2`, and failed, rejected, malformed or
unknown execution returns `1`. A failed persistent lifecycle also returns `1`.
JSON retains the detailed outcome and a successful process exit never implies
Host acceptance. `doctor` keeps its diagnostic convention (blocked `1`, other
states `0`); successful `support` and `decide-*` operations return `0`.

Compatibility: v0.3.0 returned `0` for blocked executions. Automation must now
handle `2` as requiring attention and inspect JSON before retrying. Do not treat
all nonzero results as retryable, or interpret completion as acceptance.

The CLI never falls back from one execution harness to another.

`run-workbuddy --edition mainland|international --model <model-id>` selects the
corresponding experimental desktop executor and binds one exact invocation model
without a fallback. `--read-only` narrows tools to Read; otherwise
Read/Write use native per-invocation path grants. Use `doctor --route codex-workbuddy --edition mainland`
or `doctor --route codex-workbuddy-ai --edition international` to
check identity and configuration presence without starting the harness or
claiming authenticated readiness. Add `--model <model-id>` to doctor to run the
bounded native help preflight; it sends no task prompt but can contact native
services or update caches and does not prove entitlement or price. When the
exact ID is not in that admitted help, doctor stays blocked and adds
`modelDiscovery` with only the sanitized canonical IDs parsed from the same
help; raw native help is never returned and no default, fallback or substitution
is applied. The route is single-shot and leaves Host
acceptance pending; failed/rejected/malformed results return exit code 1.
