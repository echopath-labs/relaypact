# Delegation brief and task envelope

Use this reference when framing or checking the assignment. The Host must make
these facts clear enough for the executor to act and for the Host to review:

- the goal and observable expected outcome;
- the necessary context and relevant repository instructions;
- what may be read, changed or otherwise affected, and what must remain untouched;
- completion criteria, meaningful validation and required delivery evidence;
- when to stop and report a gap instead of extending authority;
- enough task and executor identity to associate delivery with this agreement.

Natural language is sufficient for the shared requirements. For example:

> Update the documented return value for `parseCount` in `docs/api.md` to match
> its current implementation. Read `src/parse-count.mjs` and repository
> instructions; change only `docs/api.md`. Preserve unrelated edits. Deliver the
> diff and explain how it matches the implementation; run the existing focused
> documentation check if available. Stop and report if matching the documentation
> would require a code change. Return the result for Host review.

Resolve contradictions before delegation. Read permission is not write
permission. Missing context is a reason to report a gap, not to read outside
the agreement. Keep credentials out of task descriptions and delivery files.

## When using a RelayPact CLI adapter

Use the [canonical task envelope schema](../../../packages/contracts/schemas/task-envelope.schema.json)
as the authoritative transport shape; a prose brief does not replace its fields.
A complete envelope names the objective, expected outcome, target Git root,
working directory, dirty-tree policy, readable, allowed, and forbidden paths,
repository instructions, constraints, validation commands, required evidence,
stop conditions, and result version.

Use exact `scope.readablePaths` for known context. For Codex bounded dependency
discovery, add `scope.discoverablePaths` and `contextPlanning` according to
[context-planning.md](context-planning.md). Discovery authority does not grant
output authority, and readiness is not acceptance validation.

A read-only file belongs in `scope.readablePaths`, not `scope.allowedPaths`,
and must not match `scope.forbiddenPaths`. Resolve contradictory readable and
forbidden authority before worker launch.

Execution profiles are adapter configuration, required only by routes that use
them. Follow [agent-setup.md](agent-setup.md); never include provider credentials,
API keys, access tokens, passwords or secret environment values in an envelope.
