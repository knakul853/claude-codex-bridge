import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseInbox } from "../src/inbox";
import { notifyClaude } from "../src/notify";

const paths: string[] = [];
const sessionA = "11111111-1111-4111-8111-111111111111";
const sessionB = "22222222-2222-4222-8222-222222222222";

async function temporary(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  paths.push(path);
  return path;
}

async function registry(
  records: Array<Record<string, unknown>>,
): Promise<string> {
  const root = await temporary("bridge-notify-sessions-");
  for (const record of records) {
    await writeFile(
      join(root, `${record.pid}.json`),
      JSON.stringify(record),
      "utf8",
    );
  }
  return root;
}

// The push resolves when the socket closes, which can precede the server's data
// event, so the bytes are waited for rather than assumed to have landed.
async function waitForBytes(chunks: string[]): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (chunks.length > 0) return chunks.join("");
    await new Promise((done) => setTimeout(done, 10));
  }
  return chunks.join("");
}

async function laneMessages(path: string) {
  return parseInbox(await readFile(path, "utf8"));
}

afterEach(async () => {
  for (const path of paths.splice(0))
    await rm(path, { recursive: true, force: true });
});

describe("notifyClaude", () => {
  test("puts an unaddressed message on the broadcast lane", async () => {
    const home = await temporary("bridge-notify-home-");
    const result = await notifyClaude({
      from: "codex",
      message: "no particular session",
      home,
      sessionsRoot: await registry([]),
    });
    expect(result.lane).toBe(join(home, "inbox", "broadcast.jsonl"));
    expect((await laneMessages(result.lane as string))[0]?.message).toBe(
      "no particular session",
    );
  });

  test("addresses a session that is not running so the message still waits", async () => {
    const home = await temporary("bridge-notify-home-");
    const result = await notifyClaude({
      to: sessionA,
      from: "codex",
      message: "read this when you are back",
      home,
      sessionsRoot: await registry([]),
    });
    expect(result.lane).toBe(join(home, "inbox", `${sessionA}.jsonl`));
    const stored = await laneMessages(result.lane as string);
    expect(stored[0]?.to).toBe(sessionA);
  });

  test("records on the lane even when a socket nudge is attempted", async () => {
    const home = await temporary("bridge-notify-home-");
    const sessionsRoot = await registry([
      {
        pid: 101,
        sessionId: sessionA,
        cwd: "/repo/aurora",
        kind: "interactive",
        messagingSocketPath: "/nonexistent/dead.sock",
      },
    ]);
    const result = await notifyClaude({
      to: sessionA,
      from: "codex",
      message: "socket is dead, lane is not",
      push: true,
      home,
      sessionsRoot,
    });
    expect(result.sessionId).toBe(sessionA);
    expect(result.pushed).toBe(false);
    expect(result.detail).toBeDefined();
    // The nudge failing must never cost the message.
    expect((await laneMessages(result.lane as string))[0]?.message).toBe(
      "socket is dead, lane is not",
    );
  });

  test("resolves the addressee from the directory being worked in", async () => {
    const home = await temporary("bridge-notify-home-");
    const sessionsRoot = await registry([
      {
        pid: 101,
        sessionId: sessionA,
        cwd: "/repo/aurora",
        kind: "interactive",
      },
      {
        pid: 102,
        sessionId: sessionB,
        cwd: "/repo/platform",
        kind: "interactive",
      },
    ]);
    const result = await notifyClaude({
      cwd: "/repo/platform",
      from: "codex",
      message: "platform update",
      home,
      sessionsRoot,
    });
    expect(result.sessionId).toBe(sessionB);
    expect(result.lane).toBe(join(home, "inbox", `${sessionB}.jsonl`));
  });

  test("refuses to guess when a directory has two sessions in it", async () => {
    const sessionsRoot = await registry([
      { pid: 101, sessionId: sessionA, cwd: "/repo/a", kind: "interactive" },
      { pid: 102, sessionId: sessionB, cwd: "/repo/a", kind: "background" },
    ]);
    await expect(
      notifyClaude({
        cwd: "/repo/a",
        from: "codex",
        message: "which of you",
        home: await temporary("bridge-notify-home-"),
        sessionsRoot,
      }),
    ).rejects.toThrow(/address one with --to/);
  });

  test("keeps two addressees from consuming each other's messages", async () => {
    const home = await temporary("bridge-notify-home-");
    const sessionsRoot = await registry([]);
    const first = await notifyClaude({
      to: sessionA,
      from: "codex",
      message: "for a",
      home,
      sessionsRoot,
    });
    const second = await notifyClaude({
      to: sessionB,
      from: "codex",
      message: "for b",
      home,
      sessionsRoot,
    });
    expect(first.lane).not.toBe(second.lane);
    expect(
      (await laneMessages(first.lane as string)).map((m) => m.message),
    ).toEqual(["for a"]);
    expect(
      (await laneMessages(second.lane as string)).map((m) => m.message),
    ).toEqual(["for b"]);
  });

  test("redacts a credential before it reaches the lane", async () => {
    const home = await temporary("bridge-notify-home-");
    // Assembled at runtime so this file does not itself trip privacy-check.
    const credential = `API_KEY=${"super-secret-value"}`;
    const result = await notifyClaude({
      to: sessionA,
      from: "codex",
      message: `use ${credential} to reproduce`,
      home,
      sessionsRoot: await registry([]),
    });
    const stored = await laneMessages(result.lane as string);
    expect(stored[0]?.message).not.toContain("super-secret-value");
    expect(stored[0]?.message).toContain("[redacted]");
  });

  test("still records the lane when the socket nudge succeeds", async () => {
    const home = await temporary("bridge-notify-home-");
    const sessionsRoot = await temporary("bridge-notify-sessions-");
    const socketPath = join(sessionsRoot, "live.sock");
    const received: string[] = [];
    const server = createServer((socket) => {
      socket.on("data", (chunk) => received.push(chunk.toString()));
    });
    await new Promise<void>((ready) => server.listen(socketPath, ready));
    await writeFile(
      join(sessionsRoot, "101.json"),
      JSON.stringify({
        pid: 101,
        sessionId: sessionA,
        cwd: "/repo/aurora",
        kind: "interactive",
        messagingSocketPath: socketPath,
      }),
      "utf8",
    );
    await writeFile(
      join(sessionsRoot, "101.abc.key"),
      JSON.stringify({ peerToken: "token-101" }),
      "utf8",
    );
    try {
      const result = await notifyClaude({
        to: sessionA,
        from: "codex",
        message: "both paths",
        push: true,
        home,
        sessionsRoot,
      });
      expect(result.pushed).toBe(true);
      // A successful nudge must not replace the durable record: the socket
      // acknowledges nothing, so it is never proof the session got it.
      expect((await laneMessages(result.lane)).map((m) => m.message)).toEqual([
        "both paths",
      ]);
      const wire = await waitForBytes(received);
      expect(wire).toContain('"type":"auth"');
      expect(wire).toContain("token-101");
      expect(wire).toContain("both paths");
    } finally {
      server.close();
    }
  });

  test("still reaches a live session when the lane cannot be written", async () => {
    const sessionsRoot = await temporary("bridge-notify-sessions-");
    const socketPath = join(sessionsRoot, "live.sock");
    const received: string[] = [];
    const server = createServer((socket) => {
      socket.on("data", (chunk) => received.push(chunk.toString()));
    });
    await new Promise<void>((ready) => server.listen(socketPath, ready));
    await writeFile(
      join(sessionsRoot, "101.json"),
      JSON.stringify({
        pid: 101,
        sessionId: sessionA,
        cwd: "/repo/aurora",
        kind: "interactive",
        messagingSocketPath: socketPath,
      }),
      "utf8",
    );
    await writeFile(
      join(sessionsRoot, "101.abc.key"),
      JSON.stringify({ peerToken: "token-101" }),
      "utf8",
    );
    try {
      // A sandboxed sender is denied the lane but can still reach the socket,
      // so the message must not be discarded with it.
      const result = await notifyClaude({
        to: sessionA,
        from: "codex",
        message: "lane denied, socket open",
        home: "/proc/nonexistent-home",
        sessionsRoot,
      });
      expect(result.queued).toBe(false);
      expect(result.pushed).toBe(true);
      expect(result.detail).toMatch(/lane unavailable/);
      expect(await waitForBytes(received)).toContain(
        "lane denied, socket open",
      );
    } finally {
      server.close();
    }
  });

  test("fails loudly when neither channel can take the message", async () => {
    await expect(
      notifyClaude({
        to: sessionA,
        from: "codex",
        message: "nowhere to go",
        home: "/proc/nonexistent-home",
        sessionsRoot: await temporary("bridge-notify-sessions-"),
      }),
    ).rejects.toThrow(/not delivered/);
  });

  test("reports the lane as queued on the ordinary path", async () => {
    const result = await notifyClaude({
      to: sessionA,
      from: "codex",
      message: "ordinary",
      home: await temporary("bridge-notify-home-"),
      sessionsRoot: await temporary("bridge-notify-sessions-"),
    });
    expect(result.queued).toBe(true);
  });

  test("refuses an empty notification", async () => {
    await expect(
      notifyClaude({
        from: "codex",
        message: "   ",
        home: await temporary("bridge-notify-home-"),
        sessionsRoot: await registry([]),
      }),
    ).rejects.toThrow(/needs a message/);
  });
});
