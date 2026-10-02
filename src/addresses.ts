export const BROADCAST = "broadcast";

const HARNESS_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface SessionAddress {
  kind: "session";
  harness: string;
  session: string;
}

export type Address = { kind: "broadcast" } | SessionAddress;

export function isHarnessName(value: string): boolean {
  return HARNESS_NAME.test(value);
}

/**
 * `harness:session` (`codex:<thread uuid>`, `claude:<uuid>`, `opencode:ses_x`)
 * or `broadcast`. Both halves become part of file names and argv values, so a
 * malformed one is refused rather than normalised.
 */
export function parseAddress(text: string): Address {
  const wanted = text.trim();
  if (wanted === BROADCAST) return { kind: "broadcast" };
  const split = wanted.indexOf(":");
  const harness = split < 0 ? "" : wanted.slice(0, split);
  const session = split < 0 ? "" : wanted.slice(split + 1);
  if (!isHarnessName(harness) || !SESSION_ID.test(session)) {
    throw new Error(
      `"${wanted}" is not an address; use harness:session (for example codex:<thread-id>) or ${BROADCAST}`,
    );
  }
  if (session.includes("..")) throw new Error(`"${wanted}" is not an address`);
  return { kind: "session", harness, session };
}

export function formatAddress(address: Address): string {
  return address.kind === "broadcast"
    ? BROADCAST
    : `${address.harness}:${address.session}`;
}

/**
 * The lane file an address owns; undefined is the broadcast lane. A Claude
 * session keeps its bare id as its lane, which is what `notify --to <id>` has
 * always written, so existing lanes stay where they are.
 */
export function laneFor(address: Address): string | undefined {
  if (address.kind === "broadcast") return undefined;
  return address.harness === "claude"
    ? address.session
    : `${address.harness}.${address.session}`;
}

/**
 * Accepts the pre-existing bare form (a Claude session id) and the address
 * form. Used by verbs that only ever reach Claude sessions.
 */
export function claudeSessionFrom(to: string): string | undefined {
  if (!to.includes(":") && to !== BROADCAST) return to;
  const address = parseAddress(to);
  if (address.kind === "broadcast") return undefined;
  if (address.harness !== "claude") {
    throw new Error(
      `${formatAddress(address)} is not a Claude session; use \`send --to\` for other harnesses`,
    );
  }
  return address.session;
}

/** The lane named by `--to`, which may be a bare lane name or an address. */
export function laneFromTarget(to: string): string | undefined {
  if (!to.includes(":")) return to;
  return laneFor(parseAddress(to));
}
