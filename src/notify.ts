import { appendInbox, type InboxMessage, inboxLanePath } from "./inbox";
import { redactText, truncateText } from "./safety";
import {
  type ClaudeSession,
  findClaudeSessions,
  pushToSession,
} from "./sessions";

const MESSAGE_LIMIT_BYTES = 8_000;

export interface NotifyInput {
  /** Claude session id to address. Omitted messages go to the broadcast lane. */
  to?: string;
  /** Resolve the addressee by the directory it is working in. */
  cwd?: string;
  from: string;
  message: string;
  /** Also interrupt the live session over its socket, not just queue the lane. */
  push?: boolean;
  at?: () => string;
  home?: string;
  sessionsRoot?: string;
}

export interface NotifyResult {
  lane: string;
  sessionId?: string;
  /** Whether the socket nudge was attempted, and what came of it. */
  pushed?: boolean;
  detail?: string;
}

async function resolveTarget(
  input: NotifyInput,
): Promise<ClaudeSession | undefined> {
  if (!input.to && !input.cwd) return undefined;
  const matches = await findClaudeSessions(
    {
      ...(input.to ? { session: input.to } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
    },
    input.sessionsRoot,
  );
  if (matches.length > 1) {
    throw new Error(
      `${matches.length} live Claude sessions match; address one with --to <session-id>`,
    );
  }
  return matches[0];
}

/**
 * Always records the message on the addressee's lane, then optionally nudges a
 * live session over its socket.
 *
 * The lane is the delivery, not a fallback. The socket acknowledges nothing, so a
 * clean write there proves only that it was accepted — never that the session
 * received it — and a socket-only send would lose the message outright if it were
 * dropped. Writing the lane first also means a stopped or restarting session
 * still finds the message waiting.
 */
export async function notifyClaude(input: NotifyInput): Promise<NotifyResult> {
  const message = truncateText(redactText(input.message), MESSAGE_LIMIT_BYTES);
  if (!message.trim()) throw new Error("a notification needs a message");
  const target = await resolveTarget(input);
  const addressee = target?.sessionId ?? input.to;
  const lane = inboxLanePath(addressee, input.home);

  await appendInbox(lane, {
    at: (input.at ?? (() => new Date().toISOString()))(),
    from: input.from,
    message,
    ...(addressee ? { to: addressee } : {}),
  } satisfies InboxMessage);

  const result: NotifyResult = {
    lane,
    ...(addressee ? { sessionId: addressee } : {}),
  };
  if (!input.push) return result;
  if (!target) {
    return { ...result, pushed: false, detail: "no live session to interrupt" };
  }
  const pushed = await pushToSession(
    target,
    message,
    5_000,
    input.sessionsRoot,
  );
  return {
    ...result,
    pushed: pushed.delivered,
    ...(pushed.detail ? { detail: pushed.detail } : {}),
  };
}
