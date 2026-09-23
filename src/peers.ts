import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type PeerLink, parsePeerLink } from "./contracts";
import {
  absent,
  atomicWrite,
  bridgeHome,
  ensurePrivateDirectory,
  safeRead,
} from "./store";

export interface PeerIdentity {
  cwd: string;
  claudeSessionId?: string;
  codexThreadId?: string;
  gitCommonDir?: string;
  label?: string;
  /** The session this one continues, whose record it takes over. A resume that
   * returns a fresh session id is the same worker in the same tree, not a new
   * collaboration. */
  supersedesSessionId?: string;
}

function peersRoot(home = bridgeHome()): string {
  return join(home, "peers");
}

function peerPath(id: string, home?: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("peer id must be a UUID");
  return join(peersRoot(home), `${id}.json`);
}

export async function listPeers(home?: string): Promise<PeerLink[]> {
  const root = peersRoot(home);
  await ensurePrivateDirectory(root);
  const links: PeerLink[] = [];
  const glob = new Bun.Glob("*.json");
  try {
    for await (const name of glob.scan({ cwd: root, onlyFiles: true })) {
      try {
        links.push(parsePeerLink(JSON.parse(await safeRead(join(root, name)))));
      } catch {
        // A half-written or hand-edited record must not hide the valid ones.
      }
    }
  } catch (error) {
    if (!absent(error)) throw error;
  }
  return links.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * Resolves a peer by its own id or by either side's native id, so Codex can
 * address a link it only knows a Claude session for and vice versa.
 */
export async function findPeer(
  reference: string,
  home?: string,
): Promise<PeerLink | undefined> {
  const wanted = reference.trim();
  const links = await listPeers(home);
  const matches = links.filter(
    (link) =>
      link.id === wanted ||
      link.claudeSessionId === wanted ||
      link.codexThreadId === wanted ||
      link.label === wanted,
  );
  if (matches.length > 1) {
    throw new Error(
      `${matches.length} peers match ${reference}; address it by peer id`,
    );
  }
  return matches[0];
}

function sameTree(a: string, b: string): boolean {
  return resolve(a) === resolve(b);
}

function matches(link: PeerLink, identity: PeerIdentity): boolean {
  if (
    identity.claudeSessionId !== undefined &&
    link.claudeSessionId === identity.claudeSessionId
  ) {
    return true;
  }
  if (
    identity.supersedesSessionId !== undefined &&
    link.claudeSessionId === identity.supersedesSessionId
  ) {
    return true;
  }
  // A link with no session yet is a placeholder for the worker its thread is
  // about to start in that tree, so the first real session adopts it.
  if (identity.claudeSessionId !== undefined && link.claudeSessionId) {
    return false;
  }
  return (
    identity.codexThreadId !== undefined &&
    link.codexThreadId === identity.codexThreadId &&
    sameTree(link.cwd, identity.cwd)
  );
}

/**
 * Upserts one worker's record.
 *
 * The key is the Claude worker — its session id, or the session it continues.
 * A Codex thread owns as many workers as it starts, so matching on the thread
 * alone made every sibling overwrite the last one: three parallel workers under
 * one owner left one record carrying the newest tree and nothing of the other
 * two. The thread only keys a link that has no Claude session yet, and then
 * only within the same working tree.
 */
export async function linkPeer(
  identity: PeerIdentity,
  home?: string,
  now: () => string = () => new Date().toISOString(),
): Promise<PeerLink> {
  if (!identity.claudeSessionId && !identity.codexThreadId) {
    throw new Error("a peer link needs a Claude session or a Codex thread");
  }
  const links = await listPeers(home);
  const existing = links.find((link) => matches(link, identity));
  const timestamp = now();
  const link = parsePeerLink({
    schemaVersion: 1,
    id: existing?.id ?? crypto.randomUUID(),
    cwd: identity.cwd,
    ...((identity.claudeSessionId ?? existing?.claudeSessionId)
      ? {
          claudeSessionId:
            identity.claudeSessionId ?? existing?.claudeSessionId,
        }
      : {}),
    ...((identity.codexThreadId ?? existing?.codexThreadId)
      ? { codexThreadId: identity.codexThreadId ?? existing?.codexThreadId }
      : {}),
    ...((identity.gitCommonDir ?? existing?.gitCommonDir)
      ? { gitCommonDir: identity.gitCommonDir ?? existing?.gitCommonDir }
      : {}),
    ...((identity.label ?? existing?.label)
      ? { label: identity.label ?? existing?.label }
      : {}),
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
  });
  await ensurePrivateDirectory(peersRoot(home));
  await atomicWrite(peerPath(link.id, home), link);
  return link;
}

export async function unlinkPeer(id: string, home?: string): Promise<void> {
  await rm(peerPath(id, home), { force: true });
}
