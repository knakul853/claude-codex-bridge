import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closePeer, reapPeers, surveyPeers } from "../src/lifecycle";
import { linkPeer, listPeers } from "../src/peers";
import { NativeCommandError, type ProcessRunner } from "../src/process";
import { loadManifest, writeManifest } from "../src/state";

const paths: string[] = [];
const working = "11111111-1111-4111-8111-111111111111";
const finished = "22222222-2222-4222-8222-222222222222";
const stuck = "33333333-3333-4333-8333-333333333333";
const failed = "44444444-4444-4444-8444-444444444444";
let previousSessionsDir: string | undefined;

const CLAUDE_BINARY = "/opt/claude/versions/2.1.0";
const quiet = {
  sleep: async () => {},
  settleMs: 0,
  attemptMs: 0,
};

interface FakeProcess {
  pid: number;
  parent?: number;
  command?: string;
  rss?: number;
}

/** A worker and the `--bg-pty-host` that supervises it, as `ps` reports them. */
function claudeTree(pid: number, host: number, tag: string): FakeProcess[] {
  const argv = `${CLAUDE_BINARY} --resume /projects/${tag}.jsonl`;
  return [
    { pid, parent: host, command: argv },
    {
      pid: host,
      command: `${CLAUDE_BINARY} --bg-pty-host /tmp/${tag}.pty.sock 200 50 -- ${argv}`,
      rss: 64_000,
    },
  ];
}

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

function runner(
  agents: Array<Record<string, unknown>>,
  options: { gitCommonDir?: string; live?: FakeProcess[] } = {},
): {
  process: ProcessRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const live = options.live ?? [];
  return {
    calls,
    process: {
      async run(argv) {
        calls.push(argv);
        if (argv[0] === "claude")
          return { stdout: JSON.stringify(agents), stderr: "", exitCode: 0 };
        if (argv[0] === "ps") {
          const wanted = new Set((argv.at(-1) ?? "").split(",").map(Number));
          const lines = live
            .filter((entry) => wanted.has(entry.pid))
            .map(
              (entry) =>
                `${entry.pid} ${entry.parent ?? 1} ${entry.rss ?? 256_000} ${entry.command ?? ""}`,
            );
          // `ps` says nothing and exits 1 when none of the pids are alive.
          if (lines.length === 0) throw new NativeCommandError("ps", 1, "");
          return { stdout: `${lines.join("\n")}\n`, stderr: "", exitCode: 0 };
        }
        return {
          stdout: options.gitCommonDir ?? "",
          stderr: "",
          exitCode: 0,
        };
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
      { pid: 303, sessionId: stuck, cwd: "/repo/c", kind: "background" },
    ]);
    await linkPeer({ cwd: "/repo/a", claudeSessionId: working }, home);
    await linkPeer({ cwd: "/repo/b", claudeSessionId: finished }, home);
    await linkPeer({ cwd: "/repo/c", claudeSessionId: stuck }, home);
    const survey = await surveyPeers(
      runner(
        [
          { sessionId: working, cwd: "/repo/a", pid: 101, state: "working" },
          { sessionId: finished, cwd: "/repo/b", state: "done" },
          { sessionId: stuck, cwd: "/repo/c", pid: 303, state: "blocked" },
        ],
        {
          live: [...claudeTree(101, 100, "a"), ...claudeTree(303, 300, "c")],
        },
      ).process,
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
      runner(
        [{ sessionId: working, cwd: "/repo/a", pid: 101, state: "working" }],
        { live: claudeTree(101, 100, "a") },
      ).process,
      home,
    );
    expect(survey[0]?.residentMb).toBe(250);
  });

  // A background session keeps its host process after it ends, so an idle one
  // is memory to reclaim rather than a worker to stop.
  test("treats a failed session still holding an idle host process as finished", async () => {
    const home = await temporary("bridge-life-home-");
    await sessionRegistry([
      {
        pid: 404,
        sessionId: failed,
        cwd: "/repo/d",
        kind: "bg",
        status: "idle",
      },
    ]);
    await linkPeer({ cwd: "/repo/d", claudeSessionId: failed }, home);
    const survey = await surveyPeers(
      runner(
        [
          {
            sessionId: failed,
            cwd: "/repo/d",
            pid: 404,
            status: "idle",
            state: "failed",
          },
        ],
        { live: claudeTree(404, 400, "d") },
      ).process,
      home,
    );
    expect(survey[0]?.disposition).toBe("finished");
    expect(survey[0]?.facts?.revivable).toBe(false);
    expect(survey[0]?.pid).toBe(404);
  });

  // The label is written when the session ends; the registry is written by the
  // process. A busy process under a "failed" label means the label is stale.
  test("does not believe a failed label over a busy registry record", async () => {
    const home = await temporary("bridge-life-home-");
    await sessionRegistry([
      {
        pid: 404,
        sessionId: failed,
        cwd: "/repo/d",
        kind: "bg",
        status: "busy",
      },
    ]);
    await linkPeer({ cwd: "/repo/d", claudeSessionId: failed }, home);
    const survey = await surveyPeers(
      runner(
        [{ sessionId: failed, cwd: "/repo/d", pid: 404, state: "failed" }],
        { live: claudeTree(404, 400, "d") },
      ).process,
      home,
    );
    expect(survey[0]?.disposition).toBe("working");
  });

  // Signalling the worker alone leaves the daemon's lease unsettled: no process
  // is left, but the session is still listed as working and can come back.
  test("treats an unsettled lease with no process as revivable, not gone", async () => {
    const home = await temporary("bridge-life-home-");
    await sessionRegistry([]);
    await linkPeer({ cwd: "/repo/a", claudeSessionId: working }, home);
    const survey = await surveyPeers(
      runner([{ sessionId: working, cwd: "/repo/a", state: "working" }])
        .process,
      home,
    );
    expect(survey[0]?.disposition).toBe("working");
    expect(survey[0]?.facts?.revivable).toBe(true);
    expect(survey[0]?.pid).toBeUndefined();
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
      ...quiet,
      kill: () => {},
    });
    expect(result.applied).toBe(true);
    expect(result.unresolved).toEqual([]);
    expect(await listPeers(home)).toHaveLength(0);
  });

  // The sweep used to delete the routing state of a session it could not stop,
  // which left a worker nobody was tracking still holding the worktree.
  test("keeps a session it could not stop, and reports it unresolved", async () => {
    const home = await temporary("bridge-life-home-");
    const commonDir = await temporary("bridge-life-git-");
    await sessionRegistry([
      {
        pid: 404,
        sessionId: failed,
        cwd: "/repo/d",
        kind: "bg",
        status: "idle",
      },
    ]);
    await linkPeer(
      { cwd: "/repo/d", claudeSessionId: failed, gitCommonDir: commonDir },
      home,
    );
    await writeManifest({
      schemaVersion: 1,
      sessionId: failed,
      ownerThreadId: "owner-thread",
      gitCommonDir: commonDir,
      createdAt: "2026-09-11T00:00:00.000Z",
    });
    const result = await reapPeers({
      apply: true,
      process: runner(
        [{ sessionId: failed, cwd: "/repo/d", pid: 404, state: "failed" }],
        { gitCommonDir: commonDir, live: claudeTree(404, 400, "d") },
      ).process,
      home,
      ...quiet,
      // A signal that lands on nothing: the process outlives the sweep.
      kill: () => {},
    });
    expect(result.unresolved).toEqual([result.survey[0]?.peer.id as string]);
    expect(result.actions.join(" ")).toMatch(/could not confirm/);
    expect(await loadManifest(commonDir, failed)).toBeDefined();
    expect(await listPeers(home)).toHaveLength(1);
  });

  test("leaves a working session alone", async () => {
    const home = await temporary("bridge-life-home-");
    await sessionRegistry([
      { pid: 101, sessionId: working, cwd: "/repo/a", kind: "background" },
    ]);
    await linkPeer({ cwd: "/repo/a", claudeSessionId: working }, home);
    await reapPeers({
      apply: true,
      process: runner(
        [{ sessionId: working, cwd: "/repo/a", pid: 101, state: "working" }],
        { live: claudeTree(101, 100, "a") },
      ).process,
      home,
      ...quiet,
      kill: () => {},
    });
    expect(await listPeers(home)).toHaveLength(1);
  });

  test("only touches a wedged session when asked to", async () => {
    const home = await temporary("bridge-life-home-");
    await sessionRegistry([
      { pid: 303, sessionId: stuck, cwd: "/repo/c", kind: "background" },
    ]);
    await linkPeer({ cwd: "/repo/c", claudeSessionId: stuck }, home);
    const agents = [
      { sessionId: stuck, cwd: "/repo/c", pid: 303, state: "blocked" },
    ];
    const live = claudeTree(303, 300, "c");
    const silent = await reapPeers({
      process: runner(agents, { live }).process,
      home,
    });
    expect(silent.actions).toEqual([]);
    const asked = await reapPeers({
      killStuck: true,
      process: runner(agents, { live }).process,
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
        process: runner(
          [{ sessionId: working, cwd: "/repo/a", pid: 101, state: "working" }],
          { live: claudeTree(101, 100, "a") },
        ).process,
        home,
        ...quiet,
        kill: () => {},
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
      ...quiet,
      kill: () => {},
    });
    expect(result.actions.join(" ")).toMatch(/forgot peer/);
    expect(await listPeers(home)).toHaveLength(0);
  });

  // Signalling the worker without telling the daemon leaves a lease it revives
  // later, so the native stop is asked for first and the host is signalled
  // before the worker it would otherwise restart.
  test("asks claude to stop the session, then signals the host before the worker", async () => {
    const home = await temporary("bridge-life-home-");
    await sessionRegistry([
      {
        pid: 404,
        sessionId: failed,
        cwd: "/repo/d",
        kind: "bg",
        status: "idle",
      },
    ]);
    await linkPeer({ cwd: "/repo/d", claudeSessionId: failed }, home);
    const signalled: Array<[number, string]> = [];
    const recorder = runner(
      [
        {
          id: "44444444",
          sessionId: failed,
          cwd: "/repo/d",
          pid: 404,
          state: "failed",
        },
      ],
      { live: claudeTree(404, 400, "d") },
    );
    await expect(
      closePeer({
        reference: failed,
        force: true,
        process: recorder.process,
        home,
        ...quiet,
        kill: (pid, name) => {
          signalled.push([pid, name]);
        },
      }),
    ).rejects.toThrow(/could not confirm/);
    expect(
      recorder.calls.some(
        (argv) =>
          argv[0] === "claude" && argv[1] === "stop" && argv[2] === "44444444",
      ),
    ).toBe(true);
    expect(signalled.slice(0, 2)).toEqual([
      [400, "SIGTERM"],
      [404, "SIGTERM"],
    ]);
  });

  // The defect this replaces: close reported success, deleted the manifest and
  // the peer link, and left the worker running in the worktree.
  test("keeps routing state and the peer link when termination is unconfirmed", async () => {
    const home = await temporary("bridge-life-home-");
    const commonDir = await temporary("bridge-life-git-");
    await sessionRegistry([
      {
        pid: 404,
        sessionId: failed,
        cwd: "/repo/d",
        kind: "bg",
        status: "idle",
      },
    ]);
    await linkPeer(
      { cwd: "/repo/d", claudeSessionId: failed, gitCommonDir: commonDir },
      home,
    );
    await writeManifest({
      schemaVersion: 1,
      sessionId: failed,
      ownerThreadId: "owner-thread",
      gitCommonDir: commonDir,
      createdAt: "2026-09-11T00:00:00.000Z",
    });
    await expect(
      closePeer({
        reference: failed,
        force: true,
        removeWorktree: true,
        process: runner(
          [{ sessionId: failed, cwd: "/repo/d", pid: 404, state: "failed" }],
          { gitCommonDir: commonDir, live: claudeTree(404, 400, "d") },
        ).process,
        home,
        ...quiet,
        kill: () => {},
      }),
    ).rejects.toThrow(/could not confirm session .* stopped \(pid 404/);
    expect(await loadManifest(commonDir, failed)).toBeDefined();
    expect(await listPeers(home)).toHaveLength(1);
  });

  // Pids are reused and this one came from a file, so a process that is not a
  // Claude process is reported rather than signalled.
  test("refuses to signal a pid that is not a Claude process", async () => {
    const home = await temporary("bridge-life-home-");
    await sessionRegistry([
      {
        pid: 404,
        sessionId: failed,
        cwd: "/repo/d",
        kind: "bg",
        status: "idle",
      },
    ]);
    await linkPeer({ cwd: "/repo/d", claudeSessionId: failed }, home);
    const signalled: number[] = [];
    await expect(
      closePeer({
        reference: failed,
        force: true,
        process: runner(
          [{ sessionId: failed, cwd: "/repo/d", pid: 404, state: "failed" }],
          {
            live: [
              { pid: 404, parent: 1, command: "/usr/bin/postgres -D /data" },
            ],
          },
        ).process,
        home,
        ...quiet,
        kill: (pid) => {
          signalled.push(pid);
        },
      }),
    ).rejects.toThrow(/not a verified Claude process/);
    expect(signalled).toEqual([]);
  });

  test("removes the routing state of an ended session whose worktree is gone", async () => {
    const home = await temporary("bridge-life-home-");
    const commonDir = await temporary("bridge-life-git-");
    await sessionRegistry([]);
    await linkPeer(
      { cwd: "/repo/gone", claudeSessionId: failed, gitCommonDir: commonDir },
      home,
    );
    await writeManifest({
      schemaVersion: 1,
      sessionId: failed,
      ownerThreadId: "owner-thread",
      gitCommonDir: commonDir,
      createdAt: "2026-09-11T00:00:00.000Z",
    });
    const recorder = runner(
      [{ sessionId: failed, cwd: "/repo/gone", state: "failed" }],
      { gitCommonDir: commonDir },
    );
    const result = await closePeer({
      reference: failed,
      process: recorder.process,
      home,
      ...quiet,
      kill: () => {},
    });
    expect(result.actions.join(" ")).toMatch(/forgot routing state/);
    expect(await loadManifest(commonDir, failed)).toBeUndefined();
    expect(await listPeers(home)).toHaveLength(0);
    expect(recorder.calls.some((argv) => argv.includes("rev-parse"))).toBe(
      false,
    );
  });

  test("archives the Codex thread only when asked", async () => {
    const home = await temporary("bridge-life-home-");
    await sessionRegistry([]);
    await linkPeer(
      { cwd: "/repo/b", claudeSessionId: finished, codexThreadId: "t1" },
      home,
    );
    const recorder = runner([
      { sessionId: finished, cwd: "/repo/b", state: "done" },
    ]);
    await closePeer({
      reference: "t1",
      process: recorder.process,
      home,
      ...quiet,
      kill: () => {},
    });
    expect(recorder.calls.some((argv) => argv[1] === "archive")).toBe(false);
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
      ...quiet,
      kill: () => {},
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
