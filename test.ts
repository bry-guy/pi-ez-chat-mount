import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { sanitizeSegment, deriveGuestPath, normalizeUnmountName } from "./src/mount-name.js";
import { conversationIdFromWorkspaceHostPath, identifyConversation } from "./src/conversation.js";
import { equalMount, partitionMounts, validateGuestPath } from "./src/validate.js";
import { applyConfiguredMounts, installVmCreateWrapper } from "./src/wrapper.js";
import { matchSlashCommand, normalizeRemoteCommandText, stripLeadingMention } from "./src/match.js";
import { parseRepoSpec } from "./src/repo-spec.js";
import { parseMountTarget } from "./src/target.js";
import { normalizeConfig } from "./src/config.js";
import { resolveTargetHostPath } from "./src/resolve.js";
import type { MountStore, VmCreateOptionsLike } from "./src/types.js";

test("sanitizes mount path segments", () => {
  assert.equal(sanitizeSegment(" My Repo!! "), "my-repo");
  assert.equal(sanitizeSegment("A---B___C.txt"), "a-b___c.txt");
  assert.equal(deriveGuestPath("/Users/me/Infra Repo"), "/infra-repo");
  assert.equal(normalizeUnmountName("foo"), "/foo");
  assert.equal(normalizeUnmountName("/foo"), "/foo");
});

test("matches slash commands after leading bot mentions", () => {
  assert.equal(stripLeadingMention("  @bot /chat-thread hi"), "/chat-thread hi");
  assert.deepEqual(matchSlashCommand("<@123> /chat-mount bry-guy/pi-ez-chat-mount", ["chat-mount"]), {
    name: "chat-mount",
    args: "bry-guy/pi-ez-chat-mount",
  });
  assert.deepEqual(matchSlashCommand("/chat-mount bry-guy/pi-ez-chat-mount <@123>", ["chat-mount"]), {
    name: "chat-mount",
    args: "bry-guy/pi-ez-chat-mount",
  });
  assert.deepEqual(matchSlashCommand("- [2026-05-27T12:00:00.000Z] [uid:123] prettybry: <@1496> /chat-mount bry-guy/pi-ez-chat-mount", ["chat-mount"]), {
    name: "chat-mount",
    args: "bry-guy/pi-ez-chat-mount",
  });
  assert.deepEqual(matchSlashCommand("- [2026-05-27T12:00:00.000Z] [uid:123] prettybry: /chat-mount bry-guy/pi-ez-chat-mount <@1496>", ["chat-mount"]), {
    name: "chat-mount",
    args: "bry-guy/pi-ez-chat-mount",
  });
  assert.equal(normalizeRemoteCommandText("- [2026-05-27T12:00:00.000Z] [uid:123] prettybry: hello"), "hello");
  assert.equal(matchSlashCommand("@bot hello", ["chat-mount"]), undefined);
});

test("parses mount targets", () => {
  assert.deepEqual(parseMountTarget("pi-ez-chat-mount"), {
    input: "pi-ez-chat-mount",
    kind: "name",
    slug: "pi-ez-chat-mount",
    ref: undefined,
    display: "pi-ez-chat-mount",
  });
  assert.deepEqual(parseMountTarget("bry-guy/pi-ez-chat-mount"), {
    input: "bry-guy/pi-ez-chat-mount",
    kind: "shorthand",
    slug: "pi-ez-chat-mount",
    cloneUrl: "git@github.com:bry-guy/pi-ez-chat-mount.git",
    ref: undefined,
    display: "bry-guy/pi-ez-chat-mount",
  });
  assert.equal(parseMountTarget("https://github.com/bry-guy/pi-ez-chat-mount.git#main")?.slug, "pi-ez-chat-mount");
  assert.equal(parseMountTarget("git@gitlab.example:group/sub/project.git")?.slug, "project");
  assert.equal(parseMountTarget("bry-guy/pi-ez-chat-mount", "gitlab")?.cloneUrl, "git@gitlab.com:bry-guy/pi-ez-chat-mount.git");

  assert.equal(parseRepoSpec("bry-guy/pi-ez-chat-mount")?.repoName, "pi-ez-chat-mount");
  assert.equal(parseRepoSpec("not-a-repo"), undefined);
  assert.equal(normalizeConfig({ sourceDir: "~/dev", cloneMode: "shallow", defaultForge: "gitlab" }).cloneMode, "shallow");
  assert.equal(normalizeConfig({ sourceDirs: ["~/dev"] }).sourceDir.endsWith("/dev"), true);
});

test("resolves bare names from source dir and rejects missing names", async () => {
  const source = await mkdtemp(join(tmpdir(), "chat-mount-source-"));
  const repo = join(source, "pi-ez-chat-mount");
  await mkdir(repo);
  const ctx = { cwd: source } as any;
  const found = await resolveTargetHostPath("pi-ez-chat-mount", ctx, { force: false, sourceDir: source });
  assert.equal(found.hostPath, repo);
  await assert.rejects(
    () => resolveTargetHostPath("missing-repo", ctx, { force: false, sourceDir: source }),
    /Did you mean to specify a repo URL/,
  );
});

test("shorthand targets prefer an existing source-dir sibling", async () => {
  const source = await mkdtemp(join(tmpdir(), "chat-mount-source-"));
  const repo = join(source, "pi-ez-chat-mount");
  await mkdir(repo);
  const ctx = { cwd: source } as any;
  const found = await resolveTargetHostPath("bry-guy/pi-ez-chat-mount", ctx, { force: false, sourceDir: source });
  assert.equal(found.hostPath, repo);
  assert.match(found.message ?? "", /already exists in source/);
});

test("validates guest paths", () => {
  assert.equal(validateGuestPath("relative"), "guest path must be absolute");
  assert.equal(validateGuestPath("/workspace"), "guest path /workspace is reserved");
  assert.equal(validateGuestPath("/shared/x"), "guest path cannot be under /shared");
  assert.equal(validateGuestPath("/repo-session"), undefined);
});

test("identifies conversation from workspace root path", () => {
  const home = homedir();
  const workspace = `${home}/.pi/agent/chat/accounts/discord-bry-guy/channels/onlyclankers/workspace`;
  assert.equal(conversationIdFromWorkspaceHostPath(workspace, home), "discord-bry-guy/onlyclankers");
  assert.equal(identifyConversation({ vfs: { mounts: { "/workspace": { rootPath: workspace } } } }), "discord-bry-guy/onlyclankers");
});

test("partitions missing and present host paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chat-mount-"));
  const result = await partitionMounts({
    "/present": { hostPath: dir, mode: "rw" },
    "/missing": { hostPath: join(dir, "nope"), mode: "ro" },
  });
  assert.deepEqual(result.applied.map((m) => m.guestPath), ["/present"]);
  assert.equal(result.skipped[0].guestPath, "/missing");
  assert.equal(result.skipped[0].reason, "host path missing");
});

test("rejects colliding mount config", () => {
  assert.equal(equalMount({ hostPath: "/a", mode: "rw" }, { hostPath: "/a", mode: "rw" }), true);
  assert.equal(equalMount({ hostPath: "/a", mode: "rw" }, { hostPath: "/a", mode: "ro" }), false);
});

test("applyConfiguredMounts merges valid mounts and skips missing paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chat-mount-"));
  const workspace = `${homedir()}/.pi/agent/chat/accounts/acct/channels/chan/workspace`;
  const store: MountStore = {
    "acct/chan": {
      "/repo": { hostPath: dir, mode: "rw" },
      "/gone": { hostPath: join(dir, "gone"), mode: "rw" },
    },
  };
  const opts: VmCreateOptionsLike = { vfs: { mounts: { "/workspace": { rootPath: workspace }, "/shared": {} } } };
  let last: unknown;
  await applyConfiguredMounts(opts, (hostPath, mode) => ({ hostPath, mode }), {
    loadStore: async () => store,
    writeLast: async (state) => {
      last = state;
    },
    debug: async () => undefined,
  });
  assert.deepEqual(opts.vfs?.mounts?.["/repo"], { hostPath: dir, mode: "rw" });
  assert.equal(opts.vfs?.mounts?.["/gone"], undefined);
  assert.equal((last as { skipped: unknown[] }).skipped.length, 1);
});

test("installVmCreateWrapper is idempotent", async () => {
  let calls = 0;
  const module = {
    VM: {
      create: async (options?: VmCreateOptionsLike) => {
        calls++;
        return options;
      },
    },
  };
  assert.equal(installVmCreateWrapper(module), true);
  assert.equal(installVmCreateWrapper(module), false);
  await module.VM.create({});
  assert.equal(calls, 1);
});
