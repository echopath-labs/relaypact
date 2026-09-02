# CLI Composition

This package owns argument parsing, support discovery, local readiness
diagnostics, and lazy adapter loading. `support` is the static route contract;
default `doctor` checks the local Node.js, Git, Codex CLI, `codex exec`, packaged
Skill, marketplace, and plugin surface without reading credentials, contacting
a provider, or starting a worker. `doctor --route codex-cursor` explicitly
checks Cursor CLI version, required flags, and local authentication without
invoking a model or retaining account output.
`run-codex`, `correct-codex`, and `decide-codex` load the public-preview
Codex-to-Codex route. The terminal decision archives evidence but never applies
the candidate patch to the source repository.
`run-pi` loads the experimental Codex-to-Pi route explicitly. `support` reads
sanitized metadata without loading an executor.
`run-cursor` similarly loads only the experimental Codex-to-Cursor route. It
does not select or configure Cursor's model.

The CLI never falls back from one execution harness to another.
