# Codex–Pi Adapter

Status: experimental. This package is not activated by the root public-preview
Skill and is not a prerequisite for Codex-to-Codex execution.

This adapter translates the neutral delegation contract into a non-interactive
Pi invocation and normalizes the outcome for Codex review.

Run `relaypact doctor --route codex-pi [--executor <absolute-pi-path>]` before selecting
the route. Doctor requires Pi 0.84.0 or later and checks the exact print/text,
no-session, tool-selection, route-binding and project-resource-disabling flags
used here, including `--thinking` when reasoning is selected. It binds and
snapshots the complete Pi launch identity and resolved runtime dependency
closure, including the Node runtime selected by the entry shebang and toolchain;
relative path executors are refused. Prereleases below the minimum stable version,
partial help-option matches, and mode values not associated with `--mode` are refused.
Pi must resolve to a Node package entry and a Node 20 or later runtime whose exact
bytes can be snapshotted; native launchers with unresolved sibling-library semantics
are rejected.
The experimental route is currently admitted on macOS and Linux. Windows `.cmd`
and `.bat` command shims are rejected because their wrapper semantics are not yet
captured by the immutable launch snapshot; Windows support is not claimed.
It probes only `--version` and `--help` inside disposable Pi state;
it does not read authentication, invoke a model or prove provider availability.

Zero write authority is translated before launch: when `allowedPaths` is empty,
Pi receives only `read`, `grep`, `find`, and `ls`, with no `bash`, `edit`, or
`write` tools.
The same zero-write envelope must use `validation: []`: direct repository
validation commands are refused before Pi starts because they can write caches
or coverage. Run those checks in an external read-only or disposable environment.

The invocation uses Pi's text print mode to collect only the final assistant
response, which must still contain the required JSON result. Progress events
are not the delivery evidence. The existing stdout/stderr capture bounds,
credential redaction and independent postflight checks remain in force; an
oversized or malformed final response is ineligible for acceptance.

Pi receives a disposable, provider-selected configuration projection rather
than the host configuration directory. The adapter inventories projected
credential leaves for result redaction and changed-file inspection and rejects
unbounded or command-resolved authentication. Explicit environment grants are
snapshotted once; credential-bearing provider URLs and host-derived changed
paths fail closed without retaining the sensitive URL or path. Accepted URL
endpoint components, including bounded recursively decoded path components,
join the sensitive inventory, and validation narratives use the complete
executor-plus-validation union for redaction. All nonempty explicit sensitive
values remain protected, including short values. A provider path that remains
decodable after the fixed budget or contains malformed percent encoding is
rejected before execution. The resolved provider and
model are mandatory Pi arguments and project-local Pi resources are disabled,
preventing repository settings from replacing the selected route.

Public Preview auth projection supports only a selected `api_key` entry with a
literal key or one exact explicit environment reference. OAuth,
provider-specific environment, interpolation/escape, executable, and unknown
auth semantics are rejected before Pi starts.

Pair-specific process arguments belong here or in the runtime implementation.
They must not redefine the neutral contracts in `packages/contracts/`.
