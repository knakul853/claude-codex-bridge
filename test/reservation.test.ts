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

// A holder proved gone can neither publish nor release, which is the only case
// where replacing it is safe rather than a guess.
test("supersedes a holder proved gone from this machine", async () => {
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

// A pid means nothing on a machine that did not write it, so age alone never
// takes the tree away: age changes what the refusal says, not whether it refuses.
test("refuses a holder it cannot prove abandoned, however old", async () => {
  const root = await home();
  const start = Date.parse("2026-09-11T00:00:00.000Z");
  await reserveWorktree({
    ...tree,
    home: root,
    host: "elsewhere",
    now: () => start,
  });
  const contend = (when: number) =>
    reserveWorktree({
      ...tree,
      home: root,
      host: "here",
      alive: () => true,
      now: () => when,
    }).catch((reason: unknown) => reason) as Promise<BridgeError>;

  const early = await contend(start + RESERVATION_TTL_MS - 1);
  expect(early.code).toBe("worktree_owner_active");
  expect(early.message).toContain("already publishing");

  const late = await contend(start + RESERVATION_TTL_MS);
  expect(late.code).toBe("worktree_owner_active");
  expect(late.message).toContain("cannot be proved");
});

// A superseded holder releasing late must not take the new holder away with it,
// or the tree would read as free while a publication is still running.
test("releasing a superseded hold leaves the new holder alone", async () => {
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

// Separate processes are the only thing that contends for an exclusive create
// the way a second bridge command does.
test("lets one of several processes supersede an abandoned holder", async () => {
  const root = await home();
  // A holder whose process is provably gone, which is the only kind that may be
  // superseded at all.
  const departed = Bun.spawn(["true"], { stdout: "ignore", stderr: "ignore" });
  await departed.exited;
  await reserveWorktree({ ...tree, home: root, pid: departed.pid });

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
      // No release and no wait: the hold is a file, so a second winner would
      // still be a second winner however the processes are scheduled.
      '  console.log("HELD");',
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
  // Every contender has to be waiting on the barrier before it opens, so they
  // all reach the takeover together.
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
  expect(results.filter((line) => line === "HELD")).toHaveLength(1);
});
