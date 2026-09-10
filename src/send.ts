import type { CodexReviewClient } from "./codex";
import {
  type CodexThread,
  readAssistantMessages,
  resolveProject,
  type ThreadStore,
} from "./threads";

export interface SendTarget {
  thread?: string;
  project?: string;
}

export function resolveThread(
  store: ThreadStore,
  target: SendTarget,
): CodexThread {
  if (target.thread) {
    const match = store
      .threads({ limit: 1_000 })
      .find((thread) => thread.id === target.thread);
    if (!match) throw new Error(`no codex thread ${target.thread}`);
    return match;
  }
  if (!target.project)
    throw new Error("pass --thread or --project to choose a destination");
  const project = resolveProject(store.projects(), target.project);
  const newest = store.threads({ roots: project.roots, limit: 1 })[0];
  if (!newest)
    throw new Error(
      `project ${project.name} has no thread yet. open one in Codex, send any message so it is persisted, then retry`,
    );
  return newest;
}

export interface WaitOptions {
  timeoutMs: number;
  pollMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface SendResult {
  threadId: string;
  label: string;
  reply?: string;
  timedOut: boolean;
}

// The queue call returns as soon as Codex accepts the message, so a reply is
// only observable by watching the thread's rollout grow.
export async function sendToThread(
  store: ThreadStore,
  client: CodexReviewClient,
  target: SendTarget,
  message: string,
  wait?: WaitOptions,
): Promise<SendResult> {
  const thread = resolveThread(store, target);
  const before = thread.rolloutPath
    ? (await readAssistantMessages(thread.rolloutPath)).length
    : 0;

  await client.queue(thread.id, message);

  if (!wait || !thread.rolloutPath) {
    return { threadId: thread.id, label: thread.label, timedOut: false };
  }

  const now = wait.now ?? (() => Date.now());
  const sleep =
    wait.sleep ??
    ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const deadline = now() + wait.timeoutMs;
  while (now() < deadline) {
    await sleep(wait.pollMs);
    const messages = await readAssistantMessages(thread.rolloutPath);
    if (messages.length > before) {
      return {
        threadId: thread.id,
        label: thread.label,
        reply: messages[messages.length - 1]?.text,
        timedOut: false,
      };
    }
  }
  return { threadId: thread.id, label: thread.label, timedOut: true };
}
