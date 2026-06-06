# pi-ez-chat-mount

## What it does

Mounts host repositories into the pi-chat Gondolin VM as top-level sibling mounts for the connected conversation.

## Why it exists

Agents need real working trees to do real work. This extension lets you pick which repos appear inside the VM without changing `/workspace`.

## How to use it

New to pi-ez-chat? Start with the [user guide](https://github.com/bry-guy/pi-ez-chat-workspace/blob/main/docs/user-guide.md).

Install:

```text
pi install git:github.com/bry-guy/pi-ez-chat-mount
```

Connect a pi-chat conversation first with `/chat-connect`. Then:

- `/chat-mount` mounts the git repo containing the current `cwd`. Pass repo targets to mount specific repos, optionally several at once.

  ```text
  /chat-mount
  /chat-mount bry-guy/pi-ez-chat-mount
  /chat-mount bry-guy/pi-ez-chat-mount bry-guy/pi-ez-chat-ssh
  /chat-mount ~/dev/my-repo --read-only
  /chat-mount ~/dev/my-repo --include-node-modules
  ```

  Targets can be a bare name (looked up under `$sourceDir`), a `owner/repo` shorthand (cloned from the configured forge if missing), or a full git URL. `node_modules` directories are excluded from mounts by default; pass `--include-node-modules` for mounts that intentionally need host dependencies.

- `/chat-unmount` removes a configured mount. Without arguments it removes the current repo. Use `/chat-unmount-all` to clear everything for the conversation.

  ```text
  /chat-unmount
  /chat-unmount bry-guy/pi-ez-chat-mount
  /chat-unmount /pi-ez-chat-mount
  /chat-unmount-all
  ```

- `/chat-mounts` lists configured mounts and the last applied snapshot.

  ```text
  /chat-mounts
  ```

After mount changes, restart the chat sandbox with `/new` so the new VM picks them up.

## Notes

- Default source dir is `~/dev`. Override per command with `--source-dir` or globally with `PI_EZ_CHAT_MOUNT_SOURCE_DIR`.
- Default forge is `github`. Override with `--forge` or `PI_EZ_CHAT_MOUNT_DEFAULT_FORGE`.
- Mount names come from the repo basename, lowercased and sanitized to `/repo-name`.
- Re-mounting the same repo, host path, mode, and `includeNodeModules` setting is a no-op. Conflicting mounts require `--force`.
- Threads inherit mounts from the parent at thread creation time. Later parent changes do not propagate.


Per-mount entries in `mounts.json` may set `includeNodeModules` explicitly:

```json
{
  "discord-bry-guy/onlyclankers": {
    "/my-repo": {
      "hostPath": "/Users/brain/dev/my-repo",
      "mode": "rw",
      "includeNodeModules": false
    }
  }
}
```

Omitted `includeNodeModules` values are treated as `false` for backward compatibility.

## Storage

```text
~/.pi/agent/chat-mount/
├── config.json
├── mounts.json
├── last-apply.json
└── debug.log
```
