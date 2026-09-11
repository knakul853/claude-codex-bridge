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
 * When a holder stops looking like it is still publishing. Past this it is
 * reported as abandoned, but it is only ever superseded on evidence: age alone
 * never takes a worktree away from whatever might still be writing to it.
 */
export const RESERVATION_TTL_MS = 10 * 60_000;

const OWNER = "owner.json";

interface Owner {
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
function reservationDirectory(input: ReserveOptions): string {
  const hash = new Bun.CryptoHasher("sha256");
  hash.update(resolve(input.gitCommonDir));
  hash.update("\0");
  hash.update(resolve(input.cwd));
  return join(input.home ?? bridgeHome(), "reservations", hash.digest("hex"));
}

function parseOwner(value: unknown): Owner | undefined {
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
  | { kind: "held"; owner: Owner }
  | { kind: "unreadable" };

async function read(path: string): Promise<Current> {
  try {
    const owner = parseOwner(JSON.parse(await safeRead(path)));
    return owner ? { kind: "held", owner } : { kind: "unreadable" };
  } catch (error) {
    if (absent(error)) return { kind: "free" };
    return { kind: "unreadable" };
  }
}

/**
 * The whole of the mutual exclusion. `atomicCreate` links the file into place,
 * so the kernel decides who gets it; nobody has to agree about what a directory
 * looked like at some moment.
 */
async function claim(path: string, owner: Owner): Promise<boolean> {
  try {
    await atomicCreate(path, owner);
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
 * Whether the holder can be proved gone rather than merely assumed gone. Only
 * the machine that recorded a pid can judge it, and a holder proved gone can
 * neither publish nor release, which is what makes superseding it safe. Anything
 * else — another host, a pid that answers, a record that will not parse — is
 * refused instead, and cleaned up deliberately rather than raced for.
 */
function provablyAbandoned(
  owner: Owner,
  host: string,
  alive: (pid: number) => boolean,
): boolean {
  return owner.host === host && !alive(owner.pid);
}

function stale(owner: Owner, now: number): boolean {
  const age = now - Date.parse(owner.acquiredAt);
  return !Number.isFinite(age) || age >= RESERVATION_TTL_MS;
}

function refuse(input: {
  cwd: string;
  path: string;
  current: Current;
  now: number;
}): never {
  const held = input.current.kind === "held" ? input.current.owner : undefined;
  const abandoned =
    input.current.kind === "unreadable" ||
    (held !== undefined && stale(held, input.now));
  const holder = held
    ? `pid ${held.pid} on ${held.host} has held it since ${held.acquiredAt}`
    : "its record cannot be read";
  throw new BridgeError(
    "worktree_owner_active",
    abandoned
      ? `a bridge reservation for ${input.cwd} looks abandoned but cannot be proved so (${holder}), and it is never taken away on a guess. Check \`claude-codex-bridge peers\`, then delete ${input.path} once you know nothing is publishing there`
      : `another bridge start or continue is already publishing a worker for ${input.cwd} (${holder}). Let it finish and read \`claude-codex-bridge peers\`, or use a different worktree`,
  );
}

function holder(path: string, owner: Owner): WorktreeReservation {
  return {
    async release() {
      // Only the holder lets go, and only of its own hold: a reservation that
      // was superseded belongs to someone else now.
      const current = await read(path);
      if (current.kind === "held" && current.owner.token === owner.token)
        await rm(path, { force: true });
    },
  };
}

/**
 * Claims the exclusive right to publish a worker into one working tree, so that
 * reconciling who owns the tree and recording the worker that takes it cannot be
 * interleaved by a second start.
 *
 * Ownership is one file that has to be created exclusively, which is the only
 * step that decides anything; a reader's view of the directory never grants it.
 * A holder proved gone is superseded through a second exclusive create keyed to
 * that holder's own token, so exactly one contender may replace it and no
 * contender ever removes a hold that might still be live. Refuses immediately
 * rather than waiting, because the caller is a command someone is watching.
 */
export async function reserveWorktree(
  input: ReserveOptions,
): Promise<WorktreeReservation> {
  const directory = reservationDirectory(input);
  const path = join(directory, OWNER);
  const host = input.host ?? hostname();
  const alive = input.alive ?? running;
  const now = input.now ?? (() => Date.now());
  const mine: Owner = {
    schemaVersion: 1,
    token: crypto.randomUUID(),
    cwd: resolve(input.cwd),
    gitCommonDir: resolve(input.gitCommonDir),
    pid: input.pid ?? process.pid,
    host,
    acquiredAt: new Date(now()).toISOString(),
  };
  await ensurePrivateDirectory(directory);
  if (await claim(path, mine)) return holder(path, mine);

  const current = await read(path);
  if (current.kind === "free") {
    // Released between the attempt and the read. One more exclusive create,
    // which is still the kernel deciding rather than us inferring.
    if (await claim(path, mine)) return holder(path, mine);
    return refuse({
      cwd: input.cwd,
      path,
      current: await read(path),
      now: now(),
    });
  }
  if (
    current.kind !== "held" ||
    !provablyAbandoned(current.owner, host, alive)
  ) {
    return refuse({ cwd: input.cwd, path, current, now: now() });
  }

  // The holder is gone, so it cannot come back to publish or release. This
  // exclusive create is what picks the single contender allowed to replace it.
  const supersede = join(directory, `takeover.${current.owner.token}.json`);
  if (!(await claim(supersede, mine))) {
    return refuse({ cwd: input.cwd, path, current, now: now() });
  }
  try {
    const confirmed = await read(path);
    if (
      confirmed.kind !== "held" ||
      confirmed.owner.token !== current.owner.token
    ) {
      return refuse({ cwd: input.cwd, path, current: confirmed, now: now() });
    }
    await rm(path, { force: true });
    if (await claim(path, mine)) return holder(path, mine);
    return refuse({
      cwd: input.cwd,
      path,
      current: await read(path),
      now: now(),
    });
  } finally {
    await rm(supersede, { force: true });
  }
}
