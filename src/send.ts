import type { CodexReviewClient } from "./codex";
import type { ProcessRunner } from "./process";
import {
  type CodexThread,
  type MessageScan,
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
  /** Root asked for. The app picks the real cwd itself; see actualCwd. */
  requestedWorkspace: string;
  project: string;
  awaitingSend: boolean;
  threadId?: string;
  /** Where the thread actually landed, once it exists. */
  actualCwd?: string;
}

export interface AutoSendOptions {
  composerMs: number;
  timeoutMs: number;
  pollMs: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

// No query parameter submits the composer, so return has to be pressed, and the
// thread does not exist until it is — hence discovering the id by watching.
export async function autoSendAndResolve(
  store: ThreadStore,
  process: ProcessRunner,
  before: Set<string>,
  options: AutoSendOptions,
): Promise<CodexThread | undefined> {
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const now = options.now ?? (() => Date.now());
  await sleep(options.composerMs);
  await process.run([
    "osascript",
    "-e",
    'tell application "System Events" to keystroke return',
  ]);
  const deadline = now() + options.timeoutMs;
  while (now() < deadline) {
    await sleep(options.pollMs);
    const fresh = store
      .threads({ limit: 400 })
      .find((thread) => !before.has(thread.id));
    if (fresh) return fresh;
  }
  return undefined;
}

export async function openThreadInDesktop(
  store: ThreadStore,
  process: ProcessRunner,
  target: SendTarget,
  message: string,
  autoSend?: AutoSendOptions,
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
  const before = new Set(
    store.threads({ limit: 400 }).map((thread) => thread.id),
  );
  await process.run(["open", url]);
  if (!autoSend) {
    return {
      url,
      requestedWorkspace: root,
      project: project.name,
      awaitingSend: true,
    };
  }
  const created = await autoSendAndResolve(store, process, before, autoSend);
  return {
    url,
    requestedWorkspace: root,
    project: project.name,
    awaitingSend: created === undefined,
    ...(created ? { threadId: created.id, actualCwd: created.cwd } : {}),
  };
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

export interface WatchDeps {
  watch: (path: string, onChange: () => void) => { close: () => void };
  scan: (path: string, fromOffset: number) => Promise<MessageScan>;
  timer: (ms: number, fire: () => void) => { cancel: () => void };
}

export interface WatchResult {
  threadId: string;
  reply?: string;
  timedOut: boolean;
}

// Resumes from a byte offset rather than comparing message counts: the rollout is
// append-only and read through a window, so a count can stay level while Codex is
// answering and a count-based wait never returns.
export function watchForReply(
  thread: CodexThread,
  deps: WatchDeps,
  timeoutMs: number,
  fromOffset: number,
): Promise<WatchResult> {
  return new Promise<WatchResult>((resolve, reject) => {
    if (!thread.rolloutPath) {
      resolve({ threadId: thread.id, timedOut: true });
      return;
    }
    const path = thread.rolloutPath;
    let offset = fromOffset;
    let settled = false;
    let checking = false;
    let changedWhileChecking = false;
    const finish = (result: WatchResult) => {
      if (settled) return;
      settled = true;
      watcher.close();
      timer.cancel();
      resolve(result);
    };
    const check = () => {
      if (settled) return;
      // A change arriving mid-scan must not be dropped: the watcher may never
      // fire again if Codex has finished writing.
      if (checking) {
        changedWhileChecking = true;
        return;
      }
      checking = true;
      deps
        .scan(path, offset)
        .then((scan) => {
          checking = false;
          offset = scan.endOffset;
          const latest = scan.messages[scan.messages.length - 1];
          if (latest) {
            finish({
              threadId: thread.id,
              reply: latest.text,
              timedOut: false,
            });
            return;
          }
          if (changedWhileChecking) {
            changedWhileChecking = false;
            check();
          }
        })
        .catch((error: unknown) => {
          checking = false;
          if (settled) return;
          settled = true;
          watcher.close();
          timer.cancel();
          reject(error);
        });
    };
    const watcher = deps.watch(path, check);
    const timer = deps.timer(timeoutMs, () =>
      finish({ threadId: thread.id, timedOut: true }),
    );
    check();
  });
}
