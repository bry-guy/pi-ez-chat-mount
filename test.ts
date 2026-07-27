import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { sanitizeSegment, deriveGuestPath, normalizeUnmountName } from "./src/mount-name.js";
import { conversationIdFromWorkspaceHostPath, identifyConversation } from "./src/conversation.js";
import { createMountContributor } from "./src/contributor.js";
import { equalMount, partitionMounts, validateGuestPath } from "./src/validate.js";
import { matchSlashCommand, normalizeRemoteCommandText, stripLeadingMention } from "./src/match.js";
import { excludeNodeModulesProvider, pathIncludesNodeModules } from "./src/filter-provider.js";
import { parseMountArgs } from "./index.js";
import { parseMountTarget } from "./src/target.js";
import { normalizeConfig } from "./src/config.js";
import { resolveTargetHostPath } from "./src/resolve.js";
import type { MountStore } from "./src/types.js";

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
  assert.equal(equalMount({ hostPath: "/a", mode: "rw" }, { hostPath: "/a", mode: "rw", includeNodeModules: false }), true);
  assert.equal(equalMount({ hostPath: "/a", mode: "rw", includeNodeModules: true }, { hostPath: "/a", mode: "rw" }), false);
  assert.equal(equalMount({ hostPath: "/a", mode: "rw" }, { hostPath: "/a", mode: "ro" }), false);
});

test("mount contributor returns valid mounts and skips missing paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chat-mount-"));
  const store: MountStore = {
    "acct/chan": {
      "/repo": { hostPath: dir, mode: "rw" },
      "/readonly": { hostPath: dir, mode: "ro", includeNodeModules: true },
      "/gone": { hostPath: join(dir, "gone"), mode: "rw" },
    },
  };
  let last: unknown;
  class RealFSProvider {
    constructor(public hostPath: string) {}
  }
  class ReadonlyProvider {
    constructor(public provider: unknown) {}
  }
  const contributor = createMountContributor({
    loadStore: async () => store,
    writeLast: async (state) => {
      last = state;
    },
    debug: async () => undefined,
  });
  const fragment = await contributor.contribute({ conversationId: "acct/chan", gondolin: { RealFSProvider, ReadonlyProvider } });
  assert.equal((fragment?.vfs?.mounts?.["/repo"] as { hostPath?: string }).hostPath, dir);
  assert.equal(((fragment?.vfs?.mounts?.["/readonly"] as { provider?: { hostPath?: string } }).provider?.hostPath), dir);
  assert.equal(fragment?.vfs?.mounts?.["/gone"], undefined);
  assert.equal((last as { skipped: unknown[] }).skipped.length, 1);
});



test("node_modules filter hides directory entries and rejects nested paths", async () => {
  assert.equal(pathIncludesNodeModules("node_modules/pkg"), true);
  assert.equal(pathIncludesNodeModules("src/not_node_modules/file"), false);
  const provider = excludeNodeModulesProvider({
    readdir: () => ["src", "node_modules", { name: "node_modules" }, { name: "package.json" }],
    readFile: (path: string) => `read ${path}`,
  }) as { readdir(): unknown[]; readFile(path: string): string };
  assert.deepEqual(provider.readdir(), ["src", { name: "package.json" }]);
  assert.equal(provider.readFile("src/index.ts"), "read src/index.ts");
  assert.throws(() => provider.readFile("node_modules/pkg/index.js"), /node_modules is excluded/);
});

test("parseMountArgs accepts zero, one, or many targets and parses flags", () => {
  assert.deepEqual(parseMountArgs(""), { mode: "rw", force: false, includeNodeModules: false, rawTargets: [] });
  assert.deepEqual(parseMountArgs("foo"), { mode: "rw", force: false, includeNodeModules: false, rawTargets: ["foo"] });
  assert.deepEqual(parseMountArgs("foo bar baz"), { mode: "rw", force: false, includeNodeModules: false, rawTargets: ["foo", "bar", "baz"] });
  assert.deepEqual(parseMountArgs("foo bar --read-only --force"), { mode: "ro", force: true, includeNodeModules: false, rawTargets: ["foo", "bar"] });
  assert.deepEqual(parseMountArgs("--read-only foo --force bar"), { mode: "ro", force: true, includeNodeModules: false, rawTargets: ["foo", "bar"] });
  assert.deepEqual(parseMountArgs('a b --include-node-modules --source-dir=/tmp --forge gitlab'), {
    mode: "rw",
    force: false,
    includeNodeModules: true,
    sourceDir: "/tmp",
    forge: "gitlab",
    rawTargets: ["a", "b"],
  });
});

test("parseMountArgs rejects --update and unknown flags", () => {
  assert.throws(() => parseMountArgs("foo --update"), /--update has been removed/);
  assert.throws(() => parseMountArgs("foo --nope"), /Usage: \/chat-mount/);
});
