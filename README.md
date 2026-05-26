# pi-ez-chat-mount

A pi extension that adds the current pi session's `cwd` as a sibling host-bind mount inside the Gondolin VM that `pi-chat` runs per connected conversation.

Status: **design/planning only**. Implementation has not started.

## What it does (target behavior)

- Adds `/chat-mount`, `/chat-unmount`, `/chat-mounts` commands.
- `/chat-mount` takes no path argument: it mounts the current pi session's `cwd`.
- Mount point is `/<repo>-<session_name>`, both segments sanitized.
- Fails if the current pi session has no name; user must name the session first.
- `/chat-mount --read-only` makes the mount read-only.
- Mounts are **sibling roots** to `/workspace` and `/shared` inside the VM. `/workspace` semantics are unchanged.
- Mounts are persisted per-conversation in extension-local storage, and re-applied automatically when `pi-chat` (re)creates the VM.
- If a configured mount's host path is missing at VM start, the mount is skipped and the user is notified; the connection still proceeds.
- Threads created via `pi-ez-chat-threads` inherit the parent channel's mounts at thread-creation time.

## Why this exists

`pi-chat` mounts a durable per-conversation `/workspace` and per-account `/shared` into the VM. There is no built-in way to expose the user's local repository directly. `pi-ez-chat-handoff` solves this by copying files into the channel workspace, which causes drift and stale state.

`pi-ez-chat-mount` makes the local repo a **first-class sibling mount** in the VM, leaving `/workspace` untouched and avoiding copy/sync semantics entirely.

## Docs

- [docs/plan-init.md](docs/plan-init.md) — initial design and phased plan.
- [docs/known-issues.md](docs/known-issues.md) — known issues, including monkey-patch tradeoffs and the recommended upstream fix.

## License

MIT (planned)
