import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
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
test("ignores a contender whose holder is gone from this machine", async () => {
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
test("ignores a contender older than its bounded lifetime", async () => {
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

// An abandoned contender releasing late must not take the elected holder away
// with it, or the tree would read as free while a publication is still running.
test("releasing an abandoned contender leaves the elected holder alone", async () => {
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

// Taking over an abandoned tree used to be read, remove, claim, so two commands
// reclaiming at once both won and the later one deleted the winner's
// reservation. Only separate processes interleave the way that needs.
test("elects one winner when several processes reclaim one abandoned tree", async () => {
  const root = await home();
  await reserveWorktree({
    ...tree,
    home: root,
    now: () => Date.parse("2026-09-01T00:00:00.000Z"),
  });
  const barrier = join(root, "go");
  const script = join(root, "reclaim.ts");
  await Bun.write(
    script,
    [
      `import { reserveWorktree } from ${JSON.stringify(join(import.meta.dir, "../src/reservation.ts"))};`,
      `await Bun.write(${JSON.stringify(join(root, "ready."))} + crypto.randomUUID(), "1");`,
      `while (!(await Bun.file(${JSON.stringify(barrier)}).exists())) await Bun.sleep(2);`,
      "try {",
      `  await reserveWorktree({ ...${JSON.stringify(tree)}, home: ${JSON.stringify(root)} });`,
      // Hold it the way a publication would, so a loser that deleted the
      // winner's file shows up as a second winner.
      "  await Bun.sleep(1500);",
      '  console.log("WON");',
      "} catch {",
      '  console.log("REFUSED");',
      "}",
    ].join("\n"),
  );
  const children = [0, 1, 2, 3].map(() =>
    Bun.spawn(["bun", "run", script], {
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
    }),
  );
  // Every reclaimer has to be waiting on the barrier before it opens, or a late
  // one would contend with a tree the winner has already released again.
  while (
    (await readdir(root)).filter((name) => name.startsWith("ready.")).length <
    children.length
  ) {
    await Bun.sleep(10);
  }
  await Bun.write(barrier, "go");
  const results = await Promise.all(
    children.map(async (child) => {
      const text = await new Response(child.stdout).text();
      await child.exited;
      return text.trim();
    }),
  );
  expect(results.filter((line) => line === "WON")).toHaveLength(1);
});
