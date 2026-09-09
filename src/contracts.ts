const HANDOVER_LIMIT_BYTES = 4_000;
const IDENTIFIER_LIMIT_BYTES = 128;

export const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const HANDOVER_DISPOSITIONS = [
  "ready_for_review",
  "needs_owner",
  "blocked",
  "failed",
] as const;

export type HandoverDisposition = (typeof HANDOVER_DISPOSITIONS)[number];
export type DeliveryStatus = "pending" | "delivered" | "unknown";

export interface AgentHandover {
  disposition: HandoverDisposition;
  summary: string;
}

export interface BridgeManifest {
  schemaVersion: 1;
  sessionId: string;
  ownerThreadId: string;
  name?: string;
  gitCommonDir: string;
  createdAt: string;
}

export interface DeliveryRecord {
  schemaVersion: 1;
  eventId: string;
  sessionId: string;
  status: DeliveryStatus;
  updatedAt: string;
}

export function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function boundedString(
  value: unknown,
  name: string,
  max = IDENTIFIER_LIMIT_BYTES,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    utf8Length(value) > max
  ) {
    throw new Error(
      `${name} must be a non-empty string of at most ${max} bytes`,
    );
  }
  if (/\p{Cc}/u.test(value)) {
    throw new Error(`${name} contains a control character`);
  }
  return value;
}

export function parseSessionId(value: unknown): string {
  const sessionId = boundedString(value, "session id");
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error("session id must be a UUID");
  }
  return sessionId;
}

export function parseHandover(message: string): AgentHandover {
  const matches = [
    ...message.matchAll(/<agent_handover>\s*([\s\S]*?)\s*<\/agent_handover>/g),
  ];
  if (matches.length !== 1) {
    throw new Error("final response must contain exactly one agent_handover");
  }
  const payload = JSON.parse(matches[0]?.[1] ?? "") as unknown;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("agent handover must be an object");
  }
  const record = payload as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "disposition,summary") {
    throw new Error(
      "agent handover must contain exact keys disposition and summary",
    );
  }
  if (
    !HANDOVER_DISPOSITIONS.includes(record.disposition as HandoverDisposition)
  ) {
    throw new Error("agent handover disposition is invalid");
  }
  const summary = boundedString(
    record.summary,
    "agent handover summary",
    HANDOVER_LIMIT_BYTES,
  );
  return { disposition: record.disposition as HandoverDisposition, summary };
}

export function parseManifest(value: unknown): BridgeManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("bridge manifest must be an object");
  }
  const record = value as Record<string, unknown>;
  const allowed = [
    "createdAt",
    "gitCommonDir",
    "name",
    "ownerThreadId",
    "schemaVersion",
    "sessionId",
  ];
  if (Object.keys(record).some((key) => !allowed.includes(key))) {
    throw new Error("bridge manifest contains an unknown field");
  }
  if (record.schemaVersion !== 1) {
    throw new Error("bridge manifest schema version is unsupported");
  }
  const manifest: BridgeManifest = {
    schemaVersion: 1,
    sessionId: parseSessionId(record.sessionId),
    ownerThreadId: boundedString(record.ownerThreadId, "owner thread id"),
    gitCommonDir: boundedString(
      record.gitCommonDir,
      "Git common directory",
      1_024,
    ),
    createdAt: boundedString(record.createdAt, "creation time"),
  };
  if (record.name !== undefined) {
    manifest.name = boundedString(record.name, "name", 128);
  }
  return manifest;
}

export function parseDeliveryRecord(value: unknown): DeliveryRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("delivery record must be an object");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !==
    "eventId,schemaVersion,sessionId,status,updatedAt"
  ) {
    throw new Error("delivery record has an invalid shape");
  }
  if (
    record.schemaVersion !== 1 ||
    !["pending", "delivered", "unknown"].includes(String(record.status))
  ) {
    throw new Error("delivery record has an unsupported value");
  }
  return {
    schemaVersion: 1,
    eventId: boundedString(record.eventId, "event id"),
    sessionId: parseSessionId(record.sessionId),
    status: record.status as DeliveryStatus,
    updatedAt: boundedString(record.updatedAt, "updated time"),
  };
}

export const HANDOVER_INSTRUCTION = `Finish your final response with exactly one block:
<agent_handover>{"disposition":"ready_for_review|needs_owner|blocked|failed","summary":"A concise, credential-free handover."}</agent_handover>
Do not put any text after that block.`;

export function withHandoverContract(prompt: string): string {
  const trimmed = prompt.trim();
  if (!trimmed || utf8Length(trimmed) > 64 * 1024) {
    throw new Error("prompt must contain 1 to 65536 UTF-8 bytes");
  }
  return `${trimmed}\n\n${HANDOVER_INSTRUCTION}`;
}
