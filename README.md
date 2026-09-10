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

## Talking to the Codex desktop app

`start` and `review` drive Codex through `codex exec`, which runs in the CLI. A CLI
thread has neither computer use nor your logged-in browser sessions, so anything that
has to click through a real UI must run in the desktop app instead. These commands
target it.

```bash
claude-codex-bridge projects                          # projects and their root directories
claude-codex-bridge threads --project aurora-nuclei   # newest first
claude-codex-bridge send --project aurora-nuclei --new --message "..."
claude-codex-bridge send --thread <uuid> --message "..." --wait
claude-codex-bridge read --thread <uuid> --last 3
```

`send --new` opens the desktop app on the project, prefills the composer, presses
return, then waits for the thread to register and prints its id. Pass `--no-send` to
stop before the keystroke and approve the message yourself.

### What this had to work around

Each of these cost an investigation, so they are encoded in the commands rather than
left for the next agent to rediscover.

- **An empty thread does not exist.** Codex persists a thread on its first message, so
  a thread you just opened in the app is unaddressable until something is sent in it.
  That is why `send --new` carries the first message instead of creating an empty thread.
- **The deep link cannot submit.** `codex://threads/new?workspace=&prompt=` prefills the
  composer only. `autoSubmit`, `submit` and `send` were all tried as query parameters and
  none of them submitted. Pressing return in the focused app is the only way, which is
  what `--no-send` opts out of.
- **`workspace` is advisory.** The app opens the thread in whichever workspace it already
  has for that project, so the result reports `actualCwd` alongside the root you asked for.
- **Threads carry no project id.** A project's threads are the ones whose `cwd` is one of
  its roots, from `project_roots`.
- **`codex queue` is fire and forget.** It returns once Codex accepts the message, so a
  reply is only visible by reading the thread's rollout, which is what `--wait` and `read`
  do. Rollouts are append-only and reach hundreds of megabytes, so only a bounded tail is
  ever read.
- **The running app-server is unreachable.** It is launched as `app-server --listen
  stdio://` by the Electron app and speaks only to its parent, so `codex app-server proxy`
  cannot attach. Everything here goes through the CLI and the local store instead.
- **The state file is versioned.** `state_5.sqlite` becomes `state_6.sqlite` on a schema
  migration, so the newest one is selected at runtime rather than pinned.

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
