import { describe, expect, test } from "bun:test";
import {
  claudeSessionFrom,
  formatAddress,
  laneFor,
  laneFromTarget,
  parseAddress,
} from "../src/addresses";

const uuid = "01900000-0000-7000-8000-000000000000";

describe("parseAddress", () => {
  test("reads harness:session for each harness", () => {
    expect(parseAddress(`codex:${uuid}`)).toEqual({
      kind: "session",
      harness: "codex",
      session: uuid,
    });
    expect(parseAddress("claude:abc-1")).toMatchObject({ harness: "claude" });
    expect(parseAddress("opencode:ses_x")).toEqual({
      kind: "session",
      harness: "opencode",
      session: "ses_x",
    });
  });

  test("reads broadcast and round-trips through formatAddress", () => {
    expect(parseAddress(" broadcast ")).toEqual({ kind: "broadcast" });
    for (const text of ["broadcast", `codex:${uuid}`, "opencode:ses_x"]) {
      expect(formatAddress(parseAddress(text))).toBe(text);
    }
  });

  test.each([
    "",
    "codex",
    "codex:",
    ":ses",
    "Codex:ses",
    "codex:a b",
    "codex:../x",
    "codex:a..b",
    "codex:/etc/passwd",
    "codex:-flag",
    "a:b:c",
  ])("refuses %p", (text) => {
    expect(() => parseAddress(text)).toThrow("not an address");
  });
});

describe("lanes", () => {
  test("a Claude session keeps its bare id as its lane", () => {
    expect(laneFor(parseAddress("claude:abc"))).toBe("abc");
  });

  test("other harnesses get a harness-prefixed lane; broadcast has none", () => {
    expect(laneFor(parseAddress("opencode:ses_x"))).toBe("opencode.ses_x");
    expect(laneFor(parseAddress("broadcast"))).toBeUndefined();
  });

  test("--to keeps accepting a bare lane name", () => {
    expect(laneFromTarget("abc")).toBe("abc");
    expect(laneFromTarget("claude:abc")).toBe("abc");
    expect(laneFromTarget("opencode:ses_x")).toBe("opencode.ses_x");
  });
});

describe("claudeSessionFrom", () => {
  test("passes a bare session id through unchanged", () => {
    expect(claudeSessionFrom("11111111-1111-4111-8111-111111111111")).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
  });

  test("unwraps claude:ID and maps broadcast to no session", () => {
    expect(claudeSessionFrom("claude:abc")).toBe("abc");
    expect(claudeSessionFrom("broadcast")).toBeUndefined();
  });

  test("refuses another harness instead of writing a Claude lane for it", () => {
    expect(() => claudeSessionFrom("codex:abc")).toThrow(
      "not a Claude session",
    );
  });
});
