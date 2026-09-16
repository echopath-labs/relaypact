import { DelegationError } from "../../contracts/src/errors.mjs";
import {
  abandonAndCleanupFailedDirectTask,
  abandonAndCleanupInterruptedDirectTask,
  finalizeDirectTerminalDecision,
  retryDirectTerminalCleanup,
  validateDirectArchiveRoot
} from "../../core/src/direct-lifecycle.mjs";

export async function decideDirectDelegation(prepared, action, actor, archiveRoot) {
  await validateDirectArchiveRoot(prepared, archiveRoot);
  if (prepared.cleanupOnly) {
    const completed = await retryDirectTerminalCleanup(prepared, action, actor, archiveRoot);
    return {
      action, lifecycleState: completed.state.lifecycleState,
      acceptance: completed.review?.executionResult.hostAcceptance ?? { status: "abandoned", eligible: false, decidedBy: actor },
      archive: completed.archive
    };
  }
  if (new Set(["prepared", "running", "failed"]).has(prepared.state.lifecycleState)) {
    if (action !== "abandon") {
      throw new DelegationError("invalid_host_action", "An incomplete direct task can only be explicitly abandoned.");
    }
    const abandoned = prepared.state.lifecycleState === "failed"
      ? await abandonAndCleanupFailedDirectTask(prepared, actor, archiveRoot)
      : await abandonAndCleanupInterruptedDirectTask(prepared, actor, archiveRoot);
    return {
      action,
      lifecycleState: abandoned.state.lifecycleState,
      acceptance: { status: "abandoned", eligible: false, decidedBy: actor },
      archive: abandoned.archive
    };
  }
  const finalized = await finalizeDirectTerminalDecision(prepared, action, actor, archiveRoot);
  return {
    action,
    lifecycleState: finalized.state.lifecycleState,
    acceptance: finalized.review.executionResult.hostAcceptance,
    archive: finalized.archive
  };
}
