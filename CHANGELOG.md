# Changelog

All notable public changes to RelayPact are recorded here.

## [0.3.4] - 2026-09-21 - Release

### Fixed
- Require one exact Host-selected model for each WorkBuddy or WorkBuddy AI invocation, preflight that ID against the admitted native CLI, pass it without fallback, and retain launch-confirmed binding evidence separately from any native model observation. Malformed or mismatched reported model evidence now makes delivery ineligible.
- Give machine-readable Git commands an independent 64 MiB stdout evidence bound while retaining the 128 KiB diagnostic stderr bound. Repositories whose complete status or index output exceeds the generic process limit can now reach delegation; actual bound exhaustion still fails closed.
- Exclude byte-identical acknowledged dirty baseline paths from delegated `changedPaths` without granting write authority. Content, type or mode changes to those paths remain observable and subject to the original scope.

### Compatibility
- WorkBuddy routes remain experimental and now require `--model <model-id>` for task execution. Model preflight and binding do not prove provider use, account entitlement, price or free status, and RelayPact never substitutes another model.
- The 64 MiB Git stdout bound is independent from `execution.filesystemEvidenceMaxBytes`; increasing the filesystem budget does not increase Git command capture.
- Codex remains the admitted Host. Codex-to-Codex remains public-preview; Pi, Cursor, WorkBuddy and WorkBuddy AI remain explicitly selected experimental routes.

## [0.3.3] - 2026-09-20 - Release

### Fixed
- Return a bounded, static permission-denial diagnostic when a failed Cursor process emits a recognized native EPERM/EACCES filesystem error. Support plain and complete inspected-Error forms, additional filesystem operations, and apostrophes in paths; reject incomplete or empty property wrappers.
- Keep unknown diagnostics generic, omit raw stderr and private paths, and preserve failure/ineligibility plus capture, timeout and cancellation precedence.

### Compatibility
- No changes to result schemas, model selection, permissions, executable identity protection or route maturity. Local readiness does not guarantee execution can initialize native state directories.

## [0.3.2] - 2026-09-19 - Release

### Fixed
- Preserve complete Unicode surrogate pairs when truncating executor and validation output while retaining the output bound and truncation marker.
- Allow an explicit Host-owned `execution.filesystemEvidenceMaxBytes` budget for installed repositories that exceed the default 512 MiB. Apply the bounded value consistently across execution, validation, correction and review; retain ignored-file and scope checks. Results and protected task controls record the effective budget.

### Documentation
- Clarify validation context readiness, waiting on a single invocation, command-compliance evidence, and process-group cancellation limits from practical delegation use.

### Compatibility
- Omitted filesystem budgets retain 512 MiB. Larger budgets do not bypass ignored-file, scope, link, file-count, directory-depth or Git-control checks and can increase repeated scan cost.
- Results expose the effective budget as an additive optional schema property. Consumers using older strict schemas should update them; older runtimes reject the new envelope field.
- Codex remains the admitted Host; route maturity and model ownership are unchanged. No scan parallelism or automatic budget expansion is introduced.

## [0.3.1] - 2026-09-19 - Release

### Fixed
- Align TaskEnvelope schema path, text, array and profile constraints with runtime validation; add independent differential checks and document runtime-only semantic checks.
- Return exit code 2 for blocked execution across run/correction commands; 0 remains completed and 1 remains failed/rejected/error. Shell automation that previously treated blocked as success must handle 2 explicitly. Completion still does not imply Host acceptance.
- Align branch instructions with permitted Codex task branches and document release-tag protection.

### Compatibility
- Blocked execution now returns exit code 2 instead of 0; automation must inspect the JSON outcome and handle this status explicitly.
- Host acceptance, route maturity and native harness prerequisites remain unchanged. Schema validity alone does not certify runtime semantic checks or execution readiness.
- Development checks now require `npm ci --ignore-scripts`; runtime plugin installation has no new dependencies.

## [0.3.0] - 2026-09-17 - Release

### Changed

- Publish v0.3.0 as an ordinary GitHub Release for practical Host-supervised
  delegation. Adapter maturity remains independently recorded in the support
  matrix; delegation mechanisms and constraints remain subject to review and improvement.

### Added

- Experimental Codex-hosted WorkBuddy mainland and WorkBuddy AI international
  executors with explicit edition/product binding and separate native desktop
  configuration. Initial admission is macOS and bundled CLI 2.137.1.
- Bounded single-shot Read/Write tasks, independent scope/validation evidence,
  read-only mutation rejection and fresh-task correction. No shell execution,
  same-session continuation, model override or global permission bypass.
- Offline checks for identity, terminal output, interruption, native login errors
  and Host verification; opt-in live acceptance separately selects each edition.

### Fixed

- WorkBuddy repository Read ask rules reject unmatched reads that native dontAsk
  would otherwise allow automatically; existing native allow rules remain additive.
- WorkBuddy doctor accepts both support-matrix route IDs and rejects mismatched
  editions. Nonzero native login failures retain their authentication diagnosis
  without masking interrupted or truncated execution.

### Compatibility

- Codex remains the admitted Host. WorkBuddy and WorkBuddy AI require macOS,
  bundled CLI 2.137.1 and each edition's native login/configuration.
- WorkBuddy supports bounded Read/Write tasks and fresh-task correction; shell,
  same-session continuation and sanitized execution are not admitted.
- Root Plugin activation and route maturity remain unchanged. GitHub installation
  is supported; npm publication is not part of this release.

## [0.2.0] - 2026-09-16 - Public Preview

### Added

- A shared Host delegation reference covering bounded authority, task context,
  evidence, correction and acceptance, with eight review cases. Harness-specific
  setup and invocation remain in conditional references. Codex remains the
  admitted Host; this does not admit additional Host products.
- An explicitly selected experimental Codex-to-Cursor route using the local
  Cursor CLI. Optional private lifecycle state supports signed review,
  same-session correction, terminal decisions and guarded private-state cleanup.
  Direct execution may already change files; decisions do not apply or revert
  workspace changes.

### Fixed

- Pi review uses the final assistant response instead of concatenating earlier
  output. Capability probes fail closed on inconclusive CLI evidence.
- Cursor discovery supports the current bundled launcher layout and validates
  launcher/interpreter identity before correction.
- Strengthened lifecycle ownership, lock reclamation and evidence checks,
  including linked-file cleanup and conservative handling of execution whose
  termination cannot be verified.

### Compatibility

- Install v0.2.0 from its versioned GitHub tag and verify the peeled commit.
  Package metadata alone is not release identity; verify the visible GitHub
  Release before installing.
- Codex-to-Codex remains the only active Public Preview route. Cursor and Pi
  remain experimental, explicitly selected and inactive at the root Plugin.
  Models, providers and authentication remain owned by the selected harness.
- Existing task state is not automatically migrated. Finish tasks with their
  original verified installation where possible and prepare new tasks for the
  new version; never bypass an evidence or lifecycle refusal. Automatic recovery
  of orphaned Cursor execution remains unsupported.
- Distribution remains a GitHub Public Preview with private npm metadata. No
  unattended, production-critical or Windows support is claimed.

## [0.1.2] - 2026-08-21 - Public Preview

### Fixed

- Replaced raw Git index byte identity with a canonical semantic fingerprint
  over staged path, conflict stage, mode, object ID, assume-unchanged,
  skip-worktree, and intent-to-add state. Read-only Git stat-cache refreshes no
  longer invalidate an otherwise unchanged pending review or terminal decision.
- Kept HEAD, refs, objects, hooks, configuration, worktree controls, filesystem
  evidence, and actual staged/index-flag tampering fail-closed.

### Compatibility

- At this release, `v0.1.2` became the latest published version. npm publication remained out of
  scope; installation uses the versioned GitHub release tag.
- Tasks prepared by v0.1.1 lack the new preparation-time semantic index
  baseline and remain ineligible for migration or terminal decision under
  v0.1.2. Prepare a new task instead.

## [0.1.1] - 2026-08-19 - Public Preview

### Changed

- Clarified read-only task authority: a read-only file belongs in
  `readablePaths`, is omitted from writable `allowedPaths`, and must not also
  match `forbiddenPaths`. Contradictions now fail before worker launch with an
  actionable diagnostic.
- Added bounded `relaypactPromptBytes`, `relaypactResultSchemaBytes`, and
  `relaypactDeclaredInputBytes` review metrics, kept separate from selected
  context bytes and provider-reported token usage. Prompt and result-schema
  measurement each fail closed above a 4 MiB input bound; the three integers are
  HMAC-bound to private lifecycle state so terminal review preserves them.
- Made Agent-first installation verify the checked-out commit against the
  peeled annotated release tag and explained that shallow-clone warning text
  alone is not the success signal.

### Compatibility

- Codex-to-Codex remains the only active Public Preview route. Pi remains
  experimental and inactive at root Plugin activation.
- The new review metrics are additive. No provider, model, router, credential,
  dependency, or execution-authority requirement changed.

## [0.1.0] - 2026-08-13 - Public Preview

### Added

- Agent Plugins 1.0 root manifest and local marketplace metadata.
- Agent-neutral delegation, execution-result, evidence, scope-breach, and
  acceptance contracts.
- Codex-to-Codex execution through an independent `codex exec` session.
- A contract-centered internal monorepo with a machine-readable support matrix,
  isolated host/executor/adapter packages, explicit route commands, and
  dependency-boundary validation.
- A Skill-local CLI wrapper with installed-cache discovery, deterministic
  Codex-to-Codex execution coverage, and explicit terminal decision/archive
  commands that never integrate source changes automatically.
- Experimental Codex-to-Pi bounded local execution, isolated from the
  public-preview Codex route and loaded only through `run-pi`.
- Sanitized capsules, optional planned Node.js ESM context, deterministic
  context manifests, readiness checks, and identity-bound corrections.
- Native, optional loopback-router, and direct Responses Codex routes without a
  required provider, model, proxy, or protocol bridge.
- Host-controlled diff, scope, validation, source-integrity, and terminal
  acceptance evidence.
- Dependency-free package validation, deterministic tests, opt-in live smokes,
  security reporting guidance, and public-preview CI.
- A tested, credential-free OpenCode Go / GPT-5.6 Luna direct-route guide and
  copy-safe worker-profile and task-envelope examples without requiring
  OpenCodex, OpenCode CLI, or Pi.
- English-default and Simplified Chinese onboarding, bilingual Agent-first
  tutorials, a manual reference, and installed Skill guidance that lets the
  coordinating Agent prepare credential-free private task artifacts from user
  intent.
- Apache License 2.0 project licensing with explicit EchoPath Labs attribution
  in `NOTICE`.

### Security

- Minimized Pi, Codex, readiness, and validation environments so delegated or
  candidate-controlled code does not inherit unrelated host credentials.
- Moved authoritative capsule Git metadata into private task control and made
  host review reject executor-visible Git-pointer drift and truncated evidence.
- Added bounded host-owned filesystem evidence for ignored and index-hidden
  mutations in source and capsule trees, plus immutable-control checks across
  host validation.
- Added hard child-process termination, canonical path policy, pre-read context
  budgets, bounded dependency analysis, copy-time digest checks, strict task
  state validation, and exclusive correction evidence files.
- Replaced broad native Codex configuration inheritance with selected profile
  and authentication projection; unrelated global MCP and tool configuration is
  not exposed to the worker.
- Added exact-value Codex result redaction, bounded structured-result fields,
  serialized lifecycle updates, symlink-safe review archives, duplicate-safe
  planning queues, and commit-pinned CI actions.
- Bound worker and validation sensitive-value sets to host-private lifecycle
  state, covered linked-worktree and alternate Git object stores, and made the
  public file manifest reject hidden nested dependency trees.
- Added selected-provider Pi configuration projection and source credential
  scanning, post-run Codex auth verification, globally bounded Git-pointer
  traversal, behavior-bearing capsule Git controls, immutable validation-grant
  snapshots, and symlink-safe pending review evidence.
- Added immutable Pi executor-grant snapshots, strict credential-free provider
  URLs, and exact-value filtering for host-derived changed-path evidence.
- Extended exact-value inventory to accepted provider endpoint components and
  redacted host-validation evidence with the full executor-plus-validation
  grant union.
- Restricted Pi auth projection to fully inventoriable literal or exact-reference
  `api_key` entries, rejecting executable/OAuth/provider-specific semantics, and
  preserved raw plus normalized provider URL components for evidence filtering.
- Bound the resolved Pi provider and model as mandatory process arguments while
  disabling project-local Pi resources, preventing repository settings from
  replacing the host-selected route.
- Extended lifecycle binding and evidence filtering to every nonempty explicit
  sensitive value, including short credentials, and added bounded recursive
  decoding and splitting for percent-encoded provider URL path components.
- Made provider URL processing fail closed before worker launch when a path
  remains percent-decodable after the supported representation budget.
- Rejected malformed percent encoding before Pi, direct Codex, or native Codex
  execution so one invalid path component cannot truncate sibling evidence.

### Known Limitations

- The preview requires human review and is not intended for unattended or
  production-critical execution.
- Agent restrictions and sanitized capsules are not an operating-system
  sandbox; child commands still run with the current user's permissions even
  though their environment and task home are minimized.
- Codex CLI 0.147.0 is the verified minimum. Later versions are expected to
  work but must pass the package's compatibility and smoke checks.
- Local validation has been completed on macOS. Ubuntu validation becomes
  release evidence only after the public GitHub Actions workflow passes.
- Windows behavior has not been validated and is not claimed as supported.
- Experimental Pi and external-provider behavior depends on user-owned installation,
  configuration, credentials, provider compatibility, and route reliability.
- Larger external Responses requests have shown intermittent stream
  disconnections in local dogfood; users should prefer small, independently
  reviewable tasks during the preview.
- npm distribution is not part of this preview; installation is from a cloned
  GitHub repository through the packaged local marketplace.

[0.1.1]: https://github.com/echopath-labs/relaypact/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/echopath-labs/relaypact/releases/tag/v0.1.0
[0.1.2]: https://github.com/echopath-labs/relaypact/compare/v0.1.1...v0.1.2

[0.2.0]: https://github.com/echopath-labs/relaypact/compare/v0.1.2...v0.2.0

[0.3.0]: https://github.com/echopath-labs/relaypact/compare/v0.2.0...v0.3.0

[0.3.1]: https://github.com/echopath-labs/relaypact/compare/v0.3.0...v0.3.1

[0.3.2]: https://github.com/echopath-labs/relaypact/compare/v0.3.1...v0.3.2

[0.3.3]: https://github.com/echopath-labs/relaypact/compare/v0.3.2...v0.3.3

[0.3.4]: https://github.com/echopath-labs/relaypact/compare/v0.3.3...v0.3.4
