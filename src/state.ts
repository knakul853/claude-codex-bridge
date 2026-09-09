import { constants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type BridgeManifest,
  type DeliveryRecord,
  type DeliveryStatus,
  parseDeliveryRecord,
  parseManifest,
  parseSessionId,
} from "./contracts";

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

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("bridge state path must be a real directory");
  }
  await chmod(path, 0o700);
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
  await ensurePrivateDirectory(dirname(path));
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  const handle = await open(
    temporary,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  await chmod(path, 0o600);
}

async function atomicCreate(path: string, value: unknown): Promise<void> {
  await ensurePrivateDirectory(dirname(path));
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  const handle = await open(
    temporary,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (!absent(error)) throw error;
    });
  }
}

async function safeRead(path: string): Promise<string> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error("bridge state file must be a regular file");
  }
  return readFile(path, "utf8");
}

function absent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export async function writeManifest(value: BridgeManifest): Promise<string> {
  const manifest = parseManifest(value);
  await ensurePrivateDirectory(stateRoot(manifest.gitCommonDir));
  const path = manifestPath(manifest.gitCommonDir, manifest.sessionId);
  await atomicCreate(path, manifest);
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
