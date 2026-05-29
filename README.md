# pi-ez-chat-mount

Expose host repositories inside a `pi-chat` Gondolin VM as top-level sibling mounts, without changing `/workspace`.

Example: from anywhere inside `~/dev/infra`, `/chat-mount` configures `/infra -> ~/dev/infra` for the connected chat conversation. `/chat-mount bry-guy/pi-ez-chat-mount` looks for `~/dev/pi-ez-chat-mount`, clones it from GitHub if missing, then mounts it.

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

- `/chat-mount [--read-only] [--force]` — mount the git repository containing the current `cwd`. Rejects if the session is not inside a git repo.
- `/chat-mount <target> [--read-only] [--force] [--forge github|gitlab|bitbucket] [--source-dir <dir>]` — resolve, clone if appropriate, then mount a repository target.
- `/chat-unmount` — unmount the git repository containing the current `cwd`.
- `/chat-unmount <target|/guest-path>` — remove a configured mount by the same target syntax or by literal guest path.
- `/chat-unmount-all` — remove every configured mount for the connected conversation.
- `/chat-mounts` — show mounts configured for the next VM reload and the active/last VM apply snapshot.

`/chat-mount` requires a connected `pi-chat` conversation (`/chat-connect ...`). The commands also work from pi-chat itself, including mention-only channels: `@bot /chat-mount bry-guy/pi-ez-chat-mount`, `/chat-mount bry-guy/pi-ez-chat-mount @bot`, and `@bot /chat-mounts`. Transcript-shaped forwarded lines such as `- [time] [uid:...] user: <@bot> /chat-mount ...` are also recognized.

Targets:

- Bare name, e.g. `pi-ez-chat-mount`: look for `$sourceDir/pi-ez-chat-mount`. If missing, error: bare names never clone.
- Forge shorthand, e.g. `bry-guy/pi-ez-chat-mount`: look for `$sourceDir/pi-ez-chat-mount`; if missing, clone from the configured/default forge.
- Full URL, e.g. `https://github.com/bry-guy/pi-ez-chat-mount` or `git@gitlab.example:group/proj.git`: look for `$sourceDir/<repo>`; if missing, clone that URL.

The source dir defaults to `~/dev`, can be set with `PI_EZ_CHAT_MOUNT_SOURCE_DIR`, and can be overridden per command with `--source-dir`. The default forge is `github`, configurable with `PI_EZ_CHAT_MOUNT_DEFAULT_FORGE` or `defaultForge` in config.

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
├── config.json      # sourceDir / cloneMode / defaultForge
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
