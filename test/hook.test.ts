import { expect, test } from "bun:test";
import type { BridgeManifest } from "../src/contracts";
import { type HookDependencies, handleHook } from "../src/hook";

const sessionId = "55555555-5555-4555-8555-555555555555";
const manifest: BridgeManifest = {
  schemaVersion: 1,
  sessionId,
  ownerThreadId: "owner-thread",
  name: "Review worker",
  gitCommonDir: "/repo/.git",
  createdAt: "2026-09-09T00:00:00.000Z",
};

function dependencies(overrides: Partial<HookDependencies> = {}): {
  deps: HookDependencies;
  queued: string[];
} {
  const queued: string[] = [];
  let claimed = false;
  return {
    queued,
    deps: {
      gitState: async () => ({
        commonDir: "/repo/.git",
        root: "/repo/example",
        branch: "codex/fix",
        head: "a".repeat(40),
        clean: false,
        changedFiles: ["src/fix.ts"],
      }),
      loadManifest: async () => manifest,
      claimDelivery: async () => {
        if (claimed) return false;
        claimed = true;
        return true;
      },
      settleDelivery: async () => undefined,
      queue: async (_threadId, message) => {
        queued.push(message);
      },
      ...overrides,
    },
  };
}

test("blocks one malformed stop, then reports a bounded protocol failure", async () => {
  const { deps, queued } = dependencies();
  const input = {
    session_id: sessionId,
    cwd: "/repo/worktree",
    hook_event_name: "Stop",
    last_assistant_message: "done without a handover",
  };
  expect(await handleHook(input, deps)).toEqual({
    kind: "block",
    reason: "Emit the required final <agent_handover> JSON block.",
  });
  expect(queued).toHaveLength(0);
  expect(await handleHook({ ...input, stop_hook_active: true }, deps)).toEqual({
    kind: "allow",
  });
  expect(queued[0]).toContain("protocol_failure");
  expect(queued[0]).not.toContain("done without a handover");
});

test("delivers one structured handover with independently read Git state", async () => {
  const { deps, queued } = dependencies();
  const input = {
    session_id: sessionId,
    cwd: "/repo/worktree",
    hook_event_name: "Stop",
    last_assistant_message:
      'Work completed.\n\n<agent_handover>{"disposition":"ready_for_review","summary":"Fixed it; API_KEY=<fake>"}</agent_handover>\n',
  };
  expect(await handleHook(input, deps)).toEqual({ kind: "allow" });
  expect(await handleHook(input, deps)).toEqual({ kind: "allow" });
  expect(queued).toHaveLength(1);
  expect(queued[0]).toContain('branch: "codex/fix"');
  expect(queued[0]).toContain("src/fix.ts");
  expect(queued[0]).toContain("[redacted]");
  expect(queued[0]).not.toContain("<fake>");
});

test("ignores unrelated native Claude sessions", async () => {
  const { deps, queued } = dependencies({
    loadManifest: async () => undefined,
  });
  expect(
    await handleHook(
      {
        session_id: sessionId,
        cwd: "/repo/worktree",
        hook_event_name: "StopFailure",
        error: "rate_limit",
      },
      deps,
    ),
  ).toEqual({ kind: "allow" });
  expect(queued).toHaveLength(0);
});

test("marks delivery unknown and does not retry when queueing fails", async () => {
  const settlements: string[] = [];
  const { deps } = dependencies({
    queue: async () => {
      throw new Error("uncertain transport");
    },
    settleDelivery: async (_common, _event, _session, status) => {
      settlements.push(status);
    },
  });
  const result = await handleHook(
    {
      session_id: sessionId,
      cwd: "/repo/worktree",
      hook_event_name: "StopFailure",
      error: "rate_limit",
    },
    deps,
  );
  expect(result.kind).toBe("allow");
  expect(result.kind === "allow" ? result.warning : undefined).toContain(
    "unknown",
  );
  expect(settlements).toEqual(["unknown"]);
});
