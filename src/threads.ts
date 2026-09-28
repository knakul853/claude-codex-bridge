import { Database } from "bun:sqlite";
import { existsSync, readdirSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Auto-generated threads store their whole first prompt as the title, which is
// unbounded and can run to kilobytes. Every consumer prints the label, so it is
// truncated here rather than at each call site.
const LABEL_LIMIT = 120;

export interface CodexProject {
  id: string;
  name: string;
  roots: string[];
}

export interface CodexThread {
  id: string;
  label: string;
  cwd: string;
  updatedAtMs: number;
  rolloutPath: string | null;
}

export interface ThreadQuery {
  roots?: string[];
  limit?: number;
  /** Case-insensitive substring of the thread's name, title or first prompt. */
  titleContains?: string;
}

export interface ThreadStore {
  projects(): CodexProject[];
  threads(options?: ThreadQuery): CodexThread[];
}

// Codex bumps the state file name on schema migrations (state_4, state_5, ...).
// Pinning one version silently stops resolving threads after an app update.
export function newestStateDatabase(codexHome: string): string {
  const candidates = readdirSync(codexHome)
    .filter((name) => /^state_\d+\.sqlite$/.test(name))
    .map((name) => ({
      name,
      version: Number(name.match(/^state_(\d+)\.sqlite$/)?.[1] ?? 0),
    }))
    .sort((a, b) => b.version - a.version);
  const newest = candidates[0];
  if (!newest) throw new Error(`no state_<n>.sqlite found in ${codexHome}`);
  return join(codexHome, newest.name);
}

export function defaultCodexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

/**
 * The desktop app keeps its state database in WAL mode and deletes the -shm
 * file when it closes it. SQLite cannot open such a file read-only, since that
 * needs to create -shm, so it is opened immutable instead: nothing is writing
 * it, and the bridge only reads.
 */
function openStateDatabase(path: string): Database {
  const db = new Database(path, { readonly: true });
  try {
    db.query("select 1").get();
    return db;
  } catch (error) {
    db.close();
    const code = (error as { code?: unknown }).code;
    if (code !== "SQLITE_CANTOPEN" || existsSync(`${path}-shm`)) throw error;
    return new Database(`file:${encodeURI(path)}?immutable=1`, {
      readonly: true,
    });
  }
}

export class SqliteThreadStore implements ThreadStore {
  private readonly db: Database;

  constructor(databasePath: string) {
    this.db = openStateDatabase(databasePath);
  }

  static open(codexHome = defaultCodexHome()): SqliteThreadStore {
    return new SqliteThreadStore(newestStateDatabase(codexHome));
  }

  projects(): CodexProject[] {
    const rows = this.db
      .query<
        { id: string; name: string; path: string | null },
        []
      >(`select p.id as id, p.name as name, r.path as path
          from projects p left join project_roots r on r.project_id = p.id
          order by p.position, r.position`)
      .all();
    const byId = new Map<string, CodexProject>();
    for (const row of rows) {
      const project = byId.get(row.id) ?? {
        id: row.id,
        name: row.name,
        roots: [],
      };
      if (row.path) project.roots.push(row.path);
      byId.set(row.id, project);
    }
    return [...byId.values()];
  }

  // Threads carry no project_id in the local store, so a project's threads are
  // the ones whose cwd is one of its roots.
  threads(options: ThreadQuery = {}): CodexThread[] {
    const limit = options.limit ?? 20;
    const roots = options.roots;
    const where = ["coalesce(archived, 0) = 0"];
    const params: string[] = [];
    if (roots?.length) {
      where.push(`cwd in (${roots.map(() => "?").join(", ")})`);
      params.push(...roots);
    }
    if (options.titleContains) {
      where.push(
        `lower(coalesce(name, '') || ' ' || coalesce(title, '') || ' ' || coalesce(first_user_message, '')) like ? escape '\\'`,
      );
      params.push(`%${escapeLike(options.titleContains.toLowerCase())}%`);
    }
    return this.db
      .query<
        {
          id: string;
          label: string;
          cwd: string;
          updated_at_ms: number;
          rollout_path: string | null;
        },
        string[]
      >(`select id,
                substr(
                  replace(replace(coalesce(nullif(name, ''), nullif(title, ''), nullif(first_user_message, ''), '(untitled)'), char(10), ' '), char(13), ' '),
                  1, ${LABEL_LIMIT}
                ) as label,
                coalesce(cwd, '') as cwd,
                coalesce(updated_at_ms, 0) as updated_at_ms,
                rollout_path
           from threads
          where ${where.join(" and ")}
          order by updated_at_ms desc
          limit ${limit}`)
      .all(...params)
      .map((row) => ({
        id: row.id,
        label: row.label,
        cwd: row.cwd,
        updatedAtMs: row.updated_at_ms,
        rolloutPath: row.rollout_path,
      }));
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export function resolveProject(
  projects: CodexProject[],
  name: string,
): CodexProject {
  const wanted = name.trim().toLowerCase();
  const matches = projects.filter((p) => p.name.toLowerCase() === wanted);
  if (matches.length === 0) {
    const known = projects.map((p) => p.name).join(", ");
    throw new Error(`no codex project named ${name}. known projects: ${known}`);
  }
  if (matches.length > 1) {
    throw new Error(
      `${matches.length} codex projects named ${name}; pass --thread instead`,
    );
  }
  return matches[0] as CodexProject;
}

export interface AssistantMessage {
  text: string;
  index: number;
}

export interface MessageScan {
  messages: AssistantMessage[];
  /** Byte offset to resume from; pass back to read only what was appended. */
  endOffset: number;
}

// Rollouts are append-only JSONL and reach hundreds of megabytes. Reading a fixed
// tail makes the message count useless for change detection: as the file grows old
// turns leave the window as new ones enter, so the count can sit still while Codex
// is answering. Callers watching for a reply must resume from a byte offset.
export async function scanAssistantMessages(
  rolloutPath: string,
  fromOffset: number,
): Promise<MessageScan> {
  const handle = await open(rolloutPath, "r");
  try {
    const size = statSync(rolloutPath).size;
    // A truncated or replaced file means the offset no longer refers to our data.
    const start = fromOffset > size ? 0 : fromOffset;
    if (start === size) return { messages: [], endOffset: size };
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.toString("utf8");
    // A trailing partial line is re-read next time rather than parsed now.
    const lastBreak = text.lastIndexOf("\n");
    const complete = lastBreak === -1 ? "" : text.slice(0, lastBreak);
    return {
      messages: parseAssistantMessages(complete),
      endOffset: lastBreak === -1 ? start : start + lastBreak + 1,
    };
  } finally {
    await handle.close();
  }
}

interface ConversationMessage {
  role: "user" | "assistant";
  text: string;
}

function parseConversationMessage(line: string): ConversationMessage | null {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (event.type !== "response_item") return null;
  const payload = event.payload as Record<string, unknown> | undefined;
  if (!payload || payload.type !== "message") return null;
  if (payload.role !== "assistant" && payload.role !== "user") return null;
  const content = Array.isArray(payload.content) ? payload.content : [];
  const text = content
    .map((part) =>
      typeof part === "object" && part && "text" in part
        ? String((part as { text?: unknown }).text ?? "")
        : "",
    )
    .join("")
    .trim();
  return text ? { role: payload.role, text } : null;
}

export function parseAssistantMessages(text: string): AssistantMessage[] {
  const messages: AssistantMessage[] = [];
  let index = 0;
  for (const line of text.split("\n")) {
    index += 1;
    const message = parseConversationMessage(line);
    if (message?.role === "assistant")
      messages.push({ text: message.text, index });
  }
  return messages;
}

export interface ContentMatch {
  role: "user" | "assistant";
  snippet: string;
}

export interface ContentSearch {
  count: number;
  matches: ContentMatch[];
}

const SNIPPET_RADIUS = 80;

function snippetAround(text: string, at: number, length: number): string {
  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = Math.min(text.length, at + length + SNIPPET_RADIUS);
  const body = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${body}${end < text.length ? "…" : ""}`;
}

// Rollouts reach hundreds of megabytes, so they are streamed line by line, and a
// line is parsed only when its raw bytes already contain the needle. Only user
// and assistant messages count: tool output would match every command Codex ran.
export async function searchRollout(
  rolloutPath: string,
  query: string,
  maxMatches = 3,
): Promise<ContentSearch> {
  const needle = query.toLowerCase();
  const result: ContentSearch = { count: 0, matches: [] };
  const decoder = new TextDecoder();
  let pending = "";
  const consider = (line: string): void => {
    if (!line.toLowerCase().includes(needle)) return;
    const message = parseConversationMessage(line);
    if (!message) return;
    const at = message.text.toLowerCase().indexOf(needle);
    if (at === -1) return;
    result.count += 1;
    if (result.matches.length < maxMatches) {
      result.matches.push({
        role: message.role,
        snippet: snippetAround(message.text, at, needle.length),
      });
    }
  };
  for await (const chunk of Bun.file(rolloutPath).stream()) {
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) consider(line);
  }
  consider(pending + decoder.decode());
  return result;
}

export interface ThreadSearchHit extends CodexThread {
  titleMatch: boolean;
  messageMatches: number;
  snippets: ContentMatch[];
}

/** Threads whose label or messages contain the query, newest first. */
export async function searchThreads(
  threads: CodexThread[],
  query: string,
): Promise<ThreadSearchHit[]> {
  const needle = query.toLowerCase();
  const hits: ThreadSearchHit[] = [];
  for (const thread of threads) {
    const titleMatch = thread.label.toLowerCase().includes(needle);
    const content =
      thread.rolloutPath && existsSync(thread.rolloutPath)
        ? await searchRollout(thread.rolloutPath, query)
        : { count: 0, matches: [] };
    if (!titleMatch && content.count === 0) continue;
    hits.push({
      ...thread,
      titleMatch,
      messageMatches: content.count,
      snippets: content.matches,
    });
  }
  return hits;
}

export function rolloutSize(rolloutPath: string): number {
  return statSync(rolloutPath).size;
}

// Only for showing the most recent turns; the count is of the window read, not
// of the thread. Never use it to detect that something new arrived.
export async function readAssistantMessages(
  rolloutPath: string,
  tailBytes = 2_000_000,
): Promise<AssistantMessage[]> {
  const size = statSync(rolloutPath).size;
  const { messages } = await scanAssistantMessages(
    rolloutPath,
    Math.max(0, size - tailBytes),
  );
  return messages;
}
