# pi-ez-chat-mount

Expose the current pi session `cwd` inside a `pi-chat` Gondolin VM as a top-level sibling mount, without changing `/workspace`.

Example: from `~/dev/infra`, `/chat-mount` configures `/infra -> ~/dev/infra` for the connected chat conversation.

## Install

```bash
pi install /absolute/path/to/pi-ez-chat-mount
```

For one run:

```bash
pi -e /absolute/path/to/pi-ez-chat-mount
```

Load this extension before `pi-chat` creates the VM. Detached worker processes must also load it.

## Commands

- `/chat-mount [--read-only] [--force]` — configure the current `cwd` as a VM mount for the connected conversation.
- `/chat-mount <repo-url|owner/repo> [--read-only] [--force] [--update] [--source-dir <dir>]` — clone a remote repo on the host if needed, then mount that checkout. Explicit URLs are preserved; `owner/repo` uses GitHub SSH (`git@github.com:owner/repo.git`). The default source directory is `~/dev` or `PI_EZ_CHAT_MOUNT_SOURCE_DIR`.
- `/chat-unmount <name>` — remove a configured mount. `<name>` may be `foo` or `/foo`.
- `/chat-mounts` — show configured mounts and the last VM apply result.

`/chat-mount` requires a connected `pi-chat` conversation (`/chat-connect ...`). The commands also work from pi-chat itself, including mention-only channels: `@bot /chat-mount bry-guy/pi-ez-chat-mount`, `/chat-mount bry-guy/pi-ez-chat-mount @bot`, and `@bot /chat-mounts`. Transcript-shaped forwarded lines such as `- [time] [uid:...] user: <@bot> /chat-mount ...` are also recognized.

Mount names are derived as `/<repo>` after lowercasing and replacing unsafe characters with `-`. Re-running `/chat-mount` for the same repo, host path, and mode is a no-op. If the same repo mount name already exists with a different host path or mode, `/chat-mount` warns and leaves the existing mount in place; rerun with `--force` to confirm replacing it.

## Applying changes

Gondolin mounts are set when the VM is created. After `/chat-mount` or `/chat-unmount`, recreate the chat VM for the change to apply by sending `@bot /new` in the chat channel. pi-chat currently parses `/new` before extension input hooks run, so this extension cannot force-restart the active VM from inside the VM; it returns an explicit reload hint after changes.

Missing host paths are skipped at VM creation; the connection continues. Check `/chat-mounts` for skipped mounts.

## Threads

Thread inheritance belongs in `pi-ez-chat-threads`, not this extension. This extension owns the mount config and VM wrapper; `pi-ez-chat-threads` should copy the parent conversation's mount config when it creates a thread.

Until that integration lands, configure mounts separately for thread conversations if needed.

## Storage

```text
~/.pi/agent/chat-mount/
├── config.json      # sourceDir / cloneMode
├── mounts.json
├── last-apply.json
└── debug.log
```

## Development

```bash
npm install
npm test
npm run typecheck
```

## License

MIT
