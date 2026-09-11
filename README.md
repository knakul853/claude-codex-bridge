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
- Addresses a Codex thread or a Claude session by working directory, so either
  side can start a collaboration in a repository it was not launched from.
- Delivers Codex's replies to a per-session lane, waking a waiting Claude session
  on a filesystem event rather than a poll.
- Records each pairing, reports what it still costs in memory, and closes it.
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

Hook installation updates the user's `~/.claude/settings.json` (or
`$CLAUDE_CONFIG_DIR/settings.json`) and preserves unrelated settings and hooks.
The hook applies to every repository and safely does nothing for sessions the
bridge does not own. `start` refuses to launch until both completion hooks are
installed, so a worker cannot finish without a delivery path.

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

Every session verb takes `--cwd`, so Codex can run them from its own working
directory and still act on the right repository. Without it the current directory
is used, which is how a worker ends up in the wrong repo.

```sh
claude-codex-bridge start --owner-thread <id> --cwd /path/to/repo --here
```

`start` cuts a worktree inside the target repo by default and requires a clean
tree. `--here` runs the worker in the repo itself and allows a dirty one, which is
what a reviewer needs in order to see uncommitted work.

### Closing things down

Each Claude session holds a few hundred megabytes plus its own MCP children, and a
worker wedged on a permission prompt holds them indefinitely. Spawning is capped at
four live bridge workers (`--max-live`), and the rest is explicit:

```sh
claude-codex-bridge peers                        # pairings, with liveness and MB
claude-codex-bridge reap                          # report only; changes nothing
claude-codex-bridge reap --apply [--kill-stuck]   # prune finished, optionally wedged
claude-codex-bridge close --peer <ref> --force --remove-worktree --archive-thread
```

`reap` reports unless `--apply` is passed, because stopping a session discards its
unsaved work. A pid is signalled only after the session registry confirms it still
belongs to that session, since pids are reused and this one came from a file. Only
worktrees the bridge cut itself are ever removed.

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
claude-codex-bridge threads --cwd /path/to/repo       # newest first
claude-codex-bridge send --cwd /path/to/repo --new --message "..."
claude-codex-bridge send --thread <uuid> --message "..." --wait
claude-codex-bridge read --thread <uuid> --last 3
claude-codex-bridge watch --thread <uuid>             # block until the next turn
```

A destination is a **directory**, with `--project` kept as a convenience. Codex's
project table is a UI grouping: it omits working directories entirely and lets two
projects share one root, so a path addresses a thread that a project name cannot.

`watch` blocks on filesystem events, not a poll interval, so waiting on Codex costs
nothing while it thinks and returns the moment it answers. Exit code 3 means the
timeout was reached. Run it as a background job and let it wake you.

It resumes from a byte offset rather than counting turns. A rollout is read through
a window, so as the file grows old turns leave it as new ones arrive and the count
can sit still while Codex is answering — `read`'s count is of the window, never of
the thread, and must not be used to detect that something arrived.

`send --new` opens the desktop app on the project, prefills the composer, presses
return, then waits for the thread to register and prints its id. Pass `--no-send` to
stop before the keystroke and approve the message yourself.

### Codex sending a message back

Claude Code publishes a record per live session under `~/.claude/sessions`, so a
peer can discover sessions and address one without running the `claude` CLI.

```bash
claude-codex-bridge sessions                               # live sessions and ids
claude-codex-bridge sessions --cwd /path/to/repo           # just that directory
claude-codex-bridge notify --to <session-id> --message "..."
claude-codex-bridge notify --cwd /path/to/repo --message "..."   # address by directory
claude-codex-bridge notify --to <session-id> --push --message "..."
claude-codex-bridge inbox                                  # read this session's lane
claude-codex-bridge inbox --watch --since <offset>         # block for the next one
```

Each addressee gets its own append-only lane under `~/.claude-codex-bridge/inbox`,
so two Claude sessions watching at once cannot consume each other's messages. An
unaddressed message goes to the `broadcast` lane. `inbox` with no `--to` resolves
the caller's own lane from `CLAUDE_CODE_SESSION_ID`.

**The lane is the delivery; `--push` is only a nudge.** A live session also listens
on a unix socket, and `--push` writes an authenticated message straight into it,
which appears in that session immediately. That socket acknowledges nothing, so a
successful write is never proof the session received it — the lane is therefore
always written first, and a dropped nudge costs a duplicate rather than the
message. A stopped or restarting session still finds its lane waiting.

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
- **`workspace` is ignored, not advisory.** A new thread opens in whichever workspace the
  app currently holds. Measured against a registered project root, which was ignored too,
  so `--new` cannot choose a directory. `send --new` reports `actualCwd` and warns when it
  differs; to land in a specific repository, queue into a thread already there with `--cwd`.
- **Two stale bundles can claim `codex:`.** A deleted copy in the Trash and an unmounted
  installer image stay registered as URL handlers, so a bare `open` hands the link to a
  bundle that cannot service it and the app never appears. The link is opened with
  `open -a` against a named application instead.
- **A bare `keystroke return` goes to whatever is frontmost.** The submit keystroke
  activates the app, verifies it actually holds focus, and addresses the process by name,
  rather than typing into whichever window happened to steal focus.
- **Codex's sandbox does not reach the inbox.** Lanes live under the home directory, outside
  the workspace Codex may write, so `notify` needs that path allowed. Add it once in
  `~/.codex/config.toml` for unattended use:

  ```toml
  [sandbox_workspace_write]
  writable_roots = ["<your home directory>/.claude-codex-bridge"]
  ```
- **The two session sources disagree on `kind`.** `~/.claude/sessions` reports `bg` where
  `claude agents --json` reports `background`, so only `interactive` is matched on.
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
- **The desktop app and the CLI are different versions.** The app bundles its own
  `codex` and writes the shared sqlite store; `codex update` moves only the standalone
  CLI the bridge shells out to. Let the two drift and the CLI reads a store a newer
  app wrote.
- **A thread title can be the entire generated prompt.** Auto-generated threads store
  their whole opening message as the title, unbounded, running to kilobytes. Labels are
  truncated in the query, because every caller prints them and a Claude caller pays for
  it in context.
- **A live session can be reached, but not confirmably.** `~/.claude/sessions/<pid>.json`
  publishes a socket path, and `<pid>.<hash>.key` publishes the `peerToken` a peer
  authenticates with; `procStart` in both guards against pid reuse. The protocol is
  newline-delimited JSON: an `auth` line then a `user` line. A wrong token is rejected,
  and delivery is deferred while the session is busy — but nothing is ever acknowledged,
  which is why this is a nudge and not the delivery.
- **An agent record outlives its process.** `claude agents --json` keeps a session's
  state after it exits, so only the presence of `pid` distinguishes a session still
  holding memory from a stale record. Interactive sessions report `status`, not `state`.

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
