# Neutral Contracts

This package owns the Agent-neutral delegation envelope, path policy, shared
error contract, and versioned public JSON schemas. It must not import a host,
executor, adapter, provider, model, bridge, or CLI package.

The contracts define bounded authority and evidence shapes. A failed executor
may include a bounded machine-readable `failureCode` for Host review without
turning that code into acceptance authority. The contracts do not select an
execution harness or grant acceptance authority to an executor.

## TaskEnvelope validation boundary

`schemas/task-envelope.schema.json` defines portable JSON structure, bounded
strings (Unicode code points), unique string arrays, absolute repository roots,
canonical relative paths, reserved authority segments and planned-mode shape.
Legacy scope/working-directory paths accept backslash separators; planned
`discoverablePaths` and seeds require forward slashes. Forbidden paths may name
reserved controls because denying a path does not grant authority.

Call `validateTaskEnvelope` after schema validation. Two semantic checks remain
runtime-only: credential-like command argument detection and uniqueness of
readiness command IDs. They are explicit differential-test exceptions. Schema
validation alone never certifies absence of credentials, filesystem containment,
route compatibility, context sufficiency or Host acceptance. Those require
runtime preflight and independently observed evidence.

Host validation commands may explicitly invoke an interpreter; readiness commands
must invoke a non-shell executable. Neither grants authority beyond the envelope.
The runtime has no schema-validator dependency. Development tests use pinned Ajv
Draft 2020-12 after `npm ci --ignore-scripts` and compare the same envelopes against
both implementations, including invalid paths, malformed values and exceptions.
