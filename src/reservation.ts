import { rm } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { BridgeError } from "./errors";
import {
  absent,
  atomicCreate,
  bridgeHome,
  ensurePrivateDirectory,
  safeRead,
} from "./store";

/**
 * How long a contender is believed once its holder can no longer be checked.
 * Longer than any launch takes, short enough that a crash on another machine
 * frees the tree again without anyone deleting a file by hand.
 */
export const RESERVATION_TTL_MS = 10 * 60_000;

interface Contender {
  schemaVersion: 1;
  token: string;
  cwd: string;
  gitCommonDir: string;
  pid: number;
  host: string;
  acquiredAt: string;
}

interface Candidate {
  path: string;
  record?: Contender;
}

export interface WorktreeReservation {
  release(): Promise<void>;
}

export interface ReserveOptions {
  cwd: string;
  gitCommonDir: string;
  home?: string;
  now?: () => number;
  pid?: number;
  host?: string;
  alive?: (pid: number) => boolean;
}

// A working tree is identified by the repository it belongs to and its own
// path, so a name, a label or a branch can change without moving the lock.
function reservationDirectory(input: ReserveOptions): string {
  const hash = new Bun.CryptoHasher("sha256");
  hash.update(resolve(input.gitCommonDir));
  hash.update("\0");
  hash.update(resolve(input.cwd));
  return join(input.home ?? bridgeHome(), "reservations", hash.digest("hex"));
}

function parseContender(value: unknown): Contender | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    typeof record.token !== "string" ||
    typeof record.cwd !== "string" ||
    typeof record.gitCommonDir !== "string" ||
    !Number.isInteger(record.pid) ||
    typeof record.host !== "string" ||
    typeof record.acquiredAt !== "string"
  ) {
    return;
  }
  return {
    schemaVersion: 1,
    token: record.token,
    cwd: record.cwd,
    gitCommonDir: record.gitCommonDir,
    pid: record.pid as number,
    host: record.host,
    acquiredAt: record.acquiredAt,
  };
}

async function readCandidates(directory: string): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  const glob = new Bun.Glob("*.json");
  try {
    for await (const name of glob.scan({ cwd: directory, onlyFiles: true })) {
      const path = join(directory, name);
      try {
        const record = parseContender(JSON.parse(await safeRead(path)));
        candidates.push({ path, ...(record ? { record } : {}) });
      } catch (error) {
        // A file that vanished between the scan and the read is simply gone; a
        // file that will not parse cannot be a live holder, because a holder's
        // own file is linked into place whole.
        if (!absent(error)) candidates.push({ path });
      }
    }
  } catch (error) {
    if (!absent(error)) throw error;
  }
  return candidates;
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Not ours to signal still means it is there.
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

/**
 * A contender counts only until one of two things is true: the process that
 * wrote it is gone, which is only evidence on the machine that wrote it, or it
 * is older than the time any publication can take. Both bounds exist so a
 * crashed start cannot leave a worktree reserved forever.
 */
function expired(
  record: Contender,
  now: number,
  host: string,
  alive: (pid: number) => boolean,
): boolean {
  const age = now - Date.parse(record.acquiredAt);
  if (!Number.isFinite(age) || age >= RESERVATION_TTL_MS) return true;
  return record.host === host && !alive(record.pid);
}

/**
 * Every contender orders the same files the same way, so they all elect the same
 * holder without any of them writing to another's file. The comparison is on
 * code units rather than through a collator: an election has to come out
 * identically in every process, whatever locale it was started in.
 */
function earlierThan(left: Contender, right: Contender): number {
  if (left.acquiredAt !== right.acquiredAt)
    return left.acquiredAt < right.acquiredAt ? -1 : 1;
  return left.token < right.token ? -1 : 1;
}

function refuse(cwd: string, winner: Contender | undefined): never {
  const holder = winner
    ? `pid ${winner.pid} on ${winner.host} has held it since ${winner.acquiredAt}`
    : "another process holds it";
  throw new BridgeError(
    "worktree_owner_active",
    `another bridge start or continue is already publishing a worker for ${cwd} (${holder}). Let it finish and read \`claude-codex-bridge peers\`, or use a different worktree`,
  );
}

/**
 * Claims the exclusive right to publish a worker into one working tree, so that
 * reconciling who owns the tree and recording the worker that takes it cannot be
 * interleaved by a second start.
 *
 * Each contender creates only its own file and then elects a winner from what it
 * finds, which is what keeps a takeover safe: two commands reclaiming the same
 * abandoned tree agree on one winner instead of each deleting what it read and
 * claiming afterwards. Refuses immediately rather than waiting, because the
 * caller is a command someone is watching, not a queue.
 */
export async function reserveWorktree(
  input: ReserveOptions,
): Promise<WorktreeReservation> {
  const directory = reservationDirectory(input);
  const host = input.host ?? hostname();
  const alive = input.alive ?? running;
  const now = input.now ?? (() => Date.now());
  const mine: Contender = {
    schemaVersion: 1,
    token: crypto.randomUUID(),
    cwd: resolve(input.cwd),
    gitCommonDir: resolve(input.gitCommonDir),
    pid: input.pid ?? process.pid,
    host,
    acquiredAt: new Date(now()).toISOString(),
  };
  const path = join(directory, `${mine.token}.json`);
  await ensurePrivateDirectory(directory);
  await atomicCreate(path, mine);
  const candidates = await readCandidates(directory);
  const standing = candidates.filter(
    (candidate) =>
      candidate.record !== undefined &&
      (candidate.record.token === mine.token ||
        !expired(candidate.record, now(), host, alive)),
  );
  const winner = standing
    .map((candidate) => candidate.record as Contender)
    .sort(earlierThan)[0];
  if (winner?.token !== mine.token) {
    await rm(path, { force: true });
    refuse(input.cwd, winner);
  }
  // Only the elected holder tidies, and only what it proved abandoned, so no
  // contender ever removes a file another one is still standing on.
  for (const candidate of candidates) {
    if (standing.includes(candidate)) continue;
    await rm(candidate.path, { force: true });
  }
  return {
    async release() {
      await rm(path, { force: true });
    },
  };
}
