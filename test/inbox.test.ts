import { describe, expect, test } from "bun:test";
import { watch as watchFile } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AppendResult,
  appendInbox,
  inboxLanePath,
  laneName,
  parseInbox,
  readLane,
  watchInbox,
} from "../src/inbox";

async function lane(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "bridge-inbox-")), "lane.jsonl");
}

function nativeWatch(path: string, from: number, timeoutMs: number) {
  return watchInbox(path, from, timeoutMs, {
    watch: (directory, onChange) => {
      const watcher = watchFile(directory, (_event, file) =>
        onChange(typeof file === "string" ? file : null),
      );
      return { close: () => watcher.close() };
    },
    read: readLane,
    timer: (ms, fire) => {
      const handle = setTimeout(fire, ms);
      return { cancel: () => clearTimeout(handle) };
    },
  });
}

describe("inbox lanes", () => {
  test("appends one json line per message", async () => {
    const path = await lane();
    await appendInbox(path, { at: "t1", from: "codex", message: "one" });
    await appendInbox(path, { at: "t2", from: "codex", message: "two" });
    const text = await readFile(path, "utf8");
    expect(text.trim().split("\n")).toHaveLength(2);
    expect(parseInbox(text).map((m) => m.message)).toEqual(["one", "two"]);
  });

  test("skips a partially written line instead of failing", () => {
    const messages = parseInbox(
      `${JSON.stringify({ at: "t", from: "codex", message: "good" })}\n{"at":"t","mess`,
    );
    expect(messages.map((m) => m.message)).toEqual(["good"]);
  });

  test("defaults a missing sender rather than dropping the message", () => {
    expect(parseInbox(JSON.stringify({ message: "hi" }))).toEqual([
      { at: "", from: "unknown", message: "hi" },
    ]);
  });

  test("keeps the addressee so a reader can tell a lane was targeted", () => {
    expect(
      parseInbox(JSON.stringify({ message: "hi", to: "session-a" }))[0]?.to,
    ).toBe("session-a");
  });

  test("gives each addressee its own lane and an unaddressed one broadcast", () => {
    const home = "/tmp/bridge-home";
    expect(inboxLanePath("session-a", home)).toBe(
      "/tmp/bridge-home/inbox/session-a.jsonl",
    );
    expect(inboxLanePath(undefined, home)).toBe(
      "/tmp/bridge-home/inbox/broadcast.jsonl",
    );
    expect(inboxLanePath("session-a", home)).not.toBe(
      inboxLanePath("session-b", home),
    );
  });

  test("refuses a lane name that would escape the inbox directory", () => {
    expect(() => laneName("../../etc/passwd")).toThrow();
    expect(() => laneName("a/b")).toThrow();
    expect(() => laneName("..")).toThrow();
    expect(() => laneName("")).toThrow();
  });
});

describe("watchInbox", () => {
  test("returns immediately when a message is already waiting", async () => {
    const path = await lane();
    await appendInbox(path, { at: "t", from: "codex", message: "waiting" });
    const result = await nativeWatch(path, 0, 5_000);
    expect(result.timedOut).toBe(false);
    expect(result.messages.map((m) => m.message)).toEqual(["waiting"]);
  });

  test("returns only what was appended after the offset", async () => {
    const path = await lane();
    await appendInbox(path, { at: "t1", from: "codex", message: "old" });
    const first = await nativeWatch(path, 0, 5_000);
    await appendInbox(path, { at: "t2", from: "codex", message: "new" });
    const second = await nativeWatch(path, first.offset, 5_000);
    expect(second.messages.map((m) => m.message)).toEqual(["new"]);
  });

  test("wakes on a filesystem event for a lane that did not exist yet", async () => {
    const path = await lane();
    const pending = nativeWatch(path, 0, 5_000);
    await appendInbox(path, { at: "t", from: "codex", message: "arrived" });
    const result = await pending;
    expect(result.timedOut).toBe(false);
    expect(result.messages.map((m) => m.message)).toEqual(["arrived"]);
  });

  test("times out when nothing arrives", async () => {
    const result = await nativeWatch(await lane(), 0, 50);
    expect(result.timedOut).toBe(true);
    expect(result.messages).toEqual([]);
  });

  test("releases the watcher and the timer once it settles", async () => {
    const path = await lane();
    await appendInbox(path, { at: "t", from: "codex", message: "one" });
    let closed = 0;
    let cancelled = 0;
    await watchInbox(path, 0, 5_000, {
      watch: () => ({
        close: () => {
          closed += 1;
        },
      }),
      read: readLane,
      timer: () => ({
        cancel: () => {
          cancelled += 1;
        },
      }),
    });
    expect(closed).toBe(1);
    expect(cancelled).toBe(1);
  });

  test("ignores events for other lanes in the same directory", async () => {
    const path = await lane();
    const events: Array<(file: string | null) => void> = [];
    const pending: Promise<AppendResult> = watchInbox(path, 0, 5_000, {
      watch: (_directory, onChange) => {
        events.push(onChange);
        return { close: () => {} };
      },
      read: readLane,
      timer: (ms, fire) => {
        const handle = setTimeout(fire, ms);
        return { cancel: () => clearTimeout(handle) };
      },
    });
    await appendInbox(path, { at: "t", from: "codex", message: "mine" });
    events[0]?.("someone-else.jsonl");
    // The unrelated event must not settle the wait; the matching one must.
    events[0]?.("lane.jsonl");
    expect((await pending).messages.map((m) => m.message)).toEqual(["mine"]);
  });

  test("does not drop a message that arrives while a read is in flight", async () => {
    const path = await lane();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    let reads = 0;
    const pending = watchInbox(path, 0, 5_000, {
      watch: () => ({ close: () => {} }),
      read: async (target, from) => {
        reads += 1;
        if (reads === 1) await gate;
        return readLane(target, from);
      },
      timer: (ms, fire) => {
        const handle = setTimeout(fire, ms);
        return { cancel: () => clearTimeout(handle) };
      },
    });
    await appendInbox(path, { at: "t", from: "codex", message: "raced" });
    release?.();
    expect((await pending).messages.map((m) => m.message)).toEqual(["raced"]);
  });
});
