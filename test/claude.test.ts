import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { startJob } from "../src/claude";
import type { ProcessRunner } from "../src/process";

const roots: string[] = [];
const sessionId = "44444444-4444-4444-8444-444444444444";

afterEach(async () => {
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
    home: join(root, "bridge-home"),
  });
  const launch = calls.find((argv) => argv[1] === "--bg") ?? [];
  expect(launch).not.toContain("--worktree");
  expect(launch).toContain("--permission-mode");
  expect(launch).toContain("acceptEdits");
});
