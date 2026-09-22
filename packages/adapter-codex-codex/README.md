# Codex–Codex Adapter

Status: public preview. This is the first route activated by the root Agent
Skill and requires no Pi installation or configuration.

This adapter lets one Codex Agent Instance coordinate a second, independently
attributable Codex Agent Instance. Product identity does not define the roles:
the coordinating instance owns framing, risk, review, and acceptance, while the
executor receives only the authority in the delegation envelope.

The adapter uses an independent `codex exec` process, a named host-owned worker
profile, a versioned worker result schema, and host-observed postflight evidence.
Native Codex routing, direct Responses-compatible providers, and compatible
optional local routers use the same contract. OpenCodex, OpenCode Go, and
individual models are not dependencies.

The adapter never silently changes provider or model. An unavailable executable,
profile, model, or required router produces a blocked or failed result for host
review.

An envelope with `allowedPaths: []` selects Codex's native read-only sandbox,
permits report-only completion with `changedFiles: []`, and keeps the same
read-only override for same-session correction. Host mutation evidence remains
authoritative.

## Named profiles

Profiles use `examples/codex-worker-profiles.json`. They are host-owned and are
referenced by `executionProfile` in the envelope. A profile may contain:

- `codexCommand`, an executable chosen by the host;
- `codexProfile`, a safe Codex configuration profile name;
- a non-secret `model` alias and `reasoning` effort;
- `external`, which defaults omitted exposure mode to sanitized;
- a proxy-name allowlist limited to standard HTTP proxy variables;
- an optional strict `provider` object with `name`, HTTPS or loopback `baseUrl`,
  `wireApi: "responses"`, and a `credentialEnv` variable name;
- an optional HTTP(S) loopback `router.healthUrl`.

Direct providers require an explicit model and `external: true`, and cannot be
combined with `codexProfile` or `router`. Credential values, arbitrary
environment variables, task-supplied executables, non-loopback routers, and
silent fallback are rejected. Native task homes use a generated minimal
configuration. Custom named/router routes require a credential-free selected
snapshot at `$CODEX_HOME/<codexProfile>.config.toml`; only the selected profile
and model-provider tables are projected. Supported native authentication fields
are refreshed into private task state before each execution or correction,
while unrelated global MCP servers, tools, tables, and authentication fields
are omitted. Direct-provider task homes
materialize a deterministic private base configuration and inherit no global
Codex authentication or configuration. The direct configuration also declares
only the exact disposable capsule as a trusted Codex project so Codex does not
rewrite task identity on first use; correction verifies those exact bytes and
permissions. No route copies credential values into
the envelope, configuration, prompt, result, metrics, or public examples.

## Native, direct, and optional bridge routing

Native execution needs no router. Set a host-owned Codex profile and model alias
that already work with `codex exec`. If the route needs non-default Codex
configuration, maintain the selected credential-free snapshot described above;
do not copy the complete global `config.toml`.

A provider that exposes the Responses protocol can use the direct profile shown
in `examples/codex-worker-profiles.json`. The host environment must contain the
variable named by `credentialEnv`; its value is passed only to the Codex worker.
The generated task configuration makes the route available to both initial
`codex exec` and `codex exec resume` without mutating or depending on global
provider configuration.

For the tested OpenCode Go / GPT-5.6 Luna direct route, use the copy-safe
profile and full first-run procedure in `docs/opencode-go-luna.md`. The guide is
provider-specific documentation, not a fallback policy or package dependency.

Optional local protocol conversion uses the existing router contract: define
the route in Codex or bridge configuration, keep credentials there, select its
non-secret profile/model alias in the registry, and add a loopback health check.
OpenCodex, OpenCode Go, and any specific model remain optional local choices
rather than dependencies of this package. A failed direct route never falls
back to this bridge route.

Proxy values such as a personal loopback SOCKS or HTTP port are machine-local.
Only environment variable names may appear in the registry; their values are
read from the host process at runtime and must not be committed.

## Direct-provider smoke validation

The standard suite uses fake runners and needs no provider credential. To run a
real direct-route smoke explicitly, set `RELAYPACT_DIRECT_CODEX_SMOKE=1` plus
`RELAYPACT_DIRECT_PROVIDER_NAME`, `RELAYPACT_DIRECT_PROVIDER_BASE_URL`,
`RELAYPACT_DIRECT_PROVIDER_MODEL`, and `RELAYPACT_DIRECT_PROVIDER_CREDENTIAL_ENV`. Set the
credential itself in the variable named by the last setting, then run:

```bash
npm run smoke:codex-direct
```

The smoke retains only bounded review evidence and aggregate metrics. Review
reports `relaypactPromptBytes`, `relaypactResultSchemaBytes`, and
`relaypactDeclaredInputBytes` separately from selected context bytes and
provider-reported tokens. These byte counts cover only RelayPact's exact worker
prompt and generated result schema; they are not token, quota, cost,
hidden-harness, or overhead estimates. Do not
paste a credential value into any `RELAYPACT_DIRECT_*` setting, example, task envelope,
or committed shell script.

## Exposure modes

`sanitized` is the default for external profiles. Every readable input is
preflighted before mutation, then only declared files, the envelope, and result
schema are copied into a deterministic temporary Git repository. Allowed output
paths may name new files without exposing existing source content.

The canonical envelope stays in private task controls. The capsule receives a
separate valid executor projection whose repository root points to the capsule,
not the source checkout. The root is a stable virtual identity for deterministic
baseline hashing; worker commands still run from the real capsule directory.
Preparation fails if another projected field would retain the source root.
Authoritative Git metadata stays under private task control. Host postflight
addresses it explicitly and treats the executor-visible `.git` pointer as
untrusted evidence. Bounded filesystem snapshots independently cover ignored
and index-hidden paths in the capsule and source tree. A separate bounded
source Git-control baseline includes configuration, refs, indexes, hooks,
objects, and packs and is checked again after host validation.

Sanitized tasks may use either exact explicit context or bounded planned
context. Planned mode keeps `readablePaths` exact, uses `discoverablePaths` only
as maximum additional authority, and selects a deterministic Node.js ESM
dependency closure from literal seeds under explicit file, byte, and depth
budgets. A credential-free manifest records integrity and provenance. Optional
readiness commands run in the provisional capsule before credentials, routing,
lifecycle execution, or worker requests. Planning, readiness, and mutation
failures clean the provisional task and never broaden exposure automatically.
Read-only paths belong in `readablePaths`, must be omitted from writable
`allowedPaths`, and must not also match `forbiddenPaths`.

`trusted-worktree` creates a detached disposable Git worktree and requires
`execution.trustedWorktreeAcknowledged: true`. It exposes the committed checkout
and is not an operating-system sandbox. In both modes, the source HEAD/status is
recorded and checked independently.

## Review, correction, and acceptance

`run-codex` leaves a review packet and candidate patch in private task state.
The packet separates executor claims, host-observed paths/diff fingerprint,
context-plan identity and aggregates, readiness, executor-reported context gaps,
host-run validations, unresolved risks, and privacy-safe aggregate metrics.
Completion remains `pending` even when eligible.

The pending packet carries a review identity over the lifecycle revision,
correction sequence, result identity, private-control fingerprint, packet, and
candidate patch. Acceptance recollects source and candidate evidence and uses a
matching state transition, so a changed candidate, correction request, or
tampered review cannot reuse an older approval.

At acceptance time the host rebuilds that review from the persisted
executor-report identity, current candidate/source evidence, and a new
host-validation run. The caller-supplied eligibility flag is never sufficient.
Lifecycle state is HMAC-bound to a host-private per-task key outside the task
directory, and the terminal decision receives a new identity covering its
action and actor.

Host validations run only after initial executor evidence is eligible. The
controller then recollects capsule and source integrity and bases the packet,
candidate patch, scope breaches, and acceptance eligibility on that final
post-validation evidence. Validation receives a minimized environment and
disposable home; any additional environment authority is an explicit host
grant. Immutable task controls are snapshotted around validation, and exact
provider/authentication values are redacted from structured worker narratives
before review persistence. Validation uses newly randomized disposable HOME and
temporary directories created only after worker completion. Its retained
arguments, output, and failures are redacted with the worker-plus-validation
union, which is reapplied after the final lifecycle check. Candidate files,
host-derived paths, and patch bytes are also checked for every exact worker or
validation value, including nonempty values shorter than four characters.
Accepted raw and normalized provider authority, hostname, labels, and
nontrivial path components join the same inventory; percent-encoded path
components are decoded and split through a bounded depth, and provider paths
that remain decodable at the bound or contain malformed percent encoding are
rejected before worker execution.
Worker and validation grant sets are HMAC-bound separately to host-private
lifecycle state; a changed set requires a new task. Contaminated, changed-set,
or unscannable evidence is omitted and made ineligible without retaining old
credential plaintext.
The worker grant set is checked again immediately after `codex exec` exits and
before any event or structured result is parsed; changed task authentication is
discarded as untrusted evidence.

Use `correct-codex` only for defects inside the original authority boundary. It
resumes the exact stored thread when task, profile fingerprint, capsule baseline,
context-manifest identity when planned, and prior result identity match. Changed
authority or selected context requires a new task.

The library exports `recordTerminalDecision` for explicit accept, reject, or
abandon decisions and `archiveAndCleanupTerminalTask` to archive the review
packet and patch before deleting only that task's capsule and Codex session.
Lifecycle changes are serialized by a private task lock. Archive destinations
must be pre-existing real directories outside the task root; symlink roots are
rejected.
These actions do not apply the patch or commit, merge, push, tag, publish, or
deploy anything.

## Failure recovery and rollback

- Router, model, executable, compatibility, or result failures fail closed.
- Keep a non-terminal task directory for inspection or same-session correction.
- Reject or abandon a task before cleanup when recovery is no longer useful.
- Rollback is operational: stop using the Codex adapter and return to direct
  Codex Desktop or Codex-to-Pi. The source repository needs no rollback because
  the adapter never integrates the candidate automatically.
- If trusted-worktree cleanup is interrupted, inspect `git worktree list`, the
  private task marker, and review evidence before removing only the recorded
  task worktree.
