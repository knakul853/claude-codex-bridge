import { Database } from "bun:sqlite";
import { readdirSync, statSync } from "node:fs";
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

export interface ThreadStore {
  projects(): CodexProject[];
  threads(options?: { roots?: string[]; limit?: number }): CodexThread[];
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

export class SqliteThreadStore implements ThreadStore {
  private readonly db: Database;

  constructor(databasePath: string) {
    this.db = new Database(databasePath, { readonly: true });
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
  threads(options: { roots?: string[]; limit?: number } = {}): CodexThread[] {
    const limit = options.limit ?? 20;
    const roots = options.roots;
    const where = ["coalesce(archived, 0) = 0"];
    if (roots?.length) {
      where.push(`cwd in (${roots.map(() => "?").join(", ")})`);
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
      .all(...(roots ?? []))
      .map((row) => ({
        id: row.id,
        label: row.label,
        cwd: row.cwd,
        updatedAtMs: row.updated_at_ms,
        rolloutPath: row.rollout_path,
      }));
  }
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

export function parseAssistantMessages(text: string): AssistantMessage[] {
  const messages: AssistantMessage[] = [];
  let index = 0;
  for (const line of text.split("\n")) {
    index += 1;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.type !== "response_item") continue;
    const payload = event.payload as Record<string, unknown> | undefined;
    if (!payload || payload.type !== "message" || payload.role !== "assistant")
      continue;
    const content = Array.isArray(payload.content) ? payload.content : [];
    const body = content
      .map((part) =>
        typeof part === "object" && part && "text" in part
          ? String((part as { text?: unknown }).text ?? "")
          : "",
      )
      .join("")
      .trim();
    if (body) messages.push({ text: body, index });
  }
  return messages;
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
