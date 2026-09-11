import { constants } from "node:fs";
import { open, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { BridgeError } from "./errors";
import { absent, bridgeHome, ensurePrivateDirectory, safeRead } from "./store";

/**
 * How long a reservation is believed once its holder can no longer be checked.
 * Longer than any launch takes, short enough that a crash on another machine
 * frees the tree again without anyone deleting a file by hand.
 */
export const RESERVATION_TTL_MS = 10 * 60_000;

interface Reservation {
  schemaVersion: 1;
  token: string;
  cwd: string;
  gitCommonDir: string;
  pid: number;
  host: string;
  acquiredAt: string;
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
function reservationPath(input: ReserveOptions): string {
  const hash = new Bun.CryptoHasher("sha256");
  hash.update(resolve(input.gitCommonDir));
  hash.update("\0");
  hash.update(resolve(input.cwd));
  return join(
    input.home ?? bridgeHome(),
    "reservations",
    `${hash.digest("hex")}.json`,
  );
}

function parseReservation(value: unknown): Reservation | undefined {
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

type Current =
  | { kind: "free" }
  | { kind: "held"; record: Reservation }
  | { kind: "unreadable" };

async function read(path: string): Promise<Current> {
  try {
    const record = parseReservation(JSON.parse(await safeRead(path)));
    return record ? { kind: "held", record } : { kind: "unreadable" };
  } catch (error) {
    if (absent(error)) return { kind: "free" };
    return { kind: "unreadable" };
  }
}

async function claim(path: string, record: Reservation): Promise<boolean> {
  try {
    const handle = await open(
      path,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST")
      return false;
    throw error;
  }
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
 * A reservation outlives its holder only until one of two things is true: the
 * process that wrote it is gone, which is only evidence on the machine that
 * wrote it, or it is older than the time any publication can take. Both bounds
 * exist so a crashed start cannot leave a worktree reserved forever.
 */
function expired(
  record: Reservation,
  now: number,
  host: string,
  alive: (pid: number) => boolean,
): boolean {
  const age = now - Date.parse(record.acquiredAt);
  if (!Number.isFinite(age) || age >= RESERVATION_TTL_MS) return true;
  return record.host === host && !alive(record.pid);
}

function refuse(cwd: string, current: Current): never {
  const holder =
    current.kind === "held"
      ? `pid ${current.record.pid} on ${current.record.host} has held it since ${current.record.acquiredAt}`
      : "another process holds it";
  throw new BridgeError(
    "worktree_owner_active",
    `another bridge start or continue is already publishing a worker for ${cwd} (${holder}). Let it finish and read \`claude-codex-bridge peers\`, or use a different worktree`,
  );
}

/**
 * Claims the exclusive right to publish a worker into one working tree, so that
 * reconciling who owns the tree and recording the worker that takes it cannot be
 * interleaved by a second start. Refuses immediately rather than waiting: the
 * caller is a command someone is watching, not a queue.
 */
export async function reserveWorktree(
  input: ReserveOptions,
): Promise<WorktreeReservation> {
  const path = reservationPath(input);
  const host = input.host ?? hostname();
  const alive = input.alive ?? running;
  const now = input.now ?? (() => Date.now());
  const record: Reservation = {
    schemaVersion: 1,
    token: crypto.randomUUID(),
    cwd: resolve(input.cwd),
    gitCommonDir: resolve(input.gitCommonDir),
    pid: input.pid ?? process.pid,
    host,
    acquiredAt: new Date(now()).toISOString(),
  };
  await ensurePrivateDirectory(dirname(path));
  if (!(await claim(path, record))) {
    const current = await read(path);
    if (
      current.kind === "held" &&
      !expired(current.record, now(), host, alive)
    ) {
      refuse(input.cwd, current);
    }
    await rm(path, { force: true });
    // One retry only: losing this one means a live contender took the tree
    // between the break and the claim, which is a refusal rather than a race to
    // keep running.
    if (!(await claim(path, record))) refuse(input.cwd, await read(path));
  }
  return {
    async release() {
      const current = await read(path);
      // A reservation broken as stale and retaken belongs to someone else now.
      if (current.kind === "held" && current.record.token !== record.token)
        return;
      await rm(path, { force: true });
    },
  };
}
