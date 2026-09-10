import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
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
  cwd?: string;
}

/**
 * A directory is the exact address: Codex's project table is a UI grouping that
 * omits some working directories entirely and lets two projects share a root, so
 * a path resolves a destination that a project name cannot.
 */
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
  const scope = target.cwd
    ? { label: target.cwd, roots: [resolvePath(target.cwd)] }
    : target.project
      ? (() => {
          const project = resolveProject(
            store.projects(),
            target.project ?? "",
          );
          return { label: `project ${project.name}`, roots: project.roots };
        })()
      : undefined;
  if (!scope)
    throw new Error(
      "pass --thread, --cwd, or --project to choose a destination",
    );
  const newest = store.threads({ roots: scope.roots, limit: 1 })[0];
  if (!newest)
    throw new Error(
      `${scope.label} has no thread yet. open one with --new, or send any message in Codex so it is persisted, then retry`,
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

const DESKTOP_APPS = ["/Applications/ChatGPT.app", "/Applications/Codex.app"];

/**
 * The bundle that should receive the deep link.
 *
 * Deleted copies in the Trash and unmounted installer images stay registered as
 * codex: handlers in LaunchServices, so a bare `open` can hand the URL to a
 * bundle that cannot service it and the app never comes forward. Naming the
 * application removes the ambiguity.
 */
export function desktopAppPath(): string | undefined {
  const override = process.env.CODEX_DESKTOP_APP;
  if (override) return override;
  return DESKTOP_APPS.find((candidate) => existsSync(candidate));
}

export function openUrlArgv(url: string, app: string | undefined): string[] {
  return app ? ["open", "-a", app, url] : ["open", url];
}

export interface OpenedThread {
  url: string;
  /** Root asked for. The app picks the real cwd itself; see actualCwd. */
  requestedWorkspace: string;
  project: string;
  /** Whether Codex has a project whose root is the requested directory. */
  registered: boolean;
  awaitingSend: boolean;
  threadId?: string;
  /** Where the thread actually landed, once it exists. */
  actualCwd?: string;
  /** Set when the thread will not, or did not, open where it was asked to. */
  warning?: string;
}

/**
 * The app does not honour the deep link's workspace at all: a new thread opens in
 * whichever workspace the app currently holds, whether or not the requested
 * directory is a registered project root. Measured against a registered root that
 * was still ignored, so `--new` cannot choose a directory and the caller is warned
 * both before and after. To land in a specific repository, queue into a thread
 * that is already there with --cwd.
 */
export function workspaceWarning(input: {
  requestedWorkspace: string;
  registered: boolean;
  actualCwd?: string;
}): string | undefined {
  const advice =
    "queue into an existing thread with --cwd instead of --new to choose the directory";
  if (input.actualCwd) {
    return resolvePath(input.actualCwd) ===
      resolvePath(input.requestedWorkspace)
      ? undefined
      : `codex opened ${input.actualCwd}, not ${input.requestedWorkspace}. ${advice}`;
  }
  return `codex ignores the requested workspace and opens whichever it currently holds${
    input.registered
      ? ""
      : `, and ${input.requestedWorkspace} is not a project root either`
  }. Check actualCwd on the result, or ${advice}`;
}

export interface AutoSendOptions {
  composerMs: number;
  timeoutMs: number;
  pollMs: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Process name System Events knows an application bundle by. */
export function appProcessName(appPath: string): string {
  return (appPath.split("/").pop() ?? appPath).replace(/\.app$/, "");
}

/**
 * Submits the composer by pressing return in the Codex process specifically.
 *
 * A bare `keystroke return` goes to whatever happens to be frontmost, so a window
 * that stole focus in the meantime receives it instead. This activates the app,
 * refuses to type if something else is still in front, and addresses the
 * keystroke to the process rather than the screen.
 */
export function autoSendScript(appName: string): string {
  return [
    `tell application "${appName}" to activate`,
    "delay 0.4",
    'tell application "System Events"',
    "  set frontApp to name of first application process whose frontmost is true",
    `  if frontApp is not "${appName}" then error "focus moved to " & frontApp & "; nothing was typed"`,
    `  tell process "${appName}" to keystroke return`,
    "end tell",
  ].join("\n");
}

// No query parameter submits the composer, so return has to be pressed, and the
// thread does not exist until it is — hence discovering the id by watching.
export async function autoSendAndResolve(
  store: ThreadStore,
  process: ProcessRunner,
  before: Set<string>,
  options: AutoSendOptions,
  appName?: string,
): Promise<CodexThread | undefined> {
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const now = options.now ?? (() => Date.now());
  await sleep(options.composerMs);
  await process.run([
    "osascript",
    "-e",
    appName
      ? autoSendScript(appName)
      : 'tell application "System Events" to keystroke return',
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

/**
 * The deep link takes a workspace path, so a directory is enough to open a
 * thread. Resolving by project is kept as a convenience, but a working directory
 * Codex has no project row for is still addressable.
 */
export function resolveWorkspace(
  store: ThreadStore,
  target: SendTarget,
): { root: string; project: string; registered: boolean } {
  if (target.cwd) {
    const root = resolvePath(target.cwd);
    const owning = store
      .projects()
      .find((candidate) =>
        candidate.roots.some((r) => resolvePath(r) === root),
      );
    return {
      root,
      project: owning?.name ?? "(no codex project)",
      registered: owning !== undefined,
    };
  }
  if (!target.project)
    throw new Error("--cwd or --project is required to open a thread");
  const project = resolveProject(store.projects(), target.project);
  const root = target.root ?? project.roots[0];
  if (!root)
    throw new Error(`project ${project.name} has no root directory configured`);
  if (target.root && !project.roots.includes(target.root)) {
    throw new Error(
      `${target.root} is not a root of ${project.name}. roots: ${project.roots.join(", ")}`,
    );
  }
  return { root, project: project.name, registered: true };
}

export async function openThreadInDesktop(
  store: ThreadStore,
  process: ProcessRunner,
  target: SendTarget,
  message: string,
  autoSend?: AutoSendOptions,
): Promise<OpenedThread> {
  const {
    root,
    project: projectName,
    registered,
  } = resolveWorkspace(store, target);
  const url = desktopThreadUrl(root, message);
  const before = new Set(
    store.threads({ limit: 400 }).map((thread) => thread.id),
  );
  await process.run(openUrlArgv(url, desktopAppPath()));
  if (!autoSend) {
    const warning = workspaceWarning({ requestedWorkspace: root, registered });
    return {
      url,
      requestedWorkspace: root,
      project: projectName,
      registered,
      awaitingSend: true,
      ...(warning ? { warning } : {}),
    };
  }
  const app = desktopAppPath();
  const created = await autoSendAndResolve(
    store,
    process,
    before,
    autoSend,
    app ? appProcessName(app) : undefined,
  );
  const warning = workspaceWarning({
    requestedWorkspace: root,
    registered,
    ...(created ? { actualCwd: created.cwd } : {}),
  });
  return {
    url,
    requestedWorkspace: root,
    project: projectName,
    registered,
    awaitingSend: created === undefined,
    ...(created ? { threadId: created.id, actualCwd: created.cwd } : {}),
    ...(warning ? { warning } : {}),
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
