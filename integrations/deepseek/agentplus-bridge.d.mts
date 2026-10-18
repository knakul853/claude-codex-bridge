export interface BridgeSession {
  id: string;
  title: string;
  cwd: string | null;
  updated: string;
  running: boolean;
}

export interface SendRequest {
  session: string;
  message: string;
  mode?: "queue" | "steer" | string;
  wait?: boolean;
  timeoutMs?: number;
}

export interface SendResult {
  accepted: true;
  reply?: string;
  turn?: number;
  reason?: string;
}

export const name: string;
export const inject: string[];
export function defaultSocketPath(): string;

export class Bridge {
  constructor(controller: unknown, now?: () => number);
  byRequest: Map<string, unknown>;
  byTurn: Map<string, unknown>;
  list(): Promise<BridgeSession[]>;
  create(request: { cwd?: string }): Promise<{ id: string }>;
  send(request: SendRequest): Promise<SendResult>;
  onInboxClaimed(message: unknown, turn: number): void;
  onSessionEvent(sessionId: string | undefined, event: unknown): void;
  handle(request: unknown): Promise<unknown>;
}

export function serve(
  bridge: Bridge,
  socketPath: string,
  logger?: { warn(message: string): void },
): () => void;
export function apply(ctx: unknown, config?: { socket?: string }): void;
