export type Env = Record<string, string | undefined>;

// `agentplus` was released as `claude-codex-bridge`; its variables stay readable
// so existing shells, hooks and scripts keep working after the rename.
const LEGACY_NAMES = {
  HOME: "CLAUDE_CODEX_HOME",
  INBOX: "CLAUDE_CODEX_INBOX",
  DELIVERY: "CLAUDE_CODEX_BRIDGE_DELIVERY",
} as const;

export type SettingKey = keyof typeof LEGACY_NAMES;

export function settingName(key: SettingKey): string {
  return `AGENTPLUS_${key}`;
}

export function legacySettingName(key: SettingKey): string {
  return LEGACY_NAMES[key];
}

/** The `AGENTPLUS_*` value, else the legacy one; blank counts as unset. */
export function setting(env: Env, key: SettingKey): string | undefined {
  for (const name of [settingName(key), legacySettingName(key)]) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}
