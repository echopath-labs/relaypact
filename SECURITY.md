# Security Policy

## Supported Versions

RelayPact v0.3.1 is an ordinary GitHub Release for Host-supervised delegation.
Security fixes are provided on a best-effort basis for the current release line.
Until the [v0.3.1 GitHub Release](https://github.com/echopath-labs/relaypact/releases/tag/v0.3.1)
is visible, that supported release remains v0.3.0. Once v0.3.1 is published,
support moves to the latest published `0.3.x` release. Unreleased commits, older
snapshots and locally modified adapters are not supported release channels.

Product release status does not promote adapter maturity. Codex-to-Codex remains
the active public-preview route. Pi, Cursor, WorkBuddy and WorkBuddy AI remain
experimental, explicitly selected and inactive at the root Plugin. Their public
source and documented controls are covered by regression checks. Native harness
configuration remains harness-owned; direct execution is not an OS sandbox.

## Reporting A Vulnerability

Use GitHub private vulnerability reporting for this repository:

<https://github.com/echopath-labs/relaypact/security/advisories/new>

Repository maintainers must enable private vulnerability reporting before the
first public preview. If the private reporting form is unavailable, do not put
credentials, private source, exploit payloads, provider responses, task-state
artifacts, or other sensitive reproduction details in a public issue. A public
issue may report only that the private reporting channel is unavailable.

Include the affected version or commit, entry point, required configuration,
security boundary crossed, impact, and a minimal reproduction when it is safe
to do so. Reports are evaluated against the documented threat boundary;
not every self-directed or already-privileged local action is a vulnerability.

## Security Boundary

- Agent tool restrictions are not an operating-system sandbox.
- Validation and readiness commands are host-declared programs that run with
  the current user's operating-system permissions. They receive minimized
  environments and disposable homes, not ambient host credentials.
- Provider credentials remain in host-managed configuration or environment
  variables and must never be placed in task envelopes or retained evidence.
  A credential explicitly granted to a selected provider remains visible to
  that delegated provider process. Exact-value result redaction reduces
  accidental narrative retention, but candidate files and patches remain
  executor-controlled and require human inspection.
- Pi authentication is projected per task for the selected provider. Exact
  projected credential leaves sanitize retained narratives, changed paths, and
  changed source files. Explicit environment grants are captured once. Only a
  fully inventoriable selected `api_key` entry with a literal key or one exact
  explicit environment reference is supported; command, OAuth,
  provider-specific environment, interpolation/escape, credential-bearing URL,
  and unknown semantics fail closed. Accepted provider raw and normalized
  endpoint, authority, hostname, labels, and nontrivial path representations
  join the exact-value inventory, with bounded recursive decoding and splitting
  of percent-encoded path components. Provider paths that remain decodable when
  that budget is exhausted or contain malformed percent encoding are rejected
  before worker launch. The resolved provider and model are
  command-line bound and project-local Pi resources are disabled so repository
  settings cannot replace the host-selected route.
- Sanitized capsules minimize context exposure, but users must still review
  provider data-handling terms before delegating private source.
- Host review uses private Git control data and fails closed when machine
  evidence is truncated or executor-visible repository metadata drifts.
  Host-owned filesystem snapshots additionally cover ignored and index-hidden
  paths. Source Git-control snapshots include pre-existing object storage,
  linked-worktree common directories, and recursive configured alternate
  object stores under aggregate bounds. Sanitized capsule controls cover the
  behavior-bearing private Git metadata used by review while allowing
  host-created content-addressed loose objects. These controls detect mutations
  but do not prevent same-user filesystem reads.
- Candidate evidence that contains, or cannot safely exclude, an exact value
  granted to the Codex worker or a host validation is not retained as a raw
  changed path or patch and cannot become eligible for acceptance. Host-keyed
  grant-set fingerprints also make credential rotation within one task fail
  closed without retaining prior credential plaintext. Every nonempty explicit
  sensitive value participates, including values shorter than four characters.
- Worker auth is rechecked after process exit and before worker-controlled
  narratives are parsed. Git pointers, recursive alternate graphs, and pending
  evidence destinations are independently type-, identity-, containment-, and
  resource-bounded.
- Validation receives only its explicit environment authority, while retained
  validation arguments, output, and failures are redacted with the full
  executor/worker-plus-validation sensitive-value union. Codex reapplies the
  final lifecycle-bound union after validation before evidence persists.
- Executor completion never creates acceptance, source integration, a commit,
  a push, a release, or a deployment without a separate host or human decision.
- Executor process groups receive best-effort termination, but same-user code
  can deliberately daemonize into a detached session and outlive the tracked
  process. The preview does not claim OS-level descendant containment; tasks
  that start background services are outside the recommended operating model.

Please read the complete safety limits in [README.md](README.md) before filing
a report or deploying the preview in a sensitive environment.

Local direct execution checks existing repository symlinks before launching work
and validation commands. External, unresolved and unstable links are refused;
internal target changes remain part of whole-repository evidence. This does not
confine arbitrary absolute-path writes or concurrent link replacement: the Host
must still select a trusted execution environment and coordinate other writers.
Terminal cleanup retries use a minimal signed Host receipt, retained with its
integrity key outside the deleted task directory; it holds no raw session handle
and authorizes only completion of the already committed decision.
