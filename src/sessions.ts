import { readdirSync } from "node:fs";
import { open, readFile } from "node:fs/promises";
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
  title?: string;
  status?: string;
  startedAt?: number;
  procStart?: string;
  messagingSocketPath?: string;
}

export function sessionsRoot(): string {
  return (
    process.env.CLAUDE_SESSIONS_DIR ?? join(homedir(), ".claude", "sessions")
  );
}

export function projectsRoot(): string {
  return (
    process.env.CLAUDE_PROJECTS_DIR ?? join(homedir(), ".claude", "projects")
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
    ...(typeof record.title === "string" ? { title: record.title } : {}),
    ...(typeof record.status === "string" ? { status: record.status } : {}),
    ...(Number.isSafeInteger(record.startedAt)
      ? { startedAt: record.startedAt as number }
      : {}),
    ...(typeof record.procStart === "string"
      ? { procStart: record.procStart }
      : {}),
    ...(typeof record.messagingSocketPath === "string"
      ? { messagingSocketPath: record.messagingSocketPath }
      : {}),
  };
}

function projectDirectory(cwd: string, root: string): string {
  return join(root, cwd.replace(/[^A-Za-z0-9]/g, "-"));
}

async function sessionTitle(
  session: ClaudeSession,
  root: string,
): Promise<string | undefined> {
  const path = join(
    projectDirectory(session.cwd, root),
    `${session.sessionId}.jsonl`,
  );
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(path, "r");
  } catch {
    return;
  }
  try {
    const { size } = await file.stat();
    const length = Math.min(size, 256 * 1024);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await file.read(buffer, 0, length, size - length);
    let generated: string | undefined;
    for (const line of buffer
      .subarray(0, bytesRead)
      .toString("utf8")
      .split("\n")
      .reverse()) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as Record<string, unknown>;
        if (
          record.type === "custom-title" &&
          typeof record.customTitle === "string"
        ) {
          return record.customTitle;
        }
        if (
          generated === undefined &&
          record.type === "ai-title" &&
          typeof record.aiTitle === "string"
        ) {
          generated = record.aiTitle;
        }
      } catch {
        // The first line may begin before the tail window.
      }
    }
    return generated;
  } finally {
    await file.close();
  }
}

export async function listClaudeSessions(
  root = sessionsRoot(),
  transcriptRoot = projectsRoot(),
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
      if (parsed) {
        const title =
          parsed.title ?? (await sessionTitle(parsed, transcriptRoot));
        sessions.push({ ...parsed, ...(title ? { title } : {}) });
      }
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
  title?: string;
  pid?: number;
}

/**
 * Resolves by session id, working directory, or name so Codex can address a
 * Claude session by the directory being worked in rather than an id it never saw.
 */
export async function findClaudeSessions(
  query: SessionQuery,
  root?: string,
  transcriptRoot?: string,
): Promise<ClaudeSession[]> {
  const sessions = await listClaudeSessions(root, transcriptRoot);
  const wantedCwd = query.cwd ? resolve(query.cwd) : undefined;
  const wantedTitle = query.title?.trim().toLocaleLowerCase();
  const matches = sessions.filter(
    (session) =>
      (query.session === undefined || session.sessionId === query.session) &&
      (wantedCwd === undefined || resolve(session.cwd) === wantedCwd) &&
      (query.name === undefined || session.name === query.name) &&
      (wantedTitle === undefined ||
        session.title?.trim().toLocaleLowerCase() === wantedTitle) &&
      (query.pid === undefined || session.pid === query.pid),
  );
  const newest = new Map<string, ClaudeSession>();
  for (const session of matches) {
    const current = newest.get(session.sessionId);
    if (
      !current ||
      (session.startedAt ?? session.pid) > (current.startedAt ?? current.pid)
    ) {
      newest.set(session.sessionId, session);
    }
  }
  return [...newest.values()];
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
  /** The socket took the bytes. The session decides afterwards, so never a receipt. */
  accepted: boolean;
  detail?: string;
}

/**
 * Writes an authenticated message straight into a live session's socket. This is
 * an undocumented Claude Code channel recovered from the binary, so every caller
 * must treat failure as normal and fall back to the inbox. The recipient still
 * gates the message behind its own permission mode, so success here means
 * "the socket took the bytes", not "the session acted on it".
 */
export async function pushToSession(
  session: ClaudeSession,
  message: string,
  timeoutMs = 5_000,
  root?: string,
): Promise<PushResult> {
  const path = session.messagingSocketPath;
  if (!path) return { accepted: false, detail: "session publishes no socket" };
  const key = await readPeerKey(session.pid, root);
  if (!key) return { accepted: false, detail: "no peer key published" };
  // The socket is named by pid, which the OS reuses. Matching process start
  // times proves the listener is the session the record describes.
  if (key.procStart && session.procStart && key.procStart !== session.procStart)
    return { accepted: false, detail: "peer key is stale for this pid" };

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
      () => finish({ accepted: false, detail: "socket timed out" }),
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
          ? { accepted: false, detail: "socket closed with an error" }
          : { accepted: true },
      ),
    );
    socket.on("error", (error) =>
      finish({ accepted: false, detail: error.message }),
    );
  });
}
