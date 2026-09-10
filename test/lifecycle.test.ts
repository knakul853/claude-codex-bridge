import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closePeer, reapPeers, surveyPeers } from "../src/lifecycle";
import { linkPeer, listPeers } from "../src/peers";
import type { ProcessRunner } from "../src/process";

const paths: string[] = [];
const working = "11111111-1111-4111-8111-111111111111";
const finished = "22222222-2222-4222-8222-222222222222";
const stuck = "33333333-3333-4333-8333-333333333333";
let previousSessionsDir: string | undefined;

async function temporary(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  paths.push(path);
  return path;
}

/** Only live sessions publish a record, so the registry is the liveness oracle. */
async function sessionRegistry(
  records: Array<Record<string, unknown>>,
): Promise<string> {
  const root = await temporary("bridge-life-sessions-");
  for (const record of records) {
    await writeFile(
      join(root, `${record.pid}.json`),
      JSON.stringify(record),
      "utf8",
    );
  }
  process.env.CLAUDE_SESSIONS_DIR = root;
  return root;
}

function runner(agents: Array<Record<string, unknown>>): {
  process: ProcessRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    process: {
      async run(argv) {
        calls.push(argv);
        if (argv[0] === "claude")
          return { stdout: JSON.stringify(agents), stderr: "", exitCode: 0 };
        if (argv[0] === "ps")
          return { stdout: "  101   256000\n", stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    },
  };
}

beforeEach(() => {
  previousSessionsDir = process.env.CLAUDE_SESSIONS_DIR;
});

afterEach(async () => {
  if (previousSessionsDir === undefined) delete process.env.CLAUDE_SESSIONS_DIR;
  else process.env.CLAUDE_SESSIONS_DIR = previousSessionsDir;
  for (const path of paths.splice(0))
    await rm(path, { recursive: true, force: true });
});

describe("surveyPeers", () => {
  test("separates a working session from a finished one and a wedged one", async () => {
    const home = await temporary("bridge-life-home-");
    await sessionRegistry([
      { pid: 101, sessionId: working, cwd: "/repo/a", kind: "background" },
    ]);
    await linkPeer({ cwd: "/repo/a", claudeSessionId: working }, home);
    await linkPeer({ cwd: "/repo/b", claudeSessionId: finished }, home);
    await linkPeer({ cwd: "/repo/c", claudeSessionId: stuck }, home);
    const survey = await surveyPeers(
      runner([
        { sessionId: working, cwd: "/repo/a", pid: 101, state: "working" },
        { sessionId: finished, cwd: "/repo/b", state: "done" },
        { sessionId: stuck, cwd: "/repo/c", pid: 303, state: "blocked" },
      ]).process,
      home,
    );
    const byId = new Map(
      survey.map((entry) => [entry.peer.claudeSessionId, entry.disposition]),
    );
    expect(byId.get(working)).toBe("working");
    expect(byId.get(finished)).toBe("finished");
    expect(byId.get(stuck)).toBe("stuck");
  });

  test("reports resident memory for the sessions still holding a process", async () => {
    const home = await temporary("bridge-life-home-");
    await sessionRegistry([
      { pid: 101, sessionId: working, cwd: "/repo/a", kind: "background" },
    ]);
    await linkPeer({ cwd: "/repo/a", claudeSessionId: working }, home);
    const survey = await surveyPeers(
      runner([
        { sessionId: working, cwd: "/repo/a", pid: 101, state: "working" },
      ]).process,
      home,
    );
    expect(survey[0]?.residentMb).toBe(250);
  });

  test("treats a peer with no matching agent record as gone", async () => {
    const home = await temporary("bridge-life-home-");
    await sessionRegistry([]);
    await linkPeer({ cwd: "/repo/a", claudeSessionId: working }, home);
    const survey = await surveyPeers(runner([]).process, home);
    expect(survey[0]?.disposition).toBe("gone");
  });
});

describe("reapPeers", () => {
  test("reports what it would close without changing anything", async () => {
    const home = await temporary("bridge-life-home-");
    await sessionRegistry([]);
    await linkPeer({ cwd: "/repo/b", claudeSessionId: finished }, home);
    const result = await reapPeers({
      process: runner([{ sessionId: finished, cwd: "/repo/b", state: "done" }])
        .process,
      home,
    });
    expect(result.applied).toBe(false);
    expect(result.actions[0]).toMatch(/would close/);
    expect(await listPeers(home)).toHaveLength(1);
  });

  test("prunes finished collaborations when applied", async () => {
    const home = await temporary("bridge-life-home-");
    await sessionRegistry([]);
    await linkPeer({ cwd: "/repo/b", claudeSessionId: finished }, home);
    const result = await reapPeers({
      apply: true,
      process: runner([{ sessionId: finished, cwd: "/repo/b", state: "done" }])
        .process,
      home,
    });
    expect(result.applied).toBe(true);
    expect(await listPeers(home)).toHaveLength(0);
  });

  test("leaves a working session alone", async () => {
    const home = await temporary("bridge-life-home-");
    await sessionRegistry([
      { pid: 101, sessionId: working, cwd: "/repo/a", kind: "background" },
    ]);
    await linkPeer({ cwd: "/repo/a", claudeSessionId: working }, home);
    await reapPeers({
      apply: true,
      process: runner([
        { sessionId: working, cwd: "/repo/a", pid: 101, state: "working" },
      ]).process,
      home,
    });
    expect(await listPeers(home)).toHaveLength(1);
  });

  test("only touches a wedged session when asked to", async () => {
    const home = await temporary("bridge-life-home-");
    await sessionRegistry([]);
    await linkPeer({ cwd: "/repo/c", claudeSessionId: stuck }, home);
    const agents = [
      { sessionId: stuck, cwd: "/repo/c", pid: 303, state: "blocked" },
    ];
    const quiet = await reapPeers({ process: runner(agents).process, home });
    expect(quiet.actions).toEqual([]);
    const asked = await reapPeers({
      killStuck: true,
      process: runner(agents).process,
      home,
    });
    expect(asked.actions[0]).toMatch(/would close/);
  });
});

describe("closePeer", () => {
  test("refuses a session still holding a process unless forced", async () => {
    const home = await temporary("bridge-life-home-");
    await sessionRegistry([
      { pid: 101, sessionId: working, cwd: "/repo/a", kind: "background" },
    ]);
    await linkPeer({ cwd: "/repo/a", claudeSessionId: working }, home);
    await expect(
      closePeer({
        reference: working,
        process: runner([
          { sessionId: working, cwd: "/repo/a", pid: 101, state: "working" },
        ]).process,
        home,
      }),
    ).rejects.toThrow(/Pass --force/);
  });

  test("forgets a finished collaboration", async () => {
    const home = await temporary("bridge-life-home-");
    await sessionRegistry([]);
    await linkPeer(
      { cwd: "/repo/b", claudeSessionId: finished, codexThreadId: "t1" },
      home,
    );
    const result = await closePeer({
      reference: "t1",
      process: runner([{ sessionId: finished, cwd: "/repo/b", state: "done" }])
        .process,
      home,
    });
    expect(result.actions.join(" ")).toMatch(/forgot peer/);
    expect(await listPeers(home)).toHaveLength(0);
  });

  test("archives the Codex thread only when asked", async () => {
    const home = await temporary("bridge-life-home-");
    await sessionRegistry([]);
    await linkPeer(
      { cwd: "/repo/b", claudeSessionId: finished, codexThreadId: "t1" },
      home,
    );
    const quiet = runner([
      { sessionId: finished, cwd: "/repo/b", state: "done" },
    ]);
    await closePeer({ reference: "t1", process: quiet.process, home });
    expect(quiet.calls.some((argv) => argv[1] === "archive")).toBe(false);
  });

  test("will not remove a directory it did not create as a worktree", async () => {
    const home = await temporary("bridge-life-home-");
    await sessionRegistry([]);
    await linkPeer({ cwd: "/repo/precious", claudeSessionId: finished }, home);
    const recorder = runner([
      { sessionId: finished, cwd: "/repo/precious", state: "done" },
    ]);
    await closePeer({
      reference: finished,
      removeWorktree: true,
      process: recorder.process,
      home,
    });
    expect(recorder.calls.some((argv) => argv.includes("worktree"))).toBe(
      false,
    );
  });

  test("explains an unknown reference instead of doing nothing quietly", async () => {
    await expect(
      closePeer({
        reference: "nobody",
        process: runner([]).process,
        home: await temporary("bridge-life-home-"),
      }),
    ).rejects.toThrow(/no peer matches/);
  });
});
