# RelayPact Public Repository Instructions

This repository is the independently publishable public source tree. Keep
private planning records, local credentials, personal paths, raw execution
logs, and unpublished workspace decisions outside this repository.

## Architecture ownership

- `support-matrix.json` is the authority for admitted routes, harness identity,
  status, prerequisites, plugin activation, and route-owned validation.
- `packages/contracts` owns Agent-neutral contracts and schemas.
- `packages/core` owns product-neutral evidence, environment, process, Git,
  filesystem, redaction, and context services.
- Host, executor, and adapter packages own only their named product boundary.
- Codex-to-Codex is the public-preview route. Codex-to-Pi and Codex-to-Cursor
  are experimental and must never become implicit Codex prerequisites or fallbacks.
- Providers, models, proxies, and optional bridges are route configuration, not
  execution harnesses or core dependencies.

Respect the dependency direction enforced by
`scripts/validate-architecture.mjs`. Do not add cross-harness imports, ambient
configuration discovery, or an automatic fallback between adapters.

## Contracts and public files

- Keep JSON Schema identifiers aligned with the canonical
  `packages/contracts/schemas/` public location.
- `public-files.json` is the exact public file inventory. Update it
  intentionally whenever a public file is added, moved, or removed.
- Never add credentials, authentication files, environment files, personal
  absolute paths, private notes, generated logs, or raw patches.
- The root `plugin.json` is the only plugin manifest. Do not add
  `.codex-plugin/plugin.json`.

## Validation and Git

- Use Node.js 20 or later and Codex CLI 0.147.0 or later where Codex plugin
  compatibility is relevant.
- Run `npm run check` for every implementation change. Route-specific work
  should also run its focused check and relevant opt-in smoke when configured.
- Deterministic tests must remain offline and independent of user Pi, Codex,
  provider, model, proxy, router, network, or credential configuration.
- Do not commit, push, tag, publish, release, or change repository settings
  without explicit human authorization. Executor completion is never final
  host or human acceptance.

## Collaboration working rules

- Keep each pull request focused on one responsibility and to approximately
  400 or fewer net added lines. Split larger changes into multiple pull
  requests before implementation continues.
- Before implementation begins, record the acceptance commands in the
  corresponding OpenSpec change or pull request description.
- Run the full `npm test` suite locally before every push and include a concise
  result summary in the pull request description.
- Treat bot reviews as advisory rather than as merge gates. Stop after at most
  two or three bot-driven fix rounds on the same pull request, document any
  remaining findings in the pull request description, and escalate them to a
  human reviewer.
- Name branches with a `feat/`, `fix/`, `docs/`, or `chore/` prefix. Do not use
  the `codex/` prefix. Branch names do not confer merge or release authority.
- Start every work session with `git fetch origin && git status` to verify that
  the local baseline is current.
- Resolve every review thread before merge. The repository ruleset enforces
  this requirement.
