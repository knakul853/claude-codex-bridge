import { existsSync, readFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import type { CodexReviewClient } from "./codex";
import type { ProcessRunner } from "./process";
import {
  type CodexThread,
  defaultCodexHome,
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

/**
 * How a message reaches a thread that may be mid-turn.
 *
 * `queue` hands it to `codex queue`, which writes the shared queue store; the
 * desktop app drains that queue only when the running turn ends, and its payload
 * carries no field that could ask for more. `steer` puts the message in front of
 * the running turn instead, the way a person does: it opens the thread in the
 * desktop app with the message in the composer and submits it there, and the app
 * calls `turn/steer` while a turn is in progress (`turn/start` when idle).
 */
export type Delivery = "queue" | "steer";

/** Default delivery for callers that pass neither `--steer` nor `--queue`. */
export const DELIVERY_ENV = "CLAUDE_CODEX_BRIDGE_DELIVERY";

const DELIVERIES: readonly Delivery[] = ["queue", "steer"];

export function resolveDelivery(input: {
  steer: boolean;
  queue: boolean;
  env?: string | undefined;
}): Delivery {
  if (input.steer && input.queue) {
    throw new Error("pass --steer or --queue, not both");
  }
  if (input.steer) return "steer";
  if (input.queue) return "queue";
  const configured = input.env?.trim();
  if (!configured) return "queue";
  if ((DELIVERIES as readonly string[]).includes(configured)) {
    return configured as Delivery;
  }
  throw new Error(
    `${DELIVERY_ENV} must be one of ${DELIVERIES.join(", ")}, not "${configured}"`,
  );
}

export interface SendResult {
  threadId: string;
  label: string;
  delivery: Delivery;
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

/** Opens a thread that already exists, with the message waiting in its composer. */
export function existingThreadUrl(threadId: string, message: string): string {
  const params = new URLSearchParams({ prompt: message });
  return `codex://threads/${encodeURIComponent(threadId)}?${params.toString()}`;
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
export function autoSendScript(
  appName: string,
  keystroke = "keystroke return",
): string {
  return [
    `tell application "${appName}" to activate`,
    "delay 0.4",
    'tell application "System Events"',
    "  set frontApp to name of first application process whose frontmost is true",
    `  if frontApp is not "${appName}" then error "focus moved to " & frontApp & "; nothing was typed"`,
    `  tell process "${appName}" to ${keystroke}`,
    "end tell",
  ].join("\n");
}

export interface ComposerSettings {
  followUpQueueMode: "queue" | "steer";
  composerEnterBehavior: "enter" | "cmdIfMultiline" | "cmdAlways";
}

/**
 * The desktop's own `[desktop]` settings decide what a submit during a turn
 * does, so they are read rather than assumed. Unknown or missing values fall
 * back to the desktop's defaults.
 */
export function readComposerSettings(
  configPath = join(defaultCodexHome(), "config.toml"),
): ComposerSettings {
  let desktop: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    const parsed = Bun.TOML.parse(readFileSync(configPath, "utf8")) as {
      desktop?: Record<string, unknown>;
    };
    desktop = parsed.desktop ?? {};
  }
  const enter = desktop.composerEnterBehavior;
  return {
    followUpQueueMode:
      desktop.followUpQueueMode === "queue" ? "queue" : "steer",
    composerEnterBehavior:
      enter === "cmdIfMultiline" || enter === "cmdAlways" ? enter : "enter",
  };
}

/**
 * The key that steers a running turn. With follow-ups set to queue, plain
 * submit would queue, so this presses the desktop's one-message invert
 * shortcut: Cmd+Enter, or Cmd+Shift+Enter when Enter alone inserts a newline.
 */
export function steerKeystroke(settings: ComposerSettings): string {
  const enterSubmits = settings.composerEnterBehavior === "enter";
  if (settings.followUpQueueMode === "steer") {
    return enterSubmits
      ? "keystroke return"
      : "keystroke return using command down";
  }
  return enterSubmits
    ? "keystroke return using command down"
    : "keystroke return using {command down, shift down}";
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

export async function sendToThread(
  store: ThreadStore,
  client: CodexReviewClient,
  target: SendTarget,
  message: string,
  wait?: WaitOptions,
): Promise<SendResult> {
  const thread = resolveThread(store, target);
  const before = await assistantCount(thread);
  await client.queue(thread.id, message);
  return awaitReply(thread, "queue", before, wait);
}

export interface SteerOptions {
  composerMs: number;
  sleep?: (ms: number) => Promise<void>;
  /** Bundle to open; `null` means none is installed. Discovered when omitted. */
  app?: string | null;
  /** Read from the Codex config when omitted. */
  composer?: ComposerSettings;
}

/**
 * Delivers a message into the thread's running turn instead of behind it.
 *
 * The turn lives in the desktop app's own app-server, which speaks only to its
 * Electron parent, so nothing outside the app can call `turn/steer` on it. The
 * app itself does, whenever its composer is submitted during a turn — so this
 * opens the thread with the message prefilled and submits it with the
 * focus-checked keystroke that steers under the desktop's follow-up setting. A keystroke refused because another
 * window held focus leaves the message in the composer, unsent, and says so.
 */
export async function steerThread(
  store: ThreadStore,
  process: ProcessRunner,
  target: SendTarget,
  message: string,
  submit: SteerOptions,
  wait?: WaitOptions,
): Promise<SendResult> {
  const thread = resolveThread(store, target);
  const app = submit.app === undefined ? desktopAppPath() : submit.app;
  if (!app) {
    throw new Error(
      "steering needs the Codex desktop app, which owns the running turn; set CODEX_DESKTOP_APP or use --queue",
    );
  }
  const before = await assistantCount(thread);
  await process.run(openUrlArgv(existingThreadUrl(thread.id, message), app));
  const sleep =
    submit.sleep ??
    ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  await sleep(submit.composerMs);
  try {
    const keystroke = steerKeystroke(submit.composer ?? readComposerSettings());
    await process.run([
      "osascript",
      "-e",
      autoSendScript(appProcessName(app), keystroke),
    ]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `the message was left in the composer of thread ${thread.id}, not sent: ${detail}`,
    );
  }
  return awaitReply(thread, "steer", before, wait);
}

async function assistantCount(thread: CodexThread): Promise<number> {
  return thread.rolloutPath
    ? (await readAssistantMessages(thread.rolloutPath)).length
    : 0;
}

// Either delivery returns as soon as the message is handed over, so a reply is
// only observable by watching the thread's rollout grow.
async function awaitReply(
  thread: CodexThread,
  delivery: Delivery,
  before: number,
  wait?: WaitOptions,
): Promise<SendResult> {
  const settled = { threadId: thread.id, label: thread.label, delivery };
  if (!wait || !thread.rolloutPath) return { ...settled, timedOut: false };
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
        ...settled,
        reply: messages[messages.length - 1]?.text,
        timedOut: false,
      };
    }
  }
  return { ...settled, timedOut: true };
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
