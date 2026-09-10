import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Claude Code publishes one record per live session, so a peer can discover
 * sessions without shelling out to `claude agents --json`. Fields beyond these
 * exist; only the ones the bridge routes on are modelled.
 */
export interface ClaudeSession {
  pid: number;
  sessionId: string;
  cwd: string;
  kind: string;
  name?: string;
  status?: string;
  procStart?: string;
  messagingSocketPath?: string;
}

export function sessionsRoot(): string {
  return (
    process.env.CLAUDE_SESSIONS_DIR ?? join(homedir(), ".claude", "sessions")
  );
}

/** The session id of the Claude process that invoked the bridge, if any. */
export function currentSessionId(): string | undefined {
  return process.env.CLAUDE_CODE_SESSION_ID;
}

function parseSession(value: unknown): ClaudeSession | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  if (
    !Number.isInteger(record.pid) ||
    typeof record.sessionId !== "string" ||
    typeof record.cwd !== "string"
  ) {
    return;
  }
  return {
    pid: record.pid as number,
    sessionId: record.sessionId,
    cwd: record.cwd,
    kind: typeof record.kind === "string" ? record.kind : "unknown",
    ...(typeof record.name === "string" ? { name: record.name } : {}),
    ...(typeof record.status === "string" ? { status: record.status } : {}),
    ...(typeof record.procStart === "string"
      ? { procStart: record.procStart }
      : {}),
    ...(typeof record.messagingSocketPath === "string"
      ? { messagingSocketPath: record.messagingSocketPath }
      : {}),
  };
}

export async function listClaudeSessions(
  root = sessionsRoot(),
): Promise<ClaudeSession[]> {
  let names: string[];
  try {
    names = readdirSync(root).filter((name) => /^\d+\.json$/.test(name));
  } catch {
    return [];
  }
  const sessions: ClaudeSession[] = [];
  for (const name of names) {
    try {
      const parsed = parseSession(
        JSON.parse(await readFile(join(root, name), "utf8")),
      );
      if (parsed) sessions.push(parsed);
    } catch {
      // A record being rewritten must not hide the others.
    }
  }
  return sessions;
}

export interface SessionQuery {
  session?: string;
  cwd?: string;
  name?: string;
}

/**
 * Resolves by session id, working directory, or name so Codex can address a
 * Claude session by the directory being worked in rather than an id it never saw.
 */
export async function findClaudeSessions(
  query: SessionQuery,
  root?: string,
): Promise<ClaudeSession[]> {
  const sessions = await listClaudeSessions(root);
  const wantedCwd = query.cwd ? resolve(query.cwd) : undefined;
  return sessions.filter(
    (session) =>
      (query.session === undefined || session.sessionId === query.session) &&
      (wantedCwd === undefined || resolve(session.cwd) === wantedCwd) &&
      (query.name === undefined || session.name === query.name),
  );
}

interface PeerKey {
  peerToken: string;
  procStart?: string;
}

async function readPeerKey(
  pid: number,
  root = sessionsRoot(),
): Promise<PeerKey | undefined> {
  let name: string | undefined;
  try {
    name = readdirSync(root).find(
      (candidate) =>
        candidate.startsWith(`${pid}.`) && candidate.endsWith(".key"),
    );
  } catch {
    return;
  }
  if (!name) return;
  try {
    const parsed = JSON.parse(
      await readFile(join(root, name), "utf8"),
    ) as Record<string, unknown> | null;
    if (!parsed || typeof parsed.peerToken !== "string") return;
    return {
      peerToken: parsed.peerToken,
      ...(typeof parsed.procStart === "string"
        ? { procStart: parsed.procStart }
        : {}),
    };
  } catch {
    return;
  }
}

export interface PushResult {
  delivered: boolean;
  detail?: string;
}

/**
 * Writes an authenticated message straight into a live session's socket. This is
 * an undocumented Claude Code channel recovered from the binary, so every caller
 * must treat failure as normal and fall back to the inbox. The recipient still
 * gates the message behind its own permission mode, so delivery here means
 * "handed to the session", not "acted on".
 */
export async function pushToSession(
  session: ClaudeSession,
  message: string,
  timeoutMs = 5_000,
  root?: string,
): Promise<PushResult> {
  const path = session.messagingSocketPath;
  if (!path) return { delivered: false, detail: "session publishes no socket" };
  const key = await readPeerKey(session.pid, root);
  if (!key) return { delivered: false, detail: "no peer key published" };
  // The socket is named by pid, which the OS reuses. Matching process start
  // times proves the listener is the session the record describes.
  if (key.procStart && session.procStart && key.procStart !== session.procStart)
    return { delivered: false, detail: "peer key is stale for this pid" };

  return new Promise<PushResult>((settle) => {
    let done = false;
    const finish = (result: PushResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      settle(result);
    };
    const socket = connect(path);
    const timer = setTimeout(
      () => finish({ delivered: false, detail: "socket timed out" }),
      timeoutMs,
    );
    socket.on("connect", () => {
      socket.write(
        `${JSON.stringify({ type: "auth", token: key.peerToken })}\n`,
      );
      socket.write(
        `${JSON.stringify({
          type: "user",
          message: { role: "user", content: message },
        })}\n`,
      );
      socket.end();
    });
    // The server acknowledges nothing, so a clean close is the only success
    // signal available: it means the write was accepted, not that it was read.
    socket.on("close", (hadError) =>
      finish(
        hadError
          ? { delivered: false, detail: "socket closed with an error" }
          : { delivered: true },
      ),
    );
    socket.on("error", (error) =>
      finish({ delivered: false, detail: error.message }),
    );
  });
}
