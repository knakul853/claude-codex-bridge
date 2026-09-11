import { resolve } from "node:path";
import type { AgentRecord } from "./claude";
import type { PeerLink } from "./contracts";
import { errorMessage } from "./errors";
import { listPeers } from "./peers";
import {
  NativeCommandError,
  nativeProcessRunner,
  type ProcessRunner,
} from "./process";
import { type ClaudeSession, listClaudeSessions } from "./sessions";

/** Native states that mean the session's own work has ended. */
export const SETTLED_STATES = ["done", "stopped", "failed"];

/**
 * Only a Claude process is ever signalled. argv0 is an installed binary, a
 * versioned payload directory, or the macOS app bundle, so the name is matched
 * as a path segment rather than as a prefix.
 */
const CLAUDE_COMMAND = /(?:^|\/)claude(?:[/ ]|$)/;
const SUPERVISOR_FLAG = "--bg-pty-host";

const PROCESS_COLUMNS = "pid=,ppid=,rss=,command=";
const PROCESS_LINE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/;

export interface ProcessFacts {
  pid: number;
  parent: number;
  residentMb: number;
  command: string;
}

/**
 * Reads the live processes among the given pids in one call. A pid that is
 * absent from the result is dead; a `ps` that could not run at all propagates,
 * because concluding "dead" from a failed lookup is how a live worker gets its
 * routing state deleted.
 */
export async function processTable(
  pids: number[],
  runner: ProcessRunner = nativeProcessRunner,
): Promise<Map<number, ProcessFacts>> {
  const table = new Map<number, ProcessFacts>();
  const wanted = [
    ...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0)),
  ];
  if (wanted.length === 0) return table;
  let stdout: string;
  try {
    stdout = (
      await runner.run([
        "ps",
        "-ww",
        "-o",
        PROCESS_COLUMNS,
        "-p",
        wanted.join(","),
      ])
    ).stdout;
  } catch (error) {
    // `ps` exits 1 with nothing to say when none of the pids are alive, which is
    // an answer rather than a failure.
    if (
      error instanceof NativeCommandError &&
      error.exitCode === 1 &&
      !error.detail
    )
      return table;
    throw error;
  }
  for (const line of stdout.split("\n")) {
    const match = PROCESS_LINE.exec(line);
    if (!match) continue;
    table.set(Number(match[1]), {
      pid: Number(match[1]),
      parent: Number(match[2]),
      residentMb: Math.round(Number(match[3]) / 1024),
      command: match[4] ?? "",
    });
  }
  return table;
}

export type SessionDisposition = "gone" | "finished" | "stuck" | "working";

export interface SessionFacts {
  sessionId: string;
  disposition: SessionDisposition;
  /**
   * The daemon has not settled this session's background lease, so it can be
   * revived into a running worker even when no process is left right now.
   */
  revivable: boolean;
  state?: string;
  shortId?: string;
  kind?: string;
  pid?: number;
  /** The `--bg-pty-host` that owns the worker, once proved to own it. */
  supervisor?: number;
  residentMb?: number;
  /** Whether the pid was proved to be this session's Claude process. */
  verified: boolean;
}

/** A session that is writing, or that the daemon could put back to writing. */
export function isActive(facts: SessionFacts): boolean {
  return (
    facts.revivable ||
    facts.disposition === "working" ||
    facts.disposition === "stuck"
  );
}

function supervises(
  supervisor: ProcessFacts | undefined,
  worker: ProcessFacts,
): boolean {
  if (!supervisor?.command.includes(SUPERVISOR_FLAG)) return false;
  // The host's argv carries the worker's own argv after "--", so the worker's
  // last token appearing there is what proves this parent supervises it.
  const claim = worker.command.trim().split(/\s+/).at(-1);
  return claim !== undefined && supervisor.command.includes(claim);
}

interface SessionSources {
  sessionId: string;
  agent?: AgentRecord;
  record?: ClaudeSession;
  worker?: ProcessFacts;
  supervisor?: ProcessFacts;
}

function dispositionOf(
  input: SessionSources,
  settled: boolean,
): SessionDisposition {
  const { agent, record, worker } = input;
  if (!worker) {
    // No process to reclaim. An unsettled lease still counts as working: the
    // daemon can put this session back on the tree at any time.
    if (!agent) return "gone";
    return settled ? "finished" : "working";
  }
  if (agent?.state === "blocked") return "stuck";
  // A native label written before the worker went back to work is stale; the
  // registry's own status outranks it.
  return settled && record?.status !== "busy" ? "finished" : "working";
}

function reconcile(input: SessionSources): SessionFacts {
  const { agent, worker } = input;
  const state = agent?.state;
  const settled = state !== undefined && SETTLED_STATES.includes(state);
  const revivable = state !== undefined && !settled;
  const verified = worker !== undefined && CLAUDE_COMMAND.test(worker.command);
  const disposition = dispositionOf(input, settled);
  return {
    sessionId: input.sessionId,
    disposition,
    revivable,
    verified,
    ...(state !== undefined ? { state } : {}),
    ...(agent?.id !== undefined ? { shortId: agent.id } : {}),
    ...(agent?.kind !== undefined ? { kind: agent.kind } : {}),
    ...(worker ? { pid: worker.pid, residentMb: worker.residentMb } : {}),
    ...(verified &&
    input.supervisor &&
    worker &&
    supervises(input.supervisor, worker)
      ? { supervisor: input.supervisor.pid }
      : {}),
  };
}

export interface ReconcileInput {
  sessionIds: string[];
  agents: AgentRecord[];
  runner?: ProcessRunner;
  sessionsRoot?: string;
}

/**
 * Decides what each session is really doing from three sources that disagree:
 * the native state label, the session registry, and the operating system. The
 * process is the floor — a label saying "failed" over a live busy worker is a
 * stale label, and a label saying "working" over no process at all is an
 * unsettled lease the daemon can still revive.
 */
export async function reconcileSessions(
  input: ReconcileInput,
): Promise<Map<string, SessionFacts>> {
  const runner = input.runner ?? nativeProcessRunner;
  const registry = await listClaudeSessions(input.sessionsRoot);
  const wanted = [...new Set(input.sessionIds)];
  const candidates = new Map<string, number>();
  for (const sessionId of wanted) {
    const pid =
      registry.find((session) => session.sessionId === sessionId)?.pid ??
      input.agents.find((agent) => agent.sessionId === sessionId)?.pid;
    if (pid !== undefined) candidates.set(sessionId, pid);
  }
  const workers = await processTable([...candidates.values()], runner);
  const parents = await processTable(
    [...workers.values()].map((facts) => facts.parent),
    runner,
  );
  const facts = new Map<string, SessionFacts>();
  for (const sessionId of wanted) {
    const candidate = candidates.get(sessionId);
    const worker = candidate === undefined ? undefined : workers.get(candidate);
    const agent = input.agents.find((entry) => entry.sessionId === sessionId);
    const record = registry.find((entry) => entry.sessionId === sessionId);
    const supervisor = worker ? parents.get(worker.parent) : undefined;
    facts.set(
      sessionId,
      reconcile({
        sessionId,
        ...(agent ? { agent } : {}),
        ...(record ? { record } : {}),
        ...(worker ? { worker } : {}),
        ...(supervisor ? { supervisor } : {}),
      }),
    );
  }
  return facts;
}

export interface WorktreeOwner {
  peer: PeerLink;
  facts: SessionFacts;
}

/**
 * The bridge worker that already holds a working tree. Two workers in one tree
 * are two writers on the same files, so this is what start and continue check
 * before adding another.
 */
export async function worktreeOwner(input: {
  cwd: string;
  agents: AgentRecord[];
  runner?: ProcessRunner;
  home?: string;
  sessionsRoot?: string;
}): Promise<WorktreeOwner | undefined> {
  const wanted = resolve(input.cwd);
  const peers = (await listPeers(input.home)).filter(
    (peer) => peer.claudeSessionId && resolve(peer.cwd) === wanted,
  );
  if (peers.length === 0) return undefined;
  const facts = await reconcileSessions({
    sessionIds: peers.map((peer) => peer.claudeSessionId as string),
    agents: input.agents,
    ...(input.runner ? { runner: input.runner } : {}),
    ...(input.sessionsRoot ? { sessionsRoot: input.sessionsRoot } : {}),
  });
  for (const peer of peers) {
    const owner = facts.get(peer.claudeSessionId as string);
    if (owner && isActive(owner)) return { peer, facts: owner };
  }
  return undefined;
}

export interface StopOptions {
  sessionId: string;
  inventory: () => Promise<AgentRecord[]>;
  runner?: ProcessRunner;
  sessionsRoot?: string;
  /** How long a signal is given to land before the next one is sent. */
  attemptMs?: number;
  /** Quiet period after the last process dies, to catch a daemon revival. */
  settleMs?: number;
  sleep?: (ms: number) => Promise<void>;
  kill?: Signaller;
}

export type Signaller = (pid: number, signal: NodeJS.Signals) => void;

export interface StopOutcome {
  stopped: boolean;
  actions: string[];
  survivors: number[];
}

async function currentFacts(
  input: StopOptions,
  runner: ProcessRunner,
): Promise<SessionFacts> {
  const facts = await reconcileSessions({
    sessionIds: [input.sessionId],
    agents: await input.inventory(),
    runner,
    ...(input.sessionsRoot ? { sessionsRoot: input.sessionsRoot } : {}),
  });
  return (
    facts.get(input.sessionId) ?? {
      sessionId: input.sessionId,
      disposition: "gone",
      revivable: false,
      verified: false,
    }
  );
}

function signal(
  kill: Signaller,
  pid: number,
  name: NodeJS.Signals,
  actions: string[],
): void {
  try {
    kill(pid, name);
    actions.push(`sent ${name} to pid ${pid}`);
  } catch (error) {
    actions.push(`${name} to pid ${pid} failed: ${errorMessage(error)}`);
  }
}

/**
 * Ends a background session and proves it. `claude stop` is asked first because
 * it releases the daemon's lease; signalling the worker alone leaves the lease
 * unsettled and the daemon revives it later. Whatever the route, the session is
 * only reported stopped once no process survives, the daemon has settled the
 * lease, and neither has come back during a quiet period.
 */
export async function stopSession(input: StopOptions): Promise<StopOutcome> {
  const runner = input.runner ?? nativeProcessRunner;
  const sleep = input.sleep ?? ((ms: number) => Bun.sleep(ms));
  const kill = input.kill ?? ((pid, name) => process.kill(pid, name));
  const actions: string[] = [];
  let facts = await currentFacts(input, runner);
  if (facts.disposition === "gone" && !facts.revivable) {
    return {
      stopped: true,
      actions: [`session ${input.sessionId} was already gone`],
      survivors: [],
    };
  }
  if (facts.kind === "interactive") {
    return {
      stopped: false,
      actions: [
        `refused to stop session ${input.sessionId}: it is an interactive session, not a bridge worker`,
      ],
      survivors: facts.pid === undefined ? [] : [facts.pid],
    };
  }
  if (facts.shortId) {
    try {
      await runner.run(["claude", "stop", facts.shortId]);
      actions.push(`claude stop ${facts.shortId} acknowledged`);
    } catch (error) {
      actions.push(
        `claude stop ${facts.shortId} failed: ${errorMessage(error)}`,
      );
    }
    facts = await currentFacts(input, runner);
  }
  for (const name of ["SIGTERM", "SIGKILL"] as const) {
    if (facts.pid === undefined) break;
    if (!facts.verified) {
      actions.push(
        `refused to signal pid ${facts.pid}: it is not a verified Claude process for ${input.sessionId}`,
      );
      break;
    }
    // The supervisor goes first: signalling only the worker leaves a host that
    // puts it straight back.
    if (facts.supervisor !== undefined)
      signal(kill, facts.supervisor, name, actions);
    signal(kill, facts.pid, name, actions);
    await sleep(input.attemptMs ?? 1_000);
    facts = await currentFacts(input, runner);
  }
  if (facts.pid === undefined) {
    await sleep(input.settleMs ?? 2_000);
    facts = await currentFacts(input, runner);
    if (facts.pid !== undefined) {
      actions.push(
        `session ${input.sessionId} came back as pid ${facts.pid} after it was stopped`,
      );
    }
  }
  const survivors =
    facts.pid === undefined
      ? []
      : [
          facts.pid,
          ...(facts.supervisor === undefined ? [] : [facts.supervisor]),
        ];
  if (facts.revivable) {
    actions.push(
      `claude still reports session ${input.sessionId} as "${facts.state}", so its background lease was never settled`,
    );
  }
  return {
    stopped: survivors.length === 0 && !facts.revivable,
    actions,
    survivors,
  };
}
