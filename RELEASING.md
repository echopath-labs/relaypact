# Release Checklist

This checklist prepares a human-authorized `0.3.1` GitHub Release. It
does not authorize a commit, remote change, push, tag, GitHub release, npm
publish, or deployment.

## Candidate Validation

From a clean candidate repository with Node.js 20 or later and Git:

```bash
npm ci --ignore-scripts
npm run check
RELAYPACT_CODEX_PLUGIN_SMOKE=1 npm run smoke:codex-plugin
npm pack --dry-run --json
```

`public-files.json` is the exact reviewed public-tree manifest. Any added,
removed, or renamed public file requires an intentional manifest update. The
sole GitHub workflow must also match the reviewed byte digest enforced by the
package validator; changing that digest is a separate security-review event.

The private development workspace additionally runs its exact public allowlist,
sensitive-content, retained-history, clean-clone, OpenSpec, OpenDomain, and
source-backed security-review gates. Raw private scan or dogfood evidence must
not be copied into this repository.

The release candidate must have a post-remediation scan against the exact tree,
no unresolved high-severity finding, no undispositioned medium-severity finding,
and passing adversarial regressions for environment isolation, Git-control
tampering, ignored-file evidence, output truncation, hard timeouts, result
redaction, context budgets and queue pressure, profile projection, concurrent
state changes, archive symlinks, and correction-state validation. Third-party
CI actions must remain pinned to reviewed full commit identifiers.

The candidate `LICENSE` must contain the reviewed Apache License 2.0 text,
`NOTICE` must retain the EchoPath Labs attribution, and `package.json`,
`plugin.json`, both README language entries, and contribution guidance must use
the exact SPDX identifier `Apache-2.0`. License drift is a release blocker.

## 0.3.1 release-time documentation closeout

The checked-in metadata describes 0.3.1 Release, dated 2026-09-18.
The release process merges reviewed documentation before publishing the tag
and ordinary GitHub Release. Confirm both remote objects exist before treating the
version as installable; metadata alone does not establish publication.
Merge the reviewed preparation PR before closing out the release documents.
Then merge the reviewed release-documentation PR before tagging its verified main
commit. Release metadata describes that version; installation still requires a
visible official tag and GitHub Release.

1. Start a clean release branch from the then-current live main. Confirm the
   exact repository is echopath-labs/relaypact and record the reviewed candidate
   commit/tree and the complete diff from that main baseline.
2. Confirm the authenticated GitHub identity is exactly chasechou007.
3. Obtain the human-approved release date and explicit authorization for the
   final commit, branch push/review, annotated tag, GitHub Release and main
   integration. Preparation alone does not grant these operations.
4. Prepare one scoped versioned-documentation commit:
   - Set PROJECT_RELEASE_STATE in scripts/validate-package.mjs to versioned;
     set PROJECT_VERSION to 0.3.1 and the previous published version at 0.3.0.
   - Update README.md, README.zh-CN.md, docs/agent-quickstart.md,
     docs/agent-quickstart.zh-CN.md and docs/manual-configuration.md to name
     v0.3.1 as the installation target, require a visible official GitHub Release
     before running install commands, and verify the peeled
     v0.3.1^{} commit. Remove candidate-only statements and the guidance caveat
     that applies to the older installation; retain explicitly historical notes.
   - Date the 0.3.1 changelog entry and add its comparison link.
   - Versioned documentation is not a publication announcement. Do not label
     v0.3.1 as latest published before the remote tag and Release exist.
     If publication fails after merge, installation must stop at the Release
     availability precondition; the previous v0.3.0 remains the fallback.
   - Update this checklist's current-state paragraph and version-sensitive
     validation fixtures so the release itself does not retain a stale
     candidate-state description. Keep route status and known limits accurate.
5. Validate the exact final commit: full candidate checks above, allowlist,
   privacy/history, ordinary source-backed review, and no-object-sharing clean
   clone with isolated Plugin discovery. Inspect the final package contents.
   Run the required Validate CI on the final release-documentation PR. Merge the
   reviewed PR before creating the release tag, then verify the merged main tree
   matches the reviewed content and its post-merge CI passes. Earlier main CI is
   not final release-candidate CI.
6. Under the explicit remote authorization, create the annotated v0.3.1 tag at
   that verified merged main commit, push only the approved tag and create a
   ordinary GitHub Release. Verify the peeled tag and the visible GitHub Release.
7. Recheck main, tag identity, Release visibility, bilingual links and install
   commands. Record the resulting commit identities and post-integration CI.

If authority, date, identity, validation or remote state is missing or
mismatched, stop the affected publication action and preserve the local
candidate for review. After publication, never rewrite the tag; use a separately
authorized withdrawal or corrected version. Do not discard unrelated work.

## Manual GitHub Gates

Verify the existing repository gates for each release:

- establish `main` as the default branch and preserve the reviewed candidate
  history;
- configure the `echopath-labs/relaypact` remote without embedding
  credentials in its URL;
- enable GitHub private vulnerability reporting and verify the link in
  [SECURITY.md](SECURITY.md);
- require the `Validate` workflow on protected release changes;
- verify an active tag ruleset matches `refs/tags/v*`, prohibits updates and
  deletions, and has no bypass actors; new release-tag creation remains allowed;
- verify the first remote Ubuntu workflow succeeds;
- inspect the final GitHub diff and release archive;
- obtain an explicit human Go decision before pushing a version tag or creating
  a release.

## Release Positioning

Describe 0.3.1 as an ordinary GitHub Release for practical Host-supervised
delegation, with Codex as the admitted Host. Continue reviewing and improving
delegation mechanisms and constraints. Preserve the existing route maturity
labels independently: Codex-to-Codex remains the active public-preview route;
Pi, Cursor, WorkBuddy and WorkBuddy AI remain experimental and explicitly selected.
Do not claim unattended, production-ready, complete
cross-platform, provider-neutral live reliability, or operating-system sandbox
guarantees beyond the documented contracts.

Keep `package.json` private for the GitHub Release. npm publication requires a
separate design, package-metadata review, provenance plan, and human approval.

## Rollback

Before publication, revert the candidate on its feature branch. After
publication, preserve the public history and either withdraw the
release or publish a corrected version. Never rewrite a released tag silently.

Tag rules protect Git refs, not administrators' ability to change repository
settings or edit Release notes. Record the peeled commit and annotated tag object
in release evidence. Never test protection by rewriting or deleting a published tag.
