import { afterEach, expect, test } from "bun:test";
import { chmod, lstat, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  claimDelivery,
  forgetState,
  loadDelivery,
  loadManifest,
  settleDelivery,
  writeManifest,
} from "../src/state";

const roots: string[] = [];
const sessionId = "22222222-2222-4222-8222-222222222222";
const eventId = "a".repeat(64);

async function commonDir(): Promise<string> {
  const root = await Bun.$`mktemp -d /tmp/bridge-state.XXXXXX`.text();
  const common = join(root.trim(), ".git");
  await mkdir(common);
  roots.push(root.trim());
  return common;
}

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

test("manifest and delivery state are private, atomic, and deduplicated", async () => {
  const common = await commonDir();
  await writeManifest({
    schemaVersion: 1,
    sessionId,
    ownerThreadId: "owner",
    gitCommonDir: common,
    createdAt: "2026-09-09T00:00:00.000Z",
  });
  expect((await loadManifest(common, sessionId))?.ownerThreadId).toBe("owner");
  const manifestPath = join(
    common,
    "claude-codex-bridge",
    "jobs",
    `${sessionId}.json`,
  );
  expect((await lstat(manifestPath)).mode & 0o777).toBe(0o600);
  expect(await claimDelivery(common, eventId, sessionId)).toBe(true);
  expect(await claimDelivery(common, eventId, sessionId)).toBe(false);
  await settleDelivery(common, eventId, sessionId, "delivered");
  expect((await loadDelivery(common, eventId))?.status).toBe("delivered");
  await forgetState(common, sessionId);
  expect(await loadManifest(common, sessionId)).toBeUndefined();
  expect(await loadDelivery(common, eventId)).toBeUndefined();
});

test("refuses a symlinked bridge state root", async () => {
  const common = await commonDir();
  const outside = join(common, "outside");
  await mkdir(outside);
  await symlink(outside, join(common, "claude-codex-bridge"));
  await expect(
    writeManifest({
      schemaVersion: 1,
      sessionId,
      ownerThreadId: "owner",
      gitCommonDir: common,
      createdAt: "2026-09-09T00:00:00.000Z",
    }),
  ).rejects.toThrow("real directory");
});

test("refuses a forged manifest identity", async () => {
  const common = await commonDir();
  const jobs = join(common, "claude-codex-bridge", "jobs");
  await mkdir(jobs, { recursive: true });
  await chmod(join(common, "claude-codex-bridge"), 0o700);
  await writeFile(
    join(jobs, `${sessionId}.json`),
    JSON.stringify({
      schemaVersion: 1,
      sessionId: "33333333-3333-4333-8333-333333333333",
      ownerThreadId: "attacker",
      gitCommonDir: common,
      createdAt: "2026-09-09T00:00:00.000Z",
    }),
  );
  await expect(loadManifest(common, sessionId)).rejects.toThrow("identity");
});
