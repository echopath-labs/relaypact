# Neutral Core

This package owns product-neutral environment minimization, process handling,
Git and filesystem evidence, redaction, and bounded context planning. It may
depend only on the neutral contracts package and Node.js built-ins.

Product-specific routing and harness behavior belong in executor and adapter
packages.

Signed-state locks are reclaimed automatically only when the original process
has exited or its PID has a different process identity. Lock age alone does not
permit reclamation. A live process with unavailable identity, or incomplete
owner metadata, returns `task_state_busy`; unresolved residual locks require
Host investigation before any manual recovery. Never delete a lock merely to
bypass a busy result.
