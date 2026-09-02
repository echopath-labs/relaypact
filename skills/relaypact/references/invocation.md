# Installed Invocation

Resolve `../scripts/relaypact.mjs` relative to this reference file,
or `scripts/relaypact.mjs` relative to the directory containing the
Skill. Do not assume the current working directory is the plugin checkout.

Inspect support without loading an executor:

```text
node <skill-directory>/scripts/relaypact.mjs support
```

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

For the explicitly selected experimental Cursor route, the one-shot form stays
pending-only. Persistent review requires both private lifecycle identities:

```text
node <skill-directory>/scripts/relaypact.mjs run-cursor
  --envelope <task-envelope.json>
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
model flag. Terminal decision rechecks the signed direct-worktree review basis,
archives no raw session handle, and leaves source changes untouched.
