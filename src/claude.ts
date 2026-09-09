import { basename, resolve } from "node:path";
import {
  type BridgeManifest,
  parseManifest,
  parseSessionId,
  withHandoverContract,
} from "./contracts";
import { nativeProcessRunner, type ProcessRunner } from "./process";
import { forgetState, loadManifest, writeManifest } from "./state";

export interface AgentRecord {
  id?: string;
  sessionId: string;
  cwd: string;
  state?: string;
  name?: string;
}

export interface RepositoryState {
  root: string;
  commonDir: string;
  branch: string;
  clean: boolean;
}

export function parseAgentRecords(stdout: string): AgentRecord[] {
  const value = JSON.parse(stdout) as unknown;
  if (!Array.isArray(value))
    throw new Error("Claude agent inventory must be an array");
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    if (typeof record.sessionId !== "string" || typeof record.cwd !== "string")
      return [];
    return [
      {
        ...(typeof record.id === "string" ? { id: record.id } : {}),
        sessionId: record.sessionId,
        cwd: record.cwd,
        ...(typeof record.state === "string" ? { state: record.state } : {}),
        ...(typeof record.name === "string" ? { name: record.name } : {}),
      },
    ];
  });
}

function samePath(left: string, right: string): boolean {
  return resolve(left) === resolve(right);
}

async function inventory(process: ProcessRunner): Promise<AgentRecord[]> {
  return parseAgentRecords(
    (await process.run(["claude", "agents", "--json", "--all"])).stdout,
  );
}

async function requireRepositoryBinding(
  process: ProcessRunner,
  cwd: string,
  expectedCommonDir: string,
): Promise<void> {
  const common = (
    await process.run([
      "git",
      "-C",
      cwd,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ])
  ).stdout.trim();
  if (!samePath(common, expectedCommonDir)) {
    throw new Error("Claude session belongs to another repository");
  }
}

export async function startJob(input: {
  ownerThreadId: string;
  name?: string;
  prompt: string;
  repository: RepositoryState;
  process?: ProcessRunner;
  now?: () => string;
}): Promise<BridgeManifest> {
  const process = input.process ?? nativeProcessRunner;
  if (!input.repository.clean)
    throw new Error("start requires a clean working tree");
  if (!input.repository.branch)
    throw new Error("start refuses a detached repository");
  const worktreeName = `claude-codex-${crypto.randomUUID().slice(0, 8)}`;
  const launch = await process.run(
    [
      "claude",
      "--bg",
      "--worktree",
      worktreeName,
      ...(input.name ? ["--name", input.name] : []),
      withHandoverContract(input.prompt),
    ],
    { cwd: input.repository.root },
  );
  const shortId = launch.stdout.match(
    /backgrounded\s+·\s+([0-9a-f]{8})\b/i,
  )?.[1];
  if (!shortId)
    throw new Error("Claude did not report the background session id");
  const matches = (await inventory(process)).filter(
    (agent) => agent.id === shortId,
  );
  if (matches.length !== 1 || !matches[0]) {
    throw new Error("Claude background session could not be resolved uniquely");
  }
  await requireRepositoryBinding(
    process,
    matches[0].cwd,
    input.repository.commonDir,
  );
  const manifest = parseManifest({
    schemaVersion: 1,
    sessionId: parseSessionId(matches[0].sessionId),
    ownerThreadId: input.ownerThreadId,
    ...(input.name ? { name: input.name } : {}),
    gitCommonDir: input.repository.commonDir,
    createdAt: (input.now ?? (() => new Date().toISOString()))(),
  });
  await writeManifest(manifest);
  return manifest;
}

async function exactAgent(
  process: ProcessRunner,
  sessionId: string,
): Promise<AgentRecord> {
  const matches = (await inventory(process)).filter(
    (agent) => agent.sessionId === sessionId,
  );
  if (matches.length !== 1 || !matches[0]) {
    throw new Error(
      "Claude session must have exactly one full-session-id match",
    );
  }
  return matches[0];
}

export async function continueJob(input: {
  sessionId: string;
  prompt: string;
  gitCommonDir: string;
  process?: ProcessRunner;
}): Promise<void> {
  const process = input.process ?? nativeProcessRunner;
  const id = parseSessionId(input.sessionId);
  const manifest = await loadManifest(input.gitCommonDir, id);
  if (!manifest)
    throw new Error("bridge manifest was not found for this session");
  const agent = await exactAgent(process, id);
  if (!["done", "stopped"].includes(agent.state ?? "")) {
    throw new Error(
      "Claude session is live, blocked, failed, or in an unrecognized state",
    );
  }
  await requireRepositoryBinding(process, agent.cwd, manifest.gitCommonDir);
  await process.run(
    ["claude", "--resume", id, "--bg", withHandoverContract(input.prompt)],
    {
      cwd: agent.cwd,
    },
  );
}

export async function jobStatus(input: {
  sessionId: string;
  gitCommonDir: string;
  process?: ProcessRunner;
}): Promise<{ manifest: BridgeManifest; agents: AgentRecord[] }> {
  const id = parseSessionId(input.sessionId);
  const manifest = await loadManifest(input.gitCommonDir, id);
  if (!manifest)
    throw new Error("bridge manifest was not found for this session");
  const agents = (await inventory(input.process ?? nativeProcessRunner)).filter(
    (agent) => agent.sessionId === id,
  );
  return { manifest, agents };
}

export async function forgetJob(input: {
  sessionId: string;
  gitCommonDir: string;
  process?: ProcessRunner;
}): Promise<void> {
  const process = input.process ?? nativeProcessRunner;
  const id = parseSessionId(input.sessionId);
  const agent = await exactAgent(process, id);
  if (!["done", "stopped", "failed"].includes(agent.state ?? "")) {
    throw new Error("forget refuses a live, blocked, or unrecognized session");
  }
  await requireRepositoryBinding(process, agent.cwd, input.gitCommonDir);
  await forgetState(input.gitCommonDir, id);
}

export function repositoryRootFromCommonDir(gitCommonDir: string): string {
  return basename(gitCommonDir) === ".git"
    ? gitCommonDir.slice(0, -4)
    : gitCommonDir;
}
