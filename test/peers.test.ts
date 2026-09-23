import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findPeer, linkPeer, listPeers, unlinkPeer } from "../src/peers";

const homes: string[] = [];
const claudeA = "11111111-1111-4111-8111-111111111111";
const claudeB = "22222222-2222-4222-8222-222222222222";

async function home(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "bridge-peers-"));
  homes.push(path);
  return path;
}

afterEach(async () => {
  for (const path of homes.splice(0))
    await rm(path, { recursive: true, force: true });
});

describe("peer registry", () => {
  test("records a pairing that either side can resolve", async () => {
    const root = await home();
    const link = await linkPeer(
      {
        cwd: "/repo/aurora",
        claudeSessionId: claudeA,
        codexThreadId: "thread-1",
        label: "jira qa",
      },
      root,
    );
    expect((await findPeer(claudeA, root))?.id).toBe(link.id);
    expect((await findPeer("thread-1", root))?.id).toBe(link.id);
    expect((await findPeer(link.id, root))?.id).toBe(link.id);
    expect((await findPeer("jira qa", root))?.id).toBe(link.id);
  });

  test("fills in the unknown side instead of forking the link", async () => {
    const root = await home();
    const first = await linkPeer({ cwd: "/repo/a", codexThreadId: "t1" }, root);
    expect(first.claudeSessionId).toBeUndefined();
    const second = await linkPeer(
      { cwd: "/repo/a", codexThreadId: "t1", claudeSessionId: claudeA },
      root,
    );
    expect(second.id).toBe(first.id);
    expect(second.claudeSessionId).toBe(claudeA);
    expect(await listPeers(root)).toHaveLength(1);
  });

  test("preserves the original creation time across an update", async () => {
    const root = await home();
    let clock = "2026-01-01T00:00:00.000Z";
    const first = await linkPeer(
      { cwd: "/repo/a", claudeSessionId: claudeA },
      root,
      () => clock,
    );
    clock = "2026-02-02T00:00:00.000Z";
    const second = await linkPeer(
      { cwd: "/repo/a", claudeSessionId: claudeA, codexThreadId: "t9" },
      root,
      () => clock,
    );
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).toBe(clock);
  });

  test("keeps separate collaborations apart", async () => {
    const root = await home();
    await linkPeer({ cwd: "/repo/a", claudeSessionId: claudeA }, root);
    await linkPeer({ cwd: "/repo/b", claudeSessionId: claudeB }, root);
    expect(await listPeers(root)).toHaveLength(2);
    expect((await findPeer(claudeB, root))?.cwd).toBe("/repo/b");
  });

  test("refuses a link that names neither side", async () => {
    const root = await home();
    await expect(linkPeer({ cwd: "/repo/a" }, root)).rejects.toThrow(
      /Claude session or a Codex thread/,
    );
  });

  test("forgets one link without disturbing the others", async () => {
    const root = await home();
    const doomed = await linkPeer(
      { cwd: "/repo/a", claudeSessionId: claudeA },
      root,
    );
    await linkPeer({ cwd: "/repo/b", claudeSessionId: claudeB }, root);
    await unlinkPeer(doomed.id, root);
    expect(await listPeers(root)).toHaveLength(1);
    expect(await findPeer(claudeA, root)).toBeUndefined();
  });

  test("returns nothing for an unknown reference rather than guessing", async () => {
    expect(await findPeer("nobody", await home())).toBeUndefined();
  });
});

const claudeC = "33333333-3333-4333-8333-333333333333";

describe("peers under one owner thread", () => {
  const thread = "019fd8a9-4af5-7eb1-928c-550c219752ed";
  const workers = [
    { cwd: "/tmp/qa121a", claudeSessionId: claudeA, label: "QA-121a" },
    { cwd: "/tmp/qa80", claudeSessionId: claudeB, label: "QA-80" },
    { cwd: "/tmp/qa120b", claudeSessionId: claudeC, label: "QA-120b" },
  ];

  async function fleet(root: string) {
    for (const worker of workers)
      await linkPeer({ ...worker, codexThreadId: thread }, root);
  }

  test("keeps one record per worker instead of overwriting siblings", async () => {
    const root = await home();
    await fleet(root);
    const links = await listPeers(root);
    expect(links).toHaveLength(3);
    expect(links.map((link) => link.cwd).sort()).toEqual(
      workers.map((worker) => worker.cwd).sort(),
    );
    for (const worker of workers) {
      const link = await findPeer(worker.claudeSessionId, root);
      expect(link?.cwd).toBe(worker.cwd);
      expect(link?.label).toBe(worker.label);
      expect(link?.codexThreadId).toBe(thread);
    }
  });

  test("closing one worker leaves its siblings untouched", async () => {
    const root = await home();
    await fleet(root);
    const doomed = await findPeer(claudeB, root);
    await unlinkPeer(doomed?.id as string, root);
    const links = await listPeers(root);
    expect(links).toHaveLength(2);
    expect((await findPeer(claudeA, root))?.cwd).toBe("/tmp/qa121a");
    expect((await findPeer(claudeC, root))?.cwd).toBe("/tmp/qa120b");
  });

  test("refuses to guess which sibling an owner thread means", async () => {
    const root = await home();
    await fleet(root);
    await expect(findPeer(thread, root)).rejects.toThrow(/3 peers match/);
  });

  test("a resumed worker replaces its own record rather than adding one", async () => {
    const root = await home();
    await fleet(root);
    const resumed = await linkPeer(
      {
        cwd: "/tmp/qa80",
        claudeSessionId: claudeC.replace(/^3/, "4"),
        codexThreadId: thread,
        label: "QA-80",
        supersedesSessionId: claudeB,
      },
      root,
    );
    expect(await listPeers(root)).toHaveLength(3);
    expect(await findPeer(claudeB, root)).toBeUndefined();
    expect(resumed.cwd).toBe("/tmp/qa80");
  });
});
