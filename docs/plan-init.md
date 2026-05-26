# pi-ez-chat-mount — initial plan

Status: design/planning. No code yet.

## Goal

Replace the copy-into-channel-workspace approach of `pi-ez-chat-handoff` with a small pi extension that exposes the current pi session's `cwd` directly inside the Gondolin VM that `pi-chat` runs, as a sibling host-bind mount.

This must work **without modifying upstream `pi-chat`**. See [known-issues.md](known-issues.md) for the architectural cost of that constraint and the preferred upstream fix.

## Target behavior

- New extension `pi-ez-chat-mount` exposes:
  - `/chat-mount [--read-only]`
  - `/chat-unmount <name>`
  - `/chat-mounts`
- `/chat-mount`:
  - Takes no path arguments.
  - Mounts the current pi session's `cwd` into the Gondolin VM.
  - Mount point is `/<repo>-<session_name>`:
    - `repo` = sanitized basename of `cwd`,
    - `session_name` = sanitized current pi session name.
  - Fails if the current pi session has no name; instructs the user to name the session.
  - Default mode is read-write. `--read-only` makes it read-only.
- Mounts are sibling roots to `/workspace` and `/shared`. `/workspace` semantics are not changed.
- Mounts persist per conversation in extension-local storage and are re-applied on every VM (re)creation for that conversation.
- If a configured mount's host path is missing at VM start: skip that mount, surface a user-visible warning, and continue connecting.
- `/chat-status` (and/or our own listing) surfaces current applied/skipped mounts.
- Threads created via `pi-ez-chat-threads` inherit the parent channel's mounts at thread-creation time. After that, parent and thread mount sets are independent.
- `pi-ez-chat-handoff` becomes deprecated for the "use my local repo from chat" use case.

Explicitly **out of scope** for the initial implementation:

- Mounting by arbitrary host path argument.
- Mounting by git URL with auto-clone.
- Worker/thread lifecycle management changes.
- Live VM rootfs cloning.

## Mental model

`pi-chat` today configures a Gondolin VM per conversation with exactly two mounts:

- `/workspace` → `~/.pi/agent/chat/accounts/<account>/channels/<channel>/workspace/`
- `/shared`    → `~/.pi/agent/chat/accounts/<account>/shared/`

`pi-ez-chat-mount` adds extra sibling mounts at top level, e.g.:

```text
/                       Alpine rootfs
├── shared/             account shared (pi-chat)
├── workspace/          channel-durable storage (pi-chat)
├── infra-infra-dev/    host bind to ~/dev/infra        (pi-ez-chat-mount)
└── bar-bar-dev/        host bind to ~/dev/bar          (pi-ez-chat-mount)
```

The agent's cwd default stays `/workspace`. Host-mounted repos are reachable as `/infra-infra-dev` etc.

Threads behave identically: a thread's VM also gets `/workspace`, `/shared`, plus the same sibling mounts inherited from its parent at thread creation.

## Implementation strategy: monkey-patch `VM.create`

`pi-chat` owns the Gondolin VM lifecycle (`ConversationSandbox` in `pi-chat/src/gondolin.ts`) and hardcodes its `VM.create` call. Extensions do not receive the VM instance. Without upstream changes, the only reliable hook point is to wrap `@earendil-works/gondolin`'s `VM.create` static method from inside our extension before `pi-chat` calls it.

Both extensions share a single Node module instance for `@earendil-works/gondolin`, so wrapping `VM.create` once at extension register time affects all subsequent calls, including `pi-chat`'s.

The wrapper:

1. Identifies the conversation id from `opts.sessionLabel` (currently formatted as `"pi-chat <conversationName>"`) and/or from the host path of `opts.vfs.mounts['/workspace']` against pi-chat's on-disk layout.
2. Loads our mount config for that conversation.
3. Validates each configured mount:
   - host path exists (otherwise skip + warn),
   - guest path is absolute,
   - guest path is not `/`, `/workspace`, `/shared`, and not a path under those,
   - no collision with another configured mount.
4. Merges valid mounts into `opts.vfs.mounts`.
5. Records applied and skipped mounts to:
   - a structured debug log at `~/.pi/agent/chat-mount/debug.log`,
   - a pending notice queue surfaced into the next chat reply.
6. Calls the original `VM.create`.

The wrapper is idempotent: re-installing it does not double-wrap.

See [known-issues.md](known-issues.md) for the tradeoffs of this approach and the recommended long-term upstream fix.

## Storage

```text
~/.pi/agent/chat-mount/
├── mounts.json
└── debug.log
```

`mounts.json` shape:

```json
{
  "<accountId>/<channelKey>": {
    "/<guestPath>": {
      "hostPath": "/absolute/host/path",
      "mode": "rw" | "ro"
    }
  }
}
```

## Mount name derivation

`/<repo>-<session_name>` where each segment is sanitized as:

- lowercase,
- replace any non-`[a-z0-9._-]` char with `-`,
- collapse repeats of `-`,
- strip leading/trailing `-`.

Resulting combined name must be non-empty; otherwise fail.

If a mount with the same guest path and identical config already exists for this conversation, `/chat-mount` is a no-op success. If the guest path collides with a different config, `/chat-mount` fails with a clear error.

## Restart semantics

Gondolin (as currently used by pi-chat) binds mounts at `VM.create` time. There is no documented hot-add API. Therefore:

- `/chat-mount` and `/chat-unmount` update config immediately, but the new mount set only applies after the next VM (re)creation.
- The command prompts the user to restart the sandbox now (preferred) or instructs the user how to do it (`/chat-new`, secret-change-triggered restart, or pi-chat's existing restart-sandbox primitive if reachable from extension context).
- `/chat-mounts` is a pure read, no restart.

If a future Gondolin version exposes hot-add, the extension can adopt it transparently behind the same commands.

## Phases

### Phase 1: extension with VM.create wrapper and core commands

1. Scaffold `pi-ez-chat-mount` package (`package.json`, `tsconfig.json`, `mise.toml`, `release-please-config.json`, `LICENSE`, `index.ts`, `src/`, `test.ts`, `README.md`).
2. Register a one-time wrapper around `VM.create` at extension register time. Idempotent.
3. Implement conversation identification from `VM.create` opts.
4. Implement mount validation, merging, skipping with warning.
5. Implement `~/.pi/agent/chat-mount/mounts.json` load/save helpers.
6. Implement mount-name derivation.
7. Implement commands:
   - `/chat-mount [--read-only]`
   - `/chat-unmount <name>`
   - `/chat-mounts`
8. Surface notices (applied/skipped) to the user via the next chat reply.
9. Tests:
   - mount-name derivation and edge cases,
   - rejects unnamed session,
   - wrapper merges mounts correctly against synthetic `VM.create` options,
   - skipped-when-missing behavior,
   - idempotent wrap,
   - collision rejection,
   - conversation identification correctness.

### Phase 2: status integration

1. Surface configured/applied/skipped mounts via our own listing, and ideally via a pi-chat-visible channel (e.g., a system note in `/workspace/SYSTEM.md` or a structured worker-status sidecar file).
2. Document `/chat-status` limitations: pi-chat does not know about our mounts unless we additionally write to its surfaces.

### Phase 3: thread inheritance

1. Extend `pi-ez-chat-threads` (or coordinate via shared on-disk state) so that on thread creation it copies the parent conversation's entry in `mounts.json` to the new thread conversation entry.
2. Document inheritance semantics:
   - mounts are copied at thread-creation time,
   - parent and thread mount sets are independent thereafter.
3. Test: thread created from a parent with two mounts ends up with the same two mounts in its conversation config.
4. Confirm `/chat-thread` cannot fork from inside an existing thread (per earlier design decision).

### Phase 4: deprecate `pi-ez-chat-handoff`

1. Update `pi-ez-chat-handoff` README to mark deprecated for the "use my local repo from chat" workflow and direct users to `pi-ez-chat-mount`.
2. Leave `pi-ez-chat-handoff` available for users who explicitly want copy-into-channel semantics.

### Phase 5: cleanup of stale pi-chat state

1. Document a manual cleanup recipe for stale channel workspaces under `~/.pi/agent/chat/accounts/<account>/channels/<channel>/workspace/`.
2. Optional later: a `pi-ez-chat-mount` helper command like `/chat-workspace-prune <conversation>`. Not in this plan.

## Validation walkthrough (target end state)

1. From `~/dev/infra` in a pi session named `infra-dev`, `/chat-connect discord-bry-guy/onlyclankers`.
2. `/chat-mount` → VM gets `/infra-infra-dev` bound to `~/dev/infra`.
3. Add `foo.md` in `~/dev/infra` (or from inside the VM); both sides see it.
4. `/chat-thread Fix login tests` → thread conversation inherits mount `/infra-infra-dev`. Both main and thread VMs see `foo.md`.
5. `/chat-disconnect`, `cd ~/dev/bar`, name the session `bar-dev`, `/chat-connect discord-bry-guy/onlyclankers`, `/chat-mount`.
   - Main channel now has `/bar-bar-dev`.
   - The thread still has `/infra-infra-dev`.
6. In the thread VM: commit and push `foo.md`.
7. On host: `cd ~/dev/infra && git pull`. The thread sees no change (same checkout), the host sees the committed file. If you reconnect main from `~/dev/infra` later and `/chat-mount`, main also sees the committed file.

## Open questions to revisit

- Exact conversation-id derivation: stable enough to rely on `sessionLabel` alone, or always cross-check workspace mount path?
- Whether to write a SYSTEM.md or in-prompt note describing the host-mounted siblings so the agent understands they leak to the host.
- Whether `--read-only` is enforceable via Gondolin's `RealFSProvider`. If not initially, document as best-effort/intent-only and revisit.
- Whether reserved-name protection should be added later (deferred for now).
