// agent+ bridge for DeepSeek Harness desktop: a dsh Host plugin that serves one JSON request per
// connection on a user-only unix socket, so agent+ can list, create and prompt desktop sessions.
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

export const name = "agentplus-bridge";
export const inject = ["sessionController"];

const MAX_REQUEST_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

export function defaultSocketPath() {
  return join(
    process.env.DSH_HOME || join(homedir(), ".dsh"),
    "agentplus.sock",
  );
}

function textOf(message) {
  return (message?.content ?? [])
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

function titleOf(item) {
  const projected =
    item.projections?.metadata?.title ?? item.projections?.title;
  if (typeof projected === "string" && projected.trim())
    return projected.trim();
  if (projected && typeof projected.value === "string") return projected.value;
  return item.cwd ? item.cwd.split("/").filter(Boolean).pop() : "";
}

export class Bridge {
  constructor(controller, now = () => Date.now()) {
    this.controller = controller;
    this.now = now;
    this.byRequest = new Map();
    this.byTurn = new Map();
  }

  async list() {
    const { items } = await this.controller.list(
      {},
      new AbortController().signal,
    );
    return items
      .filter((item) => item.origin !== "subagent" && !item.blank)
      .map((item) => ({
        id: item.sessionId,
        title: titleOf(item),
        cwd: item.cwd ?? null,
        updated: item.updatedAt,
        running: Boolean(item.running),
      }));
  }

  async create({ cwd }) {
    const out = await this.controller.create(cwd ? { cwd } : {});
    return { id: out.sessionId };
  }

  async send({
    session,
    message,
    mode = "queue",
    wait = true,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  }) {
    if (typeof session !== "string" || !session)
      throw new Error("session is required");
    if (typeof message !== "string" || !message.trim())
      throw new Error("message is required");
    if (mode !== "queue" && mode !== "steer")
      throw new Error(`mode must be queue or steer, not ${mode}`);
    const requestId = randomUUID();
    const pending = wait
      ? this.track(requestId, session, timeoutMs)
      : undefined;
    try {
      await this.controller.prompt(
        {
          requestId,
          sessionId: session,
          mode,
          content: [{ type: "text", text: message }],
        },
        new AbortController().signal,
      );
    } catch (error) {
      pending?.cancel();
      throw error;
    }
    if (!pending) return { accepted: true };
    return pending.promise;
  }

  track(requestId, session, timeoutMs) {
    let settle;
    const promise = new Promise((resolve) => {
      settle = resolve;
    });
    const entry = { requestId, session, turn: undefined, parts: [], settle };
    const timer = setTimeout(
      () => this.finish(entry, { reason: "timeout" }),
      timeoutMs,
    );
    entry.timer = timer;
    this.byRequest.set(requestId, entry);
    return { promise, cancel: () => this.finish(entry, null) };
  }

  finish(entry, result) {
    clearTimeout(entry.timer);
    this.byRequest.delete(entry.requestId);
    if (entry.turn !== undefined)
      this.byTurn.delete(`${entry.session}#${entry.turn}`);
    if (result)
      entry.settle({
        accepted: true,
        reply: entry.parts.join("\n\n").trim(),
        turn: entry.turn,
        ...result,
      });
  }

  onInboxClaimed(message, turn) {
    const entry = this.byRequest.get(message?.source?.rpcId);
    if (!entry || entry.turn !== undefined) return;
    entry.turn = turn;
    this.byTurn.set(`${entry.session}#${turn}`, entry);
  }

  onSessionEvent(sessionId, event) {
    const entry = this.byTurn.get(`${sessionId}#${event?.data?.turn}`);
    if (!entry) return;
    if (event.type === "assistant/message") {
      const text = textOf(event.data.message);
      if (text) entry.parts.push(text);
    } else if (event.type === "turn/end") {
      this.finish(entry, { reason: event.data.reason?.kind ?? "completed" });
    }
  }

  async handle(request) {
    switch (request?.op) {
      case "ping":
        return { ok: true };
      case "list":
        return { sessions: await this.list() };
      case "create":
        return await this.create(request);
      case "send":
        return await this.send(request);
      default:
        throw new Error(`unknown op ${JSON.stringify(request?.op)}`);
    }
  }
}

export function serve(bridge, socketPath, logger = console) {
  if (existsSync(socketPath)) unlinkSync(socketPath);
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > MAX_REQUEST_BYTES) {
        socket.end(`${JSON.stringify({ error: "request too large" })}\n`);
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      buffer = "";
      Promise.resolve()
        .then(() => bridge.handle(JSON.parse(line)))
        .then(
          (result) => socket.end(`${JSON.stringify(result)}\n`),
          (error) =>
            socket.end(
              `${JSON.stringify({ error: error?.message ?? String(error) })}\n`,
            ),
        );
    });
    socket.on("error", (error) =>
      logger.warn(`agentplus-bridge: socket error: ${error.message}`),
    );
  });
  server.listen(socketPath, () => chmodSync(socketPath, 0o600));
  server.on("error", (error) =>
    logger.warn(`agentplus-bridge: server error: ${error.message}`),
  );
  return () => {
    server.close();
    if (existsSync(socketPath)) unlinkSync(socketPath);
  };
}

export function apply(ctx, config = {}) {
  const bridge = new Bridge(ctx.sessionController);
  ctx.on("agent/inbox/claimed", ({ message, turn }) =>
    bridge.onInboxClaimed(message, turn),
  );
  ctx.on("session/event", (session, event) =>
    bridge.onSessionEvent(session?.header?.id, event),
  );
  ctx.effect(
    () => serve(bridge, config.socket || defaultSocketPath(), ctx.logger),
    "agentplus-bridge socket",
  );
}
