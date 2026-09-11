import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BridgeError } from "../src/errors";
import { RESERVATION_TTL_MS, reserveWorktree } from "../src/reservation";

const homes: string[] = [];
const tree = { cwd: "/repo/a", gitCommonDir: "/repo/.git" };

afterEach(async () => {
  for (const home of homes.splice(0))
    await rm(home, { recursive: true, force: true });
});

async function home(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "bridge-reserve-"));
  homes.push(path);
  return path;
}

test("refuses a second claim on the same tree while the first is held", async () => {
  const root = await home();
  const held = await reserveWorktree({ ...tree, home: root });
  const error = (await reserveWorktree({ ...tree, home: root }).catch(
    (reason: unknown) => reason,
  )) as BridgeError;
  expect(error.code).toBe("worktree_owner_active");
  expect(error.message).toContain("/repo/a");
  await held.release();
  await (await reserveWorktree({ ...tree, home: root })).release();
});

// The path is the identity, so a different tree in the same repository, or the
// same path in another repository, is a different reservation.
test("keys the reservation by repository and worktree path", async () => {
  const root = await home();
  await reserveWorktree({ ...tree, home: root });
  await reserveWorktree({
    cwd: "/repo/b",
    gitCommonDir: "/repo/.git",
    home: root,
  });
  await reserveWorktree({
    cwd: "/repo/a",
    gitCommonDir: "/other/.git",
    home: root,
  });
});

// Otherwise a start that crashed between claiming and publishing would leave the
// tree reserved until someone deleted a file by hand.
test("breaks a reservation whose holder is gone from this machine", async () => {
  const root = await home();
  await reserveWorktree({ ...tree, home: root, pid: 4242, host: "here" });
  const retaken = await reserveWorktree({
    ...tree,
    home: root,
    host: "here",
    alive: () => false,
  });
  expect(retaken).toBeDefined();
});

// A pid means nothing on a machine that did not write it, so age is the only
// bound left; it is what stops a crash elsewhere from holding the tree forever.
test("breaks a reservation older than its bounded lifetime", async () => {
  const root = await home();
  const start = Date.parse("2026-09-11T00:00:00.000Z");
  await reserveWorktree({
    ...tree,
    home: root,
    host: "elsewhere",
    now: () => start,
  });
  const early = (await reserveWorktree({
    ...tree,
    home: root,
    host: "here",
    alive: () => true,
    now: () => start + RESERVATION_TTL_MS - 1,
  }).catch((reason: unknown) => reason)) as BridgeError;
  expect(early.code).toBe("worktree_owner_active");
  await reserveWorktree({
    ...tree,
    home: root,
    host: "here",
    alive: () => true,
    now: () => start + RESERVATION_TTL_MS,
  });
});

// The loser of a break must not take the winner's reservation away on its way
// out, or the tree would be free while a publication is still running.
test("releasing a reservation that was broken leaves the new holder alone", async () => {
  const root = await home();
  const abandoned = await reserveWorktree({
    ...tree,
    home: root,
    pid: 4242,
    host: "here",
  });
  await reserveWorktree({
    ...tree,
    home: root,
    host: "here",
    alive: () => false,
  });
  await abandoned.release();
  const error = (await reserveWorktree({ ...tree, home: root }).catch(
    (reason: unknown) => reason,
  )) as BridgeError;
  expect(error.code).toBe("worktree_owner_active");
});
