# Codex–Pi Adapter

Status: experimental. This package is not activated by the root public-preview
Skill and is not a prerequisite for Codex-to-Codex execution.

This adapter translates the neutral delegation contract into a non-interactive
Pi invocation and normalizes the outcome for Codex review.

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
