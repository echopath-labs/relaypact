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

If persistent execution enters `failed` before it has a current review, only
`decide-cursor --action abandon` is permitted. It archives a bounded failure
receipt and removes task-private state without changing candidate source files.

For persistent `run-cursor` and `correct-cursor`, completed or blocked
execution returns exit code `0`; failed, rejected, or malformed execution
returns exit code `1`. The JSON review is still authoritative, and a successful
process exit never implies host acceptance.

The CLI never falls back from one execution harness to another.
