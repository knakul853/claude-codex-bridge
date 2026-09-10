import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexReviewClient, CreatedCodexTask } from "../src/codex";
import {
  appProcessName,
  autoSendScript,
  desktopThreadUrl,
  openThreadInDesktop,
  openUrlArgv,
  resolveThread,
  resolveWorkspace,
  sendToThread,
  watchForReply,
  workspaceWarning,
} from "../src/send";
import type {
  AssistantMessage,
  CodexThread,
  ThreadStore,
} from "../src/threads";
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
        "",
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
    ).toThrow(/has no thread yet/);
  });

  test("requires a destination", () => {
    expect(() => resolveThread(store([]), {})).toThrow(
      /--thread, --cwd, or --project/,
    );
  });

  test("addresses a directory Codex has no project row for", () => {
    const thread: CodexThread = {
      id: "t-unlisted",
      label: "platform work",
      cwd: "/repo/unlisted",
      updatedAtMs: 5,
      rolloutPath: null,
    };
    expect(resolveThread(store([thread]), { cwd: "/repo/unlisted" }).id).toBe(
      "t-unlisted",
    );
  });
});

describe("autoSendScript", () => {
  test("derives the System Events process name from the bundle path", () => {
    expect(appProcessName("/Applications/ChatGPT.app")).toBe("ChatGPT");
    expect(appProcessName("/Applications/Codex.app")).toBe("Codex");
  });

  test("refuses to type when something else holds focus", () => {
    const script = autoSendScript("ChatGPT");
    // A bare keystroke goes to whatever is frontmost, which is how a stray
    // return reaches the wrong window.
    expect(script).toContain("frontmost is true");
    expect(script).toContain('if frontApp is not "ChatGPT" then error');
  });

  test("addresses the keystroke to the process, not the screen", () => {
    expect(autoSendScript("ChatGPT")).toContain(
      'tell process "ChatGPT" to keystroke return',
    );
  });

  test("activates the app before typing into it", () => {
    expect(autoSendScript("ChatGPT")).toStartWith(
      'tell application "ChatGPT" to activate',
    );
  });
});

describe("workspaceWarning", () => {
  test("warns before sending that the workspace will be ignored", () => {
    // Measured: a registered root was ignored too, so registration is no defence.
    expect(
      workspaceWarning({ requestedWorkspace: "/repo/a", registered: true }),
    ).toMatch(/ignores the requested workspace/);
    expect(
      workspaceWarning({
        requestedWorkspace: "/repo/unlisted",
        registered: false,
      }),
    ).toMatch(/not a project root either/);
  });

  test("reports where the thread actually landed", () => {
    expect(
      workspaceWarning({
        requestedWorkspace: "/repo/wanted",
        registered: true,
        actualCwd: "/repo/elsewhere",
      }),
    ).toMatch(/opened \/repo\/elsewhere, not \/repo\/wanted/);
  });

  test("stays quiet when the thread landed where it was asked to", () => {
    expect(
      workspaceWarning({
        requestedWorkspace: "/repo/wanted",
        registered: true,
        actualCwd: "/repo/wanted",
      }),
    ).toBeUndefined();
  });
});

describe("openUrlArgv", () => {
  test("names the application so a stale handler cannot intercept the link", () => {
    expect(openUrlArgv("codex://x", "/Applications/ChatGPT.app")).toEqual([
      "open",
      "-a",
      "/Applications/ChatGPT.app",
      "codex://x",
    ]);
  });

  test("falls back to the default handler when no app is installed", () => {
    expect(openUrlArgv("codex://x", undefined)).toEqual(["open", "codex://x"]);
  });
});

describe("resolveWorkspace", () => {
  test("uses a directory directly and names the project when one owns it", () => {
    expect(resolveWorkspace(store([]), { cwd: "/repo/a" })).toEqual({
      root: "/repo/a",
      project: "aurora-nuclei",
      registered: true,
    });
  });

  test("marks a directory that belongs to no project as unregistered", () => {
    expect(resolveWorkspace(store([]), { cwd: "/repo/unlisted" })).toEqual({
      root: "/repo/unlisted",
      project: "(no codex project)",
      registered: false,
    });
  });

  test("falls back to a project's first root", () => {
    expect(resolveWorkspace(store([]), { project: "aurora-nuclei" })).toEqual({
      root: "/repo/a",
      project: "aurora-nuclei",
      registered: true,
    });
  });

  test("requires one of the two ways to name a workspace", () => {
    expect(() => resolveWorkspace(store([]), {})).toThrow(
      /--cwd or --project is required/,
    );
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

describe("openThreadInDesktop", () => {
  const opener = () => {
    const opened: string[][] = [];
    return {
      opened,
      run: async (argv: string[]) => {
        opened.push(argv);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };
  };

  test("opens a desktop composer prefilled with the prompt", async () => {
    const runner = opener();
    const result = await openThreadInDesktop(
      store([]),
      runner,
      { project: "aurora-nuclei" },
      "run the QA brief",
    );
    expect(runner.opened[0]?.[0]).toBe("open");
    expect(result.requestedWorkspace).toBe("/repo/a");
    expect(result.awaitingSend).toBe(true);
    const url = new URL(runner.opened[0]?.at(-1) ?? "");
    expect(url.protocol).toBe("codex:");
    expect(url.searchParams.get("workspace")).toBe("/repo/a");
    expect(url.searchParams.get("prompt")).toBe("run the QA brief");
  });

  test("encodes newlines and spaces in the prompt", () => {
    const url = desktopThreadUrl("/repo/a", "line one\nline two");
    expect(url).toContain("prompt=line+one%0Aline+two");
    expect(new URL(url).searchParams.get("prompt")).toBe("line one\nline two");
  });

  test("rejects a root outside the project", async () => {
    await expect(
      openThreadInDesktop(
        store([]),
        opener(),
        { project: "aurora-nuclei", root: "/repo/c" },
        "brief",
      ),
    ).rejects.toThrow(/not a root of aurora-nuclei/);
  });
});

describe("auto send", () => {
  const runner = () => {
    const ran: string[][] = [];
    return {
      ran,
      run: async (argv: string[]) => {
        ran.push(argv);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };
  };

  test("presses return and reports the thread that appeared", async () => {
    const existing = thread({ id: "old" });
    let created = false;
    const dynamicStore: ThreadStore = {
      projects: () => store([]).projects(),
      threads: () =>
        created
          ? [existing, thread({ id: "brand-new", cwd: "/repo/b" })]
          : [existing],
    };
    const process = runner();
    const result = await openThreadInDesktop(
      dynamicStore,
      process,
      { project: "aurora-nuclei" },
      "brief",
      {
        composerMs: 1,
        timeoutMs: 100,
        pollMs: 1,
        sleep: async () => {
          created = true;
        },
      },
    );
    expect(process.ran[0]?.[0]).toBe("open");
    expect(process.ran[1]?.[0]).toBe("osascript");
    expect(process.ran[1]?.[2]).toContain("keystroke return");
    expect(result.threadId).toBe("brand-new");
    expect(result.awaitingSend).toBe(false);
    expect(result.actualCwd).toBe("/repo/b");
  });

  test("reports awaitingSend when no thread appears", async () => {
    let clock = 0;
    const result = await openThreadInDesktop(
      store([thread({ id: "old" })]),
      runner(),
      { project: "aurora-nuclei" },
      "brief",
      {
        composerMs: 1,
        timeoutMs: 10,
        pollMs: 1,
        sleep: async () => {},
        now: () => (clock += 4),
      },
    );
    expect(result.awaitingSend).toBe(true);
    expect(result.threadId).toBeUndefined();
  });

  test("skips the keystroke when auto send is not requested", async () => {
    const process = runner();
    const result = await openThreadInDesktop(
      store([]),
      process,
      { project: "aurora-nuclei" },
      "brief",
    );
    expect(process.ran.map((argv) => argv[0])).toEqual(["open"]);
    expect(result.awaitingSend).toBe(true);
  });
});

describe("watchForReply", () => {
  const msg = (text: string): AssistantMessage => ({ text, index: 1 });

  test("returns a turn appended after the offset it started from", async () => {
    let closed = false;
    let cancelled = false;
    const result = await watchForReply(
      thread({ rolloutPath: "/tmp/r.jsonl" }),
      {
        watch: (_p, onChange) => {
          queueMicrotask(() => onChange());
          return {
            close: () => {
              closed = true;
            },
          };
        },
        scan: async (_p, from) =>
          from === 100
            ? { messages: [], endOffset: 100 }
            : { messages: [msg("fresh")], endOffset: 200 },
        timer: () => ({
          cancel: () => {
            cancelled = true;
          },
        }),
      },
      1_000,
      50,
    );
    expect(result.reply).toBe("fresh");
    expect(result.timedOut).toBe(false);
    expect(closed).toBe(true);
    expect(cancelled).toBe(true);
  });

  // The bug this replaced: a fixed tail window drops old turns as new ones
  // arrive, so a count never grows and the wait hangs while Codex is answering.
  test("does not depend on the number of turns in the window", async () => {
    let call = 0;
    const result = await watchForReply(
      thread({ rolloutPath: "/tmp/r.jsonl" }),
      {
        watch: (_p, onChange) => {
          queueMicrotask(() => onChange());
          return { close: () => {} };
        },
        scan: async () => {
          call += 1;
          // Same count every time, but the second scan contains a new turn.
          return call === 1
            ? { messages: [], endOffset: 10 }
            : { messages: [msg("appended")], endOffset: 20 };
        },
        timer: () => ({ cancel: () => {} }),
      },
      1_000,
      0,
    );
    expect(result.reply).toBe("appended");
  });

  test("advances the offset so the same bytes are not re-read", async () => {
    const offsets: number[] = [];
    let fire: (() => void) | undefined;
    const pending = watchForReply(
      thread({ rolloutPath: "/tmp/r.jsonl" }),
      {
        watch: (_p, onChange) => {
          fire = onChange;
          return { close: () => {} };
        },
        scan: async (_p, from) => {
          offsets.push(from);
          return offsets.length < 3
            ? { messages: [], endOffset: from + 10 }
            : { messages: [msg("done")], endOffset: from + 10 };
        },
        timer: () => ({ cancel: () => {} }),
      },
      1_000,
      0,
    );
    await Promise.resolve();
    fire?.();
    await Promise.resolve();
    fire?.();
    await pending;
    expect(offsets).toEqual([0, 10, 20]);
  });

  test("reports a timeout when the deadline fires first", async () => {
    const result = await watchForReply(
      thread({ rolloutPath: "/tmp/r.jsonl" }),
      {
        watch: () => ({ close: () => {} }),
        scan: async (_p, from) => ({ messages: [], endOffset: from }),
        timer: (_ms, fireNow) => {
          queueMicrotask(fireNow);
          return { cancel: () => {} };
        },
      },
      1,
      0,
    );
    expect(result.timedOut).toBe(true);
  });

  test("times out immediately for a thread with no rollout", async () => {
    const result = await watchForReply(
      thread(),
      {
        watch: () => ({ close: () => {} }),
        scan: async (_p, from) => ({ messages: [], endOffset: from }),
        timer: () => ({ cancel: () => {} }),
      },
      1_000,
      0,
    );
    expect(result.timedOut).toBe(true);
  });
});
