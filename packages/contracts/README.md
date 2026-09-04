# Neutral Contracts

This package owns the Agent-neutral delegation envelope, path policy, shared
error contract, and versioned public JSON schemas. It must not import a host,
executor, adapter, provider, model, bridge, or CLI package.

The contracts define bounded authority and evidence shapes. A failed executor
may include a bounded machine-readable `failureCode` for Host review without
turning that code into acceptance authority. The contracts do not select an
execution harness or grant acceptance authority to an executor.
