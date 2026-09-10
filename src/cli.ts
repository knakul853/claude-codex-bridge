#!/usr/bin/env bun

import { watch as watchFile } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  continueJob,
  forgetJob,
  jobStatus,
  requestReview,
  startJob,
} from "./claude";
import { NativeCodexReviewClient } from "./codex";
import { runHook } from "./hook";
import {
  inboxLanePath,
  inboxRoot,
  parseInbox,
  readLane,
  watchInbox,
} from "./inbox";
import { closePeer, reapPeers, surveyPeers } from "./lifecycle";
import { notifyClaude } from "./notify";
import { listPeers } from "./peers";
import { nativeProcessRunner } from "./process";
import { readRepositoryState } from "./repository";
import { openThreadInDesktop, sendToThread, watchForReply } from "./send";
import { currentSessionId, listClaudeSessions } from "./sessions";
import {
  installBridgeHooks,
  readSettings,
  uninstallBridgeHooks,
  writeSettings,
} from "./settings";
import { ensurePrivateDirectory } from "./store";
import {
  readAssistantMessages,
  resolveProject,
  rolloutSize,
  SqliteThreadStore,
  scanAssistantMessages,
} from "./threads";

const USAGE = `claude-codex-bridge <command>

Codex desktop app (has computer use and your browser sessions):
  projects                                   list projects and their roots
  threads [--project N] [--limit N]          threads, newest first
  send --new --cwd PATH --message TEXT       open the app on that directory,
                                             prefill, press return, print the id
      [--project N]                          address by project instead of path
      [--no-send]                            stop before the keystroke
      [--composer-delay S] [--timeout S] [--poll S]
  send --thread UUID --message TEXT [--wait] queue into an existing thread
  send --cwd PATH --message TEXT [--wait]    queue into that directory's newest
  read --thread UUID [--last N]              assistant turns from the thread
  watch --thread UUID [--timeout S]          block on fs events until the next
                                             assistant turn; exit 3 on timeout

Messages from Codex to a Claude session:
  sessions [--cwd PATH]                      live Claude sessions, with ids
  notify --message TEXT [--to SESSION]       queue on that session's lane
      [--cwd PATH] [--from NAME]             address by directory instead of id
      [--push]                               also interrupt it over its socket
  inbox [--watch] [--to SESSION]             read this session's lane, or block
      [--since N] [--timeout S]              for the next message on it

Claude workers, owned by a Codex thread:
  start --owner-thread UUID [--cwd PATH]     run a Claude worker on that repo
      [--here]                               share the repo instead of cutting
                                             a worktree; allows a dirty tree
      [--permission-mode M] [--max-live N]
      [--name N] [--prompt-file F]
  review --session ID [--cwd PATH]           send a session to Codex for review
  continue|status|forget --session ID [--cwd PATH]

Collaborations and cleanup:
  peers                                      recorded Claude/Codex pairings
  close --peer REF [--force]                 stop a session and forget the pair
      [--archive-thread] [--remove-worktree]
  reap [--apply] [--kill-stuck]              sweep finished or wedged workers;
                                             reports only, unless --apply

Setup:
  doctor | install-hooks | uninstall-hooks

Notes: a thread does not exist until its first message is sent, so --new carries it.
The deep link cannot auto-submit, which is why return is pressed for you.
Every session verb resolves its repository from --cwd, so it can be run from
anywhere; without it the current directory is used.`;

class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
  }
}

function option(name: string): string | undefined {
  const index = Bun.argv.indexOf(name);
  return index >= 0 ? Bun.argv[index + 1] : undefined;
}

function flag(name: string): boolean {
  return Bun.argv.includes(name);
}

function required(name: string): string {
  const value = option(name);
  if (!value) throw new CliError(`${name} is required`, 2);
  return value;
}

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function prompt(): Promise<string> {
  const path = option("--prompt-file");
  if (path) return readFile(resolve(path), "utf8");
  if (process.stdin.isTTY)
    throw new CliError("pipe a prompt on stdin or use --prompt-file", 2);
  return Bun.stdin.text();
}

async function doctor(): Promise<Record<string, string>> {
  const checks: Record<string, string> = {};
  for (const [name, argv] of [
    ["bun", ["bun", "--version"]],
    ["git", ["git", "--version"]],
    ["claude", ["claude", "--version"]],
    ["codex", ["codex", "queue", "--help"]],
    ["codex-exec", ["codex", "exec", "--help"]],
  ] as const) {
    try {
      const result = await nativeProcessRunner.run([...argv]);
      checks[name] = result.stdout.trim().split("\n")[0] || "available";
    } catch (error) {
      checks[name] =
        `unavailable: ${error instanceof Error ? error.message : "unknown"}`;
    }
  }
  return checks;
}

async function settingsPath(): Promise<string> {
  const root = await nativeProcessRunner.run([
    "git",
    "rev-parse",
    "--show-toplevel",
  ]);
  return join(resolve(root.stdout.trim()), ".claude", "settings.json");
}

// A Claude session invoking the bridge inherits its own id, so reading "my lane"
// needs no argument.
function laneFor(explicit?: string): string {
  const to = explicit ?? currentSessionId();
  return inboxLanePath(to, undefined);
}

async function main(): Promise<void> {
  const command = Bun.argv[2];
  if (
    !command ||
    command === "help" ||
    command === "--help" ||
    command === "-h"
  ) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (command === "doctor") {
    emit({ ok: true, sessionId: currentSessionId(), commands: await doctor() });
    return;
  }
  if (command === "hook") {
    const result = await runHook(JSON.parse(await Bun.stdin.text()) as unknown);
    if (result.kind === "block") {
      process.stdout.write(
        `${JSON.stringify({ decision: "block", reason: result.reason })}\n`,
      );
    } else if (result.warning) {
      process.stderr.write(`${result.warning}\n`);
    }
    return;
  }
  if (command === "install-hooks" || command === "uninstall-hooks") {
    const path = await settingsPath();
    const current = await readSettings(path);
    const updated =
      command === "install-hooks"
        ? installBridgeHooks(current)
        : uninstallBridgeHooks(current);
    await writeSettings(path, updated);
    emit({ ok: true, settings: path });
    return;
  }
  if (command === "sessions") {
    const cwd = option("--cwd");
    const wanted = cwd ? resolve(cwd) : undefined;
    const sessions = (await listClaudeSessions()).filter(
      (session) => !wanted || resolve(session.cwd) === wanted,
    );
    emit({ self: currentSessionId(), sessions });
    return;
  }
  if (command === "notify") {
    const to = option("--to");
    const cwd = option("--cwd");
    const result = await notifyClaude({
      ...(to ? { to } : {}),
      ...(cwd ? { cwd } : {}),
      from: option("--from") ?? "codex",
      message: option("--message") ?? (await prompt()),
      push: flag("--push"),
    });
    emit({ ok: true, ...result });
    return;
  }
  if (command === "inbox") {
    const lane = laneFor(option("--to"));
    // fs.watch needs the containing directory to exist before the lane does.
    await ensurePrivateDirectory(inboxRoot());
    if (!flag("--watch")) {
      const { text, size } = await readLane(
        lane,
        Number(option("--since") ?? 0),
      );
      emit({ lane, messages: parseInbox(text), offset: size });
      return;
    }
    const result = await watchInbox(
      lane,
      Number(option("--since") ?? 0),
      Number(option("--timeout") ?? 1800) * 1_000,
      {
        watch: (directory, onChange) => {
          const watcher = watchFile(directory, (_event, file) =>
            onChange(typeof file === "string" ? file : null),
          );
          return { close: () => watcher.close() };
        },
        read: readLane,
        timer: (ms, fire) => {
          const handle = setTimeout(fire, ms);
          return { cancel: () => clearTimeout(handle) };
        },
      },
    );
    emit({ lane, ...result });
    if (result.timedOut) process.exitCode = 3;
    return;
  }
  if (command === "peers") {
    // The survey needs the Claude CLI to classify liveness; without it the bare
    // records are still worth printing.
    try {
      const survey = await surveyPeers();
      emit({ peers: survey });
    } catch (error) {
      process.stderr.write(
        `liveness unavailable: ${error instanceof Error ? error.message : "unknown"}\n`,
      );
      emit({ peers: await listPeers() });
    }
    return;
  }
  if (command === "close") {
    const result = await closePeer({
      reference: required("--peer"),
      force: flag("--force"),
      archiveThread: flag("--archive-thread"),
      removeWorktree: flag("--remove-worktree"),
    });
    emit({ ok: true, ...result });
    return;
  }
  if (command === "reap") {
    emit(
      await reapPeers({
        apply: flag("--apply"),
        killStuck: flag("--kill-stuck"),
      }),
    );
    return;
  }
  if (command === "projects") {
    emit({ projects: SqliteThreadStore.open().projects() });
    return;
  }
  if (command === "threads") {
    const store = SqliteThreadStore.open();
    const name = option("--project");
    const cwd = option("--cwd");
    const roots = cwd
      ? [resolve(cwd)]
      : name
        ? resolveProject(store.projects(), name).roots
        : undefined;
    const limit = Number(option("--limit") ?? 20);
    emit({ threads: store.threads({ ...(roots ? { roots } : {}), limit }) });
    return;
  }
  if (command === "read") {
    const store = SqliteThreadStore.open();
    const id = required("--thread");
    const match = store.threads({ limit: 1_000 }).find((t) => t.id === id);
    if (!match) throw new CliError(`no codex thread ${id}`, 2);
    const last = Number(option("--last") ?? 1);
    const messages = match.rolloutPath
      ? await readAssistantMessages(match.rolloutPath)
      : [];
    emit({
      threadId: match.id,
      label: match.label,
      total: messages.length,
      messages: messages.slice(-last).map((m) => m.text),
    });
    return;
  }
  if (command === "watch") {
    const store = SqliteThreadStore.open();
    const id = required("--thread");
    const match = store.threads({ limit: 1_000 }).find((t) => t.id === id);
    if (!match) throw new CliError(`no codex thread ${id}`, 2);
    const fromOffset =
      option("--since") !== undefined
        ? Number(option("--since"))
        : match.rolloutPath
          ? rolloutSize(match.rolloutPath)
          : 0;
    const result = await watchForReply(
      match,
      {
        watch: (path, onChange) => watchFile(path, () => onChange()),
        scan: scanAssistantMessages,
        timer: (ms, fire) => {
          const handle = setTimeout(fire, ms);
          return { cancel: () => clearTimeout(handle) };
        },
      },
      Number(option("--timeout") ?? 1800) * 1_000,
      fromOffset,
    );
    emit(result);
    if (result.timedOut) process.exitCode = 3;
    return;
  }
  if (command === "send") {
    const message = option("--message") ?? (await prompt());
    const thread = option("--thread");
    const project = option("--project");
    const cwd = option("--cwd");
    const root = option("--root");
    const target = {
      ...(thread ? { thread } : {}),
      ...(project ? { project } : {}),
      ...(cwd ? { cwd } : {}),
      ...(root ? { root } : {}),
    };
    if (flag("--new")) {
      emit(
        await openThreadInDesktop(
          SqliteThreadStore.open(),
          nativeProcessRunner,
          target,
          message,
          flag("--no-send")
            ? undefined
            : {
                composerMs: Number(option("--composer-delay") ?? 3) * 1_000,
                timeoutMs: Number(option("--timeout") ?? 60) * 1_000,
                pollMs: Number(option("--poll") ?? 3) * 1_000,
              },
        ),
      );
      return;
    }
    emit(
      await sendToThread(
        SqliteThreadStore.open(),
        new NativeCodexReviewClient(),
        target,
        message,
        flag("--wait")
          ? {
              timeoutMs: Number(option("--timeout") ?? 900) * 1_000,
              pollMs: Number(option("--poll") ?? 5) * 1_000,
            }
          : undefined,
      ),
    );
    return;
  }
  const repo = await readRepositoryState(option("--cwd") ?? process.cwd());
  if (command === "start") {
    const name = option("--name");
    const permissionMode = option("--permission-mode");
    const maxLive = option("--max-live");
    emit(
      await startJob({
        ownerThreadId: required("--owner-thread"),
        ...(name ? { name } : {}),
        prompt: await prompt(),
        repository: repo,
        here: flag("--here"),
        ...(permissionMode ? { permissionMode } : {}),
        ...(maxLive ? { liveWorkerLimit: Number(maxLive) } : {}),
      }),
    );
    return;
  }
  const sessionId = required("--session");
  if (command === "review") {
    const ownerThreadId = option("--owner-thread");
    emit(
      await requestReview({
        sessionId,
        instructions: await prompt(),
        repository: repo,
        ...(ownerThreadId ? { ownerThreadId } : {}),
        newCodexTask: flag("--new-codex-task"),
      }),
    );
    return;
  }
  if (command === "continue") {
    await continueJob({
      sessionId,
      prompt: await prompt(),
      gitCommonDir: repo.commonDir,
    });
    emit({ ok: true, sessionId });
    return;
  }
  if (command === "status") {
    emit(await jobStatus({ sessionId, gitCommonDir: repo.commonDir }));
    return;
  }
  if (command === "forget") {
    await forgetJob({ sessionId, gitCommonDir: repo.commonDir });
    emit({ ok: true, sessionId });
    return;
  }
  throw new CliError(USAGE, 2);
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "bridge failed"}\n`,
    );
    process.exitCode = error instanceof CliError ? error.exitCode : 4;
  });
}
