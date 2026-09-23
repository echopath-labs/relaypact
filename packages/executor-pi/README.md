# Pi Delegated Executor

Pi is an experimental community-Agent delegated executor. It receives a complete delegation envelope,
executes only within the granted authority, and reports completion, blocking, or
failure with evidence.

Pi is not a prerequisite for the public-preview Codex-to-Codex route and is
loaded only through the explicit `run-pi` command. Pi does not own task framing
or final acceptance. Provider and model selection
come from Pi configuration or an explicit non-secret execution profile.

Before a task, `relaypact doctor --route codex-pi [--executor <absolute-pi-path>]`
resolves and fingerprints the complete selected launch identity, including the
Node package, its resolved runtime dependency closure, and runtime when
applicable; the Node runtime is resolved through the entry shebang and selected
toolchain. Runtime discovery uses disposable HOME, temporary, and working directories;
opaque Node wrappers or shims and absolute package symlinks are rejected because their
launch or copy semantics cannot be reproduced exactly. Doctor requires Pi 0.84.0 or later under semantic-version precedence and
verifies complete noninteractive option tokens below, including conditional
`--thinking`, without sending a prompt. Relative path executors are rejected. The probe
uses disposable HOME, settings, session and working directories; any native
bootstrap files stay inside that disposable root and are deleted afterward.
Global/project Pi settings and authentication are neither read nor modified.
Timeout, truncation, executable drift and settings-lock failures block with
fixed diagnostics that retain no native output or private paths. Snapshot
copy, verification, or temporary-state cleanup failures use a structured blocked result. Each
doctor probe and each task execute from a separate verified private snapshot of that identity.
Task cleanup failures remain structured execution failures so Host filesystem and Git postflight
evidence is still collected.
Delegated execution reruns the same version, capability, settings-isolation, and identity checks
at the route boundary and refuses an executable that changes after readiness.

Executable snapshots prefer private roots because hardened Linux hosts may mount the
system temporary directory with `noexec`. RelayPact creates the snapshot atomically
under the XDG runtime directory, then the home directory, and finally the trusted
sticky system temporary directory. It accepts the first candidate whose ownership,
ancestor permissions, directory and executable-file probes pass.
An absolute private override is available through
`RELAYPACT_PI_EXECUTABLE_SNAPSHOT_ROOT`. The selected root must already exist, have
trusted non-writable ancestors (or sticky writable ancestors), and pass an
executable-file probe before Pi package or runtime bytes are copied.

Pi runs in print/text mode and must return exactly one final JSON object with
`status` (`completed`, `blocked`, or `failed`), a string `summary`, and optional
`residualRisks`. Put explanations inside that object. Bare compact or multiline
JSON is accepted; a single complete Markdown `json` or unlabelled fence is also
tolerated. Surrounding prose, multiple objects, arrays, partial JSON, and event
wrappers are rejected as malformed. The adapter does not guess which embedded
result to use. Output bounds, independent validation, and Host acceptance still
apply.

An envelope with `allowedPaths: []` gives Pi only `read`, `grep`, `find`, and
`ls`; RelayPact omits `bash`, `edit`, and `write` before launch and tells the
executor that the task has zero write authority. Postflight scope evidence still
rejects any observed mutation.

The adapter gives Pi a disposable HOME and temporary directory and projects a
task-scoped `PI_CODING_AGENT_DIR` containing only the selected provider's
authentication, custom model definition when needed, and safe defaults. It
does not expose the original configuration directory. Credential environment
references must be exact explicit grants. Only literal or exact-reference
`api_key` auth is supported; command-resolved, OAuth, provider-specific
environment, interpolation/escape, and unknown auth shapes are rejected.
Explicit grants are snapshotted once, and provider base URLs containing
userinfo, query parameters, or fragments are rejected. Accepted raw and
normalized endpoint, authority, hostname, labels, and nontrivial path
representations join the sensitive inventory; encoded path components are
decoded and split through a bounded depth, with paths that remain decodable at
the bound or contain malformed percent encoding rejected before Pi starts.
Every nonempty projected credential
or explicit grant, including short values, sanitizes retained executor and
validation output, changed paths, and changed source files without granting
executor credentials to validation. The resolved provider and model are bound
as Pi process arguments and project-local Pi resources are disabled so the
repository cannot replace the host-selected route. A timeout escalates to forced termination,
configuration drift fails closed, and truncated structured output is never
treated as complete.
Host-owned filesystem and Git-control snapshots make ignored, index-hidden, and
repository-metadata mutations acceptance evidence even when Git status omits
them.

Process-group cleanup is best effort. Pi tasks must not intentionally start
daemonized or detached background services: a descendant that creates a new
session can outlive the tracked executor and must be found and stopped by the
host before acceptance.
