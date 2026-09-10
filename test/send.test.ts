import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexReviewClient, CreatedCodexTask } from "../src/codex";
import { resolveThread, sendToThread } from "../src/send";
import type { CodexThread, ThreadStore } from "../src/threads";
import { readAssistantMessages, resolveProject } from "../src/threads";

function assistantLine(text: string): string {
  return JSON.stringify({
    type: "response_item",
    payload: { type: "message", role: "assistant", content: [{ text }] },
  });
}

async function rolloutWith(texts: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bridge-rollout-"));
  const path = join(dir, "rollout.jsonl");
  await writeFile(path, `${texts.map(assistantLine).join("\n")}\n`);
  return path;
}

function store(threads: CodexThread[]): ThreadStore {
  return {
    projects: () => [
      { id: "p1", name: "aurora-nuclei", roots: ["/repo/a", "/repo/b"] },
      { id: "p2", name: "other", roots: ["/repo/c"] },
    ],
    threads: (options) =>
      options?.roots
        ? threads.filter((t) => options.roots?.includes(t.cwd))
        : threads,
  };
}

function recordingClient(): CodexReviewClient & { sent: string[][] } {
  const sent: string[][] = [];
  return {
    sent,
    createTask: (): Promise<CreatedCodexTask> => {
      throw new Error("unused");
    },
    queue: async (threadId, message) => {
      sent.push([threadId, message]);
    },
  };
}

const thread = (over: Partial<CodexThread> = {}): CodexThread => ({
  id: "t1",
  label: "QA run",
  cwd: "/repo/a",
  updatedAtMs: 10,
  rolloutPath: null,
  ...over,
});

describe("readAssistantMessages", () => {
  test("returns assistant turns in order and ignores other events", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bridge-rollout-"));
    const path = join(dir, "rollout.jsonl");
    await writeFile(
      path,
      [
        JSON.stringify({ type: "event_msg", payload: { type: "noise" } }),
        assistantLine("first"),
        JSON.stringify({
          type: "response_item",
          payload: { type: "message", role: "user", content: [{ text: "hi" }] },
        }),
        "not json at all",
        assistantLine("second"),
      ].join("\n"),
    );
    expect((await readAssistantMessages(path)).map((m) => m.text)).toEqual([
      "first",
      "second",
    ]);
  });
});

describe("resolveProject", () => {
  test("matches case-insensitively", () => {
    const projects = store([]).projects();
    expect(resolveProject(projects, "AURORA-Nuclei").id).toBe("p1");
  });

  test("lists known projects when the name is unknown", () => {
    const projects = store([]).projects();
    expect(() => resolveProject(projects, "nope")).toThrow(/aurora-nuclei/);
  });
});

describe("resolveThread", () => {
  test("picks the newest thread whose cwd is a project root", () => {
    const threads = [
      thread({ id: "newest", cwd: "/repo/b", updatedAtMs: 30 }),
      thread({ id: "older", cwd: "/repo/a", updatedAtMs: 20 }),
      thread({ id: "elsewhere", cwd: "/repo/c", updatedAtMs: 99 }),
    ];
    expect(resolveThread(store(threads), { project: "aurora-nuclei" }).id).toBe(
      "newest",
    );
  });

  test("explains what to do when the project has no persisted thread", () => {
    expect(() =>
      resolveThread(store([]), { project: "aurora-nuclei" }),
    ).toThrow(/open one in Codex/);
  });

  test("requires a destination", () => {
    expect(() => resolveThread(store([]), {})).toThrow(/--thread or --project/);
  });
});

describe("sendToThread", () => {
  test("queues the message and reports the thread it chose", async () => {
    const client = recordingClient();
    const result = await sendToThread(
      store([thread({ id: "t9" })]),
      client,
      { project: "aurora-nuclei" },
      "run the QA brief",
    );
    expect(client.sent).toEqual([["t9", "run the QA brief"]]);
    expect(result).toEqual({
      threadId: "t9",
      label: "QA run",
      timedOut: false,
    });
  });

  test("waits for a reply that appears after the message is queued", async () => {
    const path = await rolloutWith(["earlier reply"]);
    const client = recordingClient();
    const result = await sendToThread(
      store([thread({ rolloutPath: path })]),
      client,
      { thread: "t1" },
      "ping",
      {
        timeoutMs: 1_000,
        pollMs: 1,
        sleep: async () => {
          await writeFile(path, `${assistantLine("fresh reply")}\n`, {
            flag: "a",
          });
        },
      },
    );
    expect(result.reply).toBe("fresh reply");
    expect(result.timedOut).toBe(false);
  });

  test("reports a timeout instead of a stale reply", async () => {
    const path = await rolloutWith(["only the old reply"]);
    let clock = 0;
    const result = await sendToThread(
      store([thread({ rolloutPath: path })]),
      recordingClient(),
      { thread: "t1" },
      "ping",
      {
        timeoutMs: 10,
        pollMs: 1,
        now: () => (clock += 4),
        sleep: async () => {},
      },
    );
    expect(result.timedOut).toBe(true);
    expect(result.reply).toBeUndefined();
  });
});
