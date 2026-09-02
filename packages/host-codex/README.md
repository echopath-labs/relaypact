# Codex Coordinating Host

Codex is the first coordinating host. It owns task framing, constraints, risk
judgment, delegation authorization, review of the actual repository state, and
final acceptance within user-granted authority.

Portable task and result semantics remain in `packages/contracts/`; Codex-specific
instructions remain under this boundary.

Host decisions for direct experimental routes also enter through this package.
Core supplies product-neutral signed-state, evidence, and cleanup primitives;
the Codex host authorizes terminal acceptance, rejection, or abandonment.
Direct terminal finalization keeps the signed-state lock while it prepares the
archive and checks candidate evidence before and after the terminal state
commit. A failed post-commit check restores the exact recoverable pending state
and removes the provisional archive; stale evidence is never returned as a
terminal decision.
