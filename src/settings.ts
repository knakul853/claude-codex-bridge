import { constants } from "node:fs";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";

export const HOOK_COMMAND = "claude-codex-bridge hook";

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Claude settings must be a JSON object");
  }
  return value as JsonObject;
}

function bridgeHookGroup(): JsonObject {
  return { hooks: [{ type: "command", command: HOOK_COMMAND }] };
}

function hasBridgeCommand(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as JsonObject;
  return record.type === "command" && record.command === HOOK_COMMAND;
}

function groupHasBridge(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const hooks = (value as JsonObject).hooks;
  return Array.isArray(hooks) && hooks.some(hasBridgeCommand);
}

export function installBridgeHooks(value: unknown): JsonObject {
  const settings = structuredClone(object(value));
  const hooks = settings.hooks === undefined ? {} : object(settings.hooks);
  for (const event of ["Stop", "StopFailure"]) {
    const groups = hooks[event] === undefined ? [] : hooks[event];
    if (!Array.isArray(groups))
      throw new Error(`Claude hooks.${event} must be an array`);
    if (!groups.some(groupHasBridge)) groups.push(bridgeHookGroup());
    hooks[event] = groups;
  }
  settings.hooks = hooks;
  return settings;
}

export function uninstallBridgeHooks(value: unknown): JsonObject {
  const settings = structuredClone(object(value));
  if (settings.hooks === undefined) return settings;
  const hooks = object(settings.hooks);
  for (const event of ["Stop", "StopFailure"]) {
    const groups = hooks[event];
    if (groups === undefined) continue;
    if (!Array.isArray(groups))
      throw new Error(`Claude hooks.${event} must be an array`);
    const kept = groups.flatMap((group) => {
      if (!group || typeof group !== "object" || Array.isArray(group))
        return [group];
      const copy = structuredClone(group as JsonObject);
      const groupHooks = copy.hooks;
      if (!Array.isArray(groupHooks)) return [copy];
      const filteredHooks = groupHooks.filter(
        (hook) => !hasBridgeCommand(hook),
      );
      copy.hooks = filteredHooks;
      return filteredHooks.length > 0 ? [copy] : [];
    });
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }
  if (Object.keys(hooks).length > 0) settings.hooks = hooks;
  else delete settings.hooks;
  return settings;
}

export async function readSettings(path: string): Promise<JsonObject> {
  try {
    return object(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return {};
    throw error;
  }
}

export async function writeSettings(
  path: string,
  value: JsonObject,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  const handle = await open(
    temporary,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}
