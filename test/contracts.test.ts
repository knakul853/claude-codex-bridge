import { describe, expect, test } from "bun:test";
import {
  parseHandover,
  parseManifest,
  withHandoverContract,
} from "../src/contracts";

const sessionId = "11111111-1111-4111-8111-111111111111";

describe("handover contract", () => {
  test("accepts one exact bounded handover", () => {
    expect(
      parseHandover(
        '<agent_handover>{"disposition":"ready_for_review","summary":"Done."}</agent_handover>',
      ),
    ).toEqual({ disposition: "ready_for_review", summary: "Done." });
  });

  test.each([
    ["missing", "Done"],
    [
      "duplicate",
      '<agent_handover>{"disposition":"failed","summary":"a"}</agent_handover><agent_handover>{"disposition":"failed","summary":"b"}</agent_handover>',
    ],
    [
      "extra key",
      '<agent_handover>{"disposition":"failed","summary":"x","command":"rm"}</agent_handover>',
    ],
    [
      "control character",
      '<agent_handover>{"disposition":"failed","summary":"\\u001b[2J"}</agent_handover>',
    ],
  ])("rejects %s", (_name, value) =>
    expect(() => parseHandover(value)).toThrow(),
  );

  test("bounds prompts and appends the neutral contract", () => {
    expect(withHandoverContract("Do the work")).toContain("<agent_handover>");
    expect(() => withHandoverContract("")).toThrow();
  });
});

test("manifest is closed and carries no prompt", () => {
  const manifest = parseManifest({
    schemaVersion: 1,
    sessionId,
    ownerThreadId: "owner-1",
    gitCommonDir: "/repo/.git",
    createdAt: "2026-09-09T00:00:00.000Z",
  });
  expect(manifest.sessionId).toBe(sessionId);
  expect(() => parseManifest({ ...manifest, prompt: "secret" })).toThrow();
});
