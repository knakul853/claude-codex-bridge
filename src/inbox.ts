import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface InboxMessage {
  at: string;
  from: string;
  message: string;
}

export function defaultInboxPath(): string {
  return (
    process.env.CLAUDE_CODEX_INBOX ??
    join(homedir(), ".claude-codex-bridge", "inbox.jsonl")
  );
}

// An append-only log rather than a socket: Codex writes whenever it likes, and a
// reader that was not running at the time still sees the message afterwards.
export async function appendInbox(
  path: string,
  message: InboxMessage,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(message)}\n`, "utf8");
}

export function parseInbox(text: string): InboxMessage[] {
  const messages: InboxMessage[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Partial<InboxMessage>;
      if (typeof parsed.message !== "string") continue;
      messages.push({
        at: typeof parsed.at === "string" ? parsed.at : "",
        from: typeof parsed.from === "string" ? parsed.from : "unknown",
        message: parsed.message,
      });
    } catch {
      // A partially written line is skipped and picked up on the next read.
    }
  }
  return messages;
}
