import { constants, existsSync } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type Env, setting } from "./env";

export const STATE_DIR_NAME = ".agentplus";
export const LEGACY_STATE_DIR_NAME = ".claude-codex-bridge";

export interface HomeLookup {
  env?: Env;
  home?: string;
  exists?: (path: string) => boolean;
}

// Peer links and inbox lanes are addressed by both agents, and neither knows the
// other's repository, so they live outside any Git directory. A user who ran the
// tool under its old name keeps that directory; nothing is moved or copied.
export function bridgeHome(lookup: HomeLookup = {}): string {
  const configured = setting(lookup.env ?? process.env, "HOME");
  if (configured) return configured;
  const home = lookup.home ?? homedir();
  const current = join(home, STATE_DIR_NAME);
  const legacy = join(home, LEGACY_STATE_DIR_NAME);
  const exists = lookup.exists ?? existsSync;
  return !exists(current) && exists(legacy) ? legacy : current;
}

export function absent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

// Only when actually loose: a sandboxed caller may be permitted to write here
// yet denied metadata changes, so a no-op chmod fails on a correct directory.
async function tighten(path: string, mode: number): Promise<void> {
  const info = await lstat(path);
  if ((info.mode & 0o777) === mode) return;
  await chmod(path, mode);
}

export async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("bridge state path must be a real directory");
  }
  await tighten(path, 0o700);
}

async function writeTemporary(path: string, value: unknown): Promise<string> {
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
  return temporary;
}

export async function atomicWrite(path: string, value: unknown): Promise<void> {
  const temporary = await writeTemporary(path, value);
  await rename(temporary, path);
  await tighten(path, 0o600);
}

export async function atomicCreate(
  path: string,
  value: unknown,
): Promise<void> {
  const temporary = await writeTemporary(path, value);
  try {
    await link(temporary, path);
    await tighten(path, 0o600);
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (!absent(error)) throw error;
    });
  }
}

export async function safeRead(path: string): Promise<string> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error("bridge state file must be a regular file");
  }
  return readFile(path, "utf8");
}
