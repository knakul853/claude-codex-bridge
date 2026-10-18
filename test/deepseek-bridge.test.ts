import { describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { Bridge } from "../integrations/deepseek/agentplus-bridge.mjs";
import {
  parseSend,
  request,
} from "../integrations/deepseek/agentplus-deepseek";

interface Prompt {
  requestId: string;
  sessionId: string;
  mode: string;
  content: { type: string; text: string }[];
}

function fakeController() {
  const prompts: Prompt[] = [];
  return {
    prompts,
    list: async () => ({
      items: [
        {
          sessionId: "session-a",
          cwd: "/repo/a",
          updatedAt: "t1",
          running: false,
          blank: false,
        },
        {
          sessionId: "session-b",
          cwd: "/repo/b",
          updatedAt: "t2",
          running: true,
          blank: true,
        },
        {
          sessionId: "session-c",
          cwd: "/repo/c",
          updatedAt: "t3",
          running: false,
          origin: "subagent",
        },
      ],
    }),
    create: async (req: { cwd?: string }) => ({
      sessionId: `session-new-${req.cwd ?? "default"}`,
    }),
    prompt: async (req: Prompt) => {
      prompts.push(req);
      return { accepted: true };
    },
  };
}

function assistant(turn: number, text: string) {
  return {
    type: "assistant/message",
    data: { turn, message: { content: [{ type: "text", text }] } },
  };
}

describe("deepseek bridge", () => {
  test("lists only top-level, non-blank sessions", async () => {
    const sessions = await new Bridge(fakeController()).list();
    expect(sessions.map((s: { id: string }) => s.id)).toEqual(["session-a"]);
    expect(sessions[0].title).toBe("a");
  });

  test("send returns the reply of the turn that claimed this message, ignoring other turns", async () => {
    const controller = fakeController();
    const bridge = new Bridge(controller);
    const pending = bridge.send({ session: "session-a", message: "hi" });
    await Promise.resolve();
    const { requestId, mode, content } = controller.prompts[0];
    expect(mode).toBe("queue");
    expect(content).toEqual([{ type: "text", text: "hi" }]);
    bridge.onSessionEvent("session-a", assistant(4, "someone else's turn"));
    bridge.onInboxClaimed({ source: { rpcId: "other" } }, 4);
    bridge.onInboxClaimed({ source: { rpcId: requestId } }, 5);
    bridge.onSessionEvent("session-a", assistant(5, "pong"));
    bridge.onSessionEvent("session-b", assistant(5, "wrong session"));
    bridge.onSessionEvent("session-a", assistant(5, "done"));
    bridge.onSessionEvent("session-a", {
      type: "turn/end",
      data: { turn: 5, reason: { kind: "completed" } },
    });
    expect(await pending).toEqual({
      accepted: true,
      reply: "pong\n\ndone",
      turn: 5,
      reason: "completed",
    });
    expect(bridge.byRequest.size).toBe(0);
    expect(bridge.byTurn.size).toBe(0);
  });

  test("a reply that never comes times out instead of hanging", async () => {
    const bridge = new Bridge(fakeController());
    const out = await bridge.send({
      session: "session-a",
      message: "hi",
      timeoutMs: 10,
    });
    expect(out.reason).toBe("timeout");
    expect(bridge.byRequest.size).toBe(0);
  });

  test("rejects bad input before prompting", async () => {
    const controller = fakeController();
    const bridge = new Bridge(controller);
    await expect(
      bridge.send({ session: "session-a", message: "  " }),
    ).rejects.toThrow("message is required");
    await expect(
      bridge.send({ session: "session-a", message: "x", mode: "now" }),
    ).rejects.toThrow("mode must be");
    expect(controller.prompts).toHaveLength(0);
  });

  test("socket under Node is user-only and answers one request per connection", async () => {
    const path = `/tmp/apds-${process.pid}-${Date.now()}.sock`;
    const server = Bun.spawn(
      [
        "node",
        join(import.meta.dir, "fixtures/deepseek-bridge-server.mjs"),
        path,
      ],
      {
        stdin: "pipe",
        stdout: "ignore",
      },
    );
    try {
      for (let i = 0; i < 100 && !existsSync(path); i++) await Bun.sleep(20);
      await Bun.sleep(20);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(await request(path, { op: "ping" }, 2000)).toEqual({ ok: true });
      expect(
        await request(path, { op: "create", cwd: "/repo/x" }, 2000),
      ).toEqual({ id: "session-new-/repo/x" });
      await expect(request(path, { op: "nope" }, 2000)).rejects.toThrow(
        "unknown op",
      );
    } finally {
      server.stdin.end();
      await server.exited;
    }
    await expect(request(path, { op: "ping" }, 2000)).rejects.toThrow(
      "not running",
    );
  });

  test("an overlong socket path fails with a clear message", async () => {
    await expect(
      request(`/tmp/${"x".repeat(120)}.sock`, { op: "ping" }, 1000),
    ).rejects.toThrow("104");
  });

  test("send argv keeps everything after -- as the message", () => {
    expect(parseSend(["session-a", "--steer", "--", "--rm", "-rf"])).toEqual({
      session: "session-a",
      message: "--rm -rf",
      mode: "steer",
      wait: true,
      timeoutSeconds: 900,
    });
    expect(() => parseSend(["session-a", "hi"])).toThrow("needs `--`");
  });
});
