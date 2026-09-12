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

  test("reads the block off the end even when prose quotes the tag", () => {
    const open = `<${"agent_handover"}>`;
    const message = [
      `Every failure reported "Emit the required final ${open} JSON block."`,
      "",
      `${open}{"disposition":"ready_for_review","summary":"Done."}</agent_handover>`,
    ].join("\n");

    // A forward scan pairs the quoted tag with the real block's closing tag and
    // hands the sentence in between to JSON.parse.
    expect(parseHandover(message)).toEqual({
      disposition: "ready_for_review",
      summary: "Done.",
    });
  });

  test("refuses a block that does not end the response", () => {
    expect(() =>
      parseHandover(
        '<agent_handover>{"disposition":"failed","summary":"a"}</agent_handover>\n\nand one more thing',
      ),
    ).toThrow(/must end the final response/);
  });

  test("accepts a summary laid out in paragraphs", () => {
    const summary = "Shipped the planner.\n\nOwner must still run the live PR.";

    expect(
      parseHandover(
        `<agent_handover>${JSON.stringify({ disposition: "ready_for_review", summary })}</agent_handover>`,
      ),
    ).toEqual({ disposition: "ready_for_review", summary });
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
    [
      "null byte",
      '<agent_handover>{"disposition":"failed","summary":"a\\u0000b"}</agent_handover>',
    ],
  ])("rejects %s", (_name, value) =>
    expect(() => parseHandover(value)).toThrow(),
  );

  test("names why a present handover was refused, not that one is missing", () => {
    expect(() =>
      parseHandover(
        `<agent_handover>{"disposition":"failed","summary":${JSON.stringify("x".repeat(4_001))}}</agent_handover>`,
      ),
    ).toThrow(/at most 4000 bytes/);
  });

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
