# Known issues

## 1. Monkey-patching `VM.create` is the implementation strategy

To avoid requiring changes to upstream `pi-chat`, `pi-ez-chat-mount` will install a runtime wrapper around `@earendil-works/gondolin`'s `VM.create` static method from inside the extension at register time.

### Why this is necessary today

- `pi-chat` owns the Gondolin VM lifecycle via `ConversationSandbox` in `pi-chat/src/gondolin.ts`.
- `pi-chat` hardcodes the mounts passed to `VM.create`:
  ```ts
  vfs: {
    mounts: {
      [GONDOLIN_WORKSPACE]: new RealFSProvider(workspaceDir),
      [GONDOLIN_SHARED]:    new RealFSProvider(sharedDir),
    },
  }
  ```
- `pi-chat` exposes no extension API for contributing additional VM mounts.
- Extensions do not receive the `VM` instance, so they cannot mutate mounts after creation.
- Mounts are bound at `VM.create` time. Even if a hot-add API existed, the mount config would need to be re-applied at every VM (re)creation event:
  - `/chat-connect`
  - `/chat-disconnect` followed by reconnect
  - `/chat-new`
  - secret-change-triggered sandbox restart
  - worker (re)spawn

The only reliable place to inject mounts across all those code paths, without upstream changes, is to wrap `VM.create` itself.

### How the wrapper works

1. At extension register time, import `@earendil-works/gondolin` and replace `VM.create` with a wrapper. Idempotent across re-registers.
2. The wrapper inspects the `VM.create` options to identify the conversation:
   - `opts.sessionLabel` is currently formatted by pi-chat as `"pi-chat <conversationName>"`.
   - `opts.vfs.mounts['/workspace']` has a host path under `~/.pi/agent/chat/accounts/<account>/channels/<channel>/workspace/`, which is parseable into `<account>/<channel>`.
3. The wrapper reads `~/.pi/agent/chat-mount/mounts.json` for that conversation, validates each mount, merges valid ones into `opts.vfs.mounts`, and surfaces applied/skipped state to the user.
4. The wrapper calls the original `VM.create`.

### Tradeoffs and risks

This works, but it is **fragile in well-defined ways**:

- **Implicit contract with pi-chat internals.** We rely on the current shape of `opts.sessionLabel` and the layout under `~/.pi/agent/chat/...`. If pi-chat changes either, our conversation identification breaks.
- **Implicit contract with Gondolin internals.** We rely on `VM.create` being the single entry point and on `opts.vfs.mounts` being a plain object we can mutate.
- **Module identity assumption.** Both pi-chat and pi-ez-chat-mount must resolve to the same `@earendil-works/gondolin` module instance. In normal pi extension loading this holds, but if either extension is installed in a way that yields a duplicate copy in `node_modules`, the wrapper has no effect.
- **Load order.** pi-ez-chat-mount must register before pi-chat starts its first VM. We will document this requirement; if pi exposes a clean lifecycle hook we will use it.
- **Restart-on-change UX.** Gondolin (as currently used) binds mounts at `VM.create` time. There is no documented hot-add API. `/chat-mount` and `/chat-unmount` therefore require a VM restart to take effect. We mitigate by prompting/triggering a sandbox restart, but it is still a UX cost.
- **No structured surface in pi-chat.** Our mount state is invisible to `/chat-status` and worker-status JSON unless we additionally write into pi-chat-managed files. That side-channel reporting is its own coupling.
- **Multi-process worker concerns.** pi-chat's `/chat-spawn-all` runs worker processes via tmux. Each worker process is its own Node runtime, so each worker must independently load pi-ez-chat-mount for the wrapper to be active. We will document this requirement; we will not attempt to globally patch outside the process.

### Tests that mitigate fragility

- Conversation identification is unit-tested against representative `VM.create` option shapes.
- The wrapper is asserted idempotent.
- Skipped-when-missing behavior is unit-tested.
- A smoke test exercises the full flow with a real pi-chat install.
- Pinned semver ranges in `package.json` declare which `pi-chat` and `gondolin` versions are known compatible.

## 2. Recommended upstream fix in pi-chat

The monkey-patch above is a stopgap. The clean fix lives in pi-chat itself. Concretely:

### Proposed pi-chat changes

1. Extend the per-conversation config schema to allow extra mounts:
   ```ts
   // src/core/config-types.ts
   export interface ExtraMountConfig {
     hostPath: string;
     mode?: "rw" | "ro";
   }

   export interface ConfiguredChannel {
     // existing fields...
     mounts?: Record<string, ExtraMountConfig>; // keyed by guest path
   }
   ```
2. Surface them in `ResolvedConversation` as `extraMounts`.
3. In `src/gondolin.ts`, build `VM.create`'s `vfs.mounts` from `/workspace`, `/shared`, plus validated `extraMounts`:
   - skip missing host paths with a logged warning,
   - reject guest paths equal to or under `/workspace` or `/shared`,
   - record applied/skipped state for `/chat-status` and worker-status JSON.
4. Expose a small extension API to allow third-party extensions to register/update conversation mount config and to trigger a sandbox restart for a conversation. Even just exposing the conversation id and a "restart sandbox now" helper would remove most of the monkey-patch's fragility.
5. Include `mounts` in `/chat-status` output and the worker-status JSON.

### Why this is better

- No reliance on `VM.create` wrapping.
- No reliance on string shapes of `sessionLabel` or host-side workspace layout.
- Mount state is durable, declarative, and centrally visible.
- Works with `/chat-spawn-all` workers without per-worker extension load gymnastics.
- Threads inherit mounts via normal pi-chat config copy, with no extra coordination.

### Migration path if upstream lands

When pi-chat ships this:

1. `pi-ez-chat-mount` switches from `VM.create` wrapping to writing the per-conversation `mounts` map in pi-chat config.
2. The wrapper is removed.
3. Behavior, command surface, and persistence semantics stay identical for users.
4. Bump the pi-chat compatibility range in `package.json` and mark the legacy wrapper path as removed in `CHANGELOG.md`.

## 3. `--read-only` enforcement

Until verified, treat `--read-only` as best-effort/intent-only. `@earendil-works/gondolin`'s `RealFSProvider` may not honor a read-only flag; this needs confirmation. If unsupported, document the limitation and consider:

- adding read-only support upstream in Gondolin,
- enforcing read-only at the VM layer (e.g., remount-ro after mount),
- or downgrading the flag to a documented intent that the agent should respect.

## 4. Missing host path on VM start

By design, a missing host path is **not fatal**:

- the mount is skipped,
- the user is notified,
- the connection continues.

This avoids the failure mode where a user can't connect at all because an old mount points at a directory that no longer exists. It does mean the user must read notices to learn that a mount they expected is absent. We mitigate via `/chat-mounts` listing applied vs skipped state.

## 5. Threads inheriting mounts is a cross-package concern

Thread inheritance requires either:

- a shared on-disk convention that both `pi-ez-chat-mount` and `pi-ez-chat-threads` agree on, or
- an explicit code path in `pi-ez-chat-threads` that copies our `mounts.json` entries at thread-creation time.

Neither is ideal. Both should converge on the upstream pi-chat config approach above; in the meantime we document the convention and ship it.

## 6. Stale state already exists in the wild

Existing `pi-chat` channel workspaces under `~/.pi/agent/chat/accounts/<account>/channels/<channel>/workspace/` may contain files copied by `pi-ez-chat-handoff` or written by previous agent runs. `pi-ez-chat-mount` does not delete or modify those automatically. A separate manual cleanup recipe is documented in the plan; an opt-in helper command may come later.
