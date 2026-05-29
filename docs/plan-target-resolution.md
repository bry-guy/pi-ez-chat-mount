# pi-ez-chat-mount — target-driven `/chat-mount $target`

Status: implemented in 0.2.0.

## Decisions

1. **Config**: JSON only at `~/.pi/agent/chat-mount/config.json`. Matches pi-native conventions.
2. **Default forge**: GitHub by default. Configurable via `defaultForge` in the JSON config; per-invocation override via `--forge`.
3. **Single source dir**: every repo is a sibling under it. Default `~/dev` (overridable by `PI_EZ_CHAT_MOUNT_SOURCE_DIR` or `--source-dir`).
4. **Lookup-first, clone-fallback**: when `$target` is a shorthand or URL, look in `$source_dir/$slug` first; clone there if missing. When `$target` is a bare name, never clone — error with "did you mean to specify a repo URL?" if the slug isn't already in source.
5. **Bare `/chat-mount` / `/chat-unmount`**: act on the repo the current pi session's cwd is inside. Reject if cwd is not inside a git repo. Removed `--here`.
6. **Dropped `--update`**: users manage repo state from inside the VM via normal `git fetch` / `git pull`.
7. **Added `/chat-unmount-all`**: clear all mounts for the connected conversation.
8. **`/chat-mounts`** now distinguishes "configured for next VM reload" from "active in VM (snapshot from last `VM.create`)".
9. **Remote auto-restart**: remote mount changes schedule a tmux pane respawn, which restarts the current pi-chat worker and creates a fresh Gondolin VM with updated mounts.

## Target shapes

```text
parseTarget("pi-ez-chat-mount")                 -> name      (no slash, no scheme)
parseTarget("bry-guy/pi-ez-chat-mount")         -> shorthand (uses defaultForge)
parseTarget("https://github.com/.../foo.git")   -> url
parseTarget("git@gitlab.example:group/proj")    -> url
parseTarget("...#some-ref")                     -> any of above with .ref = "some-ref"
```

Forge mapping for shorthand:

```text
github    -> git@github.com:<owner>/<repo>.git
gitlab    -> git@gitlab.com:<owner>/<repo>.git
bitbucket -> git@bitbucket.org:<owner>/<repo>.git
```

GitLab subgroups (`group/sub/proj`) are not supported via shorthand — use a full URL.

## Resolution

```text
resolve(target):
  if target.kind == "name":
    if exists($source_dir/$slug): return $source_dir/$slug
    else: error "no repo named $slug under $source_dir; did you mean to specify a repo URL?"

  if target.kind in ("shorthand", "url"):
    if exists($source_dir/$slug):
      if it has a .git: verify origin matches target.cloneUrl (or --force overrides)
      return $source_dir/$slug
    else:
      clone target.cloneUrl into $source_dir/$slug (respecting cloneMode)
      return $source_dir/$slug

  if target.ref: git checkout $ref inside the resolved dir
```

Bare `/chat-mount` (no positional arg):

```text
root = `git rev-parse --show-toplevel` from ctx.cwd
if root is undefined: error "current cwd is not inside a git repo"
slug = basename(root)
mount root as /<slug>
```

## Command surface

```text
/chat-mount                           Mount the current cwd's repo. Errors if cwd is not in a repo.
/chat-mount <target> [--read-only] [--force] [--forge github|gitlab|bitbucket] [--source-dir <dir>]
/chat-unmount                         Unmount the current cwd's repo by slug.
/chat-unmount <target | /guest-path>  Unmount by target shape or by literal guest path.
/chat-unmount-all                     Remove every mount for the connected conversation.
/chat-mounts                          Show configured + active mounts.
```

## Config migration

Legacy `{ "sourceDir": "...", "cloneMode": "..." }` is read transparently and rewritten with the new shape (adds `defaultForge: "github"`).

## Out of scope

- Searching multiple source dirs.
- Deleting from disk on unmount.
- Auto-refresh of repo state (no `git fetch` / `git pull` by us).
- Per-conversation default forge.
- Auto-propagation of parent mount changes to existing threads (still owned by `pi-ez-chat-threads`).
