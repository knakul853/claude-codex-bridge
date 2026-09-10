import { rm } from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
  type AgentRecord,
  isFinished,
  isLive,
  parseAgentRecords,
} from "./claude";
import type { PeerLink } from "./contracts";
import { findPeer, listPeers, unlinkPeer } from "./peers";
import { nativeProcessRunner, type ProcessRunner } from "./process";
import { listClaudeSessions } from "./sessions";

/** Worktrees the bridge cut itself, which are the only ones it may remove. */
const BRIDGE_WORKTREE = /^claude-codex-[0-9a-f]{8}$/;

export type PeerDisposition = "gone" | "finished" | "stuck" | "working";

export interface PeerHealth {
  peer: PeerLink;
  disposition: PeerDisposition;
  agent?: AgentRecord;
  pid?: number;
  residentMb?: number;
}

async function residentMb(
  pids: number[],
  process: ProcessRunner,
): Promise<Map<number, number>> {
  const sizes = new Map<number, number>();
  if (pids.length === 0) return sizes;
  try {
    const result = await process.run([
      "ps",
      "-o",
      "pid=,rss=",
      "-p",
      pids.join(","),
    ]);
    for (const line of result.stdout.trim().split("\n")) {
      const [pid, rss] = line.trim().split(/\s+/).map(Number);
      if (Number.isInteger(pid) && Number.isInteger(rss)) {
        sizes.set(pid as number, Math.round((rss as number) / 1024));
      }
    }
  } catch {
    // Memory figures are advisory; their absence must not block a sweep.
  }
  return sizes;
}

/**
 * Classifies every recorded collaboration by whether its Claude session is still
 * consuming memory. A record keeps its state after the process exits, so a
 * missing pid is what distinguishes a dead session from a live one.
 */
export async function surveyPeers(
  process: ProcessRunner = nativeProcessRunner,
  home?: string,
): Promise<PeerHealth[]> {
  const peers = await listPeers(home);
  const agents = parseAgentRecords(
    (await process.run(["claude", "agents", "--json", "--all"])).stdout,
  );
  const live = await listClaudeSessions();
  const health: PeerHealth[] = [];
  for (const peer of peers) {
    if (!peer.claudeSessionId) {
      health.push({ peer, disposition: "gone" });
      continue;
    }
    const agent = agents.find((a) => a.sessionId === peer.claudeSessionId);
    const pid =
      agent?.pid ?? live.find((s) => s.sessionId === peer.claudeSessionId)?.pid;
    const disposition: PeerDisposition = !agent
      ? "gone"
      : pid === undefined && !isLive(agent)
        ? isFinished(agent)
          ? "finished"
          : "gone"
        : agent.state === "blocked"
          ? "stuck"
          : "working";
    health.push({
      peer,
      disposition,
      ...(agent ? { agent } : {}),
      ...(pid !== undefined ? { pid } : {}),
    });
  }
  const sizes = await residentMb(
    health.flatMap((entry) => (entry.pid === undefined ? [] : [entry.pid])),
    process,
  );
  return health.map((entry) => ({
    ...entry,
    ...(entry.pid !== undefined && sizes.has(entry.pid)
      ? { residentMb: sizes.get(entry.pid) as number }
      : {}),
  }));
}

// A pid is only killed after the session registry confirms it still belongs to
// the session being closed: pids are reused, and this one came from a file.
async function killVerified(
  pid: number,
  sessionId: string,
  signal: string,
): Promise<boolean> {
  const owner = (await listClaudeSessions()).find(
    (session) => session.pid === pid,
  );
  if (!owner || owner.sessionId !== sessionId) return false;
  try {
    process.kill(pid, signal as NodeJS.Signals);
    return true;
  } catch {
    return false;
  }
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
      return `could not remove worktree ${cwd}: ${
        gitError instanceof Error ? gitError.message : "git failed"
      }; ${removeError instanceof Error ? removeError.message : "delete failed"}`;
    }
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
}

export interface CloseResult {
  peerId: string;
  actions: string[];
}

export async function closePeer(input: CloseOptions): Promise<CloseResult> {
  const runner = input.process ?? nativeProcessRunner;
  const peer = await findPeer(input.reference, input.home);
  if (!peer) throw new Error(`no peer matches ${input.reference}`);
  const actions: string[] = [];
  const survey = (await surveyPeers(runner, input.home)).find(
    (entry) => entry.peer.id === peer.id,
  );
  if (survey?.pid !== undefined && peer.claudeSessionId) {
    if (!input.force) {
      throw new Error(
        `session ${peer.claudeSessionId} is still ${survey.disposition} (pid ${survey.pid}, ${survey.residentMb ?? "?"} MB). Pass --force to stop it`,
      );
    }
    const stopped = await killVerified(
      survey.pid,
      peer.claudeSessionId,
      "SIGTERM",
    );
    actions.push(
      stopped
        ? `stopped claude session ${peer.claudeSessionId} (pid ${survey.pid})`
        : `could not stop pid ${survey.pid}; it no longer matches the session`,
    );
  }
  if (input.removeWorktree) {
    const removed = await removeWorktree(resolve(peer.cwd), runner);
    if (removed) actions.push(removed);
  }
  if (input.archiveThread && peer.codexThreadId) {
    try {
      await runner.run(["codex", "archive", peer.codexThreadId]);
      actions.push(`archived codex thread ${peer.codexThreadId}`);
    } catch (error) {
      actions.push(
        `codex archive failed: ${error instanceof Error ? error.message : "unknown"}`,
      );
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
}

export interface ReapResult {
  applied: boolean;
  reclaimedMb: number;
  survey: PeerHealth[];
  actions: string[];
}

/**
 * Sweeps collaborations whose Claude session has finished or died, and optionally
 * stops ones wedged on a permission prompt. Reports without changing anything
 * unless asked, because stopping a session discards its unsaved work.
 */
export async function reapPeers(input: ReapOptions = {}): Promise<ReapResult> {
  const runner = input.process ?? nativeProcessRunner;
  const survey = await surveyPeers(runner, input.home);
  const prunable = survey.filter(
    (entry) =>
      entry.disposition === "gone" ||
      entry.disposition === "finished" ||
      (input.killStuck && entry.disposition === "stuck"),
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
    };
  }
  const actions: string[] = [];
  for (const entry of prunable) {
    try {
      const result = await closePeer({
        reference: entry.peer.id,
        force: true,
        removeWorktree: true,
        process: runner,
        ...(input.home ? { home: input.home } : {}),
      });
      actions.push(...result.actions);
    } catch (error) {
      actions.push(
        `could not close ${entry.peer.id}: ${error instanceof Error ? error.message : "unknown"}`,
      );
    }
  }
  return { applied: true, reclaimedMb, survey, actions };
}
