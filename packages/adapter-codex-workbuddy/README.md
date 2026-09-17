# Codex → WorkBuddy adapter

The two explicitly selected editions share this adapter. It uses the neutral
local-delegation evidence service for preflight, scope checks, host-owned
validation and pending acceptance. Codex remains the Host.

`runDelegation(envelope, { edition: "mainland" | "international", appPath?, readOnly? })`
starts a fresh bounded file task. See the [invocation reference](../../skills/relaypact/references/workbuddy.md).
No persistent state, resume or implicit correction is provided: supply a new
bounded task with the original result and the required correction as context.
A completed result leaves Host acceptance pending. Rejecting a result does not
revert edits; publication is never automatic.
