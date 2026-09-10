import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendInbox, parseInbox } from "../src/inbox";
import { watchForAppend } from "../src/send";

async function inboxPath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "bridge-inbox-")), "inbox.jsonl");
}

describe("inbox", () => {
  test("appends one json line per message", async () => {
    const path = await inboxPath();
    await appendInbox(path, { at: "t1", from: "codex", message: "one" });
    await appendInbox(path, { at: "t2", from: "codex", message: "two" });
    const lines = (await readFile(path, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(
      parseInbox(await readFile(path, "utf8")).map((m) => m.message),
    ).toEqual(["one", "two"]);
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

  test("returns immediately when a message is already waiting", async () => {
    const path = await inboxPath();
    await appendInbox(path, { at: "t", from: "codex", message: "waiting" });
    const result = await watchForAppend(path, 0, 5_000);
    expect(result.timedOut).toBe(false);
    expect(result.messages.map((m) => m.message)).toEqual(["waiting"]);
  });

  test("returns only what was appended after the offset", async () => {
    const path = await inboxPath();
    await appendInbox(path, { at: "t1", from: "codex", message: "old" });
    const first = await watchForAppend(path, 0, 5_000);
    await appendInbox(path, { at: "t2", from: "codex", message: "new" });
    const second = await watchForAppend(path, first.offset, 5_000);
    expect(second.messages.map((m) => m.message)).toEqual(["new"]);
  });

  test("times out when nothing arrives", async () => {
    const result = await watchForAppend(await inboxPath(), 0, 50);
    expect(result.timedOut).toBe(true);
    expect(result.messages).toEqual([]);
  });
});
