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

## Filesystem evidence budget

The adapters hash repository content, including ignored and untracked files, to
check for out-of-scope changes. A clean Git status, a narrow path scope, or dirty
worktree acknowledgment does not reduce that scan. The default aggregate file
size bound is **512 MiB (536870912 bytes)**, measured by logical file size, so a
sparse file counts at its full size. Codex capsules also check the source tree.

For an installed monorepo that exceeds this bound, the Host can explicitly set
`execution.filesystemEvidenceMaxBytes` in the envelope before creating a task:

```json
{
  "execution": {
    "timeoutMs": 120000,
    "filesystemEvidenceMaxBytes": 2147483648
  }
}
```

This example allows 2 GiB per content snapshot. The value must be an integer
from 1 through **8589934592 (8 GiB)**; omission preserves the default. Choose a
bounded value with room for expected output. Larger budgets increase repeated
hashing and I/O cost. This is distinct from `contextPlanning.budget.maxBytes`,
which limits selected input context.

The same effective budget applies to preflight, postflight, validation checks,
correction and acceptance. Direct results report `filesystemEvidenceMaxBytes`;
Codex review packets report `hostObserved.filesystemEvidenceMaxBytes`. Persistent
tasks bind the budget to their envelope and protected control records. Do not
edit saved controls to raise it; create a new Host-authorized task instead.
Older tasks without the field retain 512 MiB. Older RelayPact versions reject
the new envelope field.

Exhaustion fails closed with `filesystem_evidence_exceeded`; incomplete evidence
cannot justify acceptance. The other limits remain: 100,000 file entries,
100,000 directories (including the root), and depth 256. Git metadata and private
control evidence have separate limits. Unsafe links, live filesystem changes,
and scope breaches remain independent failures. Raising bytes does not bypass
these checks or permit ignored-file mutations. Do not delete dependencies, skip
ignored paths, move live caches, or patch the installed adapter to evade a bound.

## Validation execution agreement

For potentially expensive checks, distinguish worker checks from later Host
acceptance checks. Name the exact commands, working directory, expected scope
and deadline; explicitly state which full suites must wait for Host review.
These instructions constrain the worker but do not create an OS command sandbox.

Require the executor to start a check once and retain its process/session
identity. While it is running, wait or poll that same invocation; silence or a
slow result is not permission to start a duplicate. Rerun after a verified
terminal result only when a changed artifact, failure or other concrete reason
justifies it. If the executor cannot observe completion, it must report the
uncertainty and stop starting more checks. Preserve the available execution
identity for Host follow-up instead of claiming the test finished.

Choose the smallest task with useful, verifiable output and sufficient context.
Consider preparation, execution, waiting, review and correction costs together;
delegation does not inherently save tokens. This agreement is usable without
ForgeRail or another governance tool.
