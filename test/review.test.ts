import { afterEach, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { requestReview } from "../src/claude";
import type { CodexReviewClient } from "../src/codex";
import type { ProcessRunner } from "../src/process";

const roots: string[] = [];
const sessionId = "66666666-6666-4666-8666-666666666666";

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

test("routes Claude review to a chosen or newly created Codex task and remembers it", async () => {
  const root = (await Bun.$`mktemp -d /tmp/bridge-review.XXXXXX`.text()).trim();
  const commonDir = join(root, ".git");
  const worktree = join(root, "worker");
  roots.push(root);
  await mkdir(commonDir);
  await mkdir(worktree);
  const process: ProcessRunner = {
    async run(argv) {
      if (argv[0] === "claude") {
        return {
          stdout: JSON.stringify([
            { sessionId, cwd: worktree, state: "done", name: "Fix worker" },
          ]),
          stderr: "",
          exitCode: 0,
        };
      }
      const command = argv.at(-1);
      if (command === "--show-toplevel")
        return { stdout: `${worktree}\n`, stderr: "", exitCode: 0 };
      if (command === "--git-common-dir")
        return { stdout: `${commonDir}\n`, stderr: "", exitCode: 0 };
      if (command === "--show-current")
        return { stdout: "fix/replay\n", stderr: "", exitCode: 0 };
      if (command === "HEAD")
        return { stdout: `${"a".repeat(40)}\n`, stderr: "", exitCode: 0 };
      if (command === "--porcelain")
        return { stdout: " M src/fix.ts\n", stderr: "", exitCode: 0 };
      throw new Error(`unexpected command: ${argv.join(" ")}`);
    },
  };
  const queued: Array<{ threadId: string; message: string }> = [];
  let created = 0;
  const codex: CodexReviewClient = {
    async createTask(cwd, message) {
      expect(cwd).toBe(worktree);
      expect(message).toContain('branch: "fix/replay"');
      created += 1;
      return {
        threadId: "01900000-0000-7000-8000-000000000001",
        response: "One correction is needed.",
      };
    },
    async queue(threadId, message) {
      queued.push({ threadId, message });
    },
  };
  const repository = {
    root,
    commonDir,
    branch: "dev",
    head: "b".repeat(40),
    clean: true,
    changedFiles: [],
  };

  const chosen = await requestReview({
    sessionId,
    instructions: "Review this branch.",
    repository,
    ownerThreadId: "existing-owner",
    process,
    codex,
  });
  expect(chosen.manifest.ownerThreadId).toBe("existing-owner");
  expect(created).toBe(0);
  expect(queued[0]?.message).toContain(`worktree: ${JSON.stringify(worktree)}`);
  expect(queued[0]?.message).toContain('branch: "fix/replay"');
  expect(queued[0]?.message).toContain("src/fix.ts");

  const fresh = await requestReview({
    sessionId,
    instructions: "Review again.",
    repository,
    newCodexTask: true,
    process,
    codex,
  });
  expect(fresh.manifest.ownerThreadId).toBe(
    "01900000-0000-7000-8000-000000000001",
  );
  expect(fresh.response).toBe("One correction is needed.");
  expect(created).toBe(1);
  expect(queued).toHaveLength(1);

  const reused = await requestReview({
    sessionId,
    instructions: "One more review.",
    repository,
    process,
    codex,
  });
  expect(reused.manifest.ownerThreadId).toBe(fresh.manifest.ownerThreadId);
  expect(created).toBe(1);
});
