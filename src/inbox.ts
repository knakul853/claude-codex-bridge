import { appendFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { bridgeHome, ensurePrivateDirectory } from "./store";

export const BROADCAST_LANE = "broadcast";

export interface InboxMessage {
  at: string;
  from: string;
  message: string;
  to?: string;
}

export function inboxRoot(home = bridgeHome()): string {
  return join(home, "inbox");
}

// A lane name becomes a file name, so anything that could escape the inbox
// directory is rejected rather than normalised.
export function laneName(to?: string): string {
  const wanted = (to ?? BROADCAST_LANE).trim();
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(wanted) ||
    wanted.includes("..")
  )
    throw new Error(`${wanted} is not a usable inbox lane name`);
  return wanted;
}

/**
 * One lane per addressee so two Claude sessions watching at once cannot consume
 * each other's messages. An unaddressed message goes to the broadcast lane.
 */
export function inboxLanePath(to?: string, home?: string): string {
  const override = process.env.CLAUDE_CODEX_INBOX;
  if (override && to === undefined) return override;
  return join(inboxRoot(home), `${laneName(to)}.jsonl`);
}

// An append-only log rather than a socket: the sender writes whenever it likes,
// and a reader that was not running at the time still sees the message after.
export async function appendInbox(
  path: string,
  message: InboxMessage,
): Promise<void> {
  await ensurePrivateDirectory(dirname(path));
  await appendFile(path, `${JSON.stringify(message)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
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
        ...(typeof parsed.to === "string" ? { to: parsed.to } : {}),
      });
    } catch {
      // A partially written line is skipped and picked up on the next read.
    }
  }
  return messages;
}

export interface AppendResult {
  messages: InboxMessage[];
  offset: number;
  timedOut: boolean;
}

export async function readLane(
  path: string,
  fromOffset = 0,
): Promise<{ text: string; size: number }> {
  const file = Bun.file(path);
  if (!(await file.exists())) return { text: "", size: 0 };
  const whole = await file.text();
  // A truncated or replaced lane means the offset no longer refers to our data.
  const start = fromOffset > whole.length ? 0 : fromOffset;
  return { text: whole.slice(start), size: whole.length };
}

export interface InboxWatchDeps {
  watch: (
    directory: string,
    onChange: (file: string | null) => void,
  ) => { close: () => void };
  read: (
    path: string,
    fromOffset: number,
  ) => Promise<{ text: string; size: number }>;
  timer: (ms: number, fire: () => void) => { cancel: () => void };
}

/**
 * Blocks on filesystem events rather than a poll interval, and watches the
 * containing directory because the lane file may not exist yet. The watcher and
 * timer are always released, so a caller that times out leaves nothing behind.
 */
export function watchInbox(
  path: string,
  fromOffset: number,
  timeoutMs: number,
  deps: InboxWatchDeps,
): Promise<AppendResult> {
  return new Promise<AppendResult>((resolve, reject) => {
    const lane = basename(path);
    let offset = fromOffset;
    let settled = false;
    let checking = false;
    let changedWhileChecking = false;
    const finish = (result: AppendResult) => {
      if (settled) return;
      settled = true;
      watcher.close();
      timer.cancel();
      resolve(result);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      watcher.close();
      timer.cancel();
      reject(error);
    };
    const check = (file: string | null = null) => {
      if (settled) return;
      if (file !== null && file !== lane) return;
      // A change arriving mid-read must not be dropped: the watcher may never
      // fire again if the sender has finished writing.
      if (checking) {
        changedWhileChecking = true;
        return;
      }
      checking = true;
      deps
        .read(path, offset)
        .then(({ text, size }) => {
          checking = false;
          if (settled) return;
          if (text.trim()) {
            finish({
              messages: parseInbox(text),
              offset: size,
              timedOut: false,
            });
            return;
          }
          offset = size;
          if (changedWhileChecking) {
            changedWhileChecking = false;
            check();
          }
        })
        .catch(fail);
    };
    const watcher = deps.watch(dirname(path), check);
    const timer = deps.timer(timeoutMs, () =>
      finish({ messages: [], offset, timedOut: true }),
    );
    check();
  });
}
