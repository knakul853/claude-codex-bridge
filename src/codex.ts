import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeProcessRunner, type ProcessRunner } from "./process";
import { redactText, truncateText } from "./safety";

const THREAD_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CreatedCodexTask {
  threadId: string;
  response: string;
}

export interface CodexReviewClient {
  createTask(cwd: string, message: string): Promise<CreatedCodexTask>;
  queue(threadId: string, message: string): Promise<void>;
}

export function codexThreadIdFromJsonl(output: string): string | undefined {
  for (const line of output.split("\n")) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (
        event.type === "thread.started" &&
        typeof event.thread_id === "string" &&
        THREAD_ID_PATTERN.test(event.thread_id)
      ) {
        return event.thread_id;
      }
    } catch {
      // Codex may write a non-JSON startup warning before its JSONL event stream.
    }
  }
  return undefined;
}

async function runCodexTask(
  cwd: string,
  message: string,
): Promise<CreatedCodexTask> {
  const temporary = await mkdtemp(join(tmpdir(), "claude-codex-bridge-"));
  const responsePath = join(temporary, "response.txt");
  try {
    const child = Bun.spawn(
      [
        "codex",
        "exec",
        "--json",
        "--output-last-message",
        responsePath,
        "-C",
        cwd,
        "-",
      ],
      {
        cwd,
        stdin: new Blob([message]),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(
        `codex exec exited ${exitCode}: ${truncateText(redactText(stderr.trim()), 1_000)}`,
      );
    }
    const threadId = codexThreadIdFromJsonl(stdout);
    if (!threadId)
      throw new Error("codex exec returned no thread.started event");
    return {
      threadId,
      response: truncateText(await readFile(responsePath, "utf8"), 16_000),
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export class NativeCodexReviewClient implements CodexReviewClient {
  constructor(private readonly process: ProcessRunner = nativeProcessRunner) {}

  createTask(cwd: string, message: string): Promise<CreatedCodexTask> {
    return runCodexTask(cwd, message);
  }

  async queue(threadId: string, message: string): Promise<void> {
    await this.process.run([
      "codex",
      "queue",
      "--thread",
      threadId,
      "--message",
      message,
    ]);
  }
}
