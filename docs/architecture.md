# Architecture and safety

The bridge is a CLI plus Claude Code `Stop` and `StopFailure` hooks. It has no
daemon. A small manifest maps a Claude session UUID to a Codex owner task and a
Git common directory. Manifests contain no prompt, transcript, reasoning,
credential, or environment value.

The owner can be a Codex desktop task. The bridge uses the local `codex queue`
command only as its delivery transport into that task; the owner does not need
to run in a terminal.

The bridge does not persist prompts. Claude Code's native background CLI does,
however, require the prompt as a positional argument, so a same-user process may
briefly observe it in the process list. Task prompts must not contain secrets.

## Ownership

- Claude Code owns worker processes, sessions, logs, and worktrees.
- Codex owns review and integration.
- Git owns branch and file state.
- The bridge owns only routing metadata and delivery state.

The bridge refuses to continue live, blocked, missing, ambiguous, or foreign
sessions. `forget` refuses live or blocked sessions and deletes only bridge
state. It never removes native sessions, branches, or worktrees.

## Delivery

Every notification has a deterministic event ID. Delivery is recorded as
`pending`, `delivered`, or `unknown` under an exclusive lock. Duplicate hooks
do not send again. If `codex queue` returns an uncertain result, the state is
`unknown` and the bridge does not automatically retry because the Codex CLI
does not expose an idempotency key. This intentionally prefers a visible
non-delivery over notification spam.

## Trust model

Claude and Codex run as the developer's OS user. File modes protect state from
other users, not from a malicious same-user process. The hook validates the
session UUID, repository identity, and live Git common directory before it
delivers anything. This is coordination hardening, not OS isolation.
