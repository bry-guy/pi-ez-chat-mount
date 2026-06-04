# Known issues

The architectural workarounds in this package (monkey-patching
`@earendil-works/gondolin`'s `VM.create`, identifying the conversation from
`opts.sessionLabel` + workspace path, prompting the user to type `/new`
instead of restarting the sandbox programmatically) all exist because
upstream `pi-chat` does not expose the hooks we would need to do these
things cleanly.

The full description of every upstream change we want — including the
exact ask and source-code receipts — lives in a single rollup:

**[pi-ez-lib/wishlist.md](../../pi-ez-lib/wishlist.md)**

Items relevant to this package:

- §1 — extension API to restart the current conversation sandbox (so
  `/chat-mount` does not have to ask the user to type `@bot /new`, and the
  previous tmux-respawn workaround can stay deleted; that workaround
  killed the user's pi session whenever `/chat-mount` ran from a non-worker
  pane).
- §2 — extension contributions to `VM.create` options (so the `VM.create`
  wrapper in `src/wrapper.ts` can be deleted in favor of pi-chat config).
- §5 — confirm and document read-only mount semantics in Gondolin (today
  `--read-only` is best-effort).
- §7 — first-class threads in pi-chat (so thread mount inheritance is a
  pi-chat concern, not a cross-package handoff between
  `pi-ez-chat-mount` and `pi-ez-chat-threads`).

## Package-local notes that are not upstream concerns

### Missing host path on VM start

By design, a missing host path is **not fatal**:

- the mount is skipped,
- the user is notified,
- the connection continues.

This avoids the failure mode where a user can't connect at all because an
old mount points at a directory that no longer exists. It does mean the
user must read notices to learn that a mount they expected is absent. We
mitigate via `/chat-mounts` listing applied vs skipped state.

### Stale state in `pi-chat` workspaces

Existing `pi-chat` channel workspaces under
`~/.pi/agent/chat/accounts/<account>/channels/<channel>/workspace/` may
contain files copied by `pi-ez-chat-handoff` or written by previous agent
runs. `pi-ez-chat-mount` does not delete or modify those automatically. A
separate manual cleanup recipe is documented in the plan; an opt-in helper
command may come later.
