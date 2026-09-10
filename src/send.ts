import type { CodexReviewClient } from "./codex";
import type { ProcessRunner } from "./process";
import {
  type CodexThread,
  readAssistantMessages,
  resolveProject,
  type ThreadStore,
} from "./threads";

export interface SendTarget {
  thread?: string;
  project?: string;
  root?: string;
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

// codex exec would create a thread in the CLI, which has neither the desktop
// app's computer use nor the user's logged-in browser sessions. The desktop app
// registers the codex:// scheme, and threads/new opens a composer prefilled with
// the prompt. It deliberately does not auto-send: a human approves the message
// before a computer-use agent acts on it, and an unsent thread is not persisted,
// so the caller has to watch for the thread to appear.
export function desktopThreadUrl(workspace: string, message: string): string {
  const params = new URLSearchParams({ workspace, prompt: message });
  return `codex://threads/new?${params.toString()}`;
}

export interface OpenedThread {
  url: string;
  workspace: string;
  project: string;
  awaitingSend: true;
}

export async function openThreadInDesktop(
  store: ThreadStore,
  process: ProcessRunner,
  target: SendTarget,
  message: string,
): Promise<OpenedThread> {
  if (!target.project)
    throw new Error("--project is required to open a thread");
  const project = resolveProject(store.projects(), target.project);
  const root = target.root ?? project.roots[0];
  if (!root)
    throw new Error(`project ${project.name} has no root directory configured`);
  if (target.root && !project.roots.includes(target.root)) {
    throw new Error(
      `${target.root} is not a root of ${project.name}. roots: ${project.roots.join(", ")}`,
    );
  }
  const url = desktopThreadUrl(root, message);
  await process.run(["open", url]);
  return { url, workspace: root, project: project.name, awaitingSend: true };
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
