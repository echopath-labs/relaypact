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

An envelope with `allowedPaths: []` selects Codex's native read-only sandbox,
permits report-only completion with `changedFiles: []`, and preserves that
sandbox when the same delegated session is corrected.

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

An envelope with `allowedPaths: []` forces Cursor read-only plan mode even when
`--read-only` is omitted. RelayPact never grants `--force` to zero write authority,
and persistent lifecycle state records that derived read-only mode for correction.
Set `validation: []` for that direct-workspace task. RelayPact refuses repository
validation commands before launch because they may write caches or coverage;
run checks in an external read-only or disposable environment.

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
When `allowedPaths` is empty, RelayPact omits Pi's `bash`, `edit`, and `write`
tools before launch and tells the executor that the task has zero write authority.
Set `validation: []` and run checks in an external read-only or disposable
environment; repository validation commands are refused before Pi starts.

Run the selected-route readiness probe first. It uses only disposable Pi state,
does not invoke a model, and blocks when the executable identity, minimum
version, required flags or bounded probe completion cannot be verified:

```text
node <skill-directory>/scripts/relaypact.mjs doctor
  --route codex-pi
  [--executor <absolute-pi-path>]
```

```text
node <skill-directory>/scripts/relaypact.mjs run-pi
  --envelope <task-envelope.json>
  [--executor <absolute-pi-path>]
```

An explicit Pi executor path must be absolute. RelayPact fingerprints and
snapshots the complete launch identity and resolved runtime dependency closure,
uses semantic-version precedence, and requires every complete option token used
by the adapter, including conditional `--thinking`, before execution.

A Host review of a one-shot result does not create a tool terminal record.

## WorkBuddy desktop editions (experimental)

For an explicitly selected mainland WorkBuddy or international WorkBuddy AI
executor, read [workbuddy.md](workbuddy.md). Both use `run-workbuddy` with a
mandatory edition and exact Host-selected model; native desktop authentication
and persistent configuration are preserved. The initial route
supports bounded Read/Write tasks and fresh-task correction, with Host checks and
acceptance kept independent.

## Waiting, interruption and process evidence

Keep the execution identity returned by the selected harness or Host tool and
wait for that invocation. Do not start another copy of the same validation just
because the first has not returned. Use only cancellation operations actually
supported by that route and host; the commands above do not imply a universal
cancel or orphan-recovery command.

On POSIX systems, the current process runner signals the process group it
started on timeout/cancellation and attempts group cleanup when the child closes.
Descendants that create another process group or session can survive this
cleanup. Windows behavior is different and is not a process-tree guarantee.
A parent exit, `codex_interrupted`, or `groupCleanupAttempted` proves neither
that every descendant stopped nor that a cancelled test completed.

If interruption leaves execution uncertain, preserve state and distinguish
known-running, known-stopped and unverified processes. Any further termination
must use task-owned process identities revalidated against current observations,
within existing authority; never kill by broad process name or reuse an old PID
list blindly. If identity or termination cannot be verified, report the blocker
and keep the affected workspace/capsule intact. Do not edit lifecycle files to
force recovery or claim a clean stop.

A supported `reject` or `abandon` archives a review decision subject to its route
checks. It is not a universal descendant-process cleanup operation, permission
to delete a capsule, or evidence that all work has stopped. Keep the Host's
process observations separate from the terminal review result.
