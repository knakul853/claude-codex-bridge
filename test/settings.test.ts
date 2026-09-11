import { expect, test } from "bun:test";
import {
  bridgeHooksInstalled,
  HOOK_COMMAND,
  installBridgeHooks,
  uninstallBridgeHooks,
} from "../src/settings";

test("hook installation is idempotent and preserves unrelated hooks", () => {
  const existing = {
    permissions: { allow: ["Bash(git status)"] },
    hooks: { Stop: [{ hooks: [{ type: "command", command: "other-hook" }] }] },
  };
  const once = installBridgeHooks(existing);
  const twice = installBridgeHooks(once);
  expect(twice).toEqual(once);
  expect(JSON.stringify(once)).toContain(HOOK_COMMAND);
  expect(JSON.stringify(once)).toContain("other-hook");
  expect(once.permissions).toEqual(existing.permissions);
  expect(bridgeHooksInstalled(once)).toBe(true);
  expect(bridgeHooksInstalled(existing)).toBe(false);
});

test("uninstall removes only bridge-owned entries", () => {
  const installed = installBridgeHooks({
    hooks: { StopFailure: [{ hooks: [{ type: "command", command: "keep" }] }] },
  });
  const removed = uninstallBridgeHooks(installed);
  expect(JSON.stringify(removed)).not.toContain(HOOK_COMMAND);
  expect(JSON.stringify(removed)).toContain("keep");
});
