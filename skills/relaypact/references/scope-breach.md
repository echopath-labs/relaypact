# Scope breach

A scope breach is an observed action or effect outside the agreement's authority.
For RelayPact CLI adapters, out-of-allowlist changed paths are an enforced form.

When reviewing a breach, identify the affected paths or effects and the evidence,
leave the delivery unaccepted, and determine a bounded correction or stop. Do not
widen the original agreement after execution to disguise the breach, or delete
or revert user work automatically. If the origin of a change is uncertain,
report that uncertainty and investigate before attributing it to the executor.

CLI postflight can mark an Execution Result `rejected`. Preserve that original
record; the Host's later rejection or correction request is a separate judgment.
Do not rewrite a generated result to record your own decision. Follow the
selected [invocation lifecycle](invocation.md) where supported, and retain the
actual workspace changes and prior evidence for review and authorized recovery.
