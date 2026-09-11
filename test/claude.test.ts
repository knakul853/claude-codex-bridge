import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { continueJob, forgetJob, startJob } from "../src/claude";
import { BridgeError } from "../src/errors";
import { linkPeer, listPeers } from "../src/peers";
import { NativeCommandError, type ProcessRunner } from "../src/process";
import { loadManifest, writeManifest } from "../src/state";

const roots: string[] = [];
const sessionId = "44444444-4444-4444-8444-444444444444";
const owner = "55555555-5555-4555-8555-555555555555";
let previousSessionsDir: string | undefined;

beforeEach(() => {
  previousSessionsDir = process.env.CLAUDE_SESSIONS_DIR;
});

afterEach(async () => {
  if (previousSessionsDir === undefined) delete process.env.CLAUDE_SESSIONS_DIR;
  else process.env.CLAUDE_SESSIONS_DIR = previousSessionsDir;
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

test("starts a native isolated Claude worker and persists routing metadata only", async () => {
  const root = (await Bun.$`mktemp -d /tmp/bridge-claude.XXXXXX`.text()).trim();
  const commonDir = join(root, ".git");
  const worker = join(root, "worker");
  roots.push(root);
  await mkdir(commonDir);
  await mkdir(worker);
  const calls: Array<{ argv: string[]; cwd?: string }> = [];
  const runner: ProcessRunner = {
    async run(argv, options) {
      calls.push({ argv, ...(options?.cwd ? { cwd: options.cwd } : {}) });
      if (argv[0] === "claude" && argv[1] === "--bg") {
        return { stdout: "backgrounded · 44444444\n", stderr: "", exitCode: 0 };
      }
      if (argv[0] === "claude" && argv[1] === "agents") {
        return {
          stdout: JSON.stringify([
            { id: "44444444", sessionId, cwd: worker, state: "working" },
          ]),
          stderr: "",
          exitCode: 0,
        };
      }
      if (argv[0] === "git") {
        return { stdout: `${commonDir}\n`, stderr: "", exitCode: 0 };
      }
      throw new Error(`unexpected command: ${argv.join(" ")}`);
    },
  };

  const manifest = await startJob({
    ownerThreadId: "owner-thread",
    name: "Review replay safety",
    prompt: "Fix the replay bug",
    repository: {
      root,
      commonDir,
      branch: "dev",
      head: "a".repeat(40),
      clean: true,
      changedFiles: [],
    },
    process: runner,
    hooksReady: async () => true,
    home: join(root, "bridge-home"),
    now: () => "2026-09-09T00:00:00.000Z",
  });

  expect(manifest.sessionId).toBe(sessionId);
  const launch = calls.find((call) => call.argv[1] === "--bg")?.argv ?? [];
  expect(launch.slice(0, 4)).toEqual([
    "claude",
    "--bg",
    "--worktree",
    expect.stringContaining("claude-codex-"),
  ]);
  expect(launch.at(-1)).toContain("<agent_handover>");
  const stored = await readFile(
    join(commonDir, "claude-codex-bridge", "jobs", `${sessionId}.json`),
    "utf8",
  );
  expect(stored).not.toContain("Fix the replay bug");
  expect(stored).not.toContain("agent_handover");
});

test("refuses dirty or detached starts before launching Claude", async () => {
  const process: ProcessRunner = {
    async run() {
      throw new Error("must not launch");
    },
  };
  const repository = {
    root: "/repo",
    commonDir: "/repo/.git",
    branch: "dev",
    head: "a".repeat(40),
    clean: false,
    changedFiles: [],
  };
  await expect(
    startJob({ ownerThreadId: "owner", prompt: "work", repository, process }),
  ).rejects.toThrow("clean working tree");
  await expect(
    startJob({
      ownerThreadId: "owner",
      prompt: "work",
      repository: { ...repository, clean: true, branch: "" },
      process,
    }),
  ).rejects.toThrow("detached");
});

test("refuses to launch when completion hooks are missing", async () => {
  const process: ProcessRunner = {
    async run() {
      throw new Error("must not launch");
    },
  };
  await expect(
    startJob({
      ownerThreadId: "owner",
      prompt: "work",
      repository: {
        root: "/repo",
        commonDir: "/repo/.git",
        branch: "dev",
        head: "a".repeat(40),
        clean: true,
        changedFiles: [],
      },
      process,
      hooksReady: async () => false,
    }),
  ).rejects.toThrow("install-hooks");
});

test("shares the current tree with --here instead of cutting a worktree", async () => {
  const root = (await Bun.$`mktemp -d /tmp/bridge-here.XXXXXX`.text()).trim();
  const commonDir = join(root, ".git");
  roots.push(root);
  await mkdir(commonDir);
  const calls: string[][] = [];
  const runner: ProcessRunner = {
    async run(argv) {
      calls.push(argv);
      if (argv[1] === "--bg")
        return { stdout: "backgrounded · 55555555\n", stderr: "", exitCode: 0 };
      if (argv[1] === "agents")
        return {
          stdout: JSON.stringify([
            {
              id: "55555555",
              sessionId: "55555555-5555-4555-8555-555555555555",
              cwd: root,
              kind: "background",
              state: "working",
            },
          ]),
          stderr: "",
          exitCode: 0,
        };
      return { stdout: `${commonDir}\n`, stderr: "", exitCode: 0 };
    },
  };
  await startJob({
    ownerThreadId: "owner-thread",
    prompt: "review the uncommitted work",
    repository: {
      root,
      commonDir,
      branch: "dev",
      head: "b".repeat(40),
      // --here is the mode a reviewer needs: the work is not committed yet.
      clean: false,
      changedFiles: ["src/a.ts"],
    },
    here: true,
    permissionMode: "acceptEdits",
    process: runner,
    hooksReady: async () => true,
    home: join(root, "bridge-home"),
  });
  const launch = calls.find((argv) => argv[1] === "--bg") ?? [];
  expect(launch).not.toContain("--worktree");
  expect(launch).toContain("--permission-mode");
  expect(launch).toContain("acceptEdits");
});

test("tracks the new session id returned by a background continuation", async () => {
  const root = (
    await Bun.$`mktemp -d /tmp/bridge-continue.XXXXXX`.text()
  ).trim();
  const commonDir = join(root, ".git");
  roots.push(root);
  await mkdir(commonDir);
  await writeManifest({
    schemaVersion: 1,
    sessionId,
    ownerThreadId: "owner-thread",
    gitCommonDir: commonDir,
    createdAt: "2026-09-09T00:00:00.000Z",
    name: "Planner visibility",
  });
  const continuedId = "55555555-5555-4555-8555-555555555555";
  let inventories = 0;
  const runner: ProcessRunner = {
    async run(argv) {
      if (argv[0] === "claude" && argv[1] === "agents") {
        inventories += 1;
        return {
          stdout: JSON.stringify(
            inventories === 1
              ? [{ id: "44444444", sessionId, cwd: root, state: "done" }]
              : [
                  { id: "44444444", sessionId, cwd: root, state: "done" },
                  {
                    id: "55555555",
                    sessionId: continuedId,
                    cwd: root,
                    state: "working",
                  },
                ],
          ),
          stderr: "",
          exitCode: 0,
        };
      }
      if (argv[0] === "claude" && argv[1] === "--resume") {
        return { stdout: "backgrounded · 55555555\n", stderr: "", exitCode: 0 };
      }
      if (argv[0] === "git") {
        return { stdout: `${commonDir}\n`, stderr: "", exitCode: 0 };
      }
      throw new Error(`unexpected command: ${argv.join(" ")}`);
    },
  };

  const continuation = await continueJob({
    sessionId,
    prompt: "Fix planner visibility",
    gitCommonDir: commonDir,
    process: runner,
    home: join(root, "bridge-home"),
    now: () => "2026-09-10T00:00:00.000Z",
  });

  expect(continuation.sessionId).toBe(continuedId);
  expect(
    await readFile(
      join(commonDir, "claude-codex-bridge", "jobs", `${continuedId}.json`),
      "utf8",
    ),
  ).not.toContain("Fix planner visibility");
});

test("forgets state for a session Claude no longer lists, but not a live one", async () => {
  const root = (await Bun.$`mktemp -d /tmp/bridge-forget.XXXXXX`.text()).trim();
  const commonDir = join(root, ".git");
  roots.push(root);
  await mkdir(commonDir);
  await writeManifest({
    schemaVersion: 1,
    sessionId,
    ownerThreadId: "owner-thread",
    gitCommonDir: commonDir,
    createdAt: "2026-09-11T00:00:00.000Z",
  });
  let agents: Array<Record<string, unknown>> = [
    { id: "44444444", sessionId, cwd: root, pid: 404, state: "working" },
  ];
  const runner: ProcessRunner = {
    async run(argv) {
      if (argv[0] === "claude")
        return { stdout: JSON.stringify(agents), stderr: "", exitCode: 0 };
      return { stdout: `${commonDir}\n`, stderr: "", exitCode: 0 };
    },
  };

  await expect(
    forgetJob({ sessionId, gitCommonDir: commonDir, process: runner }),
  ).rejects.toThrow("forget refuses a live or blocked session");
  agents = [];
  await forgetJob({ sessionId, gitCommonDir: commonDir, process: runner });

  expect(await loadManifest(commonDir, sessionId)).toBeUndefined();
});

async function repository(prefix: string): Promise<{
  root: string;
  commonDir: string;
  sessions: string;
  home: string;
}> {
  const root = (await Bun.$`mktemp -d /tmp/${prefix}.XXXXXX`.text()).trim();
  roots.push(root);
  const commonDir = join(root, ".git");
  const sessions = join(root, "sessions");
  await mkdir(commonDir);
  await mkdir(sessions);
  process.env.CLAUDE_SESSIONS_DIR = sessions;
  return { root, commonDir, sessions, home: join(root, "bridge-home") };
}

function ownerRunner(
  agents: Array<Record<string, unknown>>,
  commonDir: string,
  live: Array<{ pid: number; command: string }> = [],
): ProcessRunner {
  return {
    async run(argv) {
      if (argv[1] === "--bg" || argv[1] === "--resume")
        throw new Error("must not launch a second worker");
      if (argv[1] === "agents")
        return { stdout: JSON.stringify(agents), stderr: "", exitCode: 0 };
      if (argv[0] === "ps") {
        const wanted = new Set((argv.at(-1) ?? "").split(",").map(Number));
        const lines = live
          .filter((entry) => wanted.has(entry.pid))
          .map((entry) => `${entry.pid} 1 256000 ${entry.command}`);
        if (lines.length === 0) throw new NativeCommandError("ps", 1, "");
        return { stdout: `${lines.join("\n")}\n`, stderr: "", exitCode: 0 };
      }
      return { stdout: `${commonDir}\n`, stderr: "", exitCode: 0 };
    },
  };
}

test("refuses to share a worktree an active worker already owns", async () => {
  const repo = await repository("bridge-owner");
  await linkPeer({ cwd: repo.root, claudeSessionId: owner }, repo.home);
  const error = await startJob({
    ownerThreadId: "owner-thread",
    prompt: "do the same work again",
    repository: {
      root: repo.root,
      commonDir: repo.commonDir,
      branch: "main",
      head: "c".repeat(40),
      clean: false,
      changedFiles: ["src/a.ts"],
    },
    here: true,
    process: ownerRunner(
      [
        {
          id: "55555555",
          sessionId: owner,
          cwd: repo.root,
          kind: "background",
          state: "working",
        },
      ],
      repo.commonDir,
    ),
    hooksReady: async () => true,
    home: repo.home,
  }).catch((reason: unknown) => reason);

  expect(error).toBeInstanceOf(BridgeError);
  expect((error as BridgeError).code).toBe("worktree_owner_active");
  expect((error as BridgeError).message).toContain(owner);
});

// A worker that ended is a host process holding memory, not a second writer.
test("shares a worktree whose previous worker has settled", async () => {
  const repo = await repository("bridge-owner-settled");
  await linkPeer({ cwd: repo.root, claudeSessionId: owner }, repo.home);
  let launched = false;
  const runner: ProcessRunner = {
    async run(argv) {
      if (argv[1] === "--bg") {
        launched = true;
        return { stdout: "backgrounded · 44444444\n", stderr: "", exitCode: 0 };
      }
      if (argv[1] === "agents")
        return {
          stdout: JSON.stringify([
            {
              id: "55555555",
              sessionId: owner,
              cwd: repo.root,
              kind: "background",
              state: "done",
            },
            {
              id: "44444444",
              sessionId,
              cwd: repo.root,
              kind: "background",
              state: "working",
            },
          ]),
          stderr: "",
          exitCode: 0,
        };
      return { stdout: `${repo.commonDir}\n`, stderr: "", exitCode: 0 };
    },
  };

  await startJob({
    ownerThreadId: "owner-thread",
    prompt: "review the uncommitted work",
    repository: {
      root: repo.root,
      commonDir: repo.commonDir,
      branch: "main",
      head: "c".repeat(40),
      clean: false,
      changedFiles: ["src/a.ts"],
    },
    here: true,
    process: runner,
    hooksReady: async () => true,
    home: repo.home,
  });
  expect(launched).toBe(true);
});

test("refuses to continue into a worktree another worker is still writing", async () => {
  const repo = await repository("bridge-continue-owner");
  await writeManifest({
    schemaVersion: 1,
    sessionId,
    ownerThreadId: "owner-thread",
    gitCommonDir: repo.commonDir,
    createdAt: "2026-09-11T00:00:00.000Z",
  });
  await linkPeer({ cwd: repo.root, claudeSessionId: owner }, repo.home);
  await writeFile(
    join(repo.sessions, "4242.json"),
    JSON.stringify({
      pid: 4242,
      sessionId: owner,
      cwd: repo.root,
      kind: "bg",
      status: "busy",
    }),
    "utf8",
  );
  const error = await continueJob({
    sessionId,
    prompt: "keep going",
    gitCommonDir: repo.commonDir,
    process: ownerRunner(
      [
        {
          id: "44444444",
          sessionId,
          cwd: repo.root,
          kind: "background",
          state: "done",
        },
        {
          id: "55555555",
          sessionId: owner,
          cwd: repo.root,
          kind: "background",
          // The label says it ended; the registry says it is busy.
          state: "failed",
        },
      ],
      repo.commonDir,
      [
        {
          pid: 4242,
          command: "/opt/claude/versions/2.1.0 --resume /p/o.jsonl",
        },
      ],
    ),
    home: repo.home,
  }).catch((reason: unknown) => reason);

  expect(error).toBeInstanceOf(BridgeError);
  expect((error as BridgeError).code).toBe("worktree_owner_active");
});

// A launch the bridge cannot parse still started a worker, and that worker owns
// a worktree nothing is tracking. Colour is on whenever FORCE_COLOR is set.
test("records a worker whose launch line arrived with colour codes", async () => {
  const repo = await repository("bridge-ansi");
  const runner: ProcessRunner = {
    async run(argv) {
      if (argv[1] === "--bg")
        return {
          stdout: "backgrounded · \u001b[36m44444444\u001b[39m · worker\n",
          stderr: "",
          exitCode: 0,
        };
      if (argv[1] === "agents")
        return {
          stdout: JSON.stringify([
            {
              id: "44444444",
              sessionId,
              cwd: repo.root,
              kind: "background",
              state: "working",
            },
          ]),
          stderr: "",
          exitCode: 0,
        };
      return { stdout: `${repo.commonDir}\n`, stderr: "", exitCode: 0 };
    },
  };

  const manifest = await startJob({
    ownerThreadId: "owner-thread",
    prompt: "work",
    repository: {
      root: repo.root,
      commonDir: repo.commonDir,
      branch: "main",
      head: "c".repeat(40),
      clean: true,
      changedFiles: [],
    },
    process: runner,
    hooksReady: async () => true,
    home: repo.home,
  });
  expect(manifest.sessionId).toBe(sessionId);
});

/** A launch that yields the way a real one does, so both callers interleave. */
function racingRunner(
  repo: { root: string; commonDir: string },
  launched: string[],
  ids: string[],
  extraAgents: Array<Record<string, unknown>> = [],
): ProcessRunner {
  return {
    async run(argv) {
      if (argv[1] === "--bg" || argv[1] === "--resume") {
        const id = ids[launched.length] ?? "ffffffff";
        launched.push(id);
        await Bun.sleep(5);
        return { stdout: `backgrounded · ${id}\n`, stderr: "", exitCode: 0 };
      }
      if (argv[1] === "agents") {
        await Bun.sleep(1);
        return {
          stdout: JSON.stringify([
            ...extraAgents,
            ...launched.map((id) => ({
              id,
              sessionId: `${id}-1111-4111-8111-111111111111`,
              cwd: repo.root,
              kind: "background",
              state: "working",
            })),
          ]),
          stderr: "",
          exitCode: 0,
        };
      }
      return { stdout: `${repo.commonDir}\n`, stderr: "", exitCode: 0 };
    },
  };
}

function refusals(results: PromiseSettledResult<unknown>[]): string[] {
  return results.flatMap((result) =>
    result.status === "rejected" && result.reason instanceof BridgeError
      ? [result.reason.code]
      : [],
  );
}

// Checking the tree and recording the worker that takes it are separate steps,
// so without a reservation both callers see it free and both launch.
test("lets exactly one concurrent start --here take the worktree", async () => {
  const repo = await repository("bridge-race-start");
  const launched: string[] = [];
  const runner = racingRunner(repo, launched, ["aaaaaaaa", "bbbbbbbb"]);
  const request = (thread: string) =>
    startJob({
      ownerThreadId: thread,
      prompt: "work",
      repository: {
        root: repo.root,
        commonDir: repo.commonDir,
        branch: "main",
        head: "c".repeat(40),
        clean: false,
        changedFiles: ["src/a.ts"],
      },
      here: true,
      process: runner,
      hooksReady: async () => true,
      home: repo.home,
    });

  const results = await Promise.allSettled([
    request("owner-one"),
    request("owner-two"),
  ]);
  expect(launched).toHaveLength(1);
  expect(await listPeers(repo.home)).toHaveLength(1);
  expect(refusals(results)).toEqual(["worktree_owner_active"]);
});

// Two continuations of the same settled session resume the same transcript into
// the same tree, and go through the same reservation to stop it.
test("lets exactly one concurrent continuation resume into the worktree", async () => {
  const repo = await repository("bridge-race-continue");
  await writeManifest({
    schemaVersion: 1,
    sessionId,
    ownerThreadId: "owner-thread",
    gitCommonDir: repo.commonDir,
    createdAt: "2026-09-11T00:00:00.000Z",
  });
  const launched: string[] = [];
  const runner = racingRunner(
    repo,
    launched,
    ["aaaaaaaa", "bbbbbbbb"],
    [
      {
        id: "44444444",
        sessionId,
        cwd: repo.root,
        kind: "background",
        state: "done",
      },
    ],
  );
  const request = () =>
    continueJob({
      sessionId,
      prompt: "keep going",
      gitCommonDir: repo.commonDir,
      process: runner,
      home: repo.home,
    });

  const results = await Promise.allSettled([request(), request()]);
  expect(launched).toHaveLength(1);
  expect(refusals(results)).toEqual(["worktree_owner_active"]);
});
