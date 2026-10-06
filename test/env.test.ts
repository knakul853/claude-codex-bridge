import { expect, test } from "bun:test";
import { legacySettingName, setting, settingName } from "../src/env";

test("the AGENTPLUS name wins over the legacy one", () => {
  expect(
    setting({ AGENTPLUS_HOME: "/new", CLAUDE_CODEX_HOME: "/old" }, "HOME"),
  ).toBe("/new");
});

test("the legacy name is the fallback for every setting", () => {
  expect(setting({ CLAUDE_CODEX_HOME: "/old" }, "HOME")).toBe("/old");
  expect(setting({ CLAUDE_CODEX_INBOX: "/lane" }, "INBOX")).toBe("/lane");
  expect(setting({ CLAUDE_CODEX_BRIDGE_DELIVERY: "steer" }, "DELIVERY")).toBe(
    "steer",
  );
});

test("a blank value counts as unset", () => {
  expect(
    setting({ AGENTPLUS_HOME: "  ", CLAUDE_CODEX_HOME: "/old" }, "HOME"),
  ).toBe("/old");
  expect(setting({ AGENTPLUS_HOME: "" }, "HOME")).toBeUndefined();
});

test("names follow one pattern", () => {
  expect(settingName("DELIVERY")).toBe("AGENTPLUS_DELIVERY");
  expect(legacySettingName("DELIVERY")).toBe("CLAUDE_CODEX_BRIDGE_DELIVERY");
});
