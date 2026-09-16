# Contributing

Keep changes scoped to shared Host delegation guidance, portable contracts,
or an explicit host, executor, or adapter boundary. General Host requirements
belong in the shared Skill; harness-specific invocation belongs in its selected
reference and adapter. Keep route claims aligned with `support-matrix.json`;
Pi and Cursor remain experimental and must not become default prerequisites.

Before submitting a change:

1. Run `npm run check` with Node.js 20 or later.
2. Add or update tests for contract, Git-boundary, and error behavior.
3. Do not commit credentials, authentication files, personal absolute paths,
   private planning records, or raw executor logs.
4. Keep provider and model choices configurable.
5. Treat executor completion and host acceptance as separate concepts.

Public changes should be understandable without access to any private planning
workspace.

## Contribution license

RelayPact is licensed under the
[Apache License 2.0](LICENSE). Unless you explicitly state otherwise, an
intentional contribution submitted for inclusion in this repository is
provided under Apache-2.0, as described by Section 5 of the license. This
project does not require a Contributor License Agreement for the public preview.

Contributors retain copyright in their contributions. Do not submit code,
documentation, generated output, or other material that you do not have the
right to license under these terms.
