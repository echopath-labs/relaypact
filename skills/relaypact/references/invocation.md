# RelayPact CLI invocation

Read only for a selected RelayPact CLI route, after
[agent-setup.md](agent-setup.md). Commands depend on the installed source version
and [support matrix](../../../support-matrix.json); source documentation does
not add commands to an older installation.

Resolve `../scripts/relaypact.mjs` relative to this reference file,
or `scripts/relaypact.mjs` relative to the directory containing the
Skill. Do not assume the current working directory is the plugin checkout.

Inspect support without loading an executor:

```text
node <skill-directory>/scripts/relaypact.mjs support
```

## Codex capsule lifecycle

Start a Codex-to-Codex task only after the envelope and host-owned profile
registry are ready. The state root must be a pre-existing real private
directory outside the target repository:

```text
node <skill-directory>/scripts/relaypact.mjs run-codex
  --envelope <task-envelope.json>
  --profiles <worker-profiles.json>
  --state-root <private-state-root>
  --host-instance <coordinating-instance-id>
```

Use the returned task root for a same-context correction:

```text
node <skill-directory>/scripts/relaypact.mjs correct-codex
  --task-root <task-root>
  --profiles <worker-profiles.json>
  --prompt <correction.txt>
```

After independently inspecting the pending review packet and candidate patch,
record one terminal decision. The archive root must be a pre-existing real
private directory outside the task root:

```text
node <skill-directory>/scripts/relaypact.mjs decide-codex
  --task-root <task-root>
  --profiles <worker-profiles.json>
  --action <accept|reject|abandon>
  --actor <host-or-human-id>
  --archive-root <private-archive-root>
```

Every terminal action rebuilds authoritative host evidence and refuses a stale
packet or candidate patch before it records the decision and archives evidence.
Acceptance additionally requires current evidence to remain eligible. No
terminal action applies the candidate patch to the source repository or
commits, pushes, tags, publishes, or deploys.

## Cursor direct workspace lifecycle

Execution can write the target workspace immediately unless run in read-only
mode. Acceptance does not apply a separate patch; rejection does not revert the
workspace.

For the explicitly selected experimental Cursor route, the one-shot form stays
pending-only and can be read-only. `--executor` is optional when the compatible
Cursor CLI is discoverable:

```text
node <skill-directory>/scripts/relaypact.mjs run-cursor
  --envelope <task-envelope.json>
  [--read-only]
  [--executor <cursor-path>]
```

Persistent review requires both private lifecycle identities:

```text
node <skill-directory>/scripts/relaypact.mjs run-cursor
  --envelope <task-envelope.json>
  [--read-only]
  [--executor <cursor-path>]
  --state-root <private-state-root>
  --host-instance <coordinating-instance-id>

node <skill-directory>/scripts/relaypact.mjs correct-cursor
  --task-root <task-root>
  --prompt <correction.txt>

node <skill-directory>/scripts/relaypact.mjs decide-cursor
  --task-root <task-root>
  --action <accept|reject|abandon>
  --actor <host-or-human-id>
  --archive-root <private-archive-root>
```

Cursor correction resumes only the protected original session and never adds a
model flag. It also reuses the exact executor command bound to the original
session; an explicit mismatched override is refused. Terminal decision rechecks the signed direct-worktree review basis,
archives no raw session handle, and leaves source changes untouched.
An explicit `abandon` may clean a prepared task or a failed task with signed
execution-completion evidence. It refuses with `task_state_busy` while an active
execution lease still has a live owner, and with `execution_stop_unverified`
when completion is unknown. Preserve that state; do not infer executor death
from Host exit or manually remove the state to bypass this check.
For `run-cursor` and `correct-cursor`, completed execution returns exit code `0`, blocked execution returns `2`,
and failed, rejected, or malformed execution returns `1`.
The JSON review remains the authoritative result and host acceptance stays
pending until an explicit terminal decision.

## Pi direct workspace execution

For the explicitly selected experimental Pi route, use the adapter documented
by the installed version; do not route Codex or Cursor failures to Pi. This
route can write the target workspace and returns evidence for Host review;
it does not provide the persistent correction/terminal commands above.

```text
node <skill-directory>/scripts/relaypact.mjs run-pi
  --envelope <task-envelope.json>
  [--executor <pi-path>]
```

A Host review of a one-shot result does not create a tool terminal record.

## WorkBuddy desktop editions (experimental)

For an explicitly selected mainland WorkBuddy or international WorkBuddy AI
executor, read [workbuddy.md](workbuddy.md). Both use `run-workbuddy` with a
mandatory edition; native desktop configuration is preserved. The initial route
supports bounded Read/Write tasks and fresh-task correction, with Host checks and
acceptance kept independent.
