# Delivery and Host review

Use this reference when an executor returns work. Ask for enough information
to locate the actual artifact, identify the assignment and attempt, understand
what changed, reproduce relevant validations, and see gaps or unresolved risks.
A short response with verifiable references can suffice; a long self-report
without accessible evidence cannot establish completion.

Keep three things distinct in the review:

- **Executor claim:** what it says it changed, tested or could not complete.
- **Observed evidence:** the actual artifact or diff, relevant filesystem
  effects, validation outcomes and their provenance. Attribute user changes
  separately and include relevant ignored/untracked additions.
- **Host judgment:** whether the goal and scope were met, what is still
  unverified, and whether to accept, seek correction or stop within authority.

Check the artifact that will actually be used. Record which validation ran,
where it ran and what it establishes. Tool success alone does not prove that
the delivery answers the task. Obtain missing evidence before acceptance;
do not turn a worker's unsupported statement into an observed fact.

## RelayPact CLI results

The executor may report `completed`, `blocked`, or `failed`. The adapter may
normalize malformed or interrupted execution as `failed`, and may set the final
Execution Result to `rejected` when independent postflight checks find a contract
violation. A scope breach, failed required validation, malformed output or
missing required evidence makes the delivery ineligible for acceptance.

A `completed` result remains pending Host or human acceptance. Preserve the
original structured result and available execution identity. Review eligibility
is evidence for the Host decision, not the decision itself. Follow the selected
route's [invocation reference](invocation.md) for correction and terminal actions;
do not edit generated results or lifecycle state to make them eligible.

## Review command behavior as well as files

A clean path-scope result covers the effects that check observed; it does not
prove obedience to every instruction. Review available command evidence for
prohibited full-suite execution, overlapping duplicate checks and work started
after stop conditions. Attribute worker claims and Host observations separately.
Do not claim command compliance when telemetry is unavailable.

Treat observed violations of the agreed execution constraints as reasons to
withhold acceptance even if changed files are within their allowlist. Missing
context, a failed check and an instruction violation require different remedies;
none authorizes the executor to enlarge its own scope. After interruption,
review the process-stop evidence described in [invocation.md](invocation.md)
separately from the candidate patch and the recorded rejection or abandonment.
