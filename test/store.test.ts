import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  atomicCreate,
  atomicWrite,
  ensurePrivateDirectory,
  safeRead,
} from "../src/store";

const roots: string[] = [];

async function scratch(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "bridge-store-"));
  roots.push(path);
  return path;
}

async function mode(path: string): Promise<number> {
  return (await lstat(path)).mode & 0o777;
}

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

describe("ensurePrivateDirectory", () => {
  test("creates the directory private", async () => {
    const path = join(await scratch(), "nested", "state");
    await ensurePrivateDirectory(path);
    expect(await mode(path)).toBe(0o700);
  });

  test("tightens a directory that is readable by others", async () => {
    const path = join(await scratch(), "loose");
    await mkdir(path);
    await chmod(path, 0o777);
    await ensurePrivateDirectory(path);
    expect(await mode(path)).toBe(0o700);
  });

  test("is a no-op on a directory that is already private", async () => {
    // The chmod is skipped when the mode is already correct: a sandboxed caller
    // may be permitted to write here yet denied metadata changes, and an
    // unconditional chmod fails on a directory that needed nothing.
    const path = join(await scratch(), "already");
    await mkdir(path, { mode: 0o700 });
    const before = await mode(path);
    await ensurePrivateDirectory(path);
    await ensurePrivateDirectory(path);
    expect(await mode(path)).toBe(before);
  });

  test("refuses a path occupied by a file", async () => {
    // mkdir rejects with EEXIST before the lstat guard is reached, so this
    // asserts the refusal rather than a particular message.
    const path = join(await scratch(), "a-file");
    await writeFile(path, "x", "utf8");
    await expect(ensurePrivateDirectory(path)).rejects.toThrow();
  });

  test("refuses a symlink standing in for the state directory", async () => {
    const root = await scratch();
    const real = join(root, "elsewhere");
    const link = join(root, "state");
    await mkdir(real, { mode: 0o700 });
    await symlink(real, link);
    // A symlink is what the lstat guard exists for: mkdir is content with it,
    // so without the check the bridge would write through it.
    await expect(ensurePrivateDirectory(link)).rejects.toThrow(
      /must be a real directory/,
    );
  });
});

describe("atomic writes", () => {
  test("writes a private file and reads it back", async () => {
    const path = join(await scratch(), "state", "record.json");
    await atomicWrite(path, { a: 1 });
    expect(await mode(path)).toBe(0o600);
    expect(JSON.parse(await safeRead(path))).toEqual({ a: 1 });
  });

  test("replaces an existing record", async () => {
    const path = join(await scratch(), "state", "record.json");
    await atomicWrite(path, { a: 1 });
    await atomicWrite(path, { a: 2 });
    expect(JSON.parse(await safeRead(path))).toEqual({ a: 2 });
  });

  test("leaves no temporary files behind", async () => {
    const directory = join(await scratch(), "state");
    await atomicWrite(join(directory, "record.json"), { a: 1 });
    const glob = new Bun.Glob("*.tmp");
    const leftovers = [...glob.scanSync({ cwd: directory, onlyFiles: true })];
    expect(leftovers).toEqual([]);
  });

  test("atomicCreate refuses to overwrite an existing record", async () => {
    const path = join(await scratch(), "state", "record.json");
    await atomicCreate(path, { a: 1 });
    await expect(atomicCreate(path, { a: 2 })).rejects.toThrow();
    expect(JSON.parse(await safeRead(path))).toEqual({ a: 1 });
  });
});
