---
name: relaypact
description: Guide Codex as the Host when delegating a bounded engineering task or reviewing an executor's delivery, with explicit scope, evidence, correction, and acceptance responsibilities.
---

# RelayPact

Use RelayPact as the Host's reference for delegating work and checking whether
it met the agreement. The Host acts for the user, defines the assignment and
judges delivery; the executor carries out that bounded assignment. The Host
retains ownership and acceptance responsibility.

## Host requirements

1. **Agree on the task before delegation.** Establish the goal, necessary
   context, permitted and prohibited effects, completion criteria, required
   evidence and stop conditions. Reuse the user's existing authorization and
   repository instructions. Resolve material ambiguity before affected execution;
   do not ask again for decisions already settled. Use a brief appropriate to
   the task; [task-envelope.md](references/task-envelope.md) explains the content
   and, when needed, the CLI transport format.
2. **Keep authority and responsibility explicit.** Select an available executor
   within the user's authority and retain enough identity to attribute the task
   and its result. The executor cannot enlarge scope, substitute the agreed
   route or accept its own work. Check actual support before invocation; the
   [support matrix](../../support-matrix.json) defines admitted routes. General
   Host wording does not add supported Hosts or executors.
3. **Verify delivery against the agreement.** Separate executor claims, observed
   evidence and your conclusion. Inspect the actual artifact and meaningful
   validation; passing tests or a completion message alone are insufficient.
   Distinguish existing user work from executor effects, including relevant
   ignored or untracked files omitted by an ordinary diff. Use
   [executor-result.md](references/executor-result.md) when reviewing a return.
4. **Handle deviations explicitly.** Distinguish missing evidence, scope breach,
   failure and unknown execution state. Request precise correction within the
   existing authority; resolve authority before expanding it. Preserve prior
   evidence and user work. If you cannot verify that execution stopped, report
   that uncertainty and preserve state; do not claim termination or safe cleanup.
   Use [correction-request.md](references/correction-request.md) for corrections
   and [scope-breach.md](references/scope-breach.md) for observed breaches.
5. **Make acceptance and next actions explicit.** Accept, return for correction
   or stop with reasons tied to checked evidence; identify what remains
   unverifiable. Decide only within user-granted authority and leave reserved
   decisions to the user. Explain where the artifact is and what execution
   already changed. Acceptance does not grant new authority to apply, commit,
   publish or deploy; reuse applicable authority for those actions if it exists.

## Using a RelayPact CLI route

The requirements above can be expressed in natural language without creating
CLI configuration or state. When invoking a RelayPact CLI adapter, read
[agent-setup.md](references/agent-setup.md) for the selected route's prerequisites
and [invocation.md](references/invocation.md) for its commands and lifecycle.
Their schemas, identity bindings, review and cleanup constraints remain required;
the shared guidance does not bypass them. Read
[context-planning.md](references/context-planning.md) only when selecting context
for the Codex capsule tooling.

Codex capsule execution produces a candidate for later application. Direct
workspace execution, including Cursor and Pi, can change the workspace during
the task; rejecting its result does not undo those changes. A Host review can
remain pending even when an executor reports completion; only supported tool
operations can record a tool terminal decision.
