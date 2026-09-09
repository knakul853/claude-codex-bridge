import { expect, test } from "bun:test";
import { codexThreadIdFromJsonl } from "../src/codex";

test("reads only a valid Codex thread.started event from JSONL", () => {
  const id = "01900000-0000-7000-8000-000000000000";
  expect(
    codexThreadIdFromJsonl(
      `startup warning\n{"type":"other","thread_id":"ignored"}\n${JSON.stringify({ type: "thread.started", thread_id: id })}\n`,
    ),
  ).toBe(id);
  expect(
    codexThreadIdFromJsonl('{"type":"thread.started","thread_id":"bad"}\n'),
  ).toBeUndefined();
});
