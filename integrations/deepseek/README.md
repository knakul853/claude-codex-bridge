# DeepSeek Harness desktop

The desktop app has no queue, deep link or open API for sessions, so agent+ reaches it through a
small plugin loaded into the app: `agentplus-bridge.mjs` serves `~/.dsh/agentplus.sock` (mode
0600) and drives sessions through the app's own session controller, so messages appear in the
desktop UI like typed ones. `agentplus-deepseek.ts` is the CLI the harness manifest calls.

## Install

1. Append to `~/.dsh/profiles/desktop/cordis.patch.yml` (absolute path to your clone):
   ```yaml
   - insert:
       - id: agentplus-bridge
         name: /path/to/claude-codex-bridge/integrations/deepseek/agentplus-bridge.mjs
   ```
2. Restart DeepSeek Harness, then `integrations/deepseek/agentplus-deepseek.ts ping` prints `ok`.
3. Copy `examples/harnesses/deepseek.yaml` to `~/.config/agentplus/harnesses/` and fix `locate`;
   `agentplus harnesses` should list `deepseek` as `ok`.

## Use

```bash
agentplus sessions --harness deepseek
agentplus send --to deepseek:<session-id> --run --message "..."   # blocks for the reply
integrations/deepseek/agentplus-deepseek.ts create <cwd>          # new session in a directory
```

DeepSeek reads skills from `~/.agents/skills`, so the `agentplus` skill teaches it to message
Claude and Codex with the same CLI; inside a session, `agentplus-deepseek.ts self` prints its own
`deepseek:<id>` address for the reply command.

## Known limits

- `agentplus send --new` from DeepSeek needs macOS Automation permission for DeepSeek Harness
  (System Settings → Privacy & Security → Automation); sending into an existing Codex thread does not.
- Bun 1.3.11 crashes when a `node:net` client settles a promise on `end` after an earlier request;
  the CLI settles on `close` instead.
