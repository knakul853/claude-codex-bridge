import { resolve } from "node:path";
import {
  checkHealth,
  type DiscoveredSession,
  discoverSessions,
  locateBinary,
  sendThroughAdapter,
} from "./adapter";
import {
  type Address,
  BROADCAST,
  formatAddress,
  laneFor,
  parseAddress,
} from "./addresses";
import { type CodexReviewClient, NativeCodexReviewClient } from "./codex";
import type { Env } from "./env";
import { BridgeError, errorMessage } from "./errors";
import {
  appendInbox,
  inboxLanePath,
  isMessageKind,
  type MessageKind,
} from "./inbox";
import { labelPeerMessage } from "./label";
import {
  type HarnessManifest,
  type LoadedManifest,
  loadManifests,
  manifestDirectory,
} from "./manifest";
import { notifyClaude } from "./notify";
import type { ProcessRunner } from "./process";
import { redactText, truncateText } from "./safety";
import { sendToThread } from "./send";
import { currentSessionId, listClaudeSessions } from "./sessions";
import { SqliteThreadStore, type ThreadStore } from "./threads";

const MESSAGE_LIMIT_BYTES = 8_000;
const CODEX_SESSION_LIMIT = 50;
export const BUILTIN_HARNESSES = ["codex", "claude"] as const;

export interface DispatchDeps {
  env?: Env;
  home?: string;
  manifestDir?: string;
  /** Where lanes are written; the bridge home when omitted. */
  laneHome?: string;
  runner?: ProcessRunner;
  now?: () => string;
  newId?: () => string;
  threads?: () => ThreadStore;
  codex?: CodexReviewClient;
  sessionsRoot?: string;
}

export interface HarnessSummary {
  name: string;
  source: "builtin" | "manifest";
  status: "ok" | "invalid";
  runs_turn: boolean;
  path?: string;
  binary?: string | null;
  error?: string;
}

function manifestDir(deps: DispatchDeps): string {
  return deps.manifestDir ?? manifestDirectory(deps.env, deps.home);
}

function binaryLookup(deps: DispatchDeps) {
  return {
    ...(deps.env ? { env: deps.env } : {}),
    ...(deps.home ? { home: deps.home } : {}),
  };
}

/** Built-ins first, then every manifest with its validation status. */
export async function listHarnesses(
  deps: DispatchDeps = {},
): Promise<HarnessSummary[]> {
  const summaries: HarnessSummary[] = BUILTIN_HARNESSES.map((name) => ({
    name,
    source: "builtin",
    status: "ok",
    runs_turn: false,
  }));
  for (const loaded of await loadManifests(manifestDir(deps))) {
    if (!loaded.manifest) {
      summaries.push({
        name: loaded.name,
        source: "manifest",
        status: "invalid",
        runs_turn: false,
        path: loaded.path,
        ...(loaded.error ? { error: loaded.error } : {}),
      });
      continue;
    }
    summaries.push({
      name: loaded.name,
      source: "manifest",
      status: "ok",
      runs_turn: loaded.manifest.runsTurn,
      path: loaded.path,
      binary:
        (await locateBinary(loaded.manifest.locate, binaryLookup(deps))) ??
        null,
    });
  }
  return summaries;
}

async function manifestFor(
  name: string,
  deps: DispatchDeps,
): Promise<{ manifest: HarnessManifest; loaded: LoadedManifest }> {
  const all = await loadManifests(manifestDir(deps));
  const loaded = all.find((entry) => entry.name === name);
  if (loaded?.manifest) return { manifest: loaded.manifest, loaded };
  if (loaded) {
    throw new BridgeError(
      "invalid_manifest",
      `${loaded.path}: ${loaded.error ?? "invalid manifest"}`,
    );
  }
  const known = [...BUILTIN_HARNESSES, ...all.map((entry) => entry.name)];
  throw new BridgeError(
    "unknown_harness",
    `no harness named "${name}" (known: ${known.join(", ")}); add ${manifestDir(deps)}/${name}.yaml to define it`,
  );
}

async function requireBinary(
  manifest: HarnessManifest,
  deps: DispatchDeps,
): Promise<string> {
  const binary = await locateBinary(manifest.locate, binaryLookup(deps));
  if (binary) return binary;
  throw new BridgeError(
    "harness_unavailable",
    `${manifest.name}: no executable found for locate "${manifest.locate.value}"`,
  );
}

export interface SessionListing {
  harness: string;
  source: "builtin" | "manifest";
  sessions: DiscoveredSession[];
}

function listed(
  harness: string,
  id: string,
  extra: { title?: string; updated?: string },
): DiscoveredSession {
  return {
    id,
    address: formatAddress({ kind: "session", harness, session: id }),
    ...(extra.title ? { title: extra.title } : {}),
    ...(extra.updated ? { updated: extra.updated } : {}),
  };
}

export async function listSessions(
  harness: string,
  options: { cwd?: string },
  deps: DispatchDeps = {},
): Promise<SessionListing> {
  const wanted = options.cwd ? resolve(options.cwd) : undefined;
  if (harness === "claude") {
    const sessions = (await listClaudeSessions(deps.sessionsRoot))
      .filter((session) => !wanted || resolve(session.cwd) === wanted)
      .map((session) =>
        listed("claude", session.sessionId, {
          ...(session.title ? { title: session.title } : {}),
        }),
      );
    return { harness, source: "builtin", sessions };
  }
  if (harness === "codex") {
    const store = (deps.threads ?? (() => SqliteThreadStore.open()))();
    const sessions = store
      .threads({
        ...(wanted ? { roots: [wanted] } : {}),
        limit: CODEX_SESSION_LIMIT,
      })
      .map((thread) =>
        listed("codex", thread.id, {
          title: thread.label,
          updated: new Date(thread.updatedAtMs).toISOString(),
        }),
      );
    return { harness, source: "builtin", sessions };
  }
  const { manifest } = await manifestFor(harness, deps);
  const binary = await requireBinary(manifest, deps);
  return {
    harness,
    source: "manifest",
    sessions: await discoverSessions(manifest, binary, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(deps.runner ? { runner: deps.runner } : {}),
    }),
  };
}

export interface SendRequest {
  to: string;
  message: string;
  cwd?: string;
  /** Required to start a turn on a harness whose manifest says it runs one. */
  run?: boolean;
  from?: string;
  kind?: string;
  replyTo?: string;
}

export interface SendOutcome {
  ok: true;
  id: string;
  to: string;
  harness: string;
  reply?: string;
  lane: string;
  audit: { written: boolean; error?: string };
}

function messageKind(kind: string | undefined): MessageKind {
  if (kind === undefined) return "ask";
  if (isMessageKind(kind)) return kind;
  throw new Error("--kind must be one of ask, ack, handoff, fyi");
}

function defaultSender(): string {
  const session = currentSessionId();
  return session ? `claude:${session}` : "agentplus";
}

/**
 * The record that a message was sent, not the message: the lane carries the
 * envelope and the size, never the body, so nothing a harness was told is
 * written to disk by the bridge. Written only after the send succeeded, and a
 * failure to write it is reported rather than thrown, because by then the
 * message is gone and an error would invite a duplicate send.
 */
async function recordSend(
  lane: string,
  entry: {
    id: string;
    from: string;
    to: string;
    kind: MessageKind;
    replyTo?: string;
    harness: string;
    bytes: number;
  },
  deps: DispatchDeps,
): Promise<{ written: boolean; error?: string }> {
  try {
    await appendInbox(lane, {
      at: (deps.now ?? (() => new Date().toISOString()))(),
      from: entry.from,
      to: entry.to,
      id: entry.id,
      kind: entry.kind,
      ...(entry.replyTo ? { reply_to: entry.replyTo } : {}),
      message: `sent via ${entry.harness} (${entry.bytes} bytes, body not recorded)`,
    });
    return { written: true };
  } catch (error) {
    return { written: false, error: errorMessage(error) };
  }
}

function laneOf(address: Address, deps: DispatchDeps): string {
  return inboxLanePath(laneFor(address), deps.laneHome);
}

export async function sendMessage(
  request: SendRequest,
  deps: DispatchDeps = {},
): Promise<SendOutcome> {
  const address = parseAddress(request.to);
  const kind = messageKind(request.kind);
  const from = request.from ?? defaultSender();
  const id = (deps.newId ?? (() => crypto.randomUUID()))();
  const to = formatAddress(address);
  const harness = address.kind === "broadcast" ? BROADCAST : address.harness;

  if (address.kind === "broadcast" || address.harness === "claude") {
    const result = await notifyClaude({
      id,
      from,
      kind,
      message: request.message,
      ...(request.replyTo ? { replyTo: request.replyTo } : {}),
      ...(address.kind === "session" ? { to: address.session } : {}),
      ...(deps.now ? { at: deps.now } : {}),
      ...(deps.laneHome ? { home: deps.laneHome } : {}),
      ...(deps.sessionsRoot ? { sessionsRoot: deps.sessionsRoot } : {}),
    });
    return {
      ok: true,
      id: result.id,
      to,
      harness,
      lane: result.lane,
      audit: { written: result.queued },
    };
  }

  if (request.message.trim() === "")
    throw new Error("a message cannot be empty");
  const message = truncateText(
    redactText(labelPeerMessage(request.message, from)),
    MESSAGE_LIMIT_BYTES,
  );
  const lane = laneOf(address, deps);
  const audit = {
    id,
    from,
    to,
    kind,
    harness,
    bytes: new TextEncoder().encode(message).byteLength,
    ...(request.replyTo ? { replyTo: request.replyTo } : {}),
  };

  if (harness === "codex") {
    const store = (deps.threads ?? (() => SqliteThreadStore.open()))();
    await sendToThread(
      store,
      deps.codex ?? new NativeCodexReviewClient(),
      { thread: address.session },
      message,
    );
    return {
      ok: true,
      id,
      to,
      harness,
      lane,
      audit: await recordSend(lane, audit, deps),
    };
  }

  const { manifest } = await manifestFor(harness, deps);
  if (manifest.runsTurn && !request.run) {
    throw new BridgeError(
      "turn_requires_run",
      `${harness} starts a model turn when it receives a message (runs_turn is true in its manifest), so nothing was sent; pass --run to send anyway`,
    );
  }
  const binary = await requireBinary(manifest, deps);
  await checkHealth(manifest, binary, {
    ...(request.cwd ? { cwd: request.cwd } : {}),
    ...(deps.runner ? { runner: deps.runner } : {}),
  });
  const sent = await sendThroughAdapter(
    manifest,
    binary,
    {
      session: address.session,
      message,
      ...(request.cwd ? { cwd: request.cwd } : {}),
    },
    deps.runner,
  );
  return {
    ok: true,
    id,
    to,
    harness,
    ...(sent.reply ? { reply: sent.reply } : {}),
    lane,
    audit: await recordSend(lane, audit, deps),
  };
}
