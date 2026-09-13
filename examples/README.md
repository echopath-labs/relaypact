# End-to-end examples

These examples illustrate the contract lifecycle. Replace placeholder
repository paths and configured profile names locally; never add credentials to
an envelope or commit them with an example.

For Host decision behavior, use the [eight delegation review cases](host-delegation-cases.md).
Those scenarios are evaluation inputs and expectations, not executed trial evidence.
The CLI examples below retain their route-specific contracts.

## 1. Experimental Pi delegation

Copy `task-envelope.json`, set `repository.root` to a clean disposable Git
repository, keep `scope.allowedPaths` narrow, and run:

```bash
node ../bin/relaypact.mjs run-pi \
  --envelope ./task-envelope.json
```

The resulting shape is illustrated by `execution-result.completed.json`.
`status: completed` means the executor and independent postflight completed; it
still carries `hostAcceptance.status: pending`. Review the real diff, changed
paths, validations, and residual risks before accepting anything.

## 2. Blocked work

`execution-result.blocked.json` shows the correct outcome when information or
authority is missing. Do not tell the executor to discover or expose additional
paths by itself. The host either resolves the missing decision and creates a new
task envelope or stops the work.

## 3. Failed validation or rejected scope

`execution-result.failed.json` demonstrates an execution that is ineligible
because required validation did not pass. `execution-result.rejected.json`
demonstrates independently observed scope failure. Neither result may be
accepted because the executor reports success elsewhere.

## 4. Codex execution and same-session correction

Prepare private task state outside the target repository, then run the Codex
adapter with `codex-task-envelope.json` and `codex-worker-profiles.json`:

```bash
node ../bin/relaypact.mjs run-codex \
  --envelope ./codex-task-envelope.json \
  --profiles ./codex-worker-profiles.json \
  --state-root /absolute/private/task-state \
  --host-instance local-host-id
```

Inspect the emitted candidate patch and review packet. The pending structure is
illustrated by `host-review-packet.json`. If the defect stays inside the
original authority and context identity, copy `codex-correction-request.json`
to a private prompt file and run:

```bash
node ../bin/relaypact.mjs correct-codex \
  --task-root /absolute/private/task-state/relaypact-task-id-uuid \
  --profiles ./codex-worker-profiles.json \
  --prompt /absolute/private/correction.txt
```

Added readable authority or changed planned context requires a new task instead
of correction resume.

For the tested direct OpenCode Go / GPT-5.6 Luna route, use
`codex-task-envelope.opencode-go-luna.json` with
`codex-worker-profiles.opencode-go-luna.json`. Both files are credential-free;
the complete provider setup, optional live smoke, Codex Desktop prompt, review
flow, and troubleshooting guide is in `../docs/opencode-go-luna.md`.

## 5. Host acceptance and cleanup

Only an eligible review packet with no unresolved host risk may be accepted.
The public library requires an explicit actor and refuses ineligible
acceptance. A host integration can record and archive the terminal decision:

```js
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  archiveAndCleanupTerminalTask,
  recordTerminalDecision
} from "../packages/host-codex/src/actions.mjs";
import { loadCodexDelegation } from "../packages/adapter-codex-codex/src/controller.mjs";

const prepared = await loadCodexDelegation(taskRoot, profileRegistry);
const state = JSON.parse(await readFile(prepared.statePath, "utf8"));
const evidenceRoot = path.join(prepared.capsule.taskRoot, "evidence");
const review = {
  packet: JSON.parse(await readFile(
    path.join(evidenceRoot, `host-review-packet-${state.correctionSequence}.json`),
    "utf8"
  )),
  candidatePatch: await readFile(
    path.join(evidenceRoot, `candidate-${state.correctionSequence}.patch`),
    "utf8"
  )
};
const decided = await recordTerminalDecision(
  prepared,
  review,
  "accept",
  "reviewing-host-id"
);
await archiveAndCleanupTerminalTask(
  prepared,
  decided,
  "/absolute/private/review-archive"
);
```

Use `reject` or `abandon` instead of `accept` when appropriate. Terminal cleanup
archives the review packet and candidate patch, then removes only task-local
state. It does not apply the patch, change the source repository, commit, push,
tag, publish, or deploy. Applying an accepted patch remains a separate host or
human action.
