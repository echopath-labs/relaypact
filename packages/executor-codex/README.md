# Codex Delegated Executor

Codex can act as a Delegated Executor when it runs as a distinguishable Agent
Instance with its own task identity, session attribution, bounded authority, and
result provenance.

The first transport is an independent non-interactive `codex exec` process. A
host-approved named worker profile selects the executable, model alias,
reasoning effort, and one explicit route: native Codex configuration, a direct
Responses-compatible provider, or an optional loopback router. Provider
credential values and user-specific paths never belong in a delegation envelope
or public example.

Executor completion remains pending Coordinating Host review. This boundary
does not authorize applying work to the source workspace, acceptance, commits,
pushes, tags, releases, or deployments.

The executor writes only inside a sanitized capsule by default. It must return
`packages/contracts/schemas/codex-worker-result.schema.json`, and its changed-file and validation
claims remain separate from host-observed Git and command evidence. Corrections
use `codex exec resume` with the original thread; they never select `--last`.
With `allowedPaths: []`, initial execution uses the native read-only sandbox,
the structured report may complete with `changedFiles: []`, and correction
explicitly reapplies the same read-only sandbox override.

A Codex worker receives a generated or selected task-scoped configuration
rather than the user's complete global `config.toml`. Native authentication is
projected into private task state without unrelated global capabilities. A
custom named route uses only its credential-free selected profile snapshot. A
direct-provider configuration binds the provider, base URL, `responses` wire API, credential
environment-variable name, model, and default workspace-write sandbox. A zero-write
envelope overrides that mode for both initial execution and correction. Its bytes and
the exact disposable capsule project trust are materialized before first use.
Its bytes and permissions are verified again before correction resume; drift stops execution
instead of selecting another route. Worker HOME and temporary directories are
task-scoped, and output truncation makes the result ineligible for acceptance.
Structured result fields are size-bounded and exact injected credential values
are redacted before persistence; credential-bearing changed-path claims are
rejected instead of rewritten.
