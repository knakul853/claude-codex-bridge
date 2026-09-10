import { rm } from "node:fs/promises";
import { join } from "node:path";
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
  label?: string;
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

// Upserts on either native id: registering the same collaboration twice fills in
// the side that was unknown the first time instead of forking the link.
export async function linkPeer(
  identity: PeerIdentity,
  home?: string,
  now: () => string = () => new Date().toISOString(),
): Promise<PeerLink> {
  if (!identity.claudeSessionId && !identity.codexThreadId) {
    throw new Error("a peer link needs a Claude session or a Codex thread");
  }
  const links = await listPeers(home);
  const existing = links.find(
    (link) =>
      (identity.claudeSessionId !== undefined &&
        link.claudeSessionId === identity.claudeSessionId) ||
      (identity.codexThreadId !== undefined &&
        link.codexThreadId === identity.codexThreadId),
  );
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
