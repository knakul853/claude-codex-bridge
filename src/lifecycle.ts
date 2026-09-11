import { rm } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import { type AgentRecord, parseAgentRecords } from "./claude";
import type { PeerLink } from "./contracts";
import { BridgeError, errorMessage } from "./errors";
import { findPeer, listPeers, unlinkPeer } from "./peers";
import { nativeProcessRunner, type ProcessRunner } from "./process";
import { forgetState } from "./state";
import {
  isActive,
  reconcileSessions,
  type SessionDisposition,
  type SessionFacts,
  type Signaller,
  stopSession,
} from "./supervision";

/** Worktrees the bridge cut itself, which are the only ones it may remove. */
const BRIDGE_WORKTREE = /^claude-codex-[0-9a-f]{8}$/;

export type PeerDisposition = SessionDisposition;

export interface PeerHealth {
  peer: PeerLink;
  disposition: PeerDisposition;
  agent?: AgentRecord;
  facts?: SessionFacts;
  pid?: number;
  residentMb?: number;
}

async function inventory(process: ProcessRunner): Promise<AgentRecord[]> {
  return parseAgentRecords(
    (await process.run(["claude", "agents", "--json", "--all"])).stdout,
  );
}

/**
 * Classifies every recorded collaboration by what its Claude session is really
 * doing. The native state, the session registry and the operating system all
 * answer that question differently, so each one is reconciled against the
 * others rather than any single label being believed.
 */
export async function surveyPeers(
  process: ProcessRunner = nativeProcessRunner,
  home?: string,
): Promise<PeerHealth[]> {
  const peers = await listPeers(home);
  const agents = await inventory(process);
  const facts = await reconcileSessions({
    sessionIds: peers.flatMap((peer) =>
      peer.claudeSessionId ? [peer.claudeSessionId] : [],
    ),
    agents,
    runner: process,
  });
  return peers.map((peer) => {
    const session = peer.claudeSessionId
      ? facts.get(peer.claudeSessionId)
      : undefined;
    const agent = agents.find(
      (entry) => entry.sessionId === peer.claudeSessionId,
    );
    return {
      peer,
      disposition: session?.disposition ?? "gone",
      ...(agent ? { agent } : {}),
      ...(session ? { facts: session } : {}),
      ...(session?.pid !== undefined ? { pid: session.pid } : {}),
      ...(session?.residentMb !== undefined
        ? { residentMb: session.residentMb }
        : {}),
    };
  });
}

async function removeWorktree(
  cwd: string,
  process: ProcessRunner,
): Promise<string | undefined> {
  if (!BRIDGE_WORKTREE.test(basename(cwd))) return;
  try {
    await process.run(["git", "-C", cwd, "worktree", "remove", "--force", cwd]);
    return `removed worktree ${cwd}`;
  } catch (gitError) {
    // The worktree may already be gone, or its repository moved. Deleting the
    // directory is the fallback, and both failures are reported rather than
    // dropped: claiming a removal that did not happen is worse than saying so.
    try {
      await rm(cwd, { recursive: true, force: true });
      return `deleted worktree directory ${cwd}`;
    } catch (removeError) {
      return `could not remove worktree ${cwd}: ${errorMessage(
        gitError,
      )}; ${errorMessage(removeError)}`;
    }
  }
}

async function repositoryOf(
  peer: PeerLink,
  process: ProcessRunner,
): Promise<string | undefined> {
  if (peer.gitCommonDir) return peer.gitCommonDir;
  const common = (
    await process.run([
      "git",
      "-C",
      peer.cwd,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ])
  ).stdout.trim();
  return isAbsolute(common) ? common : undefined;
}

/**
 * Drops the manifest and delivery records the bridge kept for the session, so a
 * closed collaboration leaves nothing for `forget` to chase. Links recorded
 * before the repository was written down are resolved through the worktree, which
 * is why this runs before the worktree is removed.
 */
async function forgetRouting(
  peer: PeerLink,
  process: ProcessRunner,
): Promise<string | undefined> {
  if (!peer.claudeSessionId) return;
  try {
    const gitCommonDir = await repositoryOf(peer, process);
    if (!gitCommonDir) {
      return `kept routing state for ${peer.claudeSessionId}: ${peer.cwd} names no repository`;
    }
    await forgetState(gitCommonDir, peer.claudeSessionId);
    return `forgot routing state for ${peer.claudeSessionId}`;
  } catch (error) {
    return `could not forget routing state for ${peer.claudeSessionId}: ${errorMessage(error)}`;
  }
}

export interface CloseOptions {
  reference: string;
  /** Signal a live session instead of refusing to close it. */
  force?: boolean;
  archiveThread?: boolean;
  removeWorktree?: boolean;
  process?: ProcessRunner;
  home?: string;
  settleMs?: number;
  attemptMs?: number;
  sleep?: (ms: number) => Promise<void>;
  kill?: Signaller;
}

export interface CloseResult {
  peerId: string;
  actions: string[];
}

/**
 * Stops the session and only then forgets it. Nothing the bridge recorded is
 * deleted until the session is proved to have stopped and stayed stopped:
 * forgetting a worker the daemon can still revive leaves a writer nobody is
 * tracking in a worktree the bridge believes is free.
 */
export async function closePeer(input: CloseOptions): Promise<CloseResult> {
  const runner = input.process ?? nativeProcessRunner;
  const peer = await findPeer(input.reference, input.home);
  if (!peer) throw new Error(`no peer matches ${input.reference}`);
  const actions: string[] = [];
  if (peer.claudeSessionId) {
    const survey = (await surveyPeers(runner, input.home)).find(
      (entry) => entry.peer.id === peer.id,
    );
    // Only a session that has not ended can lose unsaved work to a signal; a
    // finished one is a host process still holding memory.
    if (
      !input.force &&
      (survey?.disposition === "working" || survey?.disposition === "stuck")
    ) {
      throw new BridgeError(
        "session_still_running",
        `session ${peer.claudeSessionId} is still ${survey.disposition} (pid ${survey.pid}, ${survey.residentMb ?? "?"} MB). Pass --force to stop it`,
      );
    }
    const outcome = await stopSession({
      sessionId: peer.claudeSessionId,
      inventory: () => inventory(runner),
      runner,
      ...(input.settleMs !== undefined ? { settleMs: input.settleMs } : {}),
      ...(input.attemptMs !== undefined ? { attemptMs: input.attemptMs } : {}),
      ...(input.sleep ? { sleep: input.sleep } : {}),
      ...(input.kill ? { kill: input.kill } : {}),
    });
    actions.push(...outcome.actions);
    if (!outcome.stopped) {
      throw new BridgeError(
        "termination_unconfirmed",
        `could not confirm session ${peer.claudeSessionId} stopped${
          outcome.survivors.length
            ? ` (pid ${outcome.survivors.join(", ")} still alive)`
            : ""
        }; routing state, worktree and peer link were left in place. Actions: ${actions.join("; ")}`,
      );
    }
  }
  const forgotten = await forgetRouting(peer, runner);
  if (forgotten) actions.push(forgotten);
  if (input.removeWorktree) {
    const removed = await removeWorktree(resolve(peer.cwd), runner);
    if (removed) actions.push(removed);
  }
  if (input.archiveThread && peer.codexThreadId) {
    try {
      await runner.run(["codex", "archive", peer.codexThreadId]);
      actions.push(`archived codex thread ${peer.codexThreadId}`);
    } catch (error) {
      actions.push(`codex archive failed: ${errorMessage(error)}`);
    }
  }
  await unlinkPeer(peer.id, input.home);
  actions.push(`forgot peer ${peer.id}`);
  return { peerId: peer.id, actions };
}

export interface ReapOptions {
  apply?: boolean;
  /** Also stop live sessions blocked on a prompt nobody is going to answer. */
  killStuck?: boolean;
  process?: ProcessRunner;
  home?: string;
  settleMs?: number;
  attemptMs?: number;
  sleep?: (ms: number) => Promise<void>;
  kill?: Signaller;
}

export interface ReapResult {
  applied: boolean;
  reclaimedMb: number;
  survey: PeerHealth[];
  actions: string[];
  /** Peers the sweep could not finish, which is what makes it exit non-zero. */
  unresolved: string[];
}

function reapable(entry: PeerHealth, killStuck: boolean): boolean {
  if (entry.disposition === "stuck") return killStuck;
  if (entry.facts && isActive(entry.facts)) return false;
  return entry.disposition === "gone" || entry.disposition === "finished";
}

/**
 * Sweeps collaborations whose Claude session has ended, and optionally stops
 * ones wedged on a permission prompt. Reports without changing anything unless
 * asked, because stopping a session discards its unsaved work.
 */
export async function reapPeers(input: ReapOptions = {}): Promise<ReapResult> {
  const runner = input.process ?? nativeProcessRunner;
  const survey = await surveyPeers(runner, input.home);
  const prunable = survey.filter((entry) =>
    reapable(entry, input.killStuck === true),
  );
  const reclaimedMb = prunable.reduce(
    (total, entry) => total + (entry.residentMb ?? 0),
    0,
  );
  if (!input.apply) {
    return {
      applied: false,
      reclaimedMb,
      survey,
      actions: prunable.map(
        (entry) =>
          `would close ${entry.peer.id} (${entry.disposition}${entry.residentMb ? `, ${entry.residentMb} MB` : ""})`,
      ),
      unresolved: [],
    };
  }
  const actions: string[] = [];
  const unresolved: string[] = [];
  for (const entry of prunable) {
    try {
      const result = await closePeer({
        reference: entry.peer.id,
        force: true,
        removeWorktree: true,
        process: runner,
        ...(input.home ? { home: input.home } : {}),
        ...(input.settleMs !== undefined ? { settleMs: input.settleMs } : {}),
        ...(input.attemptMs !== undefined
          ? { attemptMs: input.attemptMs }
          : {}),
        ...(input.sleep ? { sleep: input.sleep } : {}),
        ...(input.kill ? { kill: input.kill } : {}),
      });
      actions.push(...result.actions);
    } catch (error) {
      unresolved.push(entry.peer.id);
      actions.push(`could not close ${entry.peer.id}: ${errorMessage(error)}`);
    }
  }
  return { applied: true, reclaimedMb, survey, actions, unresolved };
}
