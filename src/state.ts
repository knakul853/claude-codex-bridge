import { constants } from "node:fs";
import { open, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type BridgeManifest,
  type DeliveryRecord,
  type DeliveryStatus,
  parseDeliveryRecord,
  parseManifest,
  parseSessionId,
} from "./contracts";
import {
  absent,
  atomicCreate,
  atomicWrite,
  ensurePrivateDirectory,
  safeRead,
} from "./store";

const STATE_DIR = "claude-codex-bridge";

function stateRoot(gitCommonDir: string): string {
  return join(gitCommonDir, STATE_DIR);
}

function manifestPath(gitCommonDir: string, sessionId: string): string {
  return join(
    stateRoot(gitCommonDir),
    "jobs",
    `${parseSessionId(sessionId)}.json`,
  );
}

function deliveryPath(gitCommonDir: string, eventId: string): string {
  if (!/^[0-9a-f]{64}$/.test(eventId))
    throw new Error("event id must be a SHA-256 hex value");
  return join(stateRoot(gitCommonDir), "deliveries", `${eventId}.json`);
}

export async function writeManifest(value: BridgeManifest): Promise<string> {
  const manifest = parseManifest(value);
  await ensurePrivateDirectory(stateRoot(manifest.gitCommonDir));
  const path = manifestPath(manifest.gitCommonDir, manifest.sessionId);
  await atomicCreate(path, manifest);
  return path;
}

export async function saveManifest(value: BridgeManifest): Promise<string> {
  const manifest = parseManifest(value);
  await ensurePrivateDirectory(stateRoot(manifest.gitCommonDir));
  const path = manifestPath(manifest.gitCommonDir, manifest.sessionId);
  await atomicWrite(path, manifest);
  return path;
}

export async function loadManifest(
  gitCommonDir: string,
  sessionId: string,
): Promise<BridgeManifest | undefined> {
  try {
    await ensurePrivateDirectory(stateRoot(gitCommonDir));
    const expected = parseSessionId(sessionId);
    const manifest = parseManifest(
      JSON.parse(await safeRead(manifestPath(gitCommonDir, expected))),
    );
    if (
      manifest.sessionId !== expected ||
      manifest.gitCommonDir !== gitCommonDir
    ) {
      throw new Error(
        "bridge manifest identity does not match its storage location",
      );
    }
    return manifest;
  } catch (error) {
    if (absent(error)) return undefined;
    throw error;
  }
}

/**
 * The sessions whose handover this repository has on record as delivered to the
 * owner. It is the one durable fact that a worker's own work ended: the native
 * state label outlives the turn it describes, and a delivery is only written
 * after the owner's thread took the message.
 */
export async function deliveredSessions(
  gitCommonDir: string,
): Promise<Set<string>> {
  const deliveries = join(stateRoot(gitCommonDir), "deliveries");
  const glob = new Bun.Glob("*.json");
  const sessions = new Set<string>();
  try {
    for await (const name of glob.scan({ cwd: deliveries, onlyFiles: true })) {
      const path = join(deliveries, name);
      try {
        const record = parseDeliveryRecord(JSON.parse(await safeRead(path)));
        if (record.status === "delivered") sessions.add(record.sessionId);
      } catch {
        // A record being rewritten must not hide the others.
      }
    }
  } catch (error) {
    if (!absent(error)) throw error;
  }
  return sessions;
}

/**
 * Which of the named workers have delivered a handover, reading each repository
 * once. A worker whose link never recorded its repository is left out rather
 * than guessed at.
 */
export async function handedOverSessions(
  workers: Array<{ gitCommonDir?: string; sessionId?: string }>,
): Promise<Set<string>> {
  const byRepository = new Map<string, Set<string>>();
  for (const worker of workers) {
    if (!worker.gitCommonDir || !worker.sessionId) continue;
    const wanted = byRepository.get(worker.gitCommonDir) ?? new Set<string>([]);
    wanted.add(worker.sessionId);
    byRepository.set(worker.gitCommonDir, wanted);
  }
  const handedOver = new Set<string>();
  for (const [gitCommonDir, wanted] of byRepository) {
    for (const sessionId of await deliveredSessions(gitCommonDir)) {
      if (wanted.has(sessionId)) handedOver.add(sessionId);
    }
  }
  return handedOver;
}

export async function forgetState(
  gitCommonDir: string,
  sessionId: string,
): Promise<void> {
  const id = parseSessionId(sessionId);
  await ensurePrivateDirectory(stateRoot(gitCommonDir));
  await rm(manifestPath(gitCommonDir, id), { force: true });
  const deliveries = join(stateRoot(gitCommonDir), "deliveries");
  const glob = new Bun.Glob("*.json");
  try {
    for await (const name of glob.scan({ cwd: deliveries, onlyFiles: true })) {
      const path = join(deliveries, name);
      const record = parseDeliveryRecord(JSON.parse(await safeRead(path)));
      if (record.sessionId === id) await rm(path, { force: true });
    }
  } catch (error) {
    if (!absent(error)) throw error;
  }
}

export async function claimDelivery(
  gitCommonDir: string,
  eventId: string,
  sessionId: string,
): Promise<boolean> {
  const path = deliveryPath(gitCommonDir, eventId);
  await ensurePrivateDirectory(stateRoot(gitCommonDir));
  await ensurePrivateDirectory(dirname(path));
  const record: DeliveryRecord = {
    schemaVersion: 1,
    eventId,
    sessionId: parseSessionId(sessionId),
    status: "pending",
    updatedAt: new Date().toISOString(),
  };
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

export async function settleDelivery(
  gitCommonDir: string,
  eventId: string,
  sessionId: string,
  status: Exclude<DeliveryStatus, "pending">,
): Promise<void> {
  await ensurePrivateDirectory(stateRoot(gitCommonDir));
  const current = await loadDelivery(gitCommonDir, eventId);
  if (
    !current ||
    current.sessionId !== parseSessionId(sessionId) ||
    current.status !== "pending"
  ) {
    throw new Error("delivery settlement does not match a pending event");
  }
  await atomicWrite(deliveryPath(gitCommonDir, eventId), {
    schemaVersion: 1,
    eventId,
    sessionId: current.sessionId,
    status,
    updatedAt: new Date().toISOString(),
  } satisfies DeliveryRecord);
}

export async function loadDelivery(
  gitCommonDir: string,
  eventId: string,
): Promise<DeliveryRecord | undefined> {
  try {
    await ensurePrivateDirectory(stateRoot(gitCommonDir));
    return parseDeliveryRecord(
      JSON.parse(await safeRead(deliveryPath(gitCommonDir, eventId))),
    );
  } catch (error) {
    if (absent(error)) return undefined;
    throw error;
  }
}
