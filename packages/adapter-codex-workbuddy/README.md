# Codex → WorkBuddy adapter

The two explicitly selected editions share this adapter. It uses the neutral
local-delegation evidence service for preflight, scope checks, host-owned
validation and pending acceptance. Codex remains the Host.

`runDelegation(envelope, { edition: "mainland" | "international", model: "exact-model-id", appPath?, readOnly? })`
starts a fresh bounded file task. See the [invocation reference](../../skills/relaypact/references/workbuddy.md).
An empty `allowedPaths` array derives read-only mode before dirty-tree preflight,
so the route keeps the same clean-tree requirement even when `readOnly` is omitted.
It also requires `validation: []`; direct repository validation commands are
refused before native launch because they can write caches or coverage. Run
those checks in an external read-only or disposable environment.
The model is required, preflighted against the admitted native help surface and
passed as an exact process argument with no configured fallback. This does not
change desktop defaults or prove account entitlement or pricing.
No persistent state, resume or implicit correction is provided: supply a new
bounded task with the original result and the required correction as context.
A completed result leaves Host acceptance pending. Rejecting a result does not
revert edits; publication is never automatic.
