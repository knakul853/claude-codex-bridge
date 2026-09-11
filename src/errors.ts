/**
 * Failures a caller can act on without reading prose. Codex drives the bridge
 * from a script, so the reason a verb refused has to survive as a value.
 */
export type BridgeErrorCode =
  | "worktree_owner_active"
  | "session_still_running"
  | "termination_unconfirmed"
  | "launch_unpublished";

export class BridgeError extends Error {
  constructor(
    readonly code: BridgeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BridgeError";
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown";
}
