#!/usr/bin/env bun

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
import { nativeProcessRunner } from "./process";
import { readRepositoryState } from "./repository";
import { openThreadInDesktop, sendToThread } from "./send";
import {
  installBridgeHooks,
  readSettings,
  uninstallBridgeHooks,
  writeSettings,
} from "./settings";
import {
  readAssistantMessages,
  resolveProject,
  SqliteThreadStore,
} from "./threads";

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

function required(name: string): string {
  const value = option(name);
  if (!value) throw new CliError(`${name} is required`, 2);
  return value;
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
    const result = await nativeProcessRunner.run([...argv]);
    checks[name] = result.stdout.trim().split("\n")[0] || "available";
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

async function main(): Promise<void> {
  const command = Bun.argv[2];
  if (command === "doctor") {
    process.stdout.write(
      `${JSON.stringify({ ok: true, commands: await doctor() }, null, 2)}\n`,
    );
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
    process.stdout.write(`${JSON.stringify({ ok: true, settings: path })}\n`);
    return;
  }
  if (command === "projects") {
    const projects = SqliteThreadStore.open().projects();
    process.stdout.write(`${JSON.stringify({ projects }, null, 2)}\n`);
    return;
  }
  if (command === "threads") {
    const store = SqliteThreadStore.open();
    const name = option("--project");
    const roots = name
      ? resolveProject(store.projects(), name).roots
      : undefined;
    const limit = Number(option("--limit") ?? 20);
    const threads = store.threads({ ...(roots ? { roots } : {}), limit });
    process.stdout.write(`${JSON.stringify({ threads }, null, 2)}\n`);
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
    process.stdout.write(
      `${JSON.stringify(
        {
          threadId: match.id,
          label: match.label,
          total: messages.length,
          messages: messages.slice(-last).map((m) => m.text),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  if (command === "send") {
    const message = option("--message") ?? (await prompt());
    const thread = option("--thread");
    const project = option("--project");
    const shouldWait = Bun.argv.includes("--wait");
    const root = option("--root");
    if (Bun.argv.includes("--new")) {
      const opened = await openThreadInDesktop(
        SqliteThreadStore.open(),
        nativeProcessRunner,
        {
          ...(project ? { project } : {}),
          ...(root ? { root } : {}),
        },
        message,
      );
      process.stdout.write(`${JSON.stringify(opened, null, 2)}\n`);
      return;
    }
    const result = await sendToThread(
      SqliteThreadStore.open(),
      new NativeCodexReviewClient(),
      { ...(thread ? { thread } : {}), ...(project ? { project } : {}) },
      message,
      shouldWait
        ? {
            timeoutMs: Number(option("--timeout") ?? 900) * 1_000,
            pollMs: Number(option("--poll") ?? 5) * 1_000,
          }
        : undefined,
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const repo = await readRepositoryState();
  if (command === "start") {
    const name = option("--name");
    const manifest = await startJob({
      ownerThreadId: required("--owner-thread"),
      ...(name ? { name } : {}),
      prompt: await prompt(),
      repository: repo,
    });
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    return;
  }
  const sessionId = required("--session");
  if (command === "review") {
    const ownerThreadId = option("--owner-thread");
    const result = await requestReview({
      sessionId,
      instructions: await prompt(),
      repository: repo,
      ...(ownerThreadId ? { ownerThreadId } : {}),
      newCodexTask: Bun.argv.includes("--new-codex-task"),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command === "continue") {
    await continueJob({
      sessionId,
      prompt: await prompt(),
      gitCommonDir: repo.commonDir,
    });
    process.stdout.write(`${JSON.stringify({ ok: true, sessionId })}\n`);
    return;
  }
  if (command === "status") {
    process.stdout.write(
      `${JSON.stringify(await jobStatus({ sessionId, gitCommonDir: repo.commonDir }), null, 2)}\n`,
    );
    return;
  }
  if (command === "forget") {
    await forgetJob({ sessionId, gitCommonDir: repo.commonDir });
    process.stdout.write(`${JSON.stringify({ ok: true, sessionId })}\n`);
    return;
  }
  throw new CliError(
    "usage: claude-codex-bridge <doctor|projects|threads|send|read|install-hooks|uninstall-hooks|start|review|continue|status|forget>",
    2,
  );
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "bridge failed"}\n`,
    );
    process.exitCode = error instanceof CliError ? error.exitCode : 4;
  });
}
