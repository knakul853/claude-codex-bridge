# Claude–Codex Bridge

A small local bridge for using Codex as the owner/reviewer while Claude Code
workers implement tasks in native isolated worktrees.

Built for local AI-agent orchestration, multi-agent coding workflows, and
structured Claude Code → OpenAI Codex handoffs without adding a hosted service.

It does not run a scheduler or hosted service. Claude owns worker sessions,
worktrees, logs, and execution; Codex owns review and integration; Git remains
the source of truth for code state.

## What it does

- Starts a Claude background worker and records the owning Codex task.
- Delivers one bounded structured handover when the worker stops.
- Reads branch, commit, cleanliness, and changed files from Git rather than
  trusting model prose.
- Continues the same Claude session after owner feedback.
- Lets Claude request review in an existing or newly created Codex task.
- Suppresses duplicate notifications and never automatically retries an
  uncertain Codex delivery.

It never merges, pushes, posts PR comments, edits boards, stores prompts or
transcripts, or sends telemetry. It creates a Codex task only when explicitly
invoked with `--new-codex-task`.

## Requirements

- macOS or Linux
- [Bun](https://bun.sh/)
- Git
- Claude Code with background agents and hooks
- Codex desktop app or CLI installation that provides the local `codex queue`
  and `codex exec` commands

## Install

```sh
git clone https://github.com/knakul853/claude-codex-bridge.git
cd claude-codex-bridge
bun install
bun link
claude-codex-bridge doctor
claude-codex-bridge install-hooks
```

Hook installation updates the current repository's `.claude/settings.json`
and preserves unrelated settings and hooks. Commit that settings change if you
want teammates to use the bridge too.

## Use

From a clean, attached Git branch:

```sh
claude-codex-bridge start \
  --owner-thread 01900000-0000-7000-8000-000000000000 \
  --name "Fix stream replay" \
  --prompt-file ./worker-prompt.txt
```

Or pipe a prompt so the bridge does not read it from a file:

```sh
printf '%s' 'Inspect the bug, fix it, verify it, and commit locally.' |
  claude-codex-bridge start --owner-thread "$CODEX_THREAD_ID"
```

Claude Code's native background command receives the prompt as a positional
argument. The bridge never persists it, but another process running as your OS
user may briefly observe it in the process list. Do not put credentials in task
prompts.

Inspect or continue a recorded session:

```sh
claude-codex-bridge status --session <claude-session-uuid>
printf '%s' 'Address the owner feedback and re-verify.' |
  claude-codex-bridge continue --session <claude-session-uuid>
```

Claude can request Codex review for its current session. Choose an existing
Codex task, or create a new durable task in Codex Desktop:

```sh
printf '%s' 'Review this work and return corrections to the same Claude session.' |
  claude-codex-bridge review --session <claude-session-uuid> --owner-thread <codex-task-id>

printf '%s' 'Review this work.' |
  claude-codex-bridge review --session <claude-session-uuid> --new-codex-task
```

After the first request, omit both routing options to reuse the recorded Codex
task. Codex can send corrections back with `continue`; the next Claude handover
returns to that same Codex task.

Creating a task waits for its first Codex review and prints that response, so a
Claude session invoking the command can use the feedback immediately. Reusing
an existing Codex task queues the request asynchronously.

After the native session and worktree have been handled, remove only the
bridge's routing state:

```sh
claude-codex-bridge forget --session <claude-session-uuid>
claude-codex-bridge uninstall-hooks
```

See [architecture and safety details](docs/architecture.md).

## Handover contract

The bridge appends this requirement to every worker prompt:

```text
<agent_handover>{"disposition":"ready_for_review","summary":"Concise result."}</agent_handover>
```

Allowed dispositions are `ready_for_review`, `needs_owner`, `blocked`, and
`failed`. The summary is treated as untrusted data and limited to 4,000 UTF-8
bytes. The Codex notification separately includes Git state read by the bridge.

## Development

```sh
bun install
bun run check
bun run privacy-check
```

## License

MIT
